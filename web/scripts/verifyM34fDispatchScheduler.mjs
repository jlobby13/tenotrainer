// M3.4f — the production safety-dispatch scheduler migration (65) on a
// scratch cluster (scripts/lib/scratchPostgres.mjs; never dev or production;
// the development project is only read for the platform stand-in shape).
// pg_net, pg_cron and Vault are TEST DOUBLES: pg_net records requests and
// never sends, so nothing here touches the network. Real pg_net / Vault
// behaviour is Stage B.
//
//   1. Build the 64-migration state, snapshot, apply migration 65: the public
//      application catalog is unchanged, the sweep job is unchanged, and no
//      request was queued by applying it.
//   2. Objects and privileges: pg_net, schema private, the wrapper
//      (SECURITY DEFINER, empty search_path), EXECUTE / USAGE for nobody but
//      its owner; the API roles cannot call the wrapper. pg_net's own grants
//      are the platform's (the double mirrors those measured on development
//      in Stage B) and the migration does not try to revoke them.
//   3. The cron job: every minute, INACTIVE, the bare wrapper call.
//   4. Wrapper behaviour, each in a rolled-back transaction: not configured
//      → no request; partial / duplicate / malformed / wrong-URL
//      configuration → value-free error and no request; valid → exactly one
//      POST to the pinned URL with exactly the three headers and a 30 s
//      timeout; a pg_net failure is masked; nothing returned or raised
//      contains a configured value.
//   5. Static: the migration text carries no credential-shaped value and no
//      Origin / Sec-Fetch / bypass-cookie header.
//
// The configured values below are inert placeholders, not credentials.
//
// Requires TENOTRAINER_PG_TOOLING (scripts/lib/scratchPostgres.mjs).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM34fDispatchScheduler.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/m32Fixtures.mjs";
import { SCRATCH_DB, ScratchPostgres } from "./lib/scratchPostgres.mjs";
import { applyMigrations, installPlatformStandIn, migrationFiles, MIGRATIONS_DIR, readPlatformShape } from "./lib/freshDatabase.mjs";
import { CATALOG_SQL, diffCatalogs, stable } from "./lib/schemaCatalog.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const M65 = "20261107000001_m34f_safety_dispatch_scheduler.sql";
const DISPATCH_URL = "https://tenotrainer.vercel.app/api/internal/safety-notifications/dispatch";
const N_URL = "tenotrainer_production_dispatch_url";
const N_SECRET = "tenotrainer_production_dispatch_secret";
const N_BYPASS = "tenotrainer_production_dispatch_vercel_bypass";
const SECRET = "TEST-PLACEHOLDER-dispatch-value-not-a-credential";
const BYPASS = "TEST-PLACEHOLDER-bypass-value-not-a-credential";
const WRAPPER = "private.safety_dispatch_tick()";
const API_ROLES = ["anon", "authenticated", "service_role"];

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 600)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const leaks = (text) => [SECRET, BYPASS, DISPATCH_URL].some((v) => String(text ?? "").includes(v));

const sp = new ScratchPostgres();
try {
  const files = migrationFiles();
  section("1. migration 65 on the 64-migration state");
  check("migration 65 (filename order, last) is the M3.4f dispatch scheduler", files.indexOf(M65) === 64 && files.at(-1) === M65, `${files.indexOf(M65)} ${files.at(-1)}`);
  const db = await sp.start();
  const standIn = await installPlatformStandIn(db, readPlatformShape(env), SCRATCH_DB);
  console.log(`      stand-in: ${standIn.columns} auth.users columns; pg_net / pg_cron / Vault are test doubles (not platform evidence)`);
  const r64 = await applyMigrations(db, files.slice(0, 64));
  check("the first 64 migrations apply in filename order", !r64.failed && r64.applied === 64, JSON.stringify(r64.failed));
  const cat64 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const sweep64 = (await db.query("SELECT schedule, command, active FROM cron.job WHERE jobname = 'tenotrainer_m32_safety_notification_sweep'")).rows[0];
  const r65 = await applyMigrations(db, [M65]);
  check("migration 65 applies on top (one transaction)", !r65.failed && r65.applied === 1, JSON.stringify(r65.failed));
  const cat65 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const d = diffCatalogs(cat64, cat65);
  const onlyNewJob = d.total === 1 && stable(d.categories.cron_jobs) === stable({ missing: [], unexpected: ["tenotrainer_m34f_safety_dispatch"], changed: [] });
  check("application catalog unchanged except the one new cron job (tables, functions, grants, policies, triggers)", onlyNewJob, JSON.stringify(d.categories).slice(0, 600));
  const sweep65 = (await db.query("SELECT schedule, command, active FROM cron.job WHERE jobname = 'tenotrainer_m32_safety_notification_sweep'")).rows[0];
  check("the M3.2 sweep job is unchanged (every minute, SQL only, active)", stable(sweep64) === stable(sweep65) && sweep65.active === true, JSON.stringify(sweep65));
  const queued = async () => Number((await db.query("SELECT count(*) AS n FROM net.http_request_queue")).rows[0].n);
  check("applying the migration queued no request", (await queued()) === 0);

  section("2. objects and privileges");
  const ext = (await db.query("SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_net'")).rows[0];
  check("pg_net enabled WITH SCHEMA extensions (objects in schema net)", ext?.nspname === "extensions", JSON.stringify(ext));
  const fn = (await db.query(`SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
      pg_get_function_result(p.oid) AS result, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p WHERE p.oid = $1::regprocedure`, [WRAPPER])).rows[0];
  const me = (await db.query("SELECT current_user AS u")).rows[0].u;
  check("wrapper: SECURITY DEFINER, search_path = '', no arguments, returns jsonb", fn?.prosecdef === true && stable(fn?.proconfig) === stable(['search_path=""']) && fn?.args === "" && fn?.result === "jsonb", JSON.stringify(fn));
  check("wrapper: owned by the migration owner; ACL grants EXECUTE to its owner only", fn?.owner === me && fn?.acl === `{${me}=X/${me}}`, `${fn?.owner} ${fn?.acl}`);
  for (const role of API_ROLES) {
    const p = (await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS fx, has_schema_privilege($1, 'private', 'USAGE') AS su`, [role, WRAPPER])).rows[0];
    check(`${role}: no EXECUTE on the wrapper, no USAGE on private`, !p.fx && !p.su, JSON.stringify(p));
  }
  const privAcl = (await db.query("SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'private'")).rows[0].acl;
  check("schema private: no PUBLIC or API-role grant", !/(^|[{,])=|anon|authenticated|service_role/.test(privAcl ?? ""), privAcl);
  for (const role of API_ROLES) {
    await db.query("BEGIN");
    let err = null;
    try {
      await db.query(`SET LOCAL ROLE ${role}`);
      await db.query(`SELECT ${WRAPPER}`);
    } catch (e) { err = e; }
    await db.query("ROLLBACK");
    check(`${role} calling the wrapper is refused (42501)`, err?.code === "42501", err?.code ?? "no error");
  }
  const netAcl = (await db.query("SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'net'")).rows[0].acl;
  check("schema net keeps the platform's grants (the migration revokes nothing there)", /(^|[{,])=U\//.test(netAcl ?? "") && API_ROLES.every((r) => netAcl.includes(`${r}=U/`)), netAcl);

  section("3. the dispatch cron job");
  const job = (await db.query("SELECT schedule, command, active, username FROM cron.job WHERE jobname = 'tenotrainer_m34f_safety_dispatch'")).rows;
  check("job tenotrainer_m34f_safety_dispatch exists exactly once, every minute", job.length === 1 && job[0].schedule === "* * * * *", JSON.stringify(job));
  check("job is INACTIVE", job[0]?.active === false, JSON.stringify(job[0]));
  check("job command is exactly the bare wrapper call", job[0]?.command === "SELECT private.safety_dispatch_tick()", job[0]?.command);
  check("job command carries no URL, header, credential or Vault reference", !/https?:|vercel|bearer|authorization|vault|bypass|secret/i.test(job[0]?.command ?? ""), job[0]?.command);

  section("4. wrapper behaviour (each case rolled back)");
  // Runs `setup` then the wrapper inside one transaction; always rolls back.
  const tick = async (setup = []) => {
    await db.query("BEGIN");
    try {
      for (const [sql, params] of setup) await db.query(sql, params ?? []);
      const before = await queued();
      await db.query("SAVEPOINT tick");
      try {
        const r = (await db.query(`SELECT ${WRAPPER} AS r`)).rows[0].r;
        const rows = (await db.query("SELECT * FROM net.http_request_queue ORDER BY id")).rows;
        return { result: r, added: (await queued()) - before, rows };
      } catch (e) {
        await db.query("ROLLBACK TO SAVEPOINT tick");
        return { error: e, added: (await queued()) - before };
      }
    } finally {
      await db.query("ROLLBACK");
    }
  };
  const put = (name, value) => ["INSERT INTO vault.secrets (name, secret) VALUES ($1, $2)", [name, value]];
  const full = (url = DISPATCH_URL, secret = SECRET, bypass = BYPASS) => [put(N_URL, url), put(N_SECRET, secret), put(N_BYPASS, bypass)];
  const errCode = (t) => t.error?.message;
  const clean = (t) => !leaks(t.error?.message) && !leaks(t.error?.detail) && !leaks(t.error?.hint) && !leaks(t.error?.where) && !leaks(JSON.stringify(t.result ?? null));

  let t = await tick();
  check("no Vault entries → {status: not_configured}, no request", stable(t.result) === stable({ status: "not_configured" }) && t.added === 0, JSON.stringify(t.result ?? errCode(t)));
  t = await tick([["DROP VIEW vault.decrypted_secrets"]]);
  check("Vault unavailable → not_configured, no request", t.result?.status === "not_configured" && t.added === 0, JSON.stringify(t.result ?? errCode(t)));
  t = await tick([put(N_URL, DISPATCH_URL)]);
  check("partial configuration (URL only) → SAFETY_DISPATCH_TICK_PARTIAL_CONFIGURATION, no request", errCode(t) === "SAFETY_DISPATCH_TICK_PARTIAL_CONFIGURATION" && t.added === 0 && clean(t), errCode(t));
  t = await tick([put(N_URL, DISPATCH_URL), put(N_SECRET, SECRET)]);
  check("partial configuration (no bypass) → PARTIAL_CONFIGURATION, no request", errCode(t) === "SAFETY_DISPATCH_TICK_PARTIAL_CONFIGURATION" && t.added === 0 && clean(t), errCode(t));
  t = await tick([...full(), put(N_SECRET, SECRET)]);
  check("duplicate entry name → SAFETY_DISPATCH_TICK_DUPLICATE_CONFIGURATION (never picks one), no request", errCode(t) === "SAFETY_DISPATCH_TICK_DUPLICATE_CONFIGURATION" && t.added === 0 && clean(t), errCode(t));

  const badUrls = [
    ["plain http", DISPATCH_URL.replace("https:", "http:")],
    ["another host", "https://evil.example/api/internal/safety-notifications/dispatch"],
    ["the Preview alias", "https://tenotrainer-git-m6-stage-3-longitudinal-int-09d582-teno-trainer.vercel.app/api/internal/safety-notifications/dispatch"],
    ["a per-deployment host", "https://tenotrainer-q70ila1g3-teno-trainer.vercel.app/api/internal/safety-notifications/dispatch"],
    ["another path", "https://tenotrainer.vercel.app/api/ready"],
    ["a longer path", `${DISPATCH_URL}/x`],
    ["a trailing slash", `${DISPATCH_URL}/`],
    ["a query string", `${DISPATCH_URL}?scope=all`],
    ["a fragment", `${DISPATCH_URL}#x`],
    ["an explicit port", "https://tenotrainer.vercel.app:443/api/internal/safety-notifications/dispatch"],
    ["userinfo", "https://user@tenotrainer.vercel.app/api/internal/safety-notifications/dispatch"],
    ["uppercase host", "https://TENOTRAINER.vercel.app/api/internal/safety-notifications/dispatch"],
    ["surrounding whitespace", ` ${DISPATCH_URL} `],
    ["empty", ""],
  ];
  for (const [label, url] of badUrls) {
    t = await tick(full(url));
    check(`URL ${label} → SAFETY_DISPATCH_TICK_URL_NOT_ALLOWED, no request`, errCode(t) === "SAFETY_DISPATCH_TICK_URL_NOT_ALLOWED" && t.added === 0 && clean(t), errCode(t));
  }
  const badSecrets = [
    ["31 characters", SECRET.slice(0, 31)],
    ["a space", `${SECRET} x`],
    ["CR/LF (header injection)", `${SECRET}\r\nx-injected: 1`],
    ["empty", ""],
  ];
  for (const [label, value] of badSecrets) {
    t = await tick(full(DISPATCH_URL, value));
    check(`dispatch secret with ${label} → SAFETY_DISPATCH_TICK_DISPATCH_SECRET_MALFORMED, no request`, errCode(t) === "SAFETY_DISPATCH_TICK_DISPATCH_SECRET_MALFORMED" && t.added === 0 && clean(t), errCode(t));
  }
  const badBypass = [
    ["15 characters", BYPASS.slice(0, 15)],
    ["LF (header injection)", `${BYPASS}\nx-injected: 1`],
    ["a tab", `${BYPASS}\tx`],
  ];
  for (const [label, value] of badBypass) {
    t = await tick(full(DISPATCH_URL, SECRET, value));
    check(`bypass with ${label} → SAFETY_DISPATCH_TICK_BYPASS_MALFORMED, no request`, errCode(t) === "SAFETY_DISPATCH_TICK_BYPASS_MALFORMED" && t.added === 0 && clean(t), errCode(t));
  }

  t = await tick(full());
  const req = t.rows?.[0];
  check("valid configuration → {status: enqueued, request_id} and exactly one request", t.result?.status === "enqueued" && Number.isInteger(Number(t.result?.request_id)) && Object.keys(t.result ?? {}).sort().join() === "request_id,status" && t.added === 1, JSON.stringify(t.result ?? errCode(t)));
  check("request: POST to exactly the pinned canonical dispatch URL", req?.method === "POST" && req?.url === DISPATCH_URL, `${req?.method} ${req?.url}`);
  check("request: 30 s timeout", req?.timeout_milliseconds === 30000, req?.timeout_milliseconds);
  check("request: body is the minimal {}", req && Buffer.from(req.body).toString("utf8") === "{}", req && Buffer.from(req.body).toString("utf8"));
  const h = req?.headers ?? {};
  check("request headers are exactly Content-Type, Authorization, x-vercel-protection-bypass", Object.keys(h).sort().join() === "Authorization,Content-Type,x-vercel-protection-bypass", Object.keys(h).join());
  check("headers: Bearer dispatch secret, bypass, JSON content type (values from Vault, unaltered)", h.Authorization === `Bearer ${SECRET}` && h["x-vercel-protection-bypass"] === BYPASS && h["Content-Type"] === "application/json");
  check("headers: no Origin, Sec-Fetch-Site, cookie or bypass-cookie request", !Object.keys(h).some((k) => /origin|sec-fetch|cookie|set-bypass/i.test(k)), Object.keys(h).join());
  check("return value carries no URL, secret or bypass", clean(t), JSON.stringify(t.result));
  t = await tick([...full(), ["SET LOCAL tenotrainer_test.pg_net_fail = 'on'"]]);
  check("a pg_net failure (whose text echoes the request) → SAFETY_DISPATCH_TICK_ENQUEUE_FAILED with a value-free detail, no request", errCode(t) === "SAFETY_DISPATCH_TICK_ENQUEUE_FAILED" && /^sqlstate=[0-9A-Z]{5}$/.test(t.error?.detail ?? "") && t.added === 0 && clean(t), `${errCode(t)} ${t.error?.detail}`);
  check("after every case: the queue is still empty (all rolled back)", (await queued()) === 0);

  section("5. static");
  const sql = readFileSync(join(MIGRATIONS_DIR, M65), "utf8");
  check("migration text holds no credential-shaped value", !/sb_secret_|sb_publishable_|sbp_|\bre_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9]/.test(sql));
  check("migration text adds no Origin / Sec-Fetch / bypass-cookie header and no redirect option", !/'origin'|sec-fetch|set-bypass-cookie|(follow|redirect)[a-z_]*\s*:=/i.test(sql));
  check("migration attempts no REVOKE / GRANT on pg_net's objects (a no-op for the migration owner on Supabase)", !/^\s*(REVOKE|GRANT)\b[^;]*\bIN SCHEMA net\b|^\s*(REVOKE|GRANT)\b[^;]*\bSCHEMA net\b|^\s*(REVOKE|GRANT)\b[^;]*\bnet\./im.test(sql));
  check("the only URL in the migration is the pinned dispatch endpoint", stable([...new Set(sql.match(/https?:\/\/[^\s'"]+/g))]) === stable([DISPATCH_URL]), sql.match(/https?:\/\/[^\s'"]+/g)?.join(" "));
} catch (e) {
  check("suite completed", false, e.stack ?? e.message);
} finally {
  await sp.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
