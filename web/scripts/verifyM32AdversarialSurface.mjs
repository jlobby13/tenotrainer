// M3.2 — adversarial surface of the safety notification system with REAL
// JWTs (PostgREST) and real HTTP, against committed synthetic fixtures
// (exact-id teardown). Development database; isolated `next start` server.
//
// Run from web/ (production build required):
//   TENOTRAINER_MODE=development node scripts/verifyM32AdversarialSurface.mjs
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { assertPurgeTarget } from "./lib/safetyFixturePurge.mjs";

const env = loadEnv(".env.local");
assertPurgeTarget(env);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PORT = 3164;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); }
};

const TABLES = ["safety_notification_events", "safety_acute_stop_notices", "safety_notification_recipients", "safety_email_outbox",
  "safety_email_attempts", "safety_email_requeues", "safety_notification_alerts", "safety_notification_heartbeats"];
const RPCS = [
  ["safety_notifications_sweep", {}],
  ["safety_email_claim", { p_limit: 10, p_lease_seconds: 120, p_only_outbox_ids: null }],
  ["safety_email_claim", { p_limit: 10, p_lease_seconds: 120 }],
  ["safety_email_record_result", { p_outbox_id: crypto.randomUUID(), p_claim_token: crypto.randomUUID(), p_outcome: "provider_accepted", p_http_status: 200, p_provider_message_id: "forged", p_error_code: null }],
  ["safety_email_requeue", { p_outbox_id: crypto.randomUUID(), p_actor_id: crypto.randomUUID(), p_reason: "x" }],
  ["safety_email_dispatch_heartbeat", { p_ok: true, p_error_code: null, p_summary: {} }],
  ["safety_notification_unread_count", { p_user_id: crypto.randomUUID() }],
  ["safety_notif_resolve_recipients", { p_patient_id: crypto.randomUUID() }],
  ["safety_notif_recipient_eligible", { p_recipient_id: crypto.randomUUID() }],
  ["safety_notif_evaluate_episode", { p_episode_id: crypto.randomUUID(), p_source: "sweep" }],
  ["safety_notif_sync_acute_stop_notice", { p_response_id: crypto.randomUUID(), p_source: "sweep" }],
  ["safety_notif_add_late_recipients", { p_patient_id: crypto.randomUUID() }],
  ["safety_notif_hook", { p_kind: "episode", p_id: crypto.randomUUID() }],
  ["safety_notif_raise_alert", { p_kind: "sweep_step_failed", p_subject: "step:x", p_code: "x" }],
  ["safety_notif_clear_alert", { p_kind: "urgent_delivery_stalled", p_subject: "outbox:x" }],
  ["safety_notif_insert_recipients", { p_event_id: null, p_notice_id: null, p_recipients: [], p_late: false }],
];
const denied = (e) => e && (e.code === "42501" || /permission denied/i.test(e.message ?? ""));

async function asUser(email) {
  const c = createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: FIXTURE_PASSWORD });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

const realBefore = guardedSql(env, `SELECT o.id, to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts FROM safety_email_outbox o ORDER BY o.id`);
const run = new FixtureRun(env, admin, "adv");
let server = null;
let browser = null;
let teardownError = null;
try {
  const cA = await run.user("ca"); const cB = await run.user("cb"); const cX = await run.user("cx"); const pA = await run.user("pa"); const pB = await run.user("pb");
  // org F: cA, cB (clinicians), pA, pB (patients); cA assigned to pA, cB to pB. cX is a clinician of REAL_ORG? No — of a SECOND
  // disposable org (cross-organization attacker).
  const { orgId, ceId } = run.setup({
    orgName: "M3.2 adversarial org", members: [["fixture", cA.id, "clinician"], ["fixture", cB.id, "clinician"], ["fixture", pA.id, "member"], ["fixture", pB.id, "member"]],
    assignments: [["fixture", cA.id, pA.id], ["fixture", cB.id, pB.id]],
    names: { [pA.id]: "Alex Attacked", [pB.id]: "Blair Other" },
  });
  const other = run.setup({ orgName: "M3.2 adversarial other org", members: [["fixture", cX.id, "clinician"]], assignments: [], names: {} });
  const fA = run.safetyFlow(pA.id, cA.id, ceId, "l5");
  run.safetyFlow(pB.id, cB.id, ceId, "l3");
  const aRid = guardedSql(env, `SELECT r.id FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id WHERE e.patient_id = ${q(pA.id)} AND r.recipient_user_id = ${q(cA.id)}`)[0].id;
  const aOb = guardedSql(env, `SELECT o.id FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = ${q(pA.id)}`)[0].id;
  check("fixtures: L5 for pA (cA), L3 for pB (cB), a clinician of another organization (cX)", aRid && aOb && other.orgId !== orgId);

  // ---------------------------------------------------------------- PostgREST with real JWTs
  const anon = createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const actors = { anon, patient: await asUser(pA.email), clinicianA: await asUser(cA.email), clinicianB: await asUser(cB.email), crossOrg: await asUser(cX.email) };
  for (const [who, c] of Object.entries(actors)) {
    const bad = [];
    for (const t of TABLES) {
      const sel = await c.from(t).select("*").limit(5);
      if (!denied(sel.error)) bad.push(`${t}:select(${sel.error?.code ?? `rows=${sel.data?.length}`})`);
    }
    for (const t of ["safety_notification_events", "safety_notification_recipients", "safety_email_outbox", "safety_email_attempts", "safety_acute_stop_notices", "safety_email_requeues", "safety_notification_alerts"]) {
      const ins = await c.from(t).insert({ id: crypto.randomUUID() });
      if (!denied(ins.error)) bad.push(`${t}:insert(${ins.error?.code})`);
      const upd = await c.from(t).update({ id: crypto.randomUUID() }).eq("id", aOb);
      if (!denied(upd.error)) bad.push(`${t}:update(${upd.error?.code})`);
      const del = await c.from(t).delete().eq("id", aOb);
      if (!denied(del.error)) bad.push(`${t}:delete(${del.error?.code})`);
    }
    const hv = await c.from("safety_notification_health").select("*");
    if (!denied(hv.error)) bad.push(`health_view(${hv.error?.code})`);
    for (const [fn, args] of RPCS) {
      const r = await c.rpc(fn, args);
      if (!denied(r.error)) bad.push(`rpc ${fn}(${r.error?.code ?? "ok"})`);
    }
    // Forged recipient / episode through the open + inbox primitives.
    for (const [fn, args] of [["safety_notification_open", { p_recipient_id: aRid, p_user_id: cA.id, p_mark_read: true }],
                              ["safety_notification_inbox", { p_user_id: cA.id, p_limit: 50 }]]) {
      const r = await c.rpc(fn, args);
      if (!denied(r.error)) bad.push(`rpc ${fn} forged(${r.error?.code ?? "ok"})`);
    }
    check(`${who} (real JWT): no read/insert/update/delete on 8 tables + view, no server-only or internal RPC (scoped/unscoped claim, record, requeue, open, inbox, sweep…) — all 42501`, bad.length === 0, bad.join(", "));
  }
  check("forged mark-read attempts changed nothing (read_at still NULL)", guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(aRid)}`)[0].read_at === null);
  // service_role: read-only on tables, writes only via functions.
  const sw = await admin.from("safety_email_outbox").update({ status: "provider_accepted" }).eq("id", aOb);
  const sd = await admin.from("safety_notification_events").delete().eq("patient_id", pA.id);
  const sr = await admin.from("safety_email_outbox").select("id").eq("id", aOb);
  check("service_role: may read, but cannot write delivery state or delete history directly (42501)", denied(sw.error) && denied(sd.error) && !sr.error && sr.data.length === 1);
  const ownFns = guardedSql(env, `SELECT count(*) AS n FROM pg_proc WHERE proname = 'safety_email_claim'`)[0].n;
  check("exactly one safety_email_claim signature exists (no stale overload)", Number(ownFns) === 1);

  // ---------------------------------------------------------------- HTTP (isolated development server)
  const envs = { ...process.env, TENOTRAINER_MODE: "development", C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: "http://127.0.0.1:9",
    NEXT_PUBLIC_APP_URL: BASE, SAFETY_EMAIL_PROVIDER: "", SAFETY_DISPATCH_SECRET: `adv-${crypto.randomUUID()}-${crypto.randomUUID()}`, RESEND_API_KEY: "" };
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { env: envs, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  server = { pid: proc.pid, exited: null };
  proc.on("exit", (c) => (server.exited = c ?? -1));
  for (let i = 0; i < 120; i++) { try { await fetch(`${BASE}/login`, { redirect: "manual" }); break; } catch { await sleep(500); } }
  browser = await chromium.launch();
  const ctx = async (email) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/login`); await page.fill("#email", email); await page.fill("#password", FIXTURE_PASSWORD);
    await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
    return { context, page };
  };
  const B = await ctx(cB.email);
  await B.page.goto(`${BASE}/clinician/notifications/${aRid}`);
  check("HTTP: clinician B opening clinician A's recipient row -> unavailable, nothing exposed, not marked read",
    B.page.url().includes("unavailable=1") && !(await B.page.content()).includes("Alex Attacked")
    && guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(aRid)}`)[0].read_at === null);
  await B.page.goto(`${BASE}/clinician/notifications/${crypto.randomUUID()}`);
  check("HTTP: a forged (non-existent) recipient id -> unavailable", B.page.url().includes("unavailable=1"));
  await B.page.goto(`${BASE}/clinician/notifications/not-a-uuid'%20OR%201=1`);
  check("HTTP: a malformed recipient id -> unavailable", B.page.url().includes("unavailable=1"));
  const forgedEp = await B.page.goto(`${BASE}/clinician/patients/${pA.id}/safety#episode-${fA.episode_id}`);
  check("HTTP: a forged episode deep link for another clinician's patient is refused (no Safety content)",
    forgedEp.status() === 404 || !(await B.page.content()).includes("Open safety episodes"), forgedEp.status());
  await B.page.goto(`${BASE}/clinician/notifications`);
  check("HTTP: clinician B's inbox shows only B's patient", (await B.page.content()).includes("Blair Other") && !(await B.page.content()).includes("Alex Attacked"));
  await B.context.close();
  const X = await ctx(cX.email);
  await X.page.goto(`${BASE}/clinician/notifications`);
  check("HTTP: a clinician of another organization sees nothing", (await X.page.locator('[data-testid="safety-inbox-empty"]').count()) === 1);
  await X.page.goto(`${BASE}/clinician/notifications/${aRid}`);
  check("HTTP: cross-organization open refused", X.page.url().includes("unavailable=1"));
  await X.context.close();
  const P = await ctx(pA.email);
  await P.page.goto(`${BASE}/clinician/notifications`);
  check("HTTP: the patient cannot reach the clinician inbox", !P.page.url().includes("/clinician/notifications"));
  await P.page.goto(`${BASE}/clinician/notifications/${aRid}`);
  check("HTTP: the patient cannot open (or mark read) a clinician notification",
    !P.page.url().includes("/clinician/patients/") && guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(aRid)}`)[0].read_at === null);
  const pd = await P.context.request.post(`${BASE}/api/internal/safety-notifications/dispatch`, { failOnStatusCode: false });
  check("HTTP: a patient session cannot invoke dispatch (401)", pd.status() === 401);
  await P.context.close();
  const anonHttp = await fetch(`${BASE}/clinician/notifications/${aRid}`, { redirect: "manual" });
  check("HTTP: anonymous open -> login (no data)", [303, 307].includes(anonHttp.status) && (anonHttp.headers.get("location") ?? "").includes("/login"));
} catch (e) {
  check("suite ran without an unexpected error", false, e?.stack ?? e);
} finally {
  if (browser) await browser.close();
  if (server && server.exited === null) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 40 && server.exited === null; i++) await sleep(250);
  }
  const realAfter = guardedSql(env, `SELECT o.id, to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts
    FROM safety_email_outbox o WHERE o.id IN (${realBefore.length ? realBefore.map((r) => q(r.id)).join(", ") : "NULL"}) ORDER BY o.id`);
  check("pre-existing development intent(s) byte-for-byte unchanged",
    realAfter.length === realBefore.length && realAfter.every((a, i) => JSON.stringify(a.row) === JSON.stringify(realBefore[i].row) && a.attempts === realBefore[i].attempts));
  try { run.teardown(); check("teardown: exact-id purge, zero residue", true); } catch (e) { teardownError = e; check("teardown", false, e.message); }
  check("isolated server stopped", !server || server.exited !== null);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 && !teardownError ? 0 : 1);
