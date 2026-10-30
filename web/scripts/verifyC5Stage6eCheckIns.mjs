// C5.6E — patient response submission + safety loop, live end-to-end over
// the REAL authenticated Next.js boundary (cookie login, /api/patient/c5/**,
// the rendered /patient/check-in forms via Playwright) on the applied
// C5.6C/E RPCs. Throwaway @example.invalid users only; full teardown.
//
// Servers (the runtime gate is a server env var, never weakened for a test):
//   GATE_ON  (default http://localhost:3001) — `next build` then
//            C5_PATIENT_RUNTIME_ENABLED=true npx next start -p 3001
//   GATE_OFF (default http://localhost:3000) — the normal dev server.
//
// Past facts (a session closed yesterday, a due morning) are SQL fixtures
// on the database clock, as in the C5.6C/D suites. The RPC-level edge cases
// (validation matrix, timing rule, immutability) live in
// verifyC5Stage6eResponses.sql.
//
// Run from web/:
//   node scripts/verifyC5Stage6eCheckIns.mjs [gateOnUrl] [gateOffUrl] [screenshotDir]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { fixtureClinicianMembership } from "./lib/fixtureClinicianMembership.mjs";
import { guardedFixtureTeardown } from "./lib/safetyFixturePurge.mjs";

const ON = process.argv[2] ?? "http://localhost:3001";
const OFF = process.argv[3] ?? "http://localhost:3000";
const SHOTS = process.argv[4] ?? null;
const REPO_ROOT = "..";
const CLINICIAN = "44197ef7-7421-47ed-a164-75d2765fc019";

// M2 — an assignment requires the clinician's clinician-role membership in
// its organization. This shared fixture clinician has none, so the suite
// grants one for the run and removes it in teardown (only if it added it).
const M2_FIXTURE_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
// M3.2 — exact-id fixture membership / assignments (never by clinician id).
let fixtureClinician = null;
const fc = () => (fixtureClinician ??= fixtureClinicianMembership(admin, { clinicianId: CLINICIAN, organizationId: M2_FIXTURE_ORG_ID }));
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const eq = t.indexOf("=");
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = loadEnv(".env.local");
// M3.1 — refuse unless TENOTRAINER_MODE=development and the target project is allow-listed.
assertDevTestTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const WORK = mkdtempSync(join(tmpdir(), "c56e-"));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`\n--- ${t} ---`);
}
function sqlQuery(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function localDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86400000));
}
async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------- fixtures
const RUN_STARTED_AT = new Date(Date.now() - 60_000).toISOString();
const createdUsers = [];
let exerciseId = null;

async function makeUser(label) {
  const email = `c56e-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `C5.6E ${label}`, timezone: TZ });
  return { userId: data.user.id, email };
}

async function makeFixture(label) {
  const patient = await makeUser(label);
  await fc().ensureMembership();
  await fc().assign(patient.userId);
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({ user_id: patient.userId, source: "clinician_change", patient_prescription_id: pp.id, version_number: 1, published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: CLINICIAN, scheduling_mode: "sequence", target_sessions_per_week: 3 })
    .select("id")
    .single();
  if (error) throw error;
  const { data: w } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: "A", order_index: 0 }).select("id").single();
  const { data: e } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseId, order_index: 0, status: "active" }).select("id").single();
  await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: e.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return { ...patient, ppId: pp.id, versionId: v.id, workoutId: w.id, exerciseId: e.id };
}

// A session that started and closed the day before its reference morning,
// with the immediate response resolved and the morning response DUE.
// refOffsetDays = the reference morning relative to today (0 = this morning,
// -2 = two mornings ago, i.e. a retrospective submission).
function priorSessionMorningDue(f, refOffsetDays = 0) {
  const sid = randomUUID();
  const sessionDaysAgo = 1 - refOffsetDays;
  const started = `(now() - interval '${sessionDaysAgo} days')`;
  sqlQuery(`BEGIN;
INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
VALUES ('${sid}', '${f.userId}', 'c5:${sid}', (${started} AT TIME ZONE '${TZ}')::date, NULL, 'started', ${started},
  c5_build_session_snapshot('${f.versionId}', '${f.workoutId}'), '${f.versionId}', '${f.workoutId}', '${TZ}', gen_random_uuid());
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${sid}', '${f.exerciseId}', 0, 0, 'completed', 8, ${started});
UPDATE rehab_sessions SET training_status = 'finished', training_closed_at = ${started} + interval '20 minutes' WHERE id = '${sid}';
INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
VALUES ('${sid}', '${f.userId}', 2, 5, false, false, false, now());
INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date)
VALUES ('${sid}', '${f.userId}', now() + interval '${refOffsetDays} days' - interval '1 hour', ((now() + interval '${refOffsetDays} days') AT TIME ZONE '${TZ}')::date);
COMMIT;`);
  return sid;
}

async function sessionsOf(f) {
  const { data } = await admin.from("rehab_sessions").select("*").eq("user_id", f.userId).not("training_status", "is", null).order("started_at");
  return data ?? [];
}
async function immediateOf(sessionId) {
  const { data } = await admin.from("session_immediate_responses").select("*").eq("rehab_session_id", sessionId).maybeSingle();
  return data;
}
async function morningOf(sessionId) {
  const { data } = await admin.from("morning_responses").select("*").eq("rehab_session_id", sessionId).maybeSingle();
  return data;
}
async function evalsOf(sessionId) {
  const { data } = await admin.from("escalation_evaluations").select("*").eq("rehab_session_id", sessionId);
  return data ?? [];
}
async function episodesOf(f) {
  const { data } = await admin.from("acute_safety_episodes").select("*").eq("user_id", f.userId);
  return data ?? [];
}

async function teardown() {
  // M3.2 — the guarded exact-id purge (safety-notification history is
  // immutable, so ordinary deletes can no longer remove these fixtures).
  guardedFixtureTeardown(env, { userIds: createdUsers, exerciseIds: exerciseId ? [exerciseId] : [], runStartedAt: RUN_STARTED_AT });
  await fc().teardown();
}

// ---------------------------------------------------------------- browser / API
async function login(browser, email, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${ON}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.close();
  return context;
}
async function api(ctx, method, path, data, base = ON) {
  const res = await ctx.request.fetch(`${base}${path}`, { method, data, failOnStatusCode: false });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status(), body };
}
const state = async (ctx) => (await api(ctx, "GET", "/api/patient/c5/state")).body?.state;
const perf = (f, unit = 0) => ({ exercise_id: f.exerciseId, unit_index: unit, outcome: "completed", actual_reps: 8 });
async function startAndClose(ctx, f, close = "finish", acuteReport = null) {
  const s = await api(ctx, "POST", "/api/patient/c5/start", {
    clientRequestId: randomUUID(), expectedVersionId: f.versionId, workoutId: f.workoutId, performance: perf(f), preStartSkips: [], sequenceChoice: null,
  });
  const id = s.body?.session?.id;
  if (!id) throw new Error(`fixture start failed: ${JSON.stringify(s.body)}`);
  await api(ctx, "POST", `/api/patient/c5/session/${id}/${close}`, close === "stop" ? { acuteReport } : {});
  return id;
}
const ALL_NO = { sudden_or_sharp_pain: false, pop_felt_or_heard: false, new_functional_difficulty: false };
const submitImmediate = (ctx, sid, response, base) => api(ctx, "POST", `/api/patient/c5/check-ins/immediate/${sid}`, { response }, base);
const submitMorning = (ctx, sid, response) => api(ctx, "POST", `/api/patient/c5/check-ins/morning/${sid}`, { response });

async function pick(page, scale, n) {
  await page.locator(`[data-score-scale="${scale}"] button`).nth(n).click();
}
async function answer(page, key, yes) {
  await page.locator(`[data-safety-question="${key}"]`).getByRole("radio", { name: yes ? "Yes" : "No" }).click();
}
const FORBIDDEN_COPY = /notified|alerted|clinician has been|has been told|cleared to train|you('|’)re cleared|injur|diagnos|torn|rupture/i;

async function layoutCheck(page, name) {
  const r = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    for (const el of document.querySelectorAll("main button, main a, main textarea")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.height < 43.5) small.push(`${el.textContent?.trim().slice(0, 30)} (${Math.round(b.height)}px)`);
    }
    return { overflow, small };
  });
  check(`layout ${name}: no horizontal overflow`, r.overflow <= 0, `overflow ${r.overflow}px`);
  check(`layout ${name}: tap targets >= 44px`, r.small.length === 0, r.small.join(", "));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------- scenarios
// PEC — the workout opens in a passive review; "Begin workout" (UI state
// only, never a write) reveals the performance controls.
async function beginIfReviewing(page) {
  await page.waitForSelector("[data-c5-exercise], [data-c5-state-card], [data-c5-sequence-choice], [data-c5-recovery-guidance], [data-c5-closed]", { timeout: 15000 }).catch(() => {});
  const begin = page.locator("[data-c5-begin]");
  if ((await begin.count()) > 0) await begin.click();
}

async function main() {
  const probe = await fetch(`${ON}/api/patient/c5/check-ins`);
  check("gate-on server reachable; unauthenticated check-in API is 401", probe.status === 401, `status ${probe.status}`);
  const { data: ex, error: exErr } = await admin.from("canonical_exercises").insert({ name: `C5.6E exercise ${randomUUID().slice(0, 6)}`, visibility: "global", active: true }).select("id").single();
  if (exErr) throw exErr;
  exerciseId = ex.id;

  const browser = await chromium.launch();
  try {
    // ======================================================================
    section("A. Training -> closure -> immediate check-in (UI) -> fresh state");
    const A = await makeFixture("loop");
    const ctxA = await login(browser, A.email);
    {
      const pre = await api(ctxA, "GET", "/api/patient/c5/check-ins");
      check("42. no exposure -> no check-in obligation", pre.body?.checkIns?.immediate?.length === 0 && pre.body.checkIns.mornings.length === 0);
      const page = await ctxA.newPage();
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      await page.locator("[data-c5-unit]").first().getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await sessionsOf(A)).length === 1);
      const S = (await sessionsOf(A))[0];
      await page.getByRole("button", { name: "Finish workout" }).click();
      await page.waitForSelector("[data-c5-closed]");
      const { data: imms } = await admin.from("session_immediate_responses").select("id").eq("rehab_session_id", S.id);
      check("1. the closed exposure created exactly one immediate obligation", imms.length === 1);
      const sI = await state(ctxA);
      check("33. outstanding immediate response blocks new training (server state)", sI?.kind === "immediate_response_required");

      await page.getByRole("link", { name: "Continue to check-in" }).click();
      await page.waitForSelector("[data-c5-immediate-form]");
      check("2. the immediate form loads this session", (await page.locator("[data-c5-immediate-form]").textContent()).includes("Workout A"));
      check("RPE title + exact question shown", (await page.getByText("Rate of Perceived Exertion (RPE)").count()) === 1 && (await page.getByText("Overall, how hard did today’s workout feel?").count()) === 1);
      const anchors = (await page.locator("[data-rpe-anchors] span").allTextContents()).join("|");
      check("10. only the four sparse RPE orientation words are shown", anchors === "Very Easy|Moderate|Hard|Very Hard", anchors);
      check("scales offer exactly 0..10", (await page.locator('[data-score-scale="peak-pain"] button').allTextContents()).join(",") === "0,1,2,3,4,5,6,7,8,9,10");
      const submit = page.getByRole("button", { name: "Submit check-in" });
      check("6. nothing is preselected; submit disabled until every item is answered", await submit.isDisabled());
      await page.setViewportSize(MOBILE);
      await layoutCheck(page, "mobile-immediate-form");
      await page.setViewportSize(DESKTOP);
      if (SHOTS) await layoutCheck(page, "desktop-immediate-form");

      await pick(page, "peak-pain", 0);
      await pick(page, "rpe", 3);
      check("safety questions still required after scores", await submit.isDisabled());
      for (const k of ["sudden_or_sharp_pain", "pop_felt_or_heard", "new_functional_difficulty"]) await answer(page, k, false);
      await submit.click();
      await page.waitForSelector("[data-c5-checkin-saved]");
      const imm = await immediateOf(S.id);
      check("5. numeric zero persisted as zero; RPE stored as the integer only", imm.peak_session_pain === 0 && imm.overall_session_rpe === 3 && !imm.peak_pain_unable_to_recall && imm.resolved_at !== null, JSON.stringify(imm));
      const ev = await evalsOf(S.id);
      check("one Level 0 evaluation (existing rule v1)", ev.length === 1 && ev[0].escalation_level === 0 && ev[0].rule_version === "v1");
      const savedText = await page.locator("[data-c5-checkin-saved]").textContent();
      check("post-submit shows the FRESH server state (already trained today), not a hard-coded clearance", savedText.includes("You've already trained today"), savedText);
      check("44. no copy claims a clinician was notified or clears training", !FORBIDDEN_COPY.test(savedText) && !FORBIDDEN_COPY.test(await page.locator("body").textContent()));
      const sAfter = await state(ctxA);
      check("35. resolving the immediate response removes that gate", sAfter?.kind === "already_trained_today");

      const replay = await submitImmediate(ctxA, S.id, { peak_session_pain: 0, overall_session_rpe: 3, ...ALL_NO });
      check("37. identical retry -> submitted (replayed); still one evaluation", replay.body?.result === "submitted" && replay.body?.replayed === true && (await evalsOf(S.id)).length === 1, JSON.stringify(replay.body)?.slice(0, 160));
      const changed = await submitImmediate(ctxA, S.id, { peak_session_pain: 8, overall_session_rpe: 9, ...ALL_NO });
      check("13. a different retry never changes the submitted observation", changed.body?.result === "already_submitted" && (await immediateOf(S.id)).peak_session_pain === 0);
      await page.close();
    }

    // ======================================================================
    section("B. API: validation, unable-to-recall, concurrency, identity, gate");
    {
      const B = await makeFixture("api");
      const ctxB = await login(browser, B.email);
      const sid = await startAndClose(ctxB, B, "finish");
      for (const [label, resp] of [
        ["3. peak pain 11 refused", { peak_session_pain: 11, overall_session_rpe: 2, ...ALL_NO }],
        ["3. peak pain 2.5 refused", { peak_session_pain: 2.5, overall_session_rpe: 2, ...ALL_NO }],
        ["4. RPE 11 refused", { peak_session_pain: 2, overall_session_rpe: 11, ...ALL_NO }],
        ["4. RPE as text refused", { peak_session_pain: 2, overall_session_rpe: "hard", ...ALL_NO }],
        ["6. unanswered pain refused (not 0-filled)", { overall_session_rpe: 2, ...ALL_NO }],
        ["9. unable-to-recall cannot answer the safety questions", { peak_pain_unable_to_recall: true, rpe_unable_to_recall: true }],
      ]) {
        const r = await submitImmediate(ctxB, sid, resp);
        check(label, r.body?.result === "invalid_response", JSON.stringify(r.body?.result) + " " + JSON.stringify(r.body?.detail));
      }
      check("refusals left the obligation open", (await immediateOf(sid)).resolved_at === null && (await evalsOf(sid)).length === 0);
      const others = await makeFixture("other");
      const ctxO = await login(browser, others.email);
      const foreign = await submitImmediate(ctxO, sid, { peak_session_pain: 1, overall_session_rpe: 1, ...ALL_NO });
      check("39. another patient cannot submit for this session", foreign.body?.result === "response_not_found" && (await immediateOf(sid)).resolved_at === null);

      const clinician = await makeUser("clinician");
      await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: clinician.userId, role: "clinician" });
      const ctxC = await login(browser, clinician.email);
      const asClin = await submitImmediate(ctxC, sid, { peak_session_pain: 1, overall_session_rpe: 1, ...ALL_NO });
      check("40. a clinician cannot use the patient endpoint", asClin.status === 403 && asClin.body?.code === "NOT_A_PATIENT", JSON.stringify(asClin));
      const off = await submitImmediate(ctxB, sid, { peak_session_pain: 1, overall_session_rpe: 1, ...ALL_NO }, OFF);
      check("43. gate off (:3000): check-in endpoints unavailable (404)", off.status === 404 && off.body?.code === "C5_RUNTIME_DISABLED", JSON.stringify(off));

      const payload = { peak_pain_unable_to_recall: true, rpe_unable_to_recall: true, ...ALL_NO };
      const results = await Promise.all([1, 2, 3].map(() => submitImmediate(ctxB, sid, payload)));
      check("37. double-submit: every request reports submitted, exactly one did the write", results.every((r) => r.body?.result === "submitted") && results.filter((r) => r.body?.replayed === false).length === 1, JSON.stringify(results.map((r) => r.body?.result + "/" + r.body?.replayed)));
      const imm = await immediateOf(sid);
      check("7/8. immediate unable-to-recall stores NULL + flags and resolves the obligation", imm.peak_session_pain === null && imm.overall_session_rpe === null && imm.peak_pain_unable_to_recall && imm.rpe_unable_to_recall && imm.resolved_at !== null);
      check("37. one evaluation despite concurrent submissions", (await evalsOf(sid)).length === 1);

      const H = await makeFixture("highscores");
      const ctxH = await login(browser, H.email);
      const sidH = await startAndClose(ctxH, H, "finish");
      const hi = await submitImmediate(ctxH, sidH, { peak_session_pain: 10, overall_session_rpe: 10, ...ALL_NO });
      check("17/18. pain 10 + RPE 10 alone: Level 0, no episode, no safety state", hi.body?.result === "submitted" && (await evalsOf(sidH))[0]?.escalation_level === 0 && (await episodesOf(H)).length === 0 && hi.body?.state?.kind === "already_trained_today", JSON.stringify(hi.body?.state));
      await Promise.all([ctxB.close(), ctxO.close(), ctxC.close(), ctxH.close()]);
    }

    // ======================================================================
    section("C. Stop-sheet pop -> check-in keeps it -> existing escalation -> brake");
    {
      const C = await makeFixture("pop");
      const ctxC = await login(browser, C.email);
      const page = await ctxC.newPage();
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      await page.locator("[data-c5-unit]").first().getByRole("button", { name: "Done" }).click();
      await page.waitForSelector("[data-c5-progress]");
      const sid = (await sessionsOf(C))[0].id;
      await page.getByRole("button", { name: "Stop session" }).click();
      await page.getByRole("dialog").getByLabel("Felt or heard a pop").check();
      await page.getByRole("dialog").getByRole("button", { name: "Stop today's session" }).click();
      await page.waitForSelector("[data-c5-closed]");
      check("fixture: stopped_acute with pop pre-filled", (await sessionsOf(C))[0].training_status === "stopped_acute" && (await immediateOf(sid)).pop_felt_or_heard === true);
      check("no escalation yet at Stop (evaluated with the check-in)", (await evalsOf(sid)).length === 0);

      await page.getByRole("link", { name: "Continue to check-in" }).click();
      await page.waitForSelector("[data-c5-immediate-form]");
      const popQ = page.locator('[data-safety-question="pop_felt_or_heard"]');
      check("12. the reported pop is shown as already reported", (await popQ.locator("[data-recorded-safety]").count()) === 1);
      check("13. the form offers no way to change it to No", (await popQ.getByRole("radio").count()) === 0);
      const conflict = await submitImmediate(ctxC, sid, { peak_session_pain: 3, overall_session_rpe: 4, sudden_or_sharp_pain: false, pop_felt_or_heard: false, new_functional_difficulty: false });
      check("13. the API refuses to downgrade the recorded pop", conflict.body?.result === "recorded_safety_fact_conflict" && (await immediateOf(sid)).pop_felt_or_heard === true && (await immediateOf(sid)).resolved_at === null);

      await page.getByTestId("pain-unknown").click();
      await pick(page, "rpe", 5);
      await answer(page, "sudden_or_sharp_pain", false);
      await answer(page, "new_functional_difficulty", false);
      await page.getByRole("button", { name: "Submit check-in" }).click();
      await page.waitForSelector("[data-c5-checkin-saved]");
      const imm = await immediateOf(sid);
      check("12. pop preserved through submission; pain NULL (unable to recall)", imm.pop_felt_or_heard === true && imm.peak_session_pain === null && imm.peak_pain_unable_to_recall && imm.overall_session_rpe === 5);
      const ev = await evalsOf(sid);
      const eps = await episodesOf(C);
      check("16. established rule: pop -> Level 5 evaluation", ev.length === 1 && ev[0].escalation_level === 5 && ev[0].escalation_reason === "pop_felt_or_heard");
      check("14. reconciliation ran after the submission committed: one Level 5 episode", eps.length === 1 && eps[0].initial_level === 5 && eps[0].source_escalation_evaluation_id === ev[0].id);
      const savedText = await page.locator("[data-c5-checkin-saved]").textContent();
      check("16. next screen shows the real safety state (training on hold)", savedText.includes("Training is on hold"), savedText);
      check("44. no diagnosis / notification claim in the safety outcome", !FORBIDDEN_COPY.test(savedText), savedText);
      const retry = await submitImmediate(ctxC, sid, { peak_pain_unable_to_recall: true, overall_session_rpe: 5, sudden_or_sharp_pain: false, new_functional_difficulty: false });
      check("38. lost-response retry: replayed, no second evaluation or episode", retry.body?.replayed === true && (await evalsOf(sid)).length === 1 && (await episodesOf(C)).length === 1);
      if (SHOTS) await layoutCheck(page, "desktop-safety-outcome");
      await page.close();
      await ctxC.close();
    }

    // ======================================================================
    section("D. Due morning check-in (UI) -> fresh state");
    {
      const D = await makeFixture("morning");
      const sid = priorSessionMorningDue(D, 0);
      const ctxD = await login(browser, D.email, MOBILE);
      const sM = await state(ctxD);
      check("34. due morning response blocks new training", sM?.kind === "morning_response_required");
      const page = await ctxD.newPage();
      await page.goto(`${ON}/patient/dashboard`);
      await page.getByRole("link", { name: "Start check-in" }).click();
      await page.waitForSelector("[data-c5-morning-form]");
      check("timely morning is asked about 'this morning'", (await page.locator("h1").textContent()).includes("this morning"));
      const submit = page.getByRole("button", { name: "Submit check-in" });
      await pick(page, "morning-pain", 2);
      await pick(page, "morning-stiffness", 0);
      check("27. stiffness 0: no duration question", (await page.locator("[data-stiffness-duration]").count()) === 0 && !(await submit.isDisabled()));
      await pick(page, "morning-stiffness", 4);
      check("26. stiffness > 0: duration required before submit", (await page.locator("[data-stiffness-duration]").count()) === 1 && (await submit.isDisabled()));
      await page.getByRole("radio", { name: "5–15 minutes" }).click();
      await page.locator("#c5-morning-note").fill("Felt tight first thing");
      await layoutCheck(page, "mobile-morning-form");
      await submit.click();
      await page.waitForSelector("[data-c5-checkin-saved]");
      const mr = await morningOf(sid);
      check("24/25. morning pain + stiffness + duration + note stored", mr.resolution === "answered" && mr.next_morning_pain === 2 && mr.next_morning_stiffness === 4 && mr.stiffness_duration === "min_5_15" && mr.patient_note === "Felt tight first thing");
      check("31. submitted_at = actual submission time; reference morning unchanged", mr.submitted_at !== null && mr.reference_local_date === localDate(0));
      const savedText = await page.locator("[data-c5-checkin-saved]").textContent();
      check("35. with everything resolved the server offers the next workout", savedText.includes("Your workout is ready"), savedText);
      if (SHOTS) {
        await page.setViewportSize(DESKTOP);
        await page.goto(`${ON}/patient/check-in`);
      }
      await page.close();
      await ctxD.close();

      const E = await makeFixture("retro");
      const sidE = priorSessionMorningDue(E, -2);
      const ctxE = await login(browser, E.email);
      const pageE = await ctxE.newPage();
      await pageE.goto(`${ON}/patient/check-in`);
      await pageE.waitForSelector("[data-c5-morning-form]");
      const heading = await pageE.locator("h1").textContent();
      check("30. retrospective morning is asked about its reference morning, not today", heading.includes("on the morning of") && !heading.includes("this morning"), heading);
      await pick(pageE, "morning-pain", 1);
      await pick(pageE, "morning-stiffness", 3);
      await layoutCheck(pageE, "desktop-morning-form");
      await pageE.getByRole("button", { name: "I don’t remember" }).click();
      await pageE.getByRole("button", { name: "Yes, I don’t remember" }).click();
      await pageE.waitForSelector("[data-c5-checkin-saved]");
      const mE = await morningOf(sidE);
      check("28/29. 'I don't remember' stores NULL values and resolves the obligation (entered scores discarded)", mE.resolution === "unable_to_recall" && mE.next_morning_pain === null && mE.next_morning_stiffness === null && mE.stiffness_duration === null && mE.submitted_at !== null);
      check("30. reference_local_date kept as the original morning", mE.reference_local_date === localDate(-2), mE.reference_local_date);
      const sub = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(mE.submitted_at));
      check("32. delay is derivable from stored facts (submitted 2 local days after the reference morning)", (Date.parse(sub) - Date.parse(mE.reference_local_date)) / 86400000 === 2, `${sub} vs ${mE.reference_local_date}`);
      await pageE.close();
      await ctxE.close();
    }

    // ======================================================================
    section("E. Brake stays independent of response resolution; static checks");
    {
      const F = await makeFixture("brake-indep");
      const ctxF = await login(browser, F.email);
      const sid = await startAndClose(ctxF, F, "finish");
      const r = await submitImmediate(ctxF, sid, { peak_session_pain: 2, overall_session_rpe: 4, sudden_or_sharp_pain: true, pop_felt_or_heard: false, new_functional_difficulty: false });
      check("16. sudden/sharp pain -> Level 3 -> review required", (await evalsOf(sid))[0]?.escalation_level === 3 && r.body?.state?.kind === "acute_blocked" && r.body.state.gate === "acute_safety_review_required", JSON.stringify(r.body?.state));
      const checkIns = r.body?.checkIns;
      check("36. immediate resolved, morning not yet due, brake still blocks", checkIns?.immediate?.length === 0 && (await state(ctxF))?.kind === "acute_blocked");
      await ctxF.close();

      const files = [
        "lib/c5ResponseServer.ts",
        "lib/c5ResponseTypes.ts",
        "app/api/patient/c5/check-ins/route.ts",
        "app/api/patient/c5/check-ins/immediate/[sessionId]/route.ts",
        "app/api/patient/c5/check-ins/morning/[sessionId]/route.ts",
        "app/patient/check-in/page.tsx",
        "app/patient/check-in/components/C5CheckInFlow.tsx",
        "app/patient/check-in/components/C5ImmediateForm.tsx",
        "app/patient/check-in/components/C5MorningForm.tsx",
        "app/patient/check-in/components/ScoreScale.tsx",
        "app/patient/dashboard/components/C5TodaysRehabCard.tsx",
        "app/patient/session/components/c5/C5SessionRunner.tsx",
      ];
      const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
      const writers = files.filter((f) => /\.from\([^)]*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/.test(src[f]));
      check("41. no direct response-table writes (RPCs only)", writers.length === 0, writers.join(", "));
      const browserFiles = files.filter((f) => f.includes("components/") || f.endsWith("Types.ts"));
      const talksToDb = browserFiles.filter((f) => /supabase|createClient|\.rpc\(/.test(src[f]));
      check("41. browser code never talks to Supabase", talksToDb.length === 0, talksToDb.join(", "));
      const badCopy = files.filter((f) => FORBIDDEN_COPY.test(src[f].replace(/\/\/.*$/gm, "")));
      check("44. no notification / clearance / diagnostic claims in the new UI copy", badCopy.length === 0, badCopy.join(", "));
      const rpeMapping = /(Very Easy|Moderate|Hard|Very Hard)["']?\s*[:=]\s*\d|\d\s*[:=]\s*["'](Very Easy|Moderate|Hard|Very Hard)/.test(Object.values(src).join("\n"));
      check("10. RPE anchor words are not mapped to numbers anywhere", !rpeMapping);
      const thresholds = /(peak_session_pain|overall_session_rpe|next_morning_pain|next_morning_stiffness|pain|rpe)\s*(>=|>|<=|<)\s*\d/i.test(src["lib/c5ResponseServer.ts"] + src["app/patient/check-in/components/C5CheckInFlow.tsx"]);
      check("17/18. no pain / RPE threshold logic in the response path", !thresholds);
    }
    await ctxA.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  fail++;
  console.log(`FAIL  unexpected error: ${e?.stack ?? e}`);
} finally {
  try {
    await teardown();
  } catch (e) {
    fail++;
    console.log(`FAIL  teardown: ${e.message}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
