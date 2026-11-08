// M3.5 D3 — the authentication rate limiter on an ISOLATED scratch cluster
// (scripts/lib/scratchPostgres.mjs; never dev or production — the
// development project is only read for the platform stand-in shape):
//
//   1. migration 67 on the 66-migration state: exactly the two new
//      service-role functions, no other application change, cron unchanged;
//   2. storage and function privileges (service_role only);
//   3. SQL semantics: validation, limits, refusals never extend a window or
//      grow a counter, window expiry, multi-bucket atomicity, clearing,
//      20 concurrent connections never exceed a limit, no deadlock,
//      bounded cleanup (at most every 10 minutes, at most 200 rows);
//   4. the REAL limiter core (lib/authRateLimit.ts) against that database:
//      login lockouts (account across many networks, network across many
//      accounts), unknown accounts, recovery during a lockout and clearing
//      after a password change, reset flooding, IPv6 /64, untrusted headers,
//      concurrency at the login boundary, fail-closed / fail-open, timing
//      floor, environment separation of keys.
//
// Requires TENOTRAINER_PG_TOOLING (scripts/lib/scratchPostgres.mjs).
// Run from web/:  TENOTRAINER_MODE=development node --experimental-strip-types scripts/verifyD3RateLimitSql.mjs
import { randomBytes } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/m32Fixtures.mjs";
import { SCRATCH_DB, ScratchPostgres } from "./lib/scratchPostgres.mjs";
import { applyMigrations, installPlatformStandIn, migrationFiles, readPlatformShape } from "./lib/freshDatabase.mjs";
import { CATALOG_SQL, diffCatalogs, stable } from "./lib/schemaCatalog.mjs";
import {
  bucketKey, clientNetworkIdentity, createAuthRateLimiter, DEFAULT_AUTH_RATE_LIMITS, guardedLoginAttempt,
  normalizeAccountIdentifier, normalizeClientIp, withMinimumDuration,
} from "../lib/authRateLimit.ts";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const M67 = "20261109000001_m35_auth_rate_limit.sql";
const API_ROLES = ["anon", "authenticated"];
const FUNCS = ["public.auth_rate_limit_reserve(text[],integer[],integer[])", "public.auth_rate_limit_clear(text[])"];
const TABLES = ["private.auth_rate_limit_buckets", "private.auth_rate_limit_maintenance"];
const hex = () => randomBytes(32).toString("hex");

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 500)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

const sp = new ScratchPostgres();
try {
  section("1. migration 67 on the 66-migration state");
  const files = migrationFiles();
  check("migration 67 (filename order, last) is the D3 rate limiter", files.indexOf(M67) === 66 && files.at(-1) === M67, `${files.indexOf(M67)} ${files.at(-1)}`);
  const db = await sp.start();
  await installPlatformStandIn(db, readPlatformShape(env), SCRATCH_DB);
  const r66 = await applyMigrations(db, files.slice(0, 66));
  check("the first 66 migrations apply", !r66.failed && r66.applied === 66, JSON.stringify(r66.failed));
  const cat66 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const r67 = await applyMigrations(db, [M67]);
  check("migration 67 applies (one transaction)", !r67.failed && r67.applied === 1, JSON.stringify(r67.failed));
  const cat67 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const d = diffCatalogs(cat66, cat67);
  const changed = Object.entries(d.categories).filter(([, v]) => v.missing.length || v.unexpected.length || v.changed.length).map(([k, v]) => [k, v]);
  const onlyFunctions = changed.every(([k, v]) => !v.missing.length && !v.changed.length && v.unexpected.every((x) => /auth_rate_limit_(reserve|clear)/.test(JSON.stringify(x))));
  check("public catalog: only the two auth_rate_limit_* functions (and their grants) are new; no table, policy, trigger or cron change",
    changed.length > 0 && onlyFunctions && !changed.some(([k]) => /table|polic|trigger|cron/i.test(k)), JSON.stringify(changed).slice(0, 600));

  section("2. privileges");
  for (const f of FUNCS) {
    const p = (await db.query("SELECT prosecdef, proconfig, proacl::text AS acl FROM pg_proc WHERE oid = $1::regprocedure", [f])).rows[0];
    const acl = p?.acl ?? "";
    check(`${f}: SECURITY DEFINER, search_path '', EXECUTE for service_role only (no PUBLIC / anon / authenticated)`,
      p?.prosecdef === true && stable(p?.proconfig) === stable(['search_path=""']) && /service_role=X/.test(acl) && !/(^|[{,])=X|anon=|authenticated=/.test(acl), JSON.stringify(p));
  }
  for (const t of TABLES) {
    const p = (await db.query("SELECT relrowsecurity AS rls, relacl::text AS acl, relnamespace::regnamespace::text AS ns FROM pg_class WHERE oid = $1::regclass", [t])).rows[0];
    check(`${t}: schema private, RLS on, no API-role or service_role grant`, p?.ns === "private" && p?.rls === true && !/anon|authenticated|service_role|(^|[{,])=/.test(p?.acl ?? ""), JSON.stringify(p));
  }
  for (const role of API_ROLES) {
    await db.query("BEGIN");
    let err = null;
    try { await db.query(`SET LOCAL ROLE ${role}`); await db.query("SELECT public.auth_rate_limit_reserve($1, $2, $3)", [[hex()], [5], [60]]); } catch (e) { err = e; }
    await db.query("ROLLBACK");
    check(`${role} calling auth_rate_limit_reserve is refused (42501)`, err?.code === "42501", err?.code ?? "no error");
  }
  {
    await db.query("BEGIN");
    let ok = false;
    try { await db.query("SET LOCAL ROLE service_role"); ok = (await db.query("SELECT public.auth_rate_limit_reserve($1, $2, $3) AS r", [[hex()], [5], [60]])).rows[0].r.allowed === true; } catch { ok = false; }
    await db.query("ROLLBACK");
    check("service_role can reserve", ok);
  }

  section("3. SQL semantics");
  const reserve = async (keys, limits, windows, client = db) => (await client.query("SELECT public.auth_rate_limit_reserve($1, $2, $3) AS r", [keys, limits, windows])).rows[0].r;
  const row = async (k) => (await db.query("SELECT hits, window_start FROM private.auth_rate_limit_buckets WHERE bucket_key = $1", [k])).rows[0];
  const invalid = async (keys, limits, windows) => { try { await reserve(keys, limits, windows); return false; } catch (e) { return e.message === "AUTH_RATE_LIMIT_INVALID_ARGUMENTS"; } };
  check("invalid arguments refused: non-hex key, uppercase, mismatched arrays, limit 0, window 0, > 8 keys, duplicates, nulls",
    (await invalid(["not-hex"], [1], [60])) && (await invalid([hex().toUpperCase()], [1], [60])) && (await invalid([hex()], [1, 2], [60]))
    && (await invalid([hex()], [0], [60])) && (await invalid([hex()], [1], [0])) && (await invalid(Array.from({ length: 9 }, hex), Array(9).fill(1), Array(9).fill(60)))
    && (await invalid((() => { const h = hex(); return [h, h]; })(), [1, 1], [60, 60])) && (await invalid([null], [1], [60])));
  {
    const k = hex();
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await reserve([k], [3], [900])).allowed);
    const before = await row(k);
    const refusals = [];
    for (let i = 0; i < 5; i++) refusals.push(await reserve([k], [3], [900]));
    const after = await row(k);
    check("limit 3: three reservations allowed, then refused", results.every(Boolean) && refusals.every((r) => r.allowed === false));
    check("refused reservations report the remaining wait (0 < retry_after_s <= window)", refusals.every((r) => r.retry_after_s > 0 && r.retry_after_s <= 900), JSON.stringify(refusals[0]));
    check("refusals never grow the counter or move the window (no indefinite lockout)", before.hits === 3 && after.hits === 3 && before.window_start.getTime() === after.window_start.getTime(), JSON.stringify({ before, after }));
    await db.query("UPDATE private.auth_rate_limit_buckets SET window_start = window_start - interval '901 seconds' WHERE bucket_key = $1", [k]);
    const fresh = await reserve([k], [3], [900]);
    check("after the window elapses a new window starts (allowed, counter 1)", fresh.allowed === true && (await row(k)).hits === 1, JSON.stringify(await row(k)));
  }
  {
    const full = hex();
    const other = hex();
    await reserve([full], [1], [900]);
    const r = await reserve([full, other], [1, 5], [900, 900]);
    check("multi-bucket atomicity: one bucket at its limit refuses the call and the other bucket is NOT incremented",
      r.allowed === false && (await row(other)).hits === 0, JSON.stringify({ r, other: await row(other) }));
    const cleared = (await db.query("SELECT public.auth_rate_limit_clear($1) AS n", [[full]])).rows[0].n;
    check("clear removes the bucket; the next reservation is allowed", cleared === 1 && (await reserve([full], [1], [900])).allowed === true);
  }
  {
    const k = hex();
    const conns = await Promise.all(Array.from({ length: 20 }, () => sp.connect(SCRATCH_DB)));
    try {
      const out = await Promise.all(conns.map((c) => reserve([k], [5], [900], c)));
      const allowed = out.filter((r) => r.allowed).length;
      check("20 concurrent connections, limit 5: exactly 5 allowed, counter exactly 5", allowed === 5 && (await row(k)).hits === 5, `${allowed} allowed, hits ${(await row(k)).hits}`);
      const a = hex();
      const b = hex();
      const mixed = await Promise.all(conns.map((c, i) => reserve(i % 2 ? [a, b] : [b, a], [100, 100], [900, 900], c)));
      check("overlapping multi-bucket reservations in opposite orders: no deadlock, every call answered", mixed.length === 20 && mixed.every((r) => r.allowed === true) && (await row(a)).hits === 20 && (await row(b)).hits === 20);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  }
  {
    await db.query("DELETE FROM private.auth_rate_limit_buckets");
    await db.query("INSERT INTO private.auth_rate_limit_buckets (bucket_key, window_start, hits, updated_at) SELECT encode(sha256(g::text::bytea), 'hex'), now() - interval '2 days', 1, now() - interval '2 days' FROM generate_series(1, 500) g");
    await db.query("UPDATE private.auth_rate_limit_maintenance SET last_cleanup_at = '-infinity'");
    const count = async () => Number((await db.query("SELECT count(*) AS n FROM private.auth_rate_limit_buckets WHERE updated_at < now() - interval '1 day'")).rows[0].n);
    await reserve([hex()], [5], [60]);
    const after1 = await count();
    await reserve([hex()], [5], [60]);
    const after2 = await count();
    await db.query("UPDATE private.auth_rate_limit_maintenance SET last_cleanup_at = now() - interval '11 minutes'");
    await reserve([hex()], [5], [60]);
    const after3 = await count();
    check("bounded cleanup: one pass deletes at most 200 idle buckets (500 → 300)", after1 === 300, after1);
    check("cleanup runs at most every 10 minutes (no second pass right away)", after2 === 300, after2);
    check("after 10 minutes another bounded pass runs (300 → 100)", after3 === 100, after3);
    const recent = Number((await db.query("SELECT count(*) AS n FROM private.auth_rate_limit_buckets WHERE updated_at >= now() - interval '1 day'")).rows[0].n);
    check("cleanup never deletes active buckets", recent === 3, recent);
  }
  {
    const nonHex = Number((await db.query("SELECT count(*) AS n FROM private.auth_rate_limit_buckets WHERE bucket_key !~ '^[0-9a-f]{64}$'")).rows[0].n);
    const cols = (await db.query("SELECT array_agg(column_name::text ORDER BY ordinal_position) AS c FROM information_schema.columns WHERE table_schema = 'private' AND table_name = 'auth_rate_limit_buckets'")).rows[0].c;
    check("storage holds only 64-hex keys, counters and timestamps (no email / IP / user column)", nonHex === 0 && stable(cols) === stable(["bucket_key", "window_start", "hits", "updated_at"]), JSON.stringify(cols));
  }

  section("4. the limiter core against the scratch database");
  const KEY = randomBytes(32);
  const rpc = {
    async reserve(keys, limits, windows) { const r = await reserve(keys, limits, windows); return { allowed: r.allowed, retryAfterS: r.retry_after_s }; },
    async clear(keys) { await db.query("SELECT public.auth_rate_limit_clear($1)", [keys]); },
  };
  const logs = [];
  const limiter = createAuthRateLimiter({ ...rpc, key: KEY, failClosed: true, log: (e, f) => logs.push([e, f]) });
  const passwords = new Map([["pat@example.invalid", "correct-horse-1"], ["clin@example.invalid", "correct-horse-2"]]);
  let signInCalls = 0;
  const login = (email, password, network) => guardedLoginAttempt(limiter, { account: normalizeAccountIdentifier(email), network }, async () => {
    signInCalls++;
    return passwords.get(normalizeAccountIdentifier(email)) === password ? { ok: true } : { ok: false, code: "invalid_credentials" };
  });
  const net = (i) => normalizeClientIp(`198.51.100.${i}`);

  check("thresholds: login 5/account/15 min, 30/network/15 min; reset 3/account/h, 10/network/h; verify 20/network/15 min; password 10/user/h",
    stable(DEFAULT_AUTH_RATE_LIMITS) === stable({ login_account: { limit: 5, windowSeconds: 900 }, login_ip: { limit: 30, windowSeconds: 900 }, reset_account: { limit: 3, windowSeconds: 3600 }, reset_ip: { limit: 10, windowSeconds: 3600 }, verify_ip: { limit: 20, windowSeconds: 900 }, password_user: { limit: 10, windowSeconds: 3600 } }));
  check("normal login succeeds", (await login("pat@example.invalid", "correct-horse-1", net(1))).kind === "signed_in");
  check("wrong password → refused (invalid_credentials)", (await login("pat@example.invalid", "nope", net(1))).code === "invalid_credentials");
  const unknown = await login("nobody@example.invalid", "nope", net(1));
  check("unknown account → the identical refusal (and counted the same way)", unknown.kind === "refused" && unknown.code === "invalid_credentials");
  check("a successful login cleared the account counter (only the 1 later failure counts)", (await row(bucketKey(KEY, "login_account", "pat@example.invalid"))).hits === 1);

  {
    // Distributed guessing: one account, a different network every time.
    const outs = [];
    for (let i = 0; i < 8; i++) outs.push(await login("Clin@Example.invalid ", "wrong", net(10 + i)));
    check("per-account lockout across 8 different networks: 5 attempts refused by the password, then limited", outs.slice(0, 5).every((o) => o.kind === "refused") && outs.slice(5).every((o) => o.kind === "limited"), JSON.stringify(outs.map((o) => o.kind)));
    const callsBefore = signInCalls;
    const right = await login("clin@example.invalid", "correct-horse-2", net(50));
    check("while locked, even the correct password is not checked (no credential oracle)", right.kind === "limited" && signInCalls === callsBefore);
    const resetDuring = await limiter.reserve([{ scope: "reset_ip", id: net(50) }, { scope: "reset_account", id: "clin@example.invalid" }]);
    check("recovery stays available during the login lockout (separate counters)", resetDuring.allowed === true);
    await limiter.clear([{ scope: "login_account", id: "clin@example.invalid" }]); // what a completed password change does
    check("after a completed recovery (account counter cleared) the owner can log in", (await login("clin@example.invalid", "correct-horse-2", net(51))).kind === "signed_in");
    check("network counters are not cleared by recovery", (await row(bucketKey(KEY, "login_ip", net(10)))).hits === 1);
  }
  {
    // One network spraying many accounts.
    const spray = net(99);
    const outs = [];
    for (let i = 0; i < 32; i++) outs.push(await login(`spray-${i}@example.invalid`, "wrong", spray));
    check("per-network lockout: 30 attempts across 30 accounts, then limited for new accounts", outs.slice(0, 30).every((o) => o.kind === "refused") && outs.slice(30).every((o) => o.kind === "limited"), JSON.stringify(outs.slice(28).map((o) => o.kind)));
    check("another network is unaffected", (await login("pat@example.invalid", "correct-horse-1", net(98))).kind === "signed_in");
  }
  {
    // Concurrency at the login boundary: 12 parallel guesses on one account.
    const calls0 = signInCalls;
    const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => login("burst@example.invalid", "wrong", net(150 + i))));
    check("12 parallel attempts on one account: at most 5 reach the credential check", signInCalls - calls0 === 5 && outs.filter((o) => o.kind === "limited").length === 7, `${signInCalls - calls0} checks`);
  }
  {
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push(await limiter.reserve([{ scope: "reset_ip", id: net(200) }, { scope: "reset_account", id: "flood@example.invalid" }]));
    check("reset flooding: 3 requests per address per hour, then refused", outs.slice(0, 3).every((o) => o.allowed) && outs.slice(3).every((o) => !o.allowed && o.reason === "limited"));
    const ipOuts = [];
    for (let i = 0; i < 12; i++) ipOuts.push(await limiter.reserve([{ scope: "reset_ip", id: net(201) }, { scope: "reset_account", id: `flood-${i}@example.invalid` }]));
    check("reset flooding: 10 requests per network per hour across addresses, then refused", ipOuts.slice(0, 10).every((o) => o.allowed) && ipOuts.slice(10).every((o) => !o.allowed));
  }
  {
    const k = bucketKey(KEY, "login_account", "expire@example.invalid");
    for (let i = 0; i < 6; i++) await login("expire@example.invalid", "wrong", net(210));
    const locked = await login("expire@example.invalid", "wrong", net(211));
    await db.query("UPDATE private.auth_rate_limit_buckets SET window_start = window_start - interval '15 minutes' WHERE bucket_key = $1", [k]);
    const later = await login("expire@example.invalid", "wrong", net(212));
    check("lockouts expire with their window (15 minutes)", locked.kind === "limited" && later.kind === "refused");
  }
  {
    const a = normalizeClientIp("2001:db8:abcd:12:1::1");
    const b = normalizeClientIp("2001:0db8:abcd:0012:ffff:ffff:ffff:fffe");
    const c = normalizeClientIp("2001:db8:abcd:13::1");
    check("IPv6: addresses in one /64 share a network identity; another /64 does not", a === b && a !== c && a === "v6:2001:db8:abcd:12::/64", `${a} ${b} ${c}`);
    const outs = [];
    for (let i = 0; i < 31; i++) outs.push(await login(`v6-${i}@example.invalid`, "wrong", normalizeClientIp(`2001:db8:abcd:12::${(i + 1).toString(16)}`)));
    check("rotating IPv6 addresses inside one /64 does not escape the network limit", outs[30].kind === "limited");
  }
  {
    check("untrusted forwarding headers: every spoofed X-Forwarded-For maps to the one shared 'untrusted' identity",
      ["1.2.3.4", "5.6.7.8", "2001:db8::1", "garbage"].every((h) => clientNetworkIdentity(h, false) === "untrusted"));
    check("trusted platform header: first address used; non-IP values become 'unknown'",
      clientNetworkIdentity("203.0.113.9, 10.0.0.1", true) === "v4:203.0.113.9" && clientNetworkIdentity("not-an-ip", true) === "unknown" && clientNetworkIdentity(null, true) === "unknown");
  }
  {
    const broken = { reserve: async () => { throw new Error("db down"); }, clear: async () => { throw new Error("db down"); } };
    const closed = createAuthRateLimiter({ ...broken, key: KEY, failClosed: true });
    const open = createAuthRateLimiter({ ...broken, key: KEY, failClosed: false });
    const c = await guardedLoginAttempt(closed, { account: "pat@example.invalid", network: net(1) }, async () => ({ ok: true }));
    const o = await guardedLoginAttempt(open, { account: "pat@example.invalid", network: net(1) }, async () => ({ ok: true }));
    check("database unavailable, fail-closed (production): the login is refused as unavailable, password never checked", c.kind === "unavailable");
    check("database unavailable, fail-open (development / isolated test profile): the login proceeds", o.kind === "signed_in");
    check("limiter events are logged without identifiers (no email, IP or key)", logs.length > 0 && !JSON.stringify(logs).match(/@|198\.51|2001:|[0-9a-f]{64}/), JSON.stringify(logs.slice(0, 3)));
  }
  {
    const t0 = Date.now();
    await withMinimumDuration(300, async () => "fast");
    check("timing floor: a fast path still takes at least the floor", Date.now() - t0 >= 295);
  }
  {
    const prodKey = randomBytes(32);
    const devKey = randomBytes(32);
    check("environment separation: the same address hashes to unrelated keys under different environment keys (and each environment has its own database)",
      bucketKey(prodKey, "login_account", "pat@example.invalid") !== bucketKey(devKey, "login_account", "pat@example.invalid")
      && bucketKey(prodKey, "login_account", "x") !== bucketKey(prodKey, "reset_account", "x"));
  }
} catch (e) {
  check("suite completed", false, e.stack ?? e.message);
} finally {
  await sp.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
