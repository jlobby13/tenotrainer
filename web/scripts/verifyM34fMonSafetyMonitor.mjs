// M3.4f-MON — the automated safety-dispatch monitor (migration 66) on a
// scratch cluster (scripts/lib/scratchPostgres.mjs; never dev or production;
// the development project is only read for the platform stand-in shape).
// pg_net, pg_cron and Vault are TEST DOUBLES: pg_net records requests and
// never sends, so nothing here touches the network; cron history, pg_net
// responses, heartbeats and alerts are synthetic rows inside rolled-back
// transactions. The pg_net worker probe is substituted per case.
//
//   1. Build the 65-migration state, apply 66: the public application catalog
//      is unchanged except the one new (inactive) cron job; no request.
//   2. Objects and privileges: owner-only functions and tables in `private`.
//   3. The monitor job: every five minutes, INACTIVE, the bare tick call.
//   4. Evaluator rules: pre-activation (no false alerts), activation grace,
//      every failure condition and its threshold edge, the monitor's own
//      check-ins excluded from dispatch classification, no-PHI payload shape.
//   5. Check-in tick: not configured (fail closed), URL pinning, duplicate,
//      pg_net failure, evaluator failure, exact request shape, /fail routing,
//      deduplication and recovery transitions, nothing leaks the URL.
//   6. Static: the migration text.
//
// The configured check-in URL below is an inert placeholder, not a credential.
//
// Requires TENOTRAINER_PG_TOOLING (scripts/lib/scratchPostgres.mjs).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM34fMonSafetyMonitor.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/m32Fixtures.mjs";
import { SCRATCH_DB, ScratchPostgres } from "./lib/scratchPostgres.mjs";
import { applyMigrations, installPlatformStandIn, migrationFiles, MIGRATIONS_DIR, readPlatformShape } from "./lib/freshDatabase.mjs";
import { CATALOG_SQL, diffCatalogs, stable } from "./lib/schemaCatalog.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const M66 = "20261108000001_m34f_mon_safety_monitor.sql";
const N_PING = "tenotrainer_production_monitor_ping_url";
const PING = "https://hc-ping.com/0000000a-000b-400c-800d-00000000000e"; // placeholder check id, not a credential
const API_ROLES = ["anon", "authenticated", "service_role"];
const FUNCS = ["private.safety_monitor_evaluate()", "private.safety_monitor_tick()", "private.safety_monitor_set_dispatch_expected(boolean)", "private.safety_monitor_pg_net_worker_up()"];
const TABLES = ["private.safety_monitor_settings", "private.safety_monitor_state", "private.safety_monitor_requests"];
const PHI_PROBE = "outbox:5d2f6c1e-1111-4222-8333-944455556666"; // an alert subject key that must never reach a payload
const OK_BODY = JSON.stringify({ result: "dispatched", claimed: 0, accepted: 0, retry_scheduled: 0, failed_permanent: 0, stale: 0, record_failed: 0, batches: 1, duration_ms: 12 });

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 600)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

const sp = new ScratchPostgres();
try {
  const files = migrationFiles();
  section("1. migration 66 on the 65-migration state");
  check("migration 66 (filename order, last) is the M3.4f-MON monitor", files.indexOf(M66) === 65 && files.at(-1) === M66, `${files.indexOf(M66)} ${files.at(-1)}`);
  const db = await sp.start();
  const standIn = await installPlatformStandIn(db, readPlatformShape(env), SCRATCH_DB);
  console.log(`      stand-in: ${standIn.columns} auth.users columns; pg_net / pg_cron / Vault are test doubles (not platform evidence)`);
  const r65 = await applyMigrations(db, files.slice(0, 65));
  check("the first 65 migrations apply in filename order", !r65.failed && r65.applied === 65, JSON.stringify(r65.failed));
  const cat65 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const jobs65 = (await db.query("SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobname")).rows;
  const r66 = await applyMigrations(db, [M66]);
  check("migration 66 applies on top (one transaction)", !r66.failed && r66.applied === 1, JSON.stringify(r66.failed));
  const cat66 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const d = diffCatalogs(cat65, cat66);
  check("application catalog unchanged except the one new cron job", d.total === 1 && stable(d.categories.cron_jobs) === stable({ missing: [], unexpected: ["tenotrainer_m34f_mon_safety_monitor"], changed: [] }), JSON.stringify(d.categories).slice(0, 600));
  const jobs66 = (await db.query("SELECT jobname, schedule, command, active FROM cron.job WHERE jobname <> 'tenotrainer_m34f_mon_safety_monitor' ORDER BY jobname")).rows;
  check("the sweep and dispatch jobs are unchanged (dispatch still inactive)", stable(jobs65) === stable(jobs66), JSON.stringify(jobs66));
  const queued = async () => Number((await db.query("SELECT count(*) AS n FROM net.http_request_queue")).rows[0].n);
  check("applying the migration queued no request", (await queued()) === 0);
  const st0 = (await db.query("SELECT s.dispatch_expected_active AS e, s.dispatch_expected_since AS since, m.last_status, m.transitions FROM private.safety_monitor_settings s, private.safety_monitor_state m")).rows[0];
  check("settings start pre-activation (dispatch not expected); state starts empty", st0.e === false && st0.since === null && st0.last_status === null && st0.transitions === 0, JSON.stringify(st0));

  section("2. objects and privileges");
  const me = (await db.query("SELECT current_user AS u")).rows[0].u;
  for (const f of FUNCS) {
    const p = (await db.query("SELECT prosecdef, proconfig, proacl::text AS acl, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = $1::regprocedure", [f])).rows[0];
    check(`${f}: SECURITY DEFINER, search_path = '', EXECUTE for its owner only`, p?.prosecdef === true && stable(p?.proconfig) === stable(['search_path=""']) && p?.acl === `{${me}=X/${me}}`, JSON.stringify(p));
  }
  for (const t of TABLES) {
    const p = (await db.query("SELECT relrowsecurity AS rls, relacl::text AS acl FROM pg_class WHERE oid = $1::regclass", [t])).rows[0];
    check(`${t}: RLS on, no grant beyond its owner`, p?.rls === true && (p.acl === null || p.acl === `{${me}=arwdDxtm/${me}}`), JSON.stringify(p));
  }
  for (const role of API_ROLES) {
    const bad = [];
    for (const f of FUNCS) if ((await db.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS x", [role, f])).rows[0].x) bad.push(f);
    for (const t of TABLES) if ((await db.query("SELECT has_table_privilege($1, $2, 'SELECT') AS x", [role, t])).rows[0].x) bad.push(t);
    check(`${role}: no EXECUTE on any monitor function, no SELECT on any monitor table`, bad.length === 0, bad.join(","));
    await db.query("BEGIN");
    let err = null;
    try { await db.query(`SET LOCAL ROLE ${role}`); await db.query("SELECT private.safety_monitor_tick()"); } catch (e) { err = e; }
    await db.query("ROLLBACK");
    check(`${role} calling the tick is refused (42501)`, err?.code === "42501", err?.code ?? "no error");
  }

  section("3. the monitor job");
  const job = (await db.query("SELECT schedule, command, active FROM cron.job WHERE jobname = 'tenotrainer_m34f_mon_safety_monitor'")).rows;
  check("job exists once, every five minutes, INACTIVE, the bare tick call", job.length === 1 && job[0].schedule === "*/5 * * * *" && job[0].active === false && job[0].command === "SELECT private.safety_monitor_tick()", JSON.stringify(job));

  section("4. evaluator rules (each case rolled back)");
  const dispatchJobId = (await db.query("SELECT jobid FROM cron.job WHERE jobname = 'tenotrainer_m34f_safety_dispatch'")).rows[0].jobid;
  const sweepJobId = (await db.query("SELECT jobid FROM cron.job WHERE jobname = 'tenotrainer_m32_safety_notification_sweep'")).rows[0].jobid;
  let nextId = 1000;
  // Setup fragments.
  const workerUp = (up = true) => [`CREATE OR REPLACE FUNCTION private.safety_monitor_pg_net_worker_up() RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT ${up} $$`];
  const sweepAge = (sec) => [`UPDATE public.safety_notification_heartbeats SET last_succeeded_at = now() - make_interval(secs => ${sec}) WHERE component = 'sweep'`];
  const healthyBase = () => [workerUp(true), sweepAge(30)];
  const expected = (sinceSec = 3600) => [`UPDATE private.safety_monitor_settings SET dispatch_expected_active = true, dispatch_expected_since = now() - make_interval(secs => ${sinceSec})`];
  const dispatchActive = (on = true) => [`UPDATE cron.job SET active = ${on} WHERE jobid = ${dispatchJobId}`];
  const runs = (ages, status = "succeeded") => ages.map((a) => [`INSERT INTO cron.job_run_details (jobid, status, return_message, start_time, end_time) VALUES (${dispatchJobId}, '${status}', '1 row', now() - make_interval(secs => ${a}), now() - make_interval(secs => ${a - 1}))`]);
  const dispatchHb = (okAgeSec, failedAgeSec = null) => [`UPDATE public.safety_notification_heartbeats SET last_started_at = now() - make_interval(secs => ${okAgeSec}), last_succeeded_at = now() - make_interval(secs => ${okAgeSec}),
      last_failed_at = ${failedAgeSec === null ? "NULL" : `now() - make_interval(secs => ${failedAgeSec})`} WHERE component = 'dispatch'`];
  const resp = (n, { status = 200, type = "application/json", body = OK_BODY, timedOut = false, err = null, ageSec = 60, monitor = false } = {}) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const id = nextId++;
      out.push([`INSERT INTO net._http_response (id, status_code, content_type, headers, content, timed_out, error_msg, created) VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, $6, now() - make_interval(secs => $7))`,
        [id, status, type, body, timedOut, err, ageSec + i]]);
      if (monitor) out.push(["INSERT INTO private.safety_monitor_requests (request_id) VALUES ($1)", [id]]);
    }
    return out;
  };
  const minutes = (from, to) => Array.from({ length: to - from }, (_, i) => (from + i) * 60 + 30); // one run per minute
  const healthyActive = () => [...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 10)), dispatchHb(30), ...resp(10)];
  const evaluate = async (setup) => {
    await db.query("BEGIN");
    try {
      for (const [sql, params] of setup) await db.query(sql, params ?? []);
      return (await db.query("SELECT private.safety_monitor_evaluate() AS r")).rows[0].r;
    } finally {
      await db.query("ROLLBACK");
    }
  };
  const codes = (r) => r?.codes ?? [];
  const only = (r, list) => stable(codes(r)) === stable([...list].sort());

  let r = await evaluate([]);
  check("fresh database (sweep never ran, no pg_net worker) → fail: sweep_heartbeat_stale, pg_net_worker_down", r.status === "fail" && only(r, ["pg_net_worker_down", "sweep_heartbeat_stale"]), JSON.stringify(r.codes));
  r = await evaluate(healthyBase());
  check("pre-activation, healthy → status pre_activation, no codes", r.status === "pre_activation" && only(r, []), JSON.stringify(r));
  r = await evaluate([...healthyBase(), dispatchHb(5 * 3600), ...resp(3, { status: 401, body: '{"error":"UNAUTHORIZED"}' }), ...resp(3, { type: "text/html", body: "<html></html>" }), ...resp(4, { timedOut: true, status: null, type: null, body: null })]);
  check("pre-activation ignores the inactive dispatcher's old heartbeat and any dispatch responses (no false alerts)", r.status === "pre_activation" && only(r, []), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), dispatchActive(true)]);
  check("pre-activation but the dispatch job is active → dispatch_scheduler_unexpectedly_active", only(r, ["dispatch_scheduler_unexpectedly_active"]), JSON.stringify(r.codes));
  r = await evaluate(healthyActive());
  check("active and healthy → status ok, no codes", r.status === "ok" && only(r, []) && r.m.dispatch_runs_10m === 10 && r.m.resp_ok_10m === 10, JSON.stringify(r));
  r = await evaluate([...healthyBase(), expected(120), dispatchActive(true), dispatchHb(5 * 3600)]);
  check("just activated (2 min, no runs yet, Stage E heartbeat hours old) → grace: ok", r.status === "ok" && r.m.dispatch_grace === true && only(r, []), JSON.stringify(r));
  r = await evaluate([...healthyBase(), expected(120), dispatchActive(false)]);
  check("expected but the job is inactive → dispatch_scheduler_inactive (even in grace)", only(r, ["dispatch_scheduler_inactive"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(false), ...runs(minutes(0, 10)), dispatchHb(30), ...resp(10)]);
  check("expected, runs recent but the job now inactive → dispatch_scheduler_inactive", only(r, ["dispatch_scheduler_inactive"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 8)), dispatchHb(30), ...resp(8)]);
  check("8 runs in 10 min (threshold) → ok", r.status === "ok", JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 7)), dispatchHb(30), ...resp(7)]);
  check("7 runs in 10 min → dispatch_runs_missing", only(r, ["dispatch_runs_missing"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(3, 10).concat([200, 230].map((x) => x + 400))), dispatchHb(30), ...resp(8)]);
  check("no run in the last 3 minutes → dispatch_runs_missing", codes(r).includes("dispatch_runs_missing"), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(3, 10)), ...runs([30, 90, 150], "failed"), dispatchHb(200), ...resp(10)]);
  check("the last 3 runs failed → dispatch_runs_failing", codes(r).includes("dispatch_runs_failing"), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(2, 10)), ...runs([30, 90], "failed"), dispatchHb(30), ...resp(10)]);
  check("two failed runs only → not dispatch_runs_failing", !codes(r).includes("dispatch_runs_failing"), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 10)), dispatchHb(11 * 60), ...resp(10)]);
  check("dispatch heartbeat 11 min old → dispatch_heartbeat_degraded", only(r, ["dispatch_heartbeat_degraded"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 10)), dispatchHb(16 * 60), ...resp(10)]);
  check("dispatch heartbeat 16 min old → dispatch_heartbeat_stale (not also degraded)", only(r, ["dispatch_heartbeat_stale"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 10)), dispatchHb(9 * 60), ...resp(10)]);
  check("dispatch heartbeat 9 min old → ok (below the 10 min threshold)", r.status === "ok", JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), expected(), dispatchActive(true), ...runs(minutes(0, 10)), dispatchHb(120, 30), ...resp(10)]);
  check("a failed dispatch after the last success → dispatch_failed_after_success", only(r, ["dispatch_failed_after_success"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(2, { status: 401, body: '{"error":"UNAUTHORIZED"}' })]);
  check("2 JSON 401 UNAUTHORIZED in 10 min → dispatch_auth_failures", only(r, ["dispatch_auth_failures"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(1, { status: 401, body: '{"error":"UNAUTHORIZED"}' })]);
  check("1 JSON 401 → no alert (transient)", r.status === "ok", JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(2, { type: "text/html; charset=utf-8", body: "<html>login</html>" })]);
  check("2 HTML responses (followed protection redirect) → dispatch_protection_redirects", only(r, ["dispatch_protection_redirects"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(2, { status: 401, type: "text/html", body: "<html/>" })]);
  check("a Vercel 401 HTML page counts as a protection failure, not a dispatch-secret failure", only(r, ["dispatch_protection_redirects"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(3, { status: 500, body: '{"error":"DISPATCH_FAILED"}' })]);
  check("3 JSON 500 DISPATCH_FAILED → dispatch_http_errors", only(r, ["dispatch_http_errors"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(1, { status: 503, body: '{"error":"SAFETY_EMAIL_DISABLED"}' }), ...resp(1, { status: 502, type: "text/plain", body: "Bad Gateway" }), ...resp(1, { status: 200, body: '{"result":"dispatched","claimed":0}' })]);
  check("3 mixed errors (503 JSON, 502 text, 200 JSON missing keys) → dispatch_http_errors", only(r, ["dispatch_http_errors"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(2, { status: 500, body: '{"error":"DISPATCH_FAILED"}' })]);
  check("2 errors → no alert", r.status === "ok", JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(2, { timedOut: true, status: null, type: null, body: null }), ...resp(1, { status: null, type: null, body: null, err: "Could not resolve host" })]);
  check("3 pg_net timeouts / transport errors → dispatch_timeouts", only(r, ["dispatch_timeouts"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(5, { status: 200, type: "text/plain; charset=utf-8", body: "OK", monitor: true }), ...resp(3, { type: "text/html", body: "<html/>", monitor: true })]);
  check("the monitor's own check-in responses are never classified as dispatch responses", r.status === "ok" && r.m.resp_html_10m === 0 && r.m.resp_error_10m === 0, JSON.stringify(r));
  r = await evaluate([...healthyActive(), ...resp(5, { status: 200, type: "text/plain; charset=utf-8", body: "OK" })]);
  check("the same responses NOT recorded as check-ins would be errors (the exclusion is what hides them)", codes(r).includes("dispatch_http_errors"), JSON.stringify(r.codes));
  r = await evaluate([...healthyActive(), ...resp(4, { status: 401, body: '{"error":"UNAUTHORIZED"}', ageSec: 11 * 60 })]);
  check("responses older than the 10-minute window are ignored", r.status === "ok", JSON.stringify(r.codes));
  r = await evaluate([workerUp(false), sweepAge(30)]);
  check("pg_net worker not running → pg_net_worker_down (also pre-activation)", only(r, ["pg_net_worker_down"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), ...Array.from({ length: 4 }, () => ["SELECT net.http_post(url := 'https://example.invalid/queued')"])]);
  check("4 requests waiting in the pg_net queue → pg_net_queue_backlog", only(r, ["pg_net_queue_backlog"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), ...Array.from({ length: 3 }, () => ["SELECT net.http_post(url := 'https://example.invalid/queued')"])]);
  check("3 waiting → no alert", r.status === "pre_activation", JSON.stringify(r.codes));
  const health = (inFlight, oldestAgeSec) => ["DROP VIEW public.safety_notification_health", `CREATE VIEW public.safety_notification_health AS SELECT ${inFlight}::bigint AS outbox_in_flight, ${oldestAgeSec === null ? "NULL::timestamptz" : `now() - make_interval(secs => ${oldestAgeSec})`} AS oldest_in_flight_created_at`].map((s) => [s]);
  r = await evaluate([...healthyBase(), ...health(21, 60)]);
  check("21 emails in flight → notification_backlog", only(r, ["notification_backlog"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), ...health(1, 16 * 60)]);
  check("oldest in-flight email 16 min old → notification_backlog", only(r, ["notification_backlog"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), ...health(20, 14 * 60)]);
  check("20 in flight, oldest 14 min → no alert", r.status === "pre_activation", JSON.stringify(r.codes));
  const alert = (kind, cleared = false) => [`INSERT INTO public.safety_notification_alerts (kind, subject_key, detail_code, cleared_at) VALUES ($1, $2, 'attempts_exhausted', ${cleared ? "now()" : "NULL"})`, [kind, PHI_PROBE]];
  r = await evaluate([...healthyBase(), alert("delivery_failed_permanent"), alert("urgent_delivery_stalled")]);
  check("open permanent-failure and stalled-urgent alerts → open_alert_delivery_failed_permanent, open_alert_urgent_delivery_stalled", only(r, ["open_alert_delivery_failed_permanent", "open_alert_urgent_delivery_stalled"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), alert("delivery_failed_permanent", true), alert("orphan_fact_reconciled")]);
  check("cleared alerts and the informational orphan_fact_reconciled → no alert", r.status === "pre_activation", JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), alert("sweep_step_failed")]);
  check("any other open operational alert kind is reported (open_alert_sweep_step_failed)", only(r, ["open_alert_sweep_step_failed"]), JSON.stringify(r.codes));
  r = await evaluate([workerUp(true), sweepAge(6 * 60)]);
  check("sweep heartbeat 6 min old → sweep_heartbeat_stale", only(r, ["sweep_heartbeat_stale"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), [`UPDATE cron.job SET active = false WHERE jobid = ${sweepJobId}`]]);
  check("sweep job inactive → sweep_job_inactive", only(r, ["sweep_job_inactive"]), JSON.stringify(r.codes));
  r = await evaluate([...healthyBase(), alert("delivery_failed_permanent"), ...health(25, 20 * 60), workerUp(false), ["UPDATE public.safety_notification_heartbeats SET last_error_code = 'dispatch_failed' WHERE component = 'dispatch'"]]);
  const payload = JSON.stringify(r);
  const metricTypesOk = Object.values(r.m ?? {}).every((v) => v === null || typeof v === "number" || typeof v === "boolean");
  check("payload shape: exactly {v, status, codes, m}; codes are fixed snake_case words; metrics are numbers / booleans only",
    stable(Object.keys(r).sort()) === stable(["codes", "m", "status", "v"]) && codes(r).every((c) => /^[a-z_]+$/.test(c)) && metricTypesOk, payload);
  check("payload carries no alert subject key, id, detail code or UUID (no PHI path)", !payload.includes(PHI_PROBE) && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(payload) && !payload.includes("attempts_exhausted") && !payload.includes("@"), payload);
  check("codes are sorted and distinct (stable payload → stable external grouping)", stable(codes(r)) === stable([...new Set(codes(r))].sort()), JSON.stringify(r.codes));

  section("5. check-in tick (each case rolled back)");
  const put = (value) => ["INSERT INTO vault.secrets (name, secret) VALUES ($1, $2)", [N_PING, value]];
  const tick = async (setup, after = null) => {
    await db.query("BEGIN");
    try {
      for (const [sql, params] of setup) await db.query(sql, params ?? []);
      const before = await queued();
      await db.query("SAVEPOINT tick");
      try {
        const res = (await db.query("SELECT private.safety_monitor_tick() AS r")).rows[0].r;
        const rows = (await db.query("SELECT * FROM net.http_request_queue ORDER BY id")).rows;
        const state = (await db.query("SELECT last_status, last_codes, transitions, last_request_id FROM private.safety_monitor_state")).rows[0];
        const tracked = (await db.query("SELECT count(*)::int AS n FROM private.safety_monitor_requests")).rows[0].n;
        return { result: res, added: (await queued()) - before, rows, state, tracked, extra: after ? await after() : null };
      } catch (e) {
        await db.query("ROLLBACK TO SAVEPOINT tick");
        return { error: e, added: (await queued()) - before };
      }
    } finally {
      await db.query("ROLLBACK");
    }
  };
  const leaks = (t) => [PING, PING.slice(-36)].some((v) => [t.error?.message, t.error?.detail, t.error?.hint, t.error?.where, JSON.stringify(t.result ?? null)].some((x) => String(x ?? "").includes(v)));
  let t = await tick(healthyBase());
  check("no Vault entry → evaluates, records state, sends nothing (ping not_configured: fail closed)", t.result?.ping === "not_configured" && t.result?.status === "pre_activation" && t.added === 0 && t.state?.last_status === "pre_activation", JSON.stringify(t.result));
  t = await tick([...healthyBase(), ["DROP VIEW vault.decrypted_secrets"]]);
  check("Vault unavailable → not_configured, nothing sent", t.result?.ping === "not_configured" && t.added === 0, JSON.stringify(t.result ?? t.error?.message));
  t = await tick([...healthyBase(), put(PING), put(PING)]);
  check("duplicate entry → SAFETY_MONITOR_TICK_DUPLICATE_CONFIGURATION, nothing sent", t.error?.message === "SAFETY_MONITOR_TICK_DUPLICATE_CONFIGURATION" && t.added === 0 && !leaks(t), t.error?.message);
  const badPings = [
    ["plain http", PING.replace("https:", "http:")],
    ["another host", PING.replace("hc-ping.com", "hc-ping.example")],
    ["a look-alike host", PING.replace("hc-ping.com", "hc-ping.com.evil.example")],
    ["the healthchecks.io site host", PING.replace("hc-ping.com", "healthchecks.io")],
    ["an uppercase check id", PING.toUpperCase().replace("HTTPS://HC-PING.COM", "https://hc-ping.com")],
    ["a trailing slash", `${PING}/`],
    ["the /fail suffix stored", `${PING}/fail`],
    ["a query string", `${PING}?rid=1`],
    ["a ping-key slug form", "https://hc-ping.com/abcdefghijklmnopqrstuv/tenotrainer"],
    ["an explicit port", PING.replace("hc-ping.com", "hc-ping.com:443")],
    ["userinfo", PING.replace("https://", "https://u@")],
    ["surrounding whitespace", ` ${PING} `],
    ["a newline", `${PING}\n`],
    ["empty", ""],
  ];
  for (const [label, url] of badPings) {
    t = await tick([...healthyBase(), put(url)]);
    check(`check-in URL ${label} → SAFETY_MONITOR_TICK_URL_NOT_ALLOWED, nothing sent, URL not echoed`, t.error?.message === "SAFETY_MONITOR_TICK_URL_NOT_ALLOWED" && t.added === 0 && !leaks(t), t.error?.message);
  }
  t = await tick([...healthyBase(), put(PING), ["SET LOCAL tenotrainer_test.pg_net_fail = 'on'"]]);
  check("pg_net failure (its text echoes the request) → SAFETY_MONITOR_TICK_ENQUEUE_FAILED with a value-free detail", t.error?.message === "SAFETY_MONITOR_TICK_ENQUEUE_FAILED" && /^sqlstate=[0-9A-Z]{5}$/.test(t.error?.detail ?? "") && t.added === 0 && !leaks(t), `${t.error?.message} ${t.error?.detail}`);

  t = await tick([...healthyBase(), put(PING)]);
  const q = t.rows?.[0];
  const body = q ? JSON.parse(Buffer.from(q.body).toString("utf8")) : null;
  check("healthy (pre-activation) → exactly one request: POST to the check-in URL itself (success ping)", t.added === 1 && q?.method === "POST" && q?.url === PING, JSON.stringify(q && { method: q.method, url: q.url === PING }));
  check("request headers: Content-Type only; timeout 10 s", stable(q?.headers) === stable({ "Content-Type": "application/json" }) && q?.timeout_milliseconds === 10000, JSON.stringify(q?.headers));
  check("request body = the evaluator payload (status pre_activation, no codes)", body?.status === "pre_activation" && stable(body?.codes) === stable([]) && body?.v === 1, JSON.stringify(body));
  check("the request id is tracked as a monitor check-in; state records it", t.tracked === 1 && Number(t.state?.last_request_id) === Number(t.result?.request_id) && t.result?.ping === "enqueued", JSON.stringify({ tracked: t.tracked, state: t.state, result: t.result }));
  check("the tick result carries status / codes / request id only (no URL)", !leaks(t) && stable(Object.keys(t.result).sort()) === stable(["codes", "ping", "request_id", "status"]), JSON.stringify(t.result));
  t = await tick([...healthyActive(), put(PING)]);
  check("active and healthy → success ping (status ok)", t.rows?.[0]?.url === PING && JSON.parse(Buffer.from(t.rows[0].body).toString("utf8")).status === "ok", t.result?.status);
  t = await tick([...healthyActive(), put(PING), ...resp(2, { type: "text/html", body: "<html/>" })]);
  const failBody = t.rows?.[0] ? JSON.parse(Buffer.from(t.rows[0].body).toString("utf8")) : null;
  check("failing → POST to <check-in URL>/fail with the codes", t.added === 1 && t.rows?.[0]?.url === `${PING}/fail` && stable(failBody?.codes) === stable(["dispatch_protection_redirects"]), JSON.stringify(failBody?.codes));
  t = await tick([...healthyBase(), put(PING),
    ["CREATE OR REPLACE FUNCTION private.safety_monitor_evaluate() RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RAISE EXCEPTION 'boom %', 'detail'; END $$"]]);
  const evalBody = t.rows?.[0] ? JSON.parse(Buffer.from(t.rows[0].body).toString("utf8")) : null;
  check("evaluator failure → a /fail check-in with monitor_evaluator_error and only the SQLSTATE (no error text)",
    t.rows?.[0]?.url === `${PING}/fail` && stable(evalBody?.codes) === stable(["monitor_evaluator_error"]) && /^[0-9A-Z]{5}$/.test(evalBody?.m?.evaluator_sqlstate ?? "") && !JSON.stringify(evalBody).includes("boom"), JSON.stringify(evalBody));

  // Deduplication and recovery: one transaction, the worker drain simulated
  // between ticks (the double never sends).
  await db.query("BEGIN");
  const seq = [];
  try {
    for (const [sql, params] of [...healthyBase(), put(PING)]) await db.query(sql, params ?? []);
    const step = async (label) => {
      const res = (await db.query("SELECT private.safety_monitor_tick() AS r")).rows[0].r;
      const row = (await db.query("SELECT url, body FROM net.http_request_queue ORDER BY id DESC LIMIT 1")).rows[0];
      const s = (await db.query("SELECT last_status, last_codes, transitions, last_transition_at FROM private.safety_monitor_state")).rows[0];
      await db.query("DELETE FROM net.http_request_queue");
      seq.push({ label, status: res.status, url: row.url === PING ? "ping" : row.url === `${PING}/fail` ? "fail" : "other", codes: res.codes, transitions: s.transitions, at: s.last_transition_at?.toISOString() });
    };
    await step("healthy");
    await step("healthy again");
    await db.query("UPDATE public.safety_notification_heartbeats SET last_succeeded_at = now() - interval '20 minutes' WHERE component = 'sweep'");
    await step("sweep stale");
    await step("sweep still stale");
    await db.query("UPDATE public.safety_notification_heartbeats SET last_succeeded_at = now() WHERE component = 'sweep'");
    await step("recovered");
  } finally {
    await db.query("ROLLBACK");
  }
  const [h1, h2, f1, f2, rec] = seq;
  check("first evaluation records a transition (none → pre_activation); a repeat does not", h1?.transitions === 1 && h2?.transitions === 1 && h1?.at === h2?.at && h1?.url === "ping" && h2?.url === "ping", JSON.stringify([h1, h2]));
  check("failure: one transition, /fail check-ins; the repeat keeps the same codes and adds no transition (deduplicated)", f1?.status === "fail" && f1?.url === "fail" && f2?.url === "fail" && f1?.transitions === 2 && f2?.transitions === 2 && stable(f1?.codes) === stable(["sweep_heartbeat_stale"]) && stable(f2?.codes) === stable(f1?.codes) && f1?.at === f2?.at, JSON.stringify([f1, f2]));
  check("recovery: back to pre_activation with a success check-in and one more transition", rec?.status === "pre_activation" && rec?.url === "ping" && rec?.transitions === 3 && rec?.at !== f2?.at, JSON.stringify(rec));

  section("5b. declaring dispatch expected");
  await db.query("BEGIN");
  try {
    const a = (await db.query("SELECT private.safety_monitor_set_dispatch_expected(true) AS r")).rows[0].r;
    await db.query("SELECT pg_sleep(0.01)");
    const b = (await db.query("SELECT private.safety_monitor_set_dispatch_expected(true) AS r")).rows[0].r;
    const c = (await db.query("SELECT private.safety_monitor_set_dispatch_expected(false) AS r")).rows[0].r;
    check("true sets dispatch_expected_since; true again keeps it; false clears it", a.dispatch_expected_active === true && a.dispatch_expected_since && b.dispatch_expected_since === a.dispatch_expected_since && c.dispatch_expected_active === false && c.dispatch_expected_since === null, JSON.stringify([a, b, c]));
    await db.query("SAVEPOINT n");
    let err = null;
    try { await db.query("SELECT private.safety_monitor_set_dispatch_expected(NULL)"); } catch (e) { err = e; }
    await db.query("ROLLBACK TO SAVEPOINT n");
    check("NULL is refused (SAFETY_MONITOR_INVALID_ARGUMENT)", err?.message === "SAFETY_MONITOR_INVALID_ARGUMENT", err?.message);
  } finally {
    await db.query("ROLLBACK");
  }
  check("after every case: the pg_net queue is empty and the settings are still pre-activation (all rolled back)", (await queued()) === 0 && (await db.query("SELECT dispatch_expected_active AS e FROM private.safety_monitor_settings")).rows[0].e === false);

  section("6. static");
  const sql = readFileSync(join(MIGRATIONS_DIR, M66), "utf8");
  check("migration text holds no credential-shaped value or concrete check id", !/sb_secret_|sb_publishable_|sbp_|\bre_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9]/.test(sql) && !/hc-ping\.com\/[0-9a-f]{8}-/.test(sql));
  check("the only URL host in the migration is the pinned check-in host", stable([...new Set((sql.match(/https?:\/\/[A-Za-z0-9.\\-]+/g) ?? []).map((u) => u.replace(/\\/g, "")))]) === stable(["https://hc-ping.com"]), sql.match(/https?:\/\/[^\s'"]+/g)?.join(" "));
  check("migration does not alter the dispatch wrapper, the dispatch job or pg_net's grants", !/safety_dispatch_tick\(\)\s*(RETURNS|IS)|alter_job\([^)]*tenotrainer_m34f_safety_dispatch|^\s*(REVOKE|GRANT)\b[^;]*\bnet\b/im.test(sql.replace(/--.*$/gm, "")));
} catch (e) {
  check("suite completed", false, e.stack ?? e.message);
} finally {
  await sp.stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
