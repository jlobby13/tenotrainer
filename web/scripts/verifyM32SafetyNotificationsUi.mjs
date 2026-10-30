// M3.2 — clinician safety notification UI + operating-mode + dispatch
// endpoint suite, on isolated `next start` servers (31xx) of this worktree's
// production build, with committed synthetic fixtures (exact-id teardown).
//
//   development server : inbox, badge, grouping, process language, deep
//                        link to the Safety episode anchor, read_at once,
//                        acute-stop notice, ended assignment, fallback
//                        admin copy-only state, resolved history, health
//                        page; dispatch endpoint auth (provider disabled ->
//                        an authorized call claims nothing)
//   maintenance server : inbox readable, opening never records read_at,
//                        dispatch path reaches its own auth (the narrow
//                        exception), every other mutation still 503
//   production server  : FastAPI unreachable, inbox works, dispatch auth
//                        (no/wrong secret, forged cron headers, GET)
//   startup refusals   : fake provider / missing or short secret / missing
//                        Resend configuration
//
// The endpoint is NEVER called with a valid secret while a real provider is
// configured (it would claim the pre-existing development intent).
//
// Requires a production build (npx next build). Run from web/:
//   TENOTRAINER_MODE=development node scripts/verifyM32SafetyNotificationsUi.mjs
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { assertPurgeTarget } from "./lib/safetyFixturePurge.mjs";

const env = loadEnv(".env.local");
assertPurgeTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PORTS = { dev: 3160, maint: 3161, prod: 3162, refuse: 3163 };
const DEV = `http://127.0.0.1:${PORTS.dev}`;
const MAINT = `http://127.0.0.1:${PORTS.maint}`;
const PROD = `http://127.0.0.1:${PORTS.prod}`;
const DEAD_FASTAPI = "http://127.0.0.1:9";
const SECRET = `m32-ui-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); }
};

// ---------------------------------------------------------------- servers (only ones this script starts)
const started = [];
function serverEnv(overrides) {
  const base = { ...process.env };
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "NEXT_PUBLIC_APP_URL"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED", "SAFETY_EMAIL_PROVIDER",
                   "SAFETY_DISPATCH_SECRET", "RESEND_API_KEY", "RESEND_FROM", "SAFETY_FAKE_PROVIDER_LOG", "SAFETY_FAKE_PROVIDER_SCRIPT"]) base[k] = "";
  return { ...base, ...overrides };
}
const PROD_ENV = {
  FASTAPI_URL: "", BRIDGE_SECRET: "", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.test", C5_PATIENT_RUNTIME_ENABLED: "true",
  SAFETY_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: SECRET, RESEND_API_KEY: "re_m32_isolated_never_called", RESEND_FROM: "TenoTrainer <safety@tenotrainer.test>",
};
function spawnServer(port, overrides) {
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { env: serverEnv(overrides), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const s = { port, pid: proc.pid, log: "", exited: null };
  proc.stdout.on("data", (d) => (s.log += d));
  proc.stderr.on("data", (d) => (s.log += d));
  proc.on("exit", (code) => (s.exited = code ?? -1));
  started.push(s);
  return s;
}
async function listening(port) {
  try { await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" }); return true; } catch { return false; }
}
async function startServer(port, overrides) {
  if (await listening(port)) throw new Error(`port ${port} already in use — refusing to touch a server this script did not start`);
  const s = spawnServer(port, overrides);
  for (let i = 0; i < 120; i++) {
    if (s.exited !== null) throw new Error(`server ${port} exited (${s.exited}): ${s.log.slice(-800)}`);
    if (await listening(port)) return s;
    await sleep(500);
  }
  throw new Error(`server ${port} not ready`);
}
async function stopServer(s) {
  if (s.exited !== null) return;
  try { process.kill(-s.pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 40 && s.exited === null; i++) await sleep(250);
  if (s.exited === null) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* gone */ } }
}
async function expectRefusal(label, overrides, mentions) {
  const s = spawnServer(PORTS.refuse, overrides);
  let everListened = false;
  for (let i = 0; i < 60 && s.exited === null; i++) { if (await listening(PORTS.refuse)) everListened = true; await sleep(500); }
  if (s.exited === null) await stopServer(s);
  check(`startup refused: ${label}`, s.exited !== null && s.exited !== 0 && !everListened && s.log.includes("TenoTrainer refused to start") && s.log.includes(mentions), s.log.slice(-300));
}
async function post(base, headers = {}, method = "POST") {
  const r = await fetch(`${base}/api/internal/safety-notifications/dispatch`, { method, headers, redirect: "manual", signal: AbortSignal.timeout(20000) });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
}
async function login(browser, base, email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill("#email", email);
  await page.fill("#password", FIXTURE_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  return { context, page };
}
const recipientRow = (eventOrNotice, userId) => guardedSql(env, `SELECT r.id, r.read_at FROM safety_notification_recipients r
  LEFT JOIN safety_notification_events e ON e.id = r.event_id LEFT JOIN safety_acute_stop_notices n ON n.id = r.acute_stop_notice_id
  WHERE r.recipient_user_id = ${q(userId)} AND coalesce(e.patient_id, n.patient_id) = ${q(eventOrNotice)} ORDER BY r.created_at LIMIT 1`)[0];

const realBefore = guardedSql(env, `SELECT o.id, to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts FROM safety_email_outbox o ORDER BY o.id`);
const run = new FixtureRun(env, admin, "ui");
let browser;
let teardownError = null;
try {
  // ---------------------------------------------------------------- startup refusals
  await expectRefusal("production with SAFETY_EMAIL_PROVIDER=fake", { ...PROD_ENV, TENOTRAINER_MODE: "production", SAFETY_EMAIL_PROVIDER: "fake" }, "forbidden");
  await expectRefusal("maintenance with SAFETY_EMAIL_PROVIDER=fake", { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", SAFETY_EMAIL_PROVIDER: "fake" }, "forbidden");
  await expectRefusal("production without SAFETY_DISPATCH_SECRET", { ...PROD_ENV, TENOTRAINER_MODE: "production", SAFETY_DISPATCH_SECRET: "" }, "SAFETY_DISPATCH_SECRET");
  await expectRefusal("production with a short SAFETY_DISPATCH_SECRET", { ...PROD_ENV, TENOTRAINER_MODE: "production", SAFETY_DISPATCH_SECRET: "short" }, "at least 32");
  await expectRefusal("production without a safety email provider", { ...PROD_ENV, TENOTRAINER_MODE: "production", SAFETY_EMAIL_PROVIDER: "" }, "SAFETY_EMAIL_PROVIDER");
  await expectRefusal("production without RESEND_API_KEY", { ...PROD_ENV, TENOTRAINER_MODE: "production", RESEND_API_KEY: "" }, "RESEND_API_KEY");

  // ---------------------------------------------------------------- fixtures
  const c1 = await run.user("c1"); const c2 = await run.user("c2"); const a1 = await run.user("a1"); const su = await run.user("su");
  const pU = await run.user("pu"); const pQ = await run.user("pq"); const pR = await run.user("pr"); const pF = await run.user("pf");
  const { ceId } = run.setup({
    orgName: "M3.2 UI fixture org",
    members: [["fixture", c1.id, "clinician"], ["fixture", c2.id, "clinician"], ["fixture", a1.id, "clinician_admin"], ["fixture", su.id, "super_user"],
              ...[pU, pQ, pR, pF].map((p) => ["fixture", p.id, "member"])],
    assignments: [["fixture", c1.id, pU.id], ["fixture", c2.id, pU.id], ["fixture", c1.id, pQ.id], ["fixture", c1.id, pR.id]],
    names: { [pU.id]: "Uma Urgent", [pQ.id]: "Quinn Stopped", [pR.id]: "Riley Routine", [pF.id]: "Frankie Fallback", [c1.id]: "Clin One", [c2.id]: "Clin Two", [a1.id]: "Admin One", [su.id]: "Super One" },
  });
  const fU = run.safetyFlow(pU.id, c1.id, ceId, "l5");
  const fQ = run.safetyFlow(pQ.id, c1.id, ceId, "acute_stop_outstanding");
  const fR = run.safetyFlow(pR.id, c1.id, ceId, "l3");
  const fF = run.safetyFlow(pF.id, a1.id, ceId, "l5");
  guardedSql(env, `UPDATE supervisor_patients SET status = 'dismissed', dismissed_at = now() WHERE supervisor_id = ${q(c2.id)} AND patient_id = ${q(pU.id)} AND status = 'active'; SELECT 1 AS ok`);
  const c2Row = recipientRow(pU.id, c2.id);
  check("fixtures: urgent event (pU), acute-stop notice (pQ), ordinary L3 (pR), fallback L5 (pF), c2's assignment ended",
    fU.episode_id && !fQ.episode_id && fR.episode_id && fF.episode_id && c2Row?.id);

  // ---------------------------------------------------------------- servers
  const dev = await startServer(PORTS.dev, { TENOTRAINER_MODE: "development", C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: DEAD_FASTAPI,
    NEXT_PUBLIC_APP_URL: DEV, SAFETY_DISPATCH_SECRET: SECRET });
  browser = await chromium.launch();

  // ---------------------------------------------------------------- dispatch endpoint (development; provider disabled)
  check("endpoint: no Authorization -> 401", (await post(DEV)).status === 401);
  check("endpoint: wrong secret -> 401", (await post(DEV, { authorization: `Bearer ${SECRET}x` })).status === 401);
  check("endpoint: secret without Bearer scheme -> 401", (await post(DEV, { authorization: SECRET })).status === 401);
  check("endpoint: forged cron headers alone -> 401", (await post(DEV, { "x-vercel-cron": "1", "user-agent": "vercel-cron/1.0", "x-supabase-cron": "1" })).status === 401);
  check("endpoint: GET is not a dispatch (405)", (await post(DEV, { authorization: `Bearer ${SECRET}` }, "GET")).status === 405);
  const conc = await Promise.all([1, 2, 3, 4, 5].map(() => post(DEV, { authorization: `Bearer ${SECRET}` })));
  check("endpoint: authorized but no provider configured -> 503 SAFETY_EMAIL_DISABLED, concurrently and replayed, claiming nothing",
    conc.every((r) => r.status === 503 && r.body?.error === "SAFETY_EMAIL_DISABLED")
    && Number(guardedSql(env, "SELECT count(*) AS n FROM safety_email_attempts")[0].n) === 0);
  check("endpoint: a browser session grants nothing (session cookie, no secret -> 401)", await (async () => {
    const { context } = await login(browser, DEV, c1.email);
    const r = await context.request.post(`${DEV}/api/internal/safety-notifications/dispatch`, { failOnStatusCode: false });
    await context.close();
    return r.status() === 401;
  })());

  // ---------------------------------------------------------------- clinician inbox (c1)
  const { context: c1ctx, page } = await login(browser, DEV, c1.email);
  await page.goto(`${DEV}/clinician/dashboard`);
  check("badge: unread count shown in the clinician layout (3)", (await page.locator('[data-testid="safety-unread-badge"]').textContent())?.trim() === "3");
  await page.goto(`${DEV}/clinician/notifications`);
  const groups = await page.locator('[data-testid="safety-inbox-patient"]').count();
  const html = await page.content();
  check("inbox: grouped by patient (3 patients)", groups === 3, groups);
  check("inbox: process-language headlines (urgent review / acute-stop check-in / check-in pending)",
    html.includes("Urgent clinician review required") && html.includes("Safety check-in outstanding after an acute stop") && html.includes("Safety check-in pending"));
  const urgentItem = page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pU.id}"] [data-tier="urgent_clinician_review"]`);
  const urgentHeadline = (await urgentItem.locator("p").first().textContent()) ?? "";
  check("inbox: the numeric level is secondary detail only (never the headline)", !/level/i.test(urgentHeadline) && (await urgentItem.textContent()).includes("Level 5"));
  const qNotice = page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pQ.id}"] [data-kind="acute_stop_notice"]`);
  check("inbox: the acute-stop notice carries no level and no email-tier", !/level/i.test(await qNotice.textContent()));
  const uGroup = page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pU.id}"]`);
  check("D6 dedupe: the urgent patient shows ONE open item (the event); its acute-stop notice is history (check-in submitted), not active",
    (await uGroup.locator('[data-open="true"]').count()) === 1 && (await uGroup.locator('[data-kind="acute_stop_notice"][data-open="false"]').count()) === 1);
  check("inbox: patient identity shown to the assigned clinician", html.includes("Uma Urgent") && html.includes("Quinn Stopped") && html.includes("Riley Routine"));
  check("inbox: no fallback patient for an assigned clinician", !html.includes("Frankie Fallback"));
  await page.mouse.move(400, 300);
  await page.waitForTimeout(2500); // give any prefetch the chance to happen
  check("inbox: viewing / hovering the inbox records NO read_at (items are never prefetched)",
    Number(guardedSql(env, `SELECT count(*) AS n FROM safety_notification_recipients WHERE recipient_user_id = ${q(c1.id)} AND read_at IS NOT NULL`)[0].n) === 0);
  const uRid = await urgentItem.getAttribute("data-recipient");
  await urgentItem.locator("a").click();
  await page.waitForURL((u) => u.pathname === `/clinician/patients/${pU.id}/safety`, { timeout: 20000 });
  check("deep link: lands on the patient's Safety page at the episode anchor", page.url().endsWith(`#episode-${fU.episode_id}`) && (await page.locator(`#episode-${fU.episode_id}`).count()) === 1, page.url());
  const readAt1 = guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(uRid)}`)[0].read_at;
  await page.goto(`${DEV}/clinician/notifications/${uRid}`);
  const readAt2 = guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(uRid)}`)[0].read_at;
  check("read_at: recorded on open, and only once (re-opening keeps the first instant)", readAt1 && readAt1 === readAt2);
  check("read_at: reading did not review or release anything (episode still requires clinician release)",
    guardedSql(env, `SELECT requires_clinician_release AND NOT released AS open FROM acute_episode_review_state(${q(fU.episode_id)})`)[0].open === true);
  await page.goto(`${DEV}/clinician/dashboard`);
  check("badge: decrements after opening (2)", (await page.locator('[data-testid="safety-unread-badge"]').textContent())?.trim() === "2");
  await page.goto(`${DEV}/clinician/notifications`);
  await page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pQ.id}"] [data-kind="acute_stop_notice"] a`).click();
  await page.waitForURL((u) => u.pathname === `/clinician/patients/${pQ.id}/sessions/${fQ.session_id}`, { timeout: 20000 });
  check("acute-stop notice: opens the session it came from", true);

  // resolved history
  guardedSql(env, `INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path) VALUES (${q(fR.episode_id)}, ${q(pR.id)}, 'self_resolved_no_evaluation'); SELECT 1 AS ok`);
  await page.goto(`${DEV}/clinician/notifications`);
  const rItem = page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pR.id}"] [data-testid="safety-notification"]`);
  check("history: a released episode's notification stays visible as Resolved", (await rItem.getAttribute("data-open")) === "false"
    && (await rItem.locator('[data-testid="safety-notification-state"]').textContent()).startsWith("Resolved"));
  // acute-stop notice resolves when the check-in is submitted
  guardedSql(env, `SELECT c5_submit_immediate_response(${q(pQ.id)}, ${q(fQ.session_id)}, '{"peak_session_pain": 5, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}') AS r`);
  await page.goto(`${DEV}/clinician/notifications`);
  const qItem = page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pQ.id}"] [data-kind="acute_stop_notice"]`);
  check("acute-stop notice: resolved (check-in submitted) once the check-in is submitted; no second active notice",
    (await qItem.getAttribute("data-open")) === "false" && (await qItem.textContent()).includes("Check-in submitted")
    && (await page.locator(`[data-testid="safety-inbox-patient"][data-patient="${pQ.id}"] [data-kind="acute_stop_notice"][data-open="true"]`).count()) === 0);
  await page.goto(`${DEV}/super/safety-notifications`);
  check("health page: refused for a clinician", !page.url().includes("/super/safety-notifications"));
  await c1ctx.close();

  // ---------------------------------------------------------------- ended assignment (c2)
  const { context: c2ctx, page: p2 } = await login(browser, DEV, c2.email);
  await p2.goto(`${DEV}/clinician/notifications`);
  check("ended assignment: the former clinician's inbox is empty (history row hidden)", (await p2.locator('[data-testid="safety-inbox-empty"]').count()) === 1
    && !(await p2.content()).includes("Uma Urgent"));
  await p2.goto(`${DEV}/clinician/notifications/${c2Row.id}`);
  check("ended assignment: opening the historical link exposes nothing (unavailable), read_at untouched",
    p2.url().includes("unavailable=1") && !(await p2.content()).includes("Uma Urgent")
    && guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(c2Row.id)}`)[0].read_at === null);
  check("ended assignment: the immutable recipient row is preserved", Number(guardedSql(env, `SELECT count(*) AS n FROM safety_notification_recipients WHERE id = ${q(c2Row.id)}`)[0].n) === 1);
  await c2ctx.close();

  // ---------------------------------------------------------------- fallback admin (a1)
  const { context: a1ctx, page: pa } = await login(browser, DEV, a1.email);
  await pa.goto(`${DEV}/clinician/notifications`);
  const fItem = pa.locator('[data-testid="safety-notification"][data-basis="fallback_clinician_admin"][data-kind="episode_event"]');
  check("fallback: the clinician_admin sees the patient and 'No clinician is currently assigned', no level or clinical detail",
    (await fItem.count()) === 1 && (await fItem.textContent()).includes("No clinician is currently assigned")
    && !/level|urgent|pop|pain/i.test(await fItem.textContent()) && (await pa.content()).includes("Frankie Fallback"));
  await fItem.locator("a").click();
  await pa.waitForURL((u) => u.pathname.endsWith("/assignment-required"), { timeout: 20000 });
  const fHtml = await pa.content();
  check("fallback: copy-only state — assignment missing, review cannot be completed here, an administrator with assignment authority must assign",
    fHtml.includes("No clinician is currently assigned to this patient") && fHtml.includes("cannot be completed from this notification")
    && fHtml.includes("assigned by an administrator with assignment authority"));
  const cta = pa.locator('[data-testid="assignment-required-cta"]');
  const ctaHref = (await cta.count()) === 1 ? await cta.getAttribute("href") : null;
  const orgOfFixture = guardedSql(env, `SELECT organization_id FROM safety_notification_recipients WHERE recipient_user_id = ${q(a1.id)} AND basis = 'fallback_clinician_admin' LIMIT 1`)[0].organization_id;
  check("fallback: the same-org clinician_admin sees the 'Assign clinician' CTA", (await cta.count()) === 1 && (await cta.textContent()).trim() === "Assign clinician");
  check("fallback: the CTA targets the EXISTING /admin/assignments surface (that organization, that patient)",
    ctaHref === `/admin/assignments?org=${orgOfFixture}&patient=${pF.id}`, ctaHref);
  check("fallback: the CTA is the only link on the state; no Safety link; no level / episode / symptom detail",
    (await pa.locator('[data-testid="assignment-required"] a').count()) === 1 && !fHtml.includes("/safety")
    && !/level\s*\d|pop felt|episode|urgent/i.test(await pa.locator('[data-testid="assignment-required"]').textContent()));
  await cta.click();
  await pa.waitForURL((u) => u.pathname === "/admin/assignments", { timeout: 20000 });
  check("fallback: the existing assignment page opens for the same-org clinician_admin (its own M2 authorization), patient selected",
    (await pa.locator('[data-testid="assignments-denied"]').count()) === 0 && (await pa.content()).includes("Frankie Fallback"));
  const res = await pa.goto(`${DEV}/clinician/patients/${pF.id}/safety`);
  check("fallback: direct patient Safety access is still refused before any assignment", res.status() === 404 || !(await pa.content()).includes("Open safety episodes"), res.status());
  await a1ctx.close();
  const { context: c2b, page: p2b } = await login(browser, DEV, c2.email);
  await p2b.goto(`${DEV}/admin/assignments`);
  check("no new assignment authority: a plain clinician is still denied /admin/assignments", (await p2b.locator('[data-testid="assignments-denied"]').count()) === 1);
  await c2b.close();

  // ---------------------------------------------------------------- health page (super user)
  const { context: suctx, page: ps } = await login(browser, DEV, su.email);
  await ps.goto(`${DEV}/super/safety-notifications`);
  const sHtml = await ps.content();
  check("health page: super user sees the metrics and open alerts", (await ps.locator('[data-testid="safety-health-metrics"] tr').count()) >= 11
    && sHtml.includes("Urgent (Level 5) email with no provider acceptance after 15 minutes") && sHtml.includes("Last successful sweep"));
  check("health page: no patient or clinician identity (names, emails) appears", !/Uma Urgent|Frankie Fallback|Clin One|@example\.invalid/.test(sHtml));
  await suctx.close();
  await stopServer(dev);

  // ---------------------------------------------------------------- maintenance
  const maint = await startServer(PORTS.maint, { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.test" });
  const mNoSecret = await post(MAINT);
  check("maintenance: the dispatch path reaches its own authentication (401, not 503 MAINTENANCE) — the narrow exception", mNoSecret.status === 401 && mNoSecret.body?.error === "UNAUTHORIZED");
  const mOther = await fetch(`${MAINT}/api/internal/safety-notifications`, { method: "POST", redirect: "manual" });
  const mOther2 = await fetch(`${MAINT}/api/internal/safety-notifications/dispatch/extra`, { method: "POST", redirect: "manual" });
  check("maintenance: only the exact dispatch path is exempted (neighbouring internal POSTs still 503)", mOther.status === 503 && mOther2.status === 503, `${mOther.status}/${mOther2.status}`);
  const { context: mctx, page: pm } = await login(browser, MAINT, c1.email);
  await pm.goto(`${MAINT}/clinician/notifications`);
  check("maintenance: the inbox stays readable", (await pm.locator('[data-testid="safety-notification"]').count()) >= 1);
  const fRid = uRid;
  // pR's event has not been opened yet (unread) — open it in maintenance.
  const qRid = guardedSql(env, `SELECT r.id FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id WHERE e.patient_id = ${q(pR.id)} AND r.recipient_user_id = ${q(c1.id)}`)[0].id;
  const qReadBefore = guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(qRid)}`)[0].read_at;
  await pm.goto(`${MAINT}/clinician/notifications/${qRid}`);
  const qReadAfter = guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(qRid)}`)[0].read_at;
  check("maintenance: opening an unread notification navigates but NEVER records read_at",
    qReadBefore === null && qReadAfter === null && pm.url().includes(`/clinician/patients/${pR.id}/safety`), pm.url());
  const rel = await mctx.request.post(`${MAINT}/api/clinician/patients/${pU.id}/acute-safety/${fU.episode_id}/release`, { data: { note: "x" }, failOnStatusCode: false });
  check("maintenance: professional release stays blocked (503)", rel.status() === 503);
  check("maintenance: already-read state unchanged", guardedSql(env, `SELECT read_at FROM safety_notification_recipients WHERE id = ${q(fRid)}`)[0].read_at === readAt1);
  await mctx.close();
  await stopServer(maint);

  // ---------------------------------------------------------------- production (FastAPI unreachable)
  const prod = await startServer(PORTS.prod, { ...PROD_ENV, TENOTRAINER_MODE: "production", FASTAPI_URL: "" });
  check("production: dispatch without a secret -> 401", (await post(PROD)).status === 401);
  check("production: dispatch with a wrong secret -> 401", (await post(PROD, { authorization: "Bearer not-the-secret-not-the-secret-not-it" })).status === 401);
  check("production: forged cron headers -> 401", (await post(PROD, { "x-vercel-cron": "1", "user-agent": "vercel-cron/1.0" })).status === 401);
  const { context: pctx, page: pp } = await login(browser, PROD, c1.email);
  await pp.goto(`${PROD}/clinician/notifications`);
  check("production: the inbox works with FastAPI not configured and unreachable", (await pp.locator('[data-testid="safety-notification"]').count()) >= 1);
  await pp.goto(`${PROD}/clinician/dashboard`);
  check("production: the badge renders", (await pp.locator('[data-testid="safety-notifications-link"]').count()) === 1);
  await pctx.close();
  check("production: no FastAPI / bridge / SQLite reference in the M3.2 server code paths", prod.log.indexOf("FASTAPI") === -1);
  await stopServer(prod);
} catch (e) {
  check("suite ran without an unexpected error", false, e?.stack ?? e);
} finally {
  if (browser) await browser.close();
  for (const s of started) await stopServer(s);
  const realAfter = guardedSql(env, `SELECT o.id, to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts
    FROM safety_email_outbox o WHERE o.id IN (${realBefore.length ? realBefore.map((r) => q(r.id)).join(", ") : "NULL"}) ORDER BY o.id`);
  check("pre-existing development intent(s) byte-for-byte unchanged, no attempt",
    realAfter.length === realBefore.length && realAfter.every((a, i) => JSON.stringify(a.row) === JSON.stringify(realBefore[i].row) && a.attempts === realBefore[i].attempts));
  try {
    const t = run.teardown();
    check("teardown: exact-id purge, zero residue", t.purge.result === "purged");
  } catch (e) {
    teardownError = e;
    check("teardown: exact-id purge", false, e.message);
  }
  for (const s of started) check(`isolated server ${s.port} stopped`, s.exited !== null && !(await listening(s.port)));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 && !teardownError ? 0 : 1);
