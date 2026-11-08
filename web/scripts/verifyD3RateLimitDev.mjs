// M3.5 D3 — the authentication rate limiter, live against the DEVELOPMENT
// project (migration 67 applied there) over the real Next.js boundary.
//
// Every scenario uses its own client network: development trusts
// X-Forwarded-For, so each browser context sends a fixed address from this
// suite's documentation-only ranges — TEST-NET-2 198.51.100.0/24 and
// 2001:db8:d3::/48 (scripts/lib/authRateLimitTestIdentity.mjs) — assigned in
// a deterministic order; the suite clears exactly those identities before
// it starts and when it ends. Bucket hit counts are read straight from
// private.auth_rate_limit_buckets using the server's HMAC derivation (the
// key space of .env.local: AUTH_RATE_LIMIT_SECRET, else the public
// development-only key). No email is sent:
// recovery requests for these @example.invalid fixtures are suppressed by
// the development email policy after the limiter, and recovery tokens come
// from auth.admin.generateLink. Fixture accounts and every bucket this
// suite touched are deleted at the end.
//
// Server: a development-mode server (nothing is restarted); pass its stdout
// log as D3_SERVER_LOG to check log outcomes and the no-identifier rule.
// Run from web/:
//   TENOTRAINER_MODE=development D3_SERVER_LOG=<file> \
//     node --experimental-strip-types scripts/verifyD3RateLimitDev.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/harnessEnv.mjs";
import { bucketKey, createAuthRateLimiter, normalizeClientIp } from "../lib/authRateLimit.ts";
import { clearSuiteCounters, D3_IPV4_NETWORK, D3_IPV6_PREFIX, rateLimitKey } from "./lib/authRateLimitTestIdentity.mjs";

const BASE = process.argv[2] ?? "http://localhost:3001";
const SERVER_LOG = process.env.D3_SERVER_LOG ?? null;
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const RUN = randomUUID().slice(0, 8);
const PASSWORD = `d3-original-${RUN}-pw`;
const NEW_PASSWORD = `d3-recovered-${RUN}-pw!`;
const emailOf = (label) => `d3-${label}-${RUN}@example.invalid`;

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anonClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const WORK = mkdtempSync(join(tmpdir(), "d3-"));

// The key space of a development server started from .env.local.
const SECRET = env.AUTH_RATE_LIMIT_SECRET || null;
const KEY = rateLimitKey(SECRET);
const touched = new Set();
const key = (scope, id) => { const k = bucketKey(KEY, scope, id); touched.add(k); return k; };

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 500)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

function sqlRows(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  const out = execFileSync("supabase", ["db", "query", "--linked", "--output-format", "json", "--file", path], { cwd: "..", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out).rows;
}
// { hits, window_start } for a bucket, or null when no row exists.
function bucket(scope, id) {
  const rows = sqlRows(`SELECT hits, window_start::text AS window_start FROM private.auth_rate_limit_buckets WHERE bucket_key = '${key(scope, id)}';`);
  return rows[0] ?? null;
}

// A new client network per scenario, in a fixed order: 198.51.100.1, .2, …
const MAX_NETWORKS = 64;
const ALL_NETWORKS = Array.from({ length: MAX_NETWORKS }, (_, i) => `${D3_IPV4_NETWORK}${i + 1}`);
const V6_NETWORK = `${D3_IPV6_PREFIX}1::1`; // the /64 2001:db8:d3:1::/64
let netSeq = 0;
const newNet = () => { if (netSeq >= MAX_NETWORKS) throw new Error("raise MAX_NETWORKS"); return ALL_NETWORKS[netSeq++]; };
const netId = (ip) => normalizeClientIp(ip);
const OWN_NETWORKS = [...ALL_NETWORKS, V6_NETWORK];

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
async function makeUser(label) {
  const email = emailOf(label);
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `D3 ${label}`, timezone: "America/New_York" });
  const { error: e } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: data.user.id, role: "clinician" });
  if (e) throw e;
  return { id: data.user.id, email };
}
async function teardown() {
  await admin.from("organization_members").delete().in("user_id", createdUsers);
  const leftovers = [];
  for (const id of createdUsers) {
    await admin.from("profiles").delete().eq("id", id);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) leftovers.push(`${id}: ${error.message}`);
  }
  return leftovers;
}

// ---------------------------------------------------------------- browser
async function ctxFrom(browser, ip) {
  return browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "x-forwarded-for": ip } });
}
// Returns "signed_in" or the /login?error= code.
async function login(browser, ip, email, password) {
  const ctx = await ctxFrom(browser, ip);
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname !== "/login" || u.searchParams.has("error"), { timeout: 60000 });
    const url = new URL(page.url());
    return url.pathname === "/login" ? url.searchParams.get("error") : "signed_in";
  } finally {
    await ctx.close();
  }
}
async function requestReset(browser, ip, email) {
  const ctx = await ctxFrom(browser, ip);
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login/forgot`);
    await page.fill("#email", email);
    await page.locator("form").first().evaluate((f) => { f.noValidate = true; });
    await page.getByTestId("request-recovery").click();
    await page.getByTestId("recovery-requested").waitFor({ timeout: 60000 });
    return page.url().replace(BASE, "");
  } finally {
    await ctx.close();
  }
}
function logEvents(event) {
  if (!SERVER_LOG) return null;
  return readFileSync(SERVER_LOG, "utf8").split("\n").filter((l) => l.includes(`"tenotrainer.auth.${event}"`)).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
}

async function main() {
  section("0. setup (development fixtures)");
  const a = await makeUser("alpha");
  const b = await makeUser("bravo");
  const c = await makeUser("charlie");
  check("fixtures created (3 accounts, @example.invalid)", !!a.id && !!b.id && !!c.id);
  const cleared = await clearSuiteCounters({ secret: SECRET, networks: OWN_NETWORKS });
  console.log(`      leftover counters of this suite's networks cleared: ${cleared}`);

  const browser = await chromium.launch();
  try {
    section("1. successful login and counting");
    const n1 = newNet();
    check("correct password → signed in", (await login(browser, n1, a.email, PASSWORD)) === "signed_in");
    check("the server and this suite derive the same bucket keys (login_ip hits = 1)", bucket("login_ip", netId(n1))?.hits === 1, JSON.stringify(bucket("login_ip", netId(n1))));
    check("a successful login leaves no account counter", bucket("login_account", a.email) === null);
    check("wrong password → invalid_credentials", (await login(browser, n1, a.email, "wrong-password-1")) === "invalid_credentials");
    check("the wrong password was counted (login_account hits = 1)", bucket("login_account", a.email)?.hits === 1);

    section("2. account lockout (across networks)");
    const lockNets = [newNet(), newNet(), newNet(), newNet()];
    const fourMore = [];
    for (const ip of lockNets) fourMore.push(await login(browser, ip, a.email, "wrong-password-2"));
    check("attempts 2–5 from four other networks → invalid_credentials", fourMore.every((x) => x === "invalid_credentials"), fourMore.join(","));
    const locked = bucket("login_account", a.email);
    check("account counter at the limit (5)", locked?.hits === 5, JSON.stringify(locked));
    check("6th attempt — the CORRECT password, from a fresh network → rate_limited", (await login(browser, newNet(), a.email, PASSWORD)) === "rate_limited");
    check("7th attempt (wrong) → rate_limited", (await login(browser, newNet(), a.email, "wrong-password-3")) === "rate_limited");
    const still = bucket("login_account", a.email);
    check("refused attempts did not extend the lockout (hits and window unchanged)", still?.hits === 5 && still?.window_start === locked?.window_start, JSON.stringify(still));

    section("3. recovery during the lockout; completed recovery clears the counter");
    const rNet = newNet();
    check("reset request for the locked account → the generic confirmation", (await requestReset(browser, rNet, a.email)) === "/login/forgot?sent=1");
    check("the reset request had its own counter (reset_account hits = 1)", bucket("reset_account", a.email)?.hits === 1);
    {
      const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: a.email });
      if (error) throw error;
      const ctx = await ctxFrom(browser, rNet);
      const page = await ctx.newPage();
      await page.goto(`${BASE}/auth/confirm?token_hash=${data.properties.hashed_token}&type=recovery`);
      await page.getByTestId("confirm-recovery").click();
      await page.waitForURL((u) => u.pathname === "/account/password" || u.searchParams.has("error"), { timeout: 60000 });
      check("recovery link verifies while the login is locked", new URL(page.url()).pathname === "/account/password", page.url());
      check("verification was counted per network (verify_ip hits = 1)", bucket("verify_ip", netId(rNet))?.hits === 1);
      await page.fill("#password", NEW_PASSWORD);
      await page.fill("#confirm_password", NEW_PASSWORD);
      await page.getByTestId("save-password").click();
      await page.waitForURL((u) => u.searchParams.has("error") || u.searchParams.has("updated"), { timeout: 60000 });
      check("new password saved", new URL(page.url()).searchParams.has("updated"), page.url());
      check("password change counted per user (password_user hits = 1)", bucket("password_user", a.id)?.hits === 1);
      await ctx.close();
    }
    check("completed recovery cleared the account login counter", bucket("login_account", a.email) === null);
    check("network counters are not cleared (login_ip of a lockout network still 1)", bucket("login_ip", netId(lockNets[0]))?.hits === 1);
    check("login with the new password → signed in", (await login(browser, newNet(), a.email, NEW_PASSWORD)) === "signed_in");

    section("4. unknown accounts behave identically");
    const ghost = emailOf("nobody");
    const ghostResults = [];
    for (let i = 0; i < 5; i++) ghostResults.push(await login(browser, newNet(), ghost, "whatever-password"));
    check("unknown account: 5 attempts → invalid_credentials (same code as a wrong password)", ghostResults.every((x) => x === "invalid_credentials"), ghostResults.join(","));
    check("unknown account counted like a real one (hits = 5)", bucket("login_account", ghost)?.hits === 5);
    check("unknown account: 6th → rate_limited (same as a real account)", (await login(browser, newNet(), ghost, "whatever-password")) === "rate_limited");

    section("5. network lockout (30 per network, many accounts)");
    const flood = newNet();
    const floodResults = [];
    for (let batch = 0; batch < 5; batch++) {
      floodResults.push(...await Promise.all(Array.from({ length: 6 }, (_, i) => login(browser, flood, emailOf(`spray-${batch}-${i}`), "spray-password"))));
    }
    check("30 attempts on 30 accounts from one network → all invalid_credentials", floodResults.length === 30 && floodResults.every((x) => x === "invalid_credentials"), floodResults.join(","));
    check("network counter at the limit (30)", bucket("login_ip", netId(flood))?.hits === 30);
    check("31st — a real account with the correct password, same network → rate_limited", (await login(browser, flood, b.email, PASSWORD)) === "rate_limited");
    check("…and that refused attempt did not count against the account (0 hits)", (bucket("login_account", b.email)?.hits ?? 0) === 0);
    check("the same account from another network → signed in", (await login(browser, newNet(), b.email, PASSWORD)) === "signed_in");
    {
      await login(browser, V6_NETWORK, emailOf("v6-1"), "v6-password");
      await login(browser, `${D3_IPV6_PREFIX}1:0:ab:cd:ef`, emailOf("v6-2"), "v6-password");
      check("IPv6: two addresses in one /64 share one network counter (hits = 2)", bucket("login_ip", netId(V6_NETWORK))?.hits === 2, netId(V6_NETWORK));
    }

    section("6. concurrent attempts");
    {
      const results = await Promise.all(Array.from({ length: 12 }, () => login(browser, newNet(), c.email, "parallel-wrong")));
      const counts = results.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
      check("12 simultaneous wrong attempts on one account → exactly 5 checked, 7 rate_limited", counts.invalid_credentials === 5 && counts.rate_limited === 7, JSON.stringify(counts));
      check("account counter exactly 5 (no overshoot)", bucket("login_account", c.email)?.hits === 5);
    }

    section("7. password-reset flooding");
    {
      const resetEvents = () => logEvents("recovery_request")?.length ?? 0;
      const e0 = resetEvents();
      const n = newNet();
      const urls = [];
      for (let i = 0; i < 5; i++) urls.push(await requestReset(browser, n, b.email));
      check("5 reset requests for one address → identical generic response each time", urls.every((u) => u === "/login/forgot?sent=1"), urls.join(","));
      check("per-address counter stops at 3 (refusals do not increment)", bucket("reset_account", b.email)?.hits === 3);
      if (SERVER_LOG) {
        const ev = logEvents("recovery_request").slice(e0).map((x) => x.outcome);
        check("server outcomes: 3 passed the limiter (suppressed in development), 2 limited", ev.filter((x) => x === "suppressed").length === 3 && ev.filter((x) => x === "limited").length === 2, ev.join(","));
      }
      const m = newNet();
      const e1 = resetEvents();
      const many = [];
      for (let i = 0; i < 11; i++) many.push(await requestReset(browser, m, emailOf(`reset-${i}`)));
      check("11 reset requests for 11 addresses from one network → identical response", many.every((u) => u === "/login/forgot?sent=1"));
      check("per-network counter stops at 10", bucket("reset_ip", netId(m))?.hits === 10);
      check("the 11th address was not counted (refused: 0 hits)", (bucket("reset_account", emailOf("reset-10"))?.hits ?? 0) === 0);
      if (SERVER_LOG) {
        const ev = logEvents("recovery_request").slice(e1).map((x) => x.outcome);
        check("server outcomes: 10 passed, the 11th limited", ev.filter((x) => x === "limited").length === 1 && ev.length === 11, ev.join(","));
      }
    }
  } finally {
    await browser.close();
  }

  section("8. window expiry (real database function, 2-second window)");
  {
    const realReserve = async (keys, limits, windowSeconds) => {
      for (const k of keys) touched.add(k);
      const { data, error } = await admin.rpc("auth_rate_limit_reserve", { p_keys: keys, p_limits: limits, p_window_seconds: windowSeconds });
      if (error) throw new Error(error.message);
      return { allowed: data.allowed, retryAfterS: data.retry_after_s };
    };
    const limiter = createAuthRateLimiter({ key: KEY, failClosed: true, rules: { login_account: { limit: 2, windowSeconds: 2 } }, reserve: realReserve, clear: async () => {} });
    const id = `expiry-${RUN}`;
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await limiter.reserve([{ scope: "login_account", id }]));
    check("2 allowed, the 3rd limited with a retry hint", r[0].allowed && r[1].allowed && r[2].reason === "limited" && r[2].retryAfterS >= 1, JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 2500));
    const after = await limiter.reserve([{ scope: "login_account", id }]);
    check("after the window elapses → allowed again, counter restarted at 1", after.allowed === true && bucket("login_account", id)?.hits === 1, JSON.stringify(after));
  }

  section("9. database error handling and privileges");
  {
    const k = key("verify_ip", `privilege-${RUN}`);
    const asAnon = await anonClient().rpc("auth_rate_limit_reserve", { p_keys: [k], p_limits: [5], p_window_seconds: [60] });
    check("anon cannot execute auth_rate_limit_reserve (Data API refuses)", !!asAnon.error && asAnon.data === null, JSON.stringify(asAnon.error));
    const clr = await anonClient().rpc("auth_rate_limit_clear", { p_keys: [k] });
    check("anon cannot execute auth_rate_limit_clear", !!clr.error, JSON.stringify(clr.error));
    const signedIn = anonClient();
    const { error: sErr } = await signedIn.auth.signInWithPassword({ email: c.email, password: PASSWORD });
    if (sErr) throw sErr;
    const asUser = await signedIn.rpc("auth_rate_limit_clear", { p_keys: [key("login_account", c.email)] });
    check("an authenticated user cannot clear their own lockout", !!asUser.error && bucket("login_account", c.email)?.hits === 5, JSON.stringify(asUser.error));
    const asUserR = await signedIn.rpc("auth_rate_limit_reserve", { p_keys: [k], p_limits: [5], p_window_seconds: [60] });
    check("an authenticated user cannot execute auth_rate_limit_reserve", !!asUserR.error);
    await signedIn.auth.signOut();
    const bad = await admin.rpc("auth_rate_limit_reserve", { p_keys: ["not-a-hex-key"], p_limits: [5], p_window_seconds: [60] });
    check("service_role: invalid arguments → AUTH_RATE_LIMIT_INVALID_ARGUMENTS", (bad.error?.message ?? "").includes("AUTH_RATE_LIMIT_INVALID_ARGUMENTS"), JSON.stringify(bad.error));
    const rows = sqlRows(`SELECT count(*)::int AS n FROM private.auth_rate_limit_buckets WHERE bucket_key = '${k}';`)[0].n;
    check("refused calls stored nothing", rows === 0);

    // The limiter with the real database failing in each way.
    const via = (client, fn) => async (keys, limits, windowSeconds) => {
      const { data, error } = await client.rpc(fn, { p_keys: keys, p_limits: limits, p_window_seconds: windowSeconds });
      if (error || typeof data?.allowed !== "boolean") throw new Error("auth_rate_limit_reserve failed");
      return { allowed: data.allowed, retryAfterS: data.retry_after_s };
    };
    const cases = [
      ["RPC error (permission denied)", via(anonClient(), "auth_rate_limit_reserve")],
      ["RPC missing", via(admin, "auth_rate_limit_reserve_missing")],
      ["database unreachable", via(createClient("http://127.0.0.1:9", "placeholder-not-a-key", { auth: { persistSession: false } }), "auth_rate_limit_reserve")],
    ];
    for (const [label, reserve] of cases) {
      const closed = await createAuthRateLimiter({ key: KEY, failClosed: true, reserve, clear: async () => {} }).reserve([{ scope: "login_account", id: `err-${RUN}` }]);
      const open = await createAuthRateLimiter({ key: KEY, failClosed: false, reserve, clear: async () => {} }).reserve([{ scope: "login_account", id: `err-${RUN}` }]);
      check(`${label}: fail-closed policy → refused (unavailable); fail-open policy → allowed (degraded)`, closed.reason === "unavailable" && open.allowed === true && open.degraded === true, JSON.stringify({ closed, open }));
    }
  }

  if (SERVER_LOG) {
    section("10. server logs carry no identifiers");
    const log = readFileSync(SERVER_LOG, "utf8");
    const authLines = log.split("\n").filter((l) => l.includes("tenotrainer.auth."));
    check("auth log events were written", authLines.length > 0, authLines.length);
    const leaks = [RUN, D3_IPV4_NETWORK, "2001:db8", "@example.invalid", a.id, b.id, c.id].filter((s) => authLines.some((l) => l.includes(s)));
    check("no email, user id, IP address or bucket key in auth log events", leaks.length === 0 && !authLines.some((l) => /[0-9a-f]{64}/.test(l)), leaks.join(","));
  }
}

async function clearTouched() {
  const keys = [...touched];
  for (let i = 0; i < keys.length; i += 8) {
    const { error } = await admin.rpc("auth_rate_limit_clear", { p_keys: keys.slice(i, i + 8) });
    if (error) throw new Error(error.message);
  }
  // Every key the server may have created for this run: also the ones the
  // suite never read back (spray accounts, reset addresses, lockout networks).
  return sqlRows(`SELECT count(*)::int AS n FROM private.auth_rate_limit_buckets WHERE bucket_key IN (${keys.map((k) => `'${k}'`).join(",")});`)[0].n;
}

try {
  await main();
} catch (e) {
  check("suite completed", false, e.stack ?? e.message);
} finally {
  // The keys of everything the run may have touched (also those it never
  // read back: spray accounts, reset addresses, every network it used).
  for (const ip of OWN_NETWORKS) for (const scope of ["login_ip", "reset_ip", "verify_ip"]) key(scope, netId(ip));
  for (let batch = 0; batch < 5; batch++) for (let i = 0; i < 6; i++) key("login_account", emailOf(`spray-${batch}-${i}`));
  for (let i = 0; i < 11; i++) key("reset_account", emailOf(`reset-${i}`));
  for (const label of ["alpha", "bravo", "charlie", "nobody", "v6-1", "v6-2"]) { key("login_account", emailOf(label)); key("reset_account", emailOf(label)); }
  for (const id of createdUsers) key("password_user", id);
  const remainingBuckets = await clearTouched();
  check("teardown: every bucket this run created is deleted", remainingBuckets === 0, remainingBuckets);
  const leftovers = await teardown();
  check("teardown: every fixture account deleted", leftovers.length === 0, leftovers.join("; "));
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
