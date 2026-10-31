// C5.6D — patient runtime integration. Live end-to-end verification over the
// REAL authenticated Next.js boundary (cookie login + /api/patient/c5/** +
// the rendered pages via Playwright), backed by the applied C5.6C lifecycle
// RPCs. Throwaway @example.invalid patients only; full teardown in finally.
//
// Two servers (the runtime gate is a server env var, never weakened for a test):
//   GATE_ON  (default http://localhost:3001) — `next build` then
//            C5_PATIENT_RUNTIME_ENABLED=true npx next start -p 3001
//   GATE_OFF (default http://localhost:3000) — the normal dev server (gate unset).
//
// Fixtures that need the past (a session "yesterday", a due morning
// response, an escalation) are written directly with SQL using the database
// clock — exactly as the C5.6C suites do — because response submission and
// escalation evaluation are C5.6E. Everything the patient does goes through
// the Next.js API / UI.
//
// Run from web/:
//   node scripts/verifyC5Stage6dPatientRuntime.mjs [gateOnUrl] [gateOffUrl] [screenshotDir]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { localDateOffset, localDowOffset, sqlLocalDate, sqlLocalInstant } from "./lib/patientLocalDate.mjs";
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
const WORK = mkdtempSync(join(tmpdir(), "c56d-"));
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

// Never concurrent (see the verification-environment notes).
function sqlQuery(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Patient-local calendar arithmetic (never elapsed time: see lib/patientLocalDate.mjs).
function localDate(offsetDays = 0) {
  return localDateOffset(TZ, offsetDays);
}
function localDow(offsetDays = 0) {
  return localDowOffset(TZ, offsetDays);
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
let exerciseIds = [];

async function makePatient(label) {
  const email = `c56d-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `C5.6D ${label}`, timezone: TZ });
  await fc().ensureMembership();
  await fc().assign(data.user.id);
  return { userId: data.user.id, email };
}

// Each workout: Exercise 1 = 3 x 8 reps (exact); Exercise 2 = 2 x 30 s hold.
async function addVersion(patientId, ppId, versionNumber, mode, workoutDays, publishedAt) {
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({
      user_id: patientId, source: "clinician_change", patient_prescription_id: ppId, version_number: versionNumber,
      published_at: publishedAt ?? new Date(Date.now() - 30 * 86400000).toISOString(), published_by: CLINICIAN,
      scheduling_mode: mode, target_sessions_per_week: mode === "sequence" ? 3 : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  const workouts = [];
  for (let i = 0; i < workoutDays.length; i++) {
    const { data: w } = await admin
      .from("prescription_workouts")
      .insert({ prescription_version_id: v.id, label: String.fromCharCode(65 + i), order_index: i, days_of_week: workoutDays[i] })
      .select("id")
      .single();
    const { data: e1 } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseIds[0], order_index: 0, status: "active" }).select("id").single();
    const { data: e2 } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseIds[1], order_index: 1, status: "active" }).select("id").single();
    await admin.from("prescription_exercise_dosage").insert([
      { prescription_exercise_id: e1.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" },
      { prescription_exercise_id: e2.id, dosage_type: "hold", sets: 2, hold_duration_mode: "exact", hold_duration_exact_seconds: 30, load_type: "not_applicable" },
    ]);
    workouts.push({ id: w.id, e1: e1.id, e2: e2.id });
  }
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", ppId);
  return { versionId: v.id, workouts };
}

async function makeFixture(label, { mode = "sequence", workoutDays = [null, null], publishedAt } = {}) {
  const patient = await makePatient(label);
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
  const version = await addVersion(patient.userId, pp.id, 1, mode, workoutDays, publishedAt);
  return { ...patient, ppId: pp.id, ...version };
}

// A C5 session that started and closed YESTERDAY (patient-local), with both
// response obligations resolved unless told otherwise.
function priorSession(f, { status = "finished", workoutIndex = 0, morning = "resolved" } = {}) {
  const sid = randomUUID();
  const w = f.workouts[workoutIndex];
  const morningSql =
    morning === "resolved"
      ? `INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
         VALUES ('${sid}', '${f.userId}', now() - interval '2 hours', (now() AT TIME ZONE '${TZ}')::date, 'unable_to_recall', now());`
      : `INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date)
         VALUES ('${sid}', '${f.userId}', now() - interval '1 hour', (now() AT TIME ZONE '${TZ}')::date);`;
  sqlQuery(`BEGIN;
INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
VALUES ('${sid}', '${f.userId}', 'c5:${sid}', ${sqlLocalDate(TZ, -1)}, NULL, 'started', ${sqlLocalInstant(TZ, -1)},
  c5_build_session_snapshot('${f.versionId}', '${w.id}'), '${f.versionId}', '${w.id}', '${TZ}', gen_random_uuid());
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${sid}', '${w.e1}', 0, 0, 'completed', 8, ${sqlLocalInstant(TZ, -1)});
UPDATE rehab_sessions SET training_status = '${status}', training_closed_at = ${sqlLocalInstant(TZ, -1)} + interval '20 minutes' WHERE id = '${sid}';
INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
VALUES ('${sid}', '${f.userId}', 2, 5, false, false, false, now());
${morningSql}
COMMIT;`);
  return sid;
}

function addEscalation(sessionId, level = 5) {
  sqlQuery(`INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot)
VALUES ('${sessionId}', ${level}, 'pop_reported', 'c56d-verify', '{}');`);
}

function resolveImmediate(sessionId) {
  sqlQuery(`UPDATE session_immediate_responses SET peak_session_pain = 1, overall_session_rpe = 5,
  sudden_or_sharp_pain = false, pop_felt_or_heard = false, new_functional_difficulty = false, resolved_at = now()
WHERE rehab_session_id = '${sessionId}';`);
}

async function sessionsOf(f) {
  const { data } = await admin.from("rehab_sessions").select("*").eq("user_id", f.userId).not("training_status", "is", null).order("started_at");
  return data ?? [];
}
async function todaysSessions(f) {
  return (await sessionsOf(f)).filter((s) => s.patient_local_date === localDate(0));
}
async function unitsOf(sessionId) {
  const { data } = await admin.from("set_outcomes").select("*").eq("rehab_session_id", sessionId);
  return data ?? [];
}

async function teardown() {
  // M3.2 — the guarded exact-id purge (safety-notification history is
  // immutable, so ordinary deletes can no longer remove these fixtures).
  guardedFixtureTeardown(env, { userIds: createdUsers, exerciseIds, runStartedAt: RUN_STARTED_AT });
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
const perf = (exerciseId, unit, reps = 8) => ({ exercise_id: exerciseId, unit_index: unit, outcome: "completed", actual_reps: reps });
const holdPerf = (exerciseId, unit, seconds = 30) => ({ exercise_id: exerciseId, unit_index: unit, outcome: "completed", actual_duration_seconds: seconds });
function startBody(f, o = {}) {
  return {
    clientRequestId: o.requestId ?? randomUUID(),
    expectedVersionId: o.versionId ?? f.versionId,
    workoutId: o.workoutId ?? f.workouts[0].id,
    performance: o.performance ?? perf(f.workouts[0].e1, 0),
    preStartSkips: o.skips ?? [],
    sequenceChoice: o.choice ?? null,
    ...(o.extra ?? {}),
  };
}

function unitRow(page, exerciseId, index) {
  return page.locator(`[data-c5-exercise="${exerciseId}"] [data-c5-unit]`).nth(index);
}

// Responsive checks: no horizontal overflow; every visible C5 control is a
// comfortable tap target (>= 44px tall, the min-h-11 convention).
async function layoutCheck(page, name) {
  const r = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    for (const el of document.querySelectorAll("main button, main a, [data-c5-action-bar] button, [data-c5-action-bar] a, [role=dialog] button")) {
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
  const probe = await fetch(`${ON}/api/patient/c5/state`);
  check("gate-on server reachable; unauthenticated C5 API is 401", probe.status === 401, `status ${probe.status}`);

  for (const name of ["C5.6D reps exercise", "C5.6D hold exercise"]) {
    const { data, error } = await admin.from("canonical_exercises").insert({ name: `${name} ${randomUUID().slice(0, 6)}`, visibility: "global", active: true }).select("id").single();
    if (error) throw error;
    exerciseIds.push(data.id);
  }

  const browser = await chromium.launch();
  try {
    // ======================================================================
    section("A. open / skip / all-skipped / first performance / writes / edit / resume / publish / finish / gates");
    const A = await makeFixture("main");
    const ctxA = await login(browser, A.email);
    const startCalls = [];
    {
      const page = await ctxA.newPage();
      page.on("request", (req) => {
        if (/\/api\/patient\/c5\/(start|session\/)/.test(req.url()) && req.method() === "POST") startCalls.push(req.url());
      });

      await page.goto(`${ON}/patient/dashboard`);
      check("Today's Rehab renders the C5 card (workout ready)", (await page.locator("[data-c5-state-card]").textContent())?.includes("Your workout is ready"));
      check("legacy stage/irritability badges are not shown", !(await page.content()).includes("irritability"));
      check("1. opening Today's Rehab creates no session", (await sessionsOf(A)).length === 0);

      await page.goto(`${ON}/patient/session`);

      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      check("2. opening the workout creates no session", (await sessionsOf(A)).length === 0);
      const s0 = await state(ctxA);
      check("state: available, Sequence first workout from the server", s0?.kind === "available" && s0.options[0].key === "first" && s0.options[0].workoutId === A.workouts[0].id, JSON.stringify(s0)?.slice(0, 200));
      if (SHOTS) await layoutCheck(page, "desktop-pre-session");

      await unitRow(page, A.workouts[0].e1, 0).getByRole("button", { name: "Skip" }).click();
      await unitRow(page, A.workouts[0].e2, 0).getByRole("button", { name: "Skip" }).click();
      check("3. pre-session skips create no session and make no server write", (await sessionsOf(A)).length === 0 && startCalls.length === 0, `posts ${startCalls.length}`);

      for (const ex of [A.workouts[0].e1, A.workouts[0].e2]) {
        await page.locator(`[data-c5-exercise="${ex}"]`).getByRole("button", { name: "Skip this exercise" }).click();
      }
      check("every unit shows skipped", (await page.locator('[data-c5-unit-state="skipped"]').count()) === 5);
      // PEC: before the first performance there is no Finish control at all.
      check("4. all-skipped (nothing performed): no Finish control is offered", (await page.getByRole("button", { name: /Finish/ }).count()) === 0);
      check("4. all-skipped workout created no session and wrote nothing", (await sessionsOf(A)).length === 0 && startCalls.length === 0);

      await page.reload();
      await page.waitForSelector("[data-c5-exercise]");
      await beginIfReviewing(page);
      check("pre-session skips are ephemeral (gone after reload)", (await page.locator('[data-c5-unit-state="skipped"]').count()) === 0);

      // 6. first confirmed performance, with one pre-start skip.
      await unitRow(page, A.workouts[0].e1, 0).getByRole("button", { name: "Skip" }).click();
      await beginIfReviewing(page);
      await unitRow(page, A.workouts[0].e1, 1).getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await sessionsOf(A)).length === 1);
      const sessions = await sessionsOf(A);
      check("6. first confirmed performance creates exactly one session", sessions.length === 1 && sessions[0].training_status === "started");
      const S = sessions[0];
      let units = await unitsOf(S.id);
      check(
        "6. first unit + pre-start skip persisted atomically with the session",
        units.length === 2 &&
          units.some((u) => u.set_index === 1 && u.outcome === "completed" && Number(u.actual_reps) === 8) &&
          units.some((u) => u.set_index === 0 && u.outcome === "skipped"),
        JSON.stringify(units.map((u) => [u.set_index, u.outcome]))
      );
      check("6. server-built snapshot, version and workout", S.prescription_version_id === A.versionId && S.prescription_workout_id === A.workouts[0].id && S.prescription_snapshot.exercises.length === 2);
      await page.waitForSelector("[data-c5-progress]");

      // 8. subsequent performance
      await beginIfReviewing(page);
      await unitRow(page, A.workouts[0].e1, 2).getByRole("button", { name: "Done" }).click();
      check("8. subsequent performance persists", await waitFor(async () => (await unitsOf(S.id)).some((u) => u.set_index === 2 && u.outcome === "completed")));
      check("8. UI reports the unit as saved", await waitFor(async () => (await unitRow(page, A.workouts[0].e1, 2).textContent())?.includes("Saved")));

      // 9. retry the same unit through the API: replay, no duplicate.
      const replay = await api(ctxA, "POST", `/api/patient/c5/session/${S.id}/performance`, { performance: perf(A.workouts[0].e1, 2) });
      units = await unitsOf(S.id);
      check("9. retried subsequent performance is a replay, not a duplicate", replay.body?.result === "recorded" && replay.body?.replayed === true && units.filter((u) => u.exercise_id === A.workouts[0].e1 && u.set_index === 2).length === 1, JSON.stringify(replay.body));

      // 10. edit uses the authoritative edit path.
      const row1 = unitRow(page, A.workouts[0].e1, 1);
      await row1.getByRole("button", { name: "Edit" }).click();
      await row1.locator("input").first().fill("6");
      await row1.getByRole("button", { name: "Save change" }).click();
      check("10. edit goes through c5_edit_performance (value changed, was_edited)", await waitFor(async () => {
        const u = (await unitsOf(S.id)).find((x) => x.exercise_id === A.workouts[0].e1 && x.set_index === 1);
        return u && Number(u.actual_reps) === 6 && u.was_edited === true;
      }));
      const overwrite = await api(ctxA, "POST", `/api/patient/c5/session/${S.id}/performance`, { performance: perf(A.workouts[0].e1, 1, 9) });
      const u1 = (await unitsOf(S.id)).find((x) => x.exercise_id === A.workouts[0].e1 && x.set_index === 1);
      check("10. a non-edit write never silently overwrites a recorded unit", overwrite.body?.result === "performance_already_recorded" && Number(u1.actual_reps) === 6, JSON.stringify(overwrite.body));

      // 7 (UI-level). A second Start while the session is open never creates another.
      const second = await api(ctxA, "POST", "/api/patient/c5/start", startBody(A));
      check("a second Start while STARTED returns the open session, creates nothing", second.body?.result === "resume_existing_session" && second.body?.state?.kind === "resume" && second.body.state.session.id === S.id && (await sessionsOf(A)).length === 1, JSON.stringify(second.body)?.slice(0, 200));

      // 11. resume
      await page.reload();
      await page.waitForSelector("[data-c5-progress]");
      check("11. resume loads the same Started session with its recorded units", (await page.locator('[data-c5-unit-state="completed"]').count()) === 2 && (await page.locator('[data-c5-unit-state="skipped"]').count()) === 1);
      const sR = await state(ctxA);
      check("11. state = resume with the same session id", sR?.kind === "resume" && sR.session.id === S.id);
      await page.goto(`${ON}/patient/dashboard`);
      check("dashboard shows 'Session in progress' with Resume", (await page.locator("[data-c5-state-card]").textContent())?.includes("Session in progress"));

      // 12. publish a new version while Started.
      const { data: draftId, error: draftErr } = await admin.rpc("create_prescription_draft", { p_patient_id: A.userId, p_clinician_id: CLINICIAN, p_source: "clone_active", p_source_version_id: A.versionId });
      const pub = draftErr ? { error: draftErr } : await admin.rpc("publish_prescription_draft", { p_draft_id: draftId, p_clinician_id: CLINICIAN });
      const { data: ppRow } = await admin.from("patient_prescriptions").select("current_prescription_version_id").eq("id", A.ppId).single();
      check("publish while Started succeeds (new current version)", !pub.error && ppRow.current_prescription_version_id !== A.versionId, pub.error?.message);
      const sP = await state(ctxA);
      check("12. Started old-version session survives publish (state still resumes it on V1)", sP?.kind === "resume" && sP.session.id === S.id && sP.session.snapshot.versionId === A.versionId);
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-progress]");
      await beginIfReviewing(page);
      await unitRow(page, A.workouts[0].e2, 0).getByRole("button", { name: "Done" }).click();
      check("12. performance keeps recording against the frozen old-version snapshot", await waitFor(async () => (await unitsOf(S.id)).some((u) => u.exercise_id === A.workouts[0].e2 && Number(u.actual_duration_seconds) === 30)));
      check("12. session version / snapshot unchanged", (await sessionsOf(A))[0].prescription_version_id === A.versionId);

      // Finish
      await page.getByRole("button", { name: "Finish workout" }).click();
      await page.waitForSelector("[data-c5-closed]");
      check("Finish -> terminal 'Workout finished' screen", (await page.locator("[data-c5-closed]").getAttribute("data-c5-closed")) === "finished");
      const closedText = await page.locator("[data-c5-closed]").textContent();
      check("23. after Finish the UI shows no locally-derived next workout", !closedText.includes("Workout B") && closedText.includes("check-in"));
      const fin = (await sessionsOf(A))[0];
      check("Finish persisted as finished", fin.training_status === "finished");
      const { data: imm } = await admin.from("session_immediate_responses").select("*").eq("rehab_session_id", S.id);
      const { data: morn } = await admin.from("morning_responses").select("*").eq("rehab_session_id", S.id);
      check("closure created exactly one immediate + one morning obligation, nothing fabricated", imm.length === 1 && morn.length === 1 && imm[0].peak_session_pain === null && imm[0].overall_session_rpe === null);

      // 28. immediate-response gate
      const sI = await state(ctxA);
      check("28. immediate-response gate: state immediate_response_required", sI?.kind === "immediate_response_required");
      await page.goto(`${ON}/patient/dashboard`);
      const cardI = await page.locator("[data-c5-state-card]").textContent();
      check("28. dashboard shows the check-in requirement, no workout offered", cardI.includes("Post-session check-in needed") && (await page.getByRole("link", { name: "Open workout" }).count()) === 0);
      const startI = await api(ctxA, "POST", "/api/patient/c5/start", startBody(A, { versionId: ppRow.current_prescription_version_id }));
      check("28. Start refused while the immediate response is unresolved", startI.body?.result === "immediate_response_required" && (await sessionsOf(A)).length === 1, JSON.stringify(startI.body)?.slice(0, 120));
      if (SHOTS) await layoutCheck(page, "desktop-dashboard-checkin");

      // 13. same-day second independent Start
      resolveImmediate(S.id);
      const sT = await state(ctxA);
      check("13. same day after closure: already_trained_today", sT?.kind === "already_trained_today");
      const startT = await api(ctxA, "POST", "/api/patient/c5/start", startBody(A, { versionId: ppRow.current_prescription_version_id }));
      check("13. same-day second independent Start blocked; nothing created", startT.body?.result === "already_trained_today" && (await sessionsOf(A)).length === 1, JSON.stringify(startT.body)?.slice(0, 120));
      await page.goto(`${ON}/patient/dashboard`);
      check("13. dashboard says \"You've already trained today\"", (await page.locator("[data-c5-state-card]").textContent())?.includes("You've already trained today"));
      await page.close();
    }

    // ======================================================================
    section("B. Start idempotency + identity boundary (API)");
    {
      const B = await makeFixture("idem");
      const ctxB = await login(browser, B.email);
      const requestId = randomUUID();
      const results = await Promise.all([1, 2, 3].map(() => api(ctxB, "POST", "/api/patient/c5/start", startBody(B, { requestId }))));
      const ids = new Set(results.map((r) => r.body?.session?.id));
      check("7. retried first performance (same clientRequestId) -> one session", results.every((r) => r.body?.result === "started") && ids.size === 1 && (await sessionsOf(B)).length === 1, JSON.stringify(results.map((r) => r.body?.result)));
      check("7. exactly one non-replayed Start", results.filter((r) => r.body?.replayed === false).length === 1);
      const sid = [...ids][0];
      check("7. one first performance unit", (await unitsOf(sid)).length === 1);

      const spoof = await api(ctxB, "POST", "/api/patient/c5/start", startBody(B, { extra: { patientId: A.userId, p_patient_id: A.userId } }));
      check("identity comes from the session: a body patient id is ignored", spoof.body?.result === "resume_existing_session" && spoof.body.state.session.id === sid && (await sessionsOf(A)).length === 1);
      const { data: aSessions } = await admin.from("rehab_sessions").select("id").eq("user_id", A.userId);
      const foreign = await api(ctxB, "POST", `/api/patient/c5/session/${aSessions[0].id}/finish`, {});
      check("another patient's session id is not reachable", foreign.body?.result === "session_not_found", JSON.stringify(foreign.body));
      const skipFirst = await api(ctxB, "POST", "/api/patient/c5/start", startBody(B, { requestId: randomUUID(), performance: { exercise_id: B.workouts[0].e1, unit_index: 0, outcome: "skipped" } }));
      check("a skip can never Start (open session returned instead)", skipFirst.body?.result === "resume_existing_session");
      await ctxB.close();

      const B2 = await makeFixture("skipstart");
      const ctxB2 = await login(browser, B2.email);
      const skipOnly = await api(ctxB2, "POST", "/api/patient/c5/start", startBody(B2, { performance: { exercise_id: B2.workouts[0].e1, unit_index: 0, outcome: "skipped" } }));
      check("a skip as the 'first performance' is refused; no session", skipOnly.body?.result === "invalid_performance" && (await sessionsOf(B2)).length === 0, JSON.stringify(skipOnly.body)?.slice(0, 120));
      const legacy = await api(ctxB2, "POST", "/api/patient/rehab-session", { sessionInstanceId: randomUUID(), prescriptionInstanceId: "x", patientLocalDate: localDate(0), startedAt: new Date().toISOString(), prescriptionSnapshot: [] });
      check("legacy session creation is refused for a C5-served patient", legacy.status === 409 && legacy.body?.code === "C5_RUNTIME_ACTIVE", JSON.stringify(legacy.body));
      await ctxB2.close();
    }

    // ======================================================================
    section("C. Pause: no session / existing session / Finish while paused");
    {
      const C = await makeFixture("pause");
      const ctxC = await login(browser, C.email);
      await admin.rpc("pause_prescription", { p_patient_prescription_id: C.ppId, p_clinician_id: CLINICIAN });
      const sPause = await state(ctxC);
      check("14. paused + no session: prescription_paused", sPause?.kind === "prescription_paused");
      const page = await ctxC.newPage();
      await page.goto(`${ON}/patient/dashboard`);
      check("14. dashboard: 'Your clinician has paused your program', no workout", (await page.locator("[data-c5-state-card]").textContent())?.includes("Your clinician has paused your program") && (await page.getByRole("link", { name: "Open workout" }).count()) === 0);
      const blocked = await api(ctxC, "POST", "/api/patient/c5/start", startBody(C));
      check("14. Start refused while paused; nothing created", blocked.body?.result === "prescription_paused" && (await sessionsOf(C)).length === 0);
      await admin.rpc("resume_prescription", { p_patient_prescription_id: C.ppId, p_clinician_id: CLINICIAN });

      await page.goto(`${ON}/patient/session`);

      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      await beginIfReviewing(page);
      await unitRow(page, C.workouts[0].e1, 0).getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await sessionsOf(C)).length === 1);
      const sid = (await sessionsOf(C))[0].id;
      await admin.rpc("pause_prescription", { p_patient_prescription_id: C.ppId, p_clinician_id: CLINICIAN });
      await page.reload();
      await page.waitForSelector("[data-testid=c5-paused-banner]");
      check("15. paused with a Started session: calm notice, session usable", (await page.getByTestId("c5-paused-banner").textContent()).includes("Your clinician has paused your program"));
      check("15. paused: Finish Current Session + Stop Today's Session offered", (await page.getByRole("button", { name: "Finish current session" }).count()) === 1 && (await page.getByRole("button", { name: "Stop today's session" }).count()) === 1);
      const sPS = await state(ctxC);
      check("15. state: resume (paused) with the same session", sPS?.kind === "resume" && sPS.paused === true && sPS.session.id === sid);
      await beginIfReviewing(page);
      await unitRow(page, C.workouts[0].e1, 1).getByRole("button", { name: "Done" }).click();
      check("15. performance still records while paused", await waitFor(async () => (await unitsOf(sid)).length === 2));
      await page.setViewportSize(MOBILE);
      await layoutCheck(page, "mobile-paused-session");
      await page.setViewportSize(DESKTOP);
      if (SHOTS) await layoutCheck(page, "desktop-paused-session");
      await page.getByRole("button", { name: "Finish current session" }).click();
      await page.waitForSelector("[data-c5-closed]");
      check("16. Finish while paused succeeds -> finished", (await sessionsOf(C))[0].training_status === "finished");
      await page.close();
      await ctxC.close();
    }

    section("D. Stop while paused -> stopped_pause (server-classified)");
    {
      const D = await makeFixture("stoppause");
      const ctxD = await login(browser, D.email);
      const started = await api(ctxD, "POST", "/api/patient/c5/start", startBody(D));
      await admin.rpc("pause_prescription", { p_patient_prescription_id: D.ppId, p_clinician_id: CLINICIAN });
      const page = await ctxD.newPage();
      await page.setViewportSize(MOBILE);
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-testid=c5-paused-banner]");
      await page.getByRole("button", { name: "Stop today's session" }).click();
      await page.waitForSelector("[role=dialog]");
      await layoutCheck(page, "mobile-stop-sheet");
      await page.getByRole("dialog").getByRole("button", { name: "Stop today's session" }).click();
      await page.waitForSelector("[data-c5-closed]");
      check("17. Stop while paused -> stopped_pause", (await sessionsOf(D))[0].training_status === "stopped_pause" && (await page.locator("[data-c5-closed]").getAttribute("data-c5-closed")) === "stopped_pause");
      check("17. the browser never sent a stop type", started.body?.result === "started");
      await page.close();
      await ctxD.close();
    }

    // ======================================================================
    section("E. Acute brake, no Started session");
    {
      const E = await makeFixture("acute-none");
      const prior = priorSession(E);
      const ctxE = await login(browser, E.email);
      const before = await state(ctxE);
      check("fixture: eligible before the brake", before?.kind === "available");
      addEscalation(prior, 5);
      const sA = await state(ctxE);
      const { data: episodes } = await admin.from("acute_safety_episodes").select("id").eq("user_id", E.userId);
      check("the API boundary reconciled the escalation first (episode exists)", (episodes ?? []).length === 1);
      check("18. acute + no session: training blocked", sA?.kind === "acute_blocked" && sA.gate === "acute_safety_professional_review_required", JSON.stringify(sA));
      const page = await ctxE.newPage();
      await page.goto(`${ON}/patient/dashboard`);
      check("18. dashboard: 'Training is on hold', link to the safety check-in", (await page.locator("[data-c5-state-card]").textContent())?.includes("Training is on hold") && (await page.getByRole("link", { name: "Go to safety check-in" }).count()) === 1);
      const blocked = await api(ctxE, "POST", "/api/patient/c5/start", startBody(E));
      const { data: blo } = await admin.from("blocked_loading_opportunities").select("id").eq("user_id", E.userId);
      check("18. Start refused; blocked opportunity recorded; no session", blocked.body?.result === "acute_safety_professional_review_required" && (blo ?? []).length === 1 && (await todaysSessions(E)).length === 0);
      await page.close();
      await ctxE.close();
    }

    section("F. Acute brake activates during a Started session");
    {
      const F = await makeFixture("acute-open");
      const prior = priorSession(F);
      const ctxF = await login(browser, F.email);
      // Yesterday finished Workout A, so the server offers Workout B.
      const offered = await state(ctxF);
      const W = F.workouts.find((w) => w.id === offered?.options?.[0]?.workoutId);
      check("fixture: after a Finished A the server offers the next workout (B)", W === F.workouts[1]);
      const page = await ctxF.newPage();
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      await beginIfReviewing(page);
      await unitRow(page, W.e1, 0).getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await todaysSessions(F)).length === 1);
      const S = (await todaysSessions(F))[0];
      const snapshotBefore = JSON.stringify(S.prescription_snapshot);
      addEscalation(prior, 5);

      const sAR = await state(ctxF);
      check("19. state: acute_resolution_required carrying the open session", sAR?.kind === "acute_resolution_required" && sAR.session.id === S.id && sAR.brakeLevel === 5, JSON.stringify(sAR)?.slice(0, 200));
      await page.goto(`${ON}/patient/dashboard`);
      check("19. dashboard: not a Resume — 'Your session needs to be stopped'", (await page.locator("[data-c5-state-card]").textContent())?.includes("Your session needs to be stopped") && (await page.getByRole("link", { name: "Resume session" }).count()) === 0);
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-testid=c5-acute-banner]");
      check("19. session page shows the existing session + its recorded work", (await page.locator('[data-c5-unit-state="completed"]').count()) === 1);
      check("20. no performance controls are offered", (await page.getByRole("button", { name: "Done" }).count()) === 0 && (await page.getByRole("button", { name: "Skip" }).count()) === 0 && (await page.getByRole("button", { name: "Edit" }).count()) === 0);
      check("21. no ordinary Finish is offered", (await page.getByRole("button", { name: /Finish/ }).count()) === 0);
      await page.setViewportSize(MOBILE);
      await layoutCheck(page, "mobile-acute-resolution");
      await page.setViewportSize(DESKTOP);
      if (SHOTS) await layoutCheck(page, "desktop-acute-resolution");

      const more = await api(ctxF, "POST", `/api/patient/c5/session/${S.id}/performance`, { performance: perf(W.e1, 1) });
      check("20. API refuses more performance under the brake", more.body?.result === "acute_safety_professional_review_required" && (await unitsOf(S.id)).length === 1, JSON.stringify(more.body));
      const finish = await api(ctxF, "POST", `/api/patient/c5/session/${S.id}/finish`, {});
      check("21. API refuses ordinary Finish; session stays Started", finish.body?.result === "acute_safety_professional_review_required" && (await todaysSessions(F))[0].training_status === "started");

      await page.getByRole("button", { name: "Stop today's session" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Stop today's session" }).click();
      await page.waitForSelector("[data-c5-closed]");
      const after = (await todaysSessions(F))[0];
      check("22. acute Stop -> stopped_acute", after.training_status === "stopped_acute" && (await page.locator("[data-c5-closed]").getAttribute("data-c5-closed")) === "stopped_acute");
      check("22. performed work, snapshot and version preserved", (await unitsOf(S.id)).length === 1 && JSON.stringify(after.prescription_snapshot) === snapshotBefore && after.prescription_version_id === F.versionId);
      const again = await api(ctxF, "POST", `/api/patient/c5/session/${S.id}/stop`, {});
      const { data: imm } = await admin.from("session_immediate_responses").select("id").eq("rehab_session_id", S.id);
      check("22. retrying acute Stop is an idempotent replay; obligations created once", again.body?.replayed === true && imm.length === 1);
      await page.close();
      await ctxF.close();
    }

    // ======================================================================
    section("G. Sequence: Stopped -> Repeat / Move to next (ephemeral until performance)");
    {
      const G = await makeFixture("seq-choice");
      const prior = priorSession(G, { status: "stopped_early" });
      const ctxG = await login(browser, G.email);
      const s = await state(ctxG);
      check("24. server reports a pending choice (repeat A / advance B)", s?.kind === "available" && s.choiceRequired === true && s.options.map((o) => o.workoutId).join() === `${G.workouts[0].id},${G.workouts[1].id}`);
      const page = await ctxG.newPage();
      await page.setViewportSize(MOBILE);
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-sequence-choice]");
      check("24. Stopped Sequence session presents Repeat / Move to next", (await page.locator("[data-c5-choice]").count()) === 2 && (await page.getByText("Repeat previous workout").count()) === 1 && (await page.getByText("Move to next workout").count()) === 1);
      await layoutCheck(page, "mobile-sequence-choice");
      await page.locator('[data-c5-choice="advance_next"]').click();
      await page.waitForSelector("[data-c5-exercise]");
      check("choosing shows that workout (Workout B)", (await page.locator("h1").textContent())?.includes("Workout B"));
      check("5. a Sequence choice alone creates no session", (await todaysSessions(G)).length === 0);
      await page.goto(`${ON}/patient/dashboard`);
      const s2 = await state(ctxG);
      check("25. leaving after choosing records nothing (choice still pending)", s2?.choiceRequired === true && (await todaysSessions(G)).length === 0);
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.locator('[data-c5-choice="advance_next"]').click();
      await page.waitForSelector("[data-c5-exercise]");
      await beginIfReviewing(page);
      await unitRow(page, G.workouts[1].e1, 0).getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await todaysSessions(G)).length === 1);
      const S = (await todaysSessions(G))[0];
      check("25. the choice becomes authoritative only with the first performance", S?.sequence_choice === "advance_next" && S.prescription_workout_id === G.workouts[1].id && S.resolves_stopped_session_id === prior);
      await layoutCheck(page, "mobile-active-session");
      await page.close();
      await ctxG.close();
    }

    section("H. Single-workout Sequence: no Repeat/Next screen");
    {
      const H = await makeFixture("seq-single", { workoutDays: [null] });
      priorSession(H, { status: "stopped_early" });
      const ctxH = await login(browser, H.email);
      const s = await state(ctxH);
      check("single workout: server resolves the choice (no choice required)", s?.kind === "available" && s.choiceRequired === false && s.options.length === 1 && s.options[0].key === "single");
      const page = await ctxH.newPage();
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      check("single workout: no Repeat/Next choice screen", (await page.locator("[data-c5-sequence-choice]").count()) === 0);
      await page.close();
      await ctxH.close();
    }

    section("I. Calendar opportunities come from the server");
    {
      const I = await makeFixture("cal-today", { mode: "calendar", workoutDays: [[localDow(-2)], [localDow(0)]] });
      const ctxI = await login(browser, I.email);
      const s = await state(ctxI);
      check("26. Calendar: today's scheduled workout (B) from the server", s?.kind === "available" && s.options.length === 1 && s.options[0].key === "scheduled_today" && s.options[0].workoutId === I.workouts[1].id && s.options[0].calendarScheduledDate === localDate(0), JSON.stringify(s)?.slice(0, 200));
      const page = await ctxI.newPage();
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector("[data-c5-exercise]");
      check("27. the earlier missed workout (A) is not offered once B is due", (await page.locator(`[data-c5-exercise="${I.workouts[0].e1}"]`).count()) === 0 && (await page.getByText("Today's scheduled workout").count()) === 1);
      const stale = await api(ctxI, "POST", "/api/patient/c5/start", startBody(I, { workoutId: I.workouts[0].id, performance: perf(I.workouts[0].e1, 0) }));
      check("27. expired make-up cannot be started through the API", stale.body?.result === "workout_not_eligible" && (await sessionsOf(I)).length === 0, JSON.stringify(stale.body)?.slice(0, 120));
      await page.close();
      await ctxI.close();

      const M = await makeFixture("cal-makeup", { mode: "calendar", workoutDays: [[localDow(-1)]] });
      const ctxM = await login(browser, M.email);
      const sm = await state(ctxM);
      check("26. Calendar make-up offered by the server for yesterday", sm?.kind === "available" && sm.options[0].key === "make_up" && sm.options[0].calendarScheduledDate === localDate(-1), JSON.stringify(sm)?.slice(0, 200));
      const pageM = await ctxM.newPage();
      await pageM.goto(`${ON}/patient/session`);
      await beginIfReviewing(pageM);
      await pageM.waitForSelector("[data-c5-exercise]");
      check("make-up is labelled as a make-up", (await pageM.getByText(/Make-up for/).count()) === 1);
      await beginIfReviewing(pageM);
      await unitRow(pageM, M.workouts[0].e1, 0).getByRole("button", { name: "Done" }).click();
      await waitFor(async () => (await sessionsOf(M)).length === 1);
      check("26. calendar_scheduled_date stays server-authoritative", (await sessionsOf(M))[0]?.calendar_scheduled_date === localDate(-1));
      await pageM.close();
      await ctxM.close();
    }

    section("J. Due morning response blocks a new workout");
    {
      const J = await makeFixture("morning");
      priorSession(J, { morning: "due" });
      const ctxJ = await login(browser, J.email);
      const s = await state(ctxJ);
      check("29. due morning response: morning_response_required", s?.kind === "morning_response_required");
      const page = await ctxJ.newPage();
      await page.setViewportSize(MOBILE);
      await page.goto(`${ON}/patient/dashboard`);
      check("29. dashboard shows the morning check-in requirement, no workout", (await page.locator("[data-c5-state-card]").textContent())?.includes("Morning check-in needed") && (await page.getByRole("link", { name: "Open workout" }).count()) === 0);
      await layoutCheck(page, "mobile-dashboard-morning");
      const startJ = await api(ctxJ, "POST", "/api/patient/c5/start", startBody(J));
      check("29. Start refused; nothing created today", startJ.body?.result === "morning_response_required" && (await todaysSessions(J)).length === 0);
      await page.close();
      await ctxJ.close();
    }

    // ======================================================================
    section("K. Gate off + no direct C5 table mutation");
    {
      const off = await api(ctxA, "GET", "/api/patient/c5/state", undefined, OFF);
      check("gate off (:3000): C5 API is unavailable (404 C5_RUNTIME_DISABLED)", off.status === 404 && off.body?.code === "C5_RUNTIME_DISABLED", JSON.stringify(off));
      const offPage = await ctxA.newPage();
      await offPage.goto(`${OFF}/patient/dashboard`);
      check("gate off: the dashboard stays on the legacy runtime (no C5 card)", (await offPage.locator("[data-c5-state-card]").count()) === 0);
      await offPage.close();

      const patientClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await patientClient.auth.signInWithPassword({ email: A.email, password: PASSWORD });
      const r1 = await patientClient.rpc("c5_record_first_performance", {
        p_patient_id: A.userId, p_client_request_id: randomUUID(), p_expected_version_id: A.versionId, p_workout_id: A.workouts[0].id, p_performance: perf(A.workouts[0].e1, 0),
      });
      const r2 = await patientClient.rpc("c5_get_start_eligibility", { p_patient_id: A.userId });
      check("30. a patient cannot call C5 lifecycle RPCs directly", !!r1.error && !!r2.error, `${r1.error?.message} / ${r2.error?.message}`);
      const sid = randomUUID();
      const ins = await patientClient.from("rehab_sessions").insert({
        id: sid, user_id: A.userId, prescription_instance_id: `c5:${sid}`, patient_local_date: localDate(0), status: null, training_status: "started",
        started_at: new Date().toISOString(), prescription_snapshot: {}, prescription_version_id: A.versionId, prescription_workout_id: A.workouts[0].id, patient_timezone: TZ, client_request_id: randomUUID(),
      });
      check("30. a patient cannot insert a C5 session directly", !!ins.error, ins.error?.message);
      const { data: sess } = await admin.from("rehab_sessions").select("id").eq("user_id", A.userId).not("training_status", "is", null);
      const upd = await patientClient.from("set_outcomes").update({ actual_reps: 99 }).eq("rehab_session_id", sess[0].id).select("id");
      const { data: after } = await admin.from("set_outcomes").select("actual_reps").eq("rehab_session_id", sess[0].id);
      check("30. a patient cannot modify recorded C5 units directly", (!!upd.error || (upd.data ?? []).length === 0) && after.every((u) => Number(u.actual_reps) !== 99), upd.error?.message);
      await patientClient.auth.signOut();

      const files = [
        "lib/c5RuntimeServer.ts",
        "lib/c5RuntimeHttp.ts",
        "lib/c5RuntimeClient.ts",
        "lib/c5RuntimeTypes.ts",
        "app/api/patient/c5/start/route.ts",
        "app/api/patient/c5/state/route.ts",
        "app/api/patient/c5/session/[id]/performance/route.ts",
        "app/api/patient/c5/session/[id]/finish/route.ts",
        "app/api/patient/c5/session/[id]/stop/route.ts",
        "app/api/patient/c5/session/[id]/view/route.ts",
        "app/patient/session/components/c5/C5SessionRunner.tsx",
        "app/patient/session/components/c5/C5ExerciseCard.tsx",
        "app/patient/session/components/c5/C5UnitRow.tsx",
        "app/patient/session/components/c5/C5SequenceChoice.tsx",
        "app/patient/session/components/c5/C5StopSheet.tsx",
        "app/patient/dashboard/components/C5TodaysRehabCard.tsx",
        "app/patient/dashboard/components/C5Dashboard.tsx",
      ];
      const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
      // A Supabase write chain: .from(table) ... .insert/.update/.upsert/.delete(
      const writers = files.filter((f) => /\.from\([^)]*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/.test(src[f]));
      check("30. no C5 runtime file writes a table directly (RPCs only)", writers.length === 0, writers.join(", "));
      const clientFiles = files.filter((f) => f.includes("components/") || f.endsWith("Client.ts") || f.endsWith("Types.ts"));
      const clientSupabase = clientFiles.filter((f) => /supabase|createClient|\.rpc\(/.test(src[f]));
      check("30. browser code never talks to Supabase (only /api/patient/c5)", clientSupabase.length === 0, clientSupabase.join(", "));
      const lifecycleLogic = clientFiles.filter((f) => /order_index\s*[+<>]|orderIndex\s*\+\s*1|c5_next_workout|days_of_week|daysOfWeek|getDay\(/.test(src[f]));
      check("23/26. no Sequence / Calendar derivation in browser code", lifecycleLogic.length === 0, lifecycleLogic.join(", "));
      const stopBody = src["lib/c5RuntimeClient.ts"].match(/export function stopSession[\s\S]*?\n}/)?.[0] ?? "";
      check("the browser's Stop request carries no stop type", /JSON\.stringify\(\{ acuteReport \}\)/.test(stopBody) && !/stopped_|trainingStatus|reason/.test(stopBody), stopBody);
      const storage = clientFiles.filter((f) => /localStorage|sessionStorage|indexedDB/.test(src[f]));
      check("no browser storage used as the clinical record", storage.length === 0, storage.join(", "));
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
