// C5.4C — Workout Structure & Scheduling. Live HTTP/UI verification. Drives
// the REAL Next.js pages/API routes over authenticated Playwright sessions,
// using entirely throwaway fixture users and REAL (read-only, never
// mutated) canonical exercises from the C5.3G migrated library. Mirrors
// verifyC5Stage4bDosageAuthoring.mjs's conventions exactly.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4cWorkoutScheduling.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";

const LEGACY_DB_PATH = "../app/tenotrainer.db";

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
const BASE_URL = "http://localhost:3000";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";

// Real, permanently-migrated C5.3G canonical exercises (deterministic
// UUIDv5). READ-ONLY here.
const REP_EX = { id: "8b1bf121-fa02-5e64-9a1d-61deaf7e8c70", name: "Double-Leg Calf Isometric Hold" };
const HOLD_EX = { id: "a09d5f06-4e1c-534e-8e28-521ded8d679b", name: "Single-Leg Calf Isometric Hold" };
const CLONE_EX = { id: "105e9b07-0895-5dff-be29-b1d00fda34e3", name: "Bent-Knee Calf Isometric Hold" };

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

async function makeUser(label) {
  const email = `c5s4c-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("profiles").upsert({ id: userId, name: label });
  return { userId, email };
}
async function addOrgMember(userId, role) {
  const { error } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  if (error) throw error;
}
async function loginContext(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.close();
  return context;
}

function tabByLabel(page, label) {
  return page.locator('[data-testid="workout-tab"]').filter({ hasText: label });
}
async function selectWorkout(page, label) {
  await tabByLabel(page, label).click();
  await page.waitForTimeout(150);
}
function draftRow(page, exerciseName) {
  return page.locator('[data-testid="draft-exercise-row"]').filter({ hasText: exerciseName });
}
async function addFromLibrary(page, exerciseName) {
  const card = page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]').filter({ hasText: exerciseName });
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await waitForCondition(async () => (await draftRow(page, exerciseName).count()) >= 1, 5000);
  // C5.4 Performance Pass — the row appears immediately as a pending add;
  // "added" for the purposes of this suite means persisted.
  await waitForCondition(async () => (await draftRow(page, exerciseName).locator('[data-testid="pending-add-indicator"]').count()) === 0, 8000);
}
async function waitForTabCount(page, n, timeoutMs = 10000) {
  return waitForCondition(async () => (await page.locator('[data-testid="workout-tab"]').count()) === n, timeoutMs);
}
async function waitForCondition(fn, timeoutMs = 5000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  const owner = await makeUser("sched-owner");
  const otherSupervisor = await makeUser("sched-other");
  const patient = await makeUser("sched-patient");
  const clonePatient = await makeUser("sched-clone-patient");

  let legacyOwnerId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let legacyClonePatientId = null;
  let patientPrescriptionId = null;
  let draftId = null;
  let clonePatientPrescriptionId = null;
  let cloneVersionId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyOwnerId = insertUser.run("c5s4c-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4c-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4c-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
    legacyClonePatientId = insertUser.run("c5s4c-verify-clone-patient", clonePatient.email, "patient", clonePatient.userId).lastInsertRowid;
    const insertSp = legacyDb.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')");
    insertSp.run(legacyOwnerId, legacyPatientId);
    insertSp.run(legacyOtherId, legacyPatientId);
    insertSp.run(legacyOwnerId, legacyClonePatientId);
  } finally {
    legacyDb.close();
  }

  try {
    await addOrgMember(owner.userId, "clinician");
    await addOrgMember(otherSupervisor.userId, "clinician");
    await addOrgMember(patient.userId, "member");
    await addOrgMember(clonePatient.userId, "member");
    await admin.from("supervisor_patients").insert({ supervisor_id: owner.userId, patient_id: patient.userId, status: "active" });
    await admin.from("supervisor_patients").insert({ supervisor_id: otherSupervisor.userId, patient_id: patient.userId, status: "active" });
    await admin.from("supervisor_patients").insert({ supervisor_id: owner.userId, patient_id: clonePatient.userId, status: "active" });

    // --- primary fixture: empty draft, ZERO workouts (exercises the full
    // Add-Workout flow from scratch) ---
    const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
    patientPrescriptionId = pp.id;
    const { data: draftRowData } = await admin
      .from("prescription_drafts")
      .insert({ patient_prescription_id: patientPrescriptionId, status: "editing", source: "empty", created_by: owner.userId, editing_clinician_id: owner.userId, updated_by: owner.userId })
      .select("id")
      .single();
    draftId = draftRowData.id;

    // --- clone-active fixture: a real published version with scheduling
    // fields already set, to prove clone_active copies them into a new draft ---
    const { data: clonePp } = await admin.from("patient_prescriptions").insert({ patient_id: clonePatient.userId }).select("id").single();
    clonePatientPrescriptionId = clonePp.id;
    const { data: cloneVersion } = await admin
      .from("prescription_versions")
      .insert({
        user_id: clonePatient.userId,
        stage: 1,
        irritability: "low",
        is_insertional: false,
        source: "onboarding",
        patient_prescription_id: clonePatientPrescriptionId,
        version_number: 1,
        published_at: new Date().toISOString(),
        published_by: owner.userId,
        scheduling_mode: "sequence",
        target_sessions_per_week: 3,
        phase: "early",
      })
      .select("id")
      .single();
    cloneVersionId = cloneVersion.id;
    await admin.from("patient_prescriptions").update({ current_prescription_version_id: cloneVersionId }).eq("id", clonePatientPrescriptionId);
    await admin.from("prescription_version_performance_focus").insert({ prescription_version_id: cloneVersionId, focus: "maintenance" });
    const { data: cloneWorkoutA } = await admin.from("prescription_workouts").insert({ prescription_version_id: cloneVersionId, order_index: 0, label: "Workout A" }).select("id").single();
    await admin.from("prescription_workouts").insert({ prescription_version_id: cloneVersionId, order_index: 1, label: "Workout B" });
    await admin.from("prescription_exercises").insert({ prescription_workout_id: cloneWorkoutA.id, canonical_exercise_id: CLONE_EX.id, order_index: 0 });

    const browser = await chromium.launch();
    try {
      const ctxOwner = await loginContext(browser, owner.email);
      const ctxOther = await loginContext(browser, otherSupervisor.email);
      const page = await ctxOwner.newPage();
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      // ===================== WORKOUT CRUD =====================
      check("no workout tabs yet on a brand-empty draft", (await page.locator('[data-testid="workout-tab"]').count()) === 0);
      check("Add Workout button visible when empty", await page.getByRole("button", { name: "+ Add Workout" }).isVisible());

      await page.getByRole("button", { name: "+ Add Workout" }).click();
      check("Workout A created", await waitForTabCount(page, 1));
      await page.locator('[data-testid="scheduling-mode-sequence"]').click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: "scripts/.c5s4c-sequence-workout-a-only.png", fullPage: true });
      await page.getByRole("button", { name: "+ Add Workout" }).click();
      check("Workout B created", await waitForTabCount(page, 2));
      await page.getByRole("button", { name: "+ Add Workout" }).click();
      check("Workout C created", await waitForTabCount(page, 3));
      check("Add Workout button hidden once at the UI cap of 3", (await page.getByRole("button", { name: "+ Add Workout" }).count()) === 0);

      const { data: workoutsAfterCreate } = await admin.from("prescription_workouts").select("id, label, order_index").eq("prescription_draft_id", draftId).order("order_index");
      check("exactly 3 workouts persisted with correct default A/B/C labels and order", workoutsAfterCreate.length === 3 && workoutsAfterCreate.map((w) => w.label).join(",") === "Workout A,Workout B,Workout C");
      const workoutAId = workoutsAfterCreate[0].id;

      // Server/DB itself remains capable of >3 (UI-only cap) — bypass the UI cap directly.
      const fourthResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/workouts`, { data: { orderIndex: 3, label: "Workout D" } });
      check("server/DB itself has NO workout-count limit (4th workout succeeds via direct API)", fourthResp.status() === 201, `got ${fourthResp.status()}`);
      const fourthBody = await fourthResp.json();
      const deleteFourthResp = await ctxOwner.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${fourthBody.workoutId}`, { method: "DELETE" });
      check("cleanup: 4th workout deleted", deleteFourthResp.status() === 200);
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      check("still exactly 3 tabs after cleanup", await waitForTabCount(page, 3));

      // Rename (double-click to open inline edit)
      await tabByLabel(page, "Workout A").dblclick();
      const renameInput = page.getByLabel("Workout name");
      await renameInput.fill("Calf Focus");
      await renameInput.press("Enter");
      let renamedWorkout = null;
      const renameStart = Date.now();
      while (Date.now() - renameStart < 5000) {
        const { data } = await admin.from("prescription_workouts").select("id, label").eq("id", workoutAId).single();
        if (data.label === "Calf Focus") {
          renamedWorkout = data;
          break;
        }
        await page.waitForTimeout(150);
      }
      check("rename persisted without changing workout identity", !!renamedWorkout && renamedWorkout.id === workoutAId && renamedWorkout.label === "Calf Focus");
      const uiShowsRename = await waitForCondition(async () => (await tabByLabel(page, "Calf Focus").count()) > 0, 5000);
      check("renamed tab visible in the UI", uiShowsRename);

      // ===================== EXERCISE ADD / DUPLICATE SCOPING / MOVE =====================
      await selectWorkout(page, "Calf Focus");
      await addFromLibrary(page, REP_EX.name);
      check("exercise added to selected workout (Calf Focus / A)", (await draftRow(page, REP_EX.name).count()) === 1);

      // The draft panel scrolls independently of the page (h-screen layout),
      // so a fullPage screenshot never reaches content below the fold here —
      // scroll the exercise list into view within its own panel and capture
      // just that panel for a screenshot that actually shows the rows.
      async function screenshotDraftPanel(path) {
        await page.locator('[data-testid="draft-exercise-list"]').scrollIntoViewIfNeeded();
        await page.locator('[data-testid="draft-panel"]').screenshot({ path });
      }

      await selectWorkout(page, "Workout B");
      const repCardInB = page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]').filter({ hasText: REP_EX.name });
      check("same canonical exercise remains addable in a DIFFERENT workout (shows Add, not Added)", await repCardInB.getByRole("button", { name: "Add", exact: true }).isVisible());
      await screenshotDraftPanel("scripts/.c5s4c-duplicate-add-scoping.png");
      await addFromLibrary(page, REP_EX.name);
      await addFromLibrary(page, HOLD_EX.name);
      check("Workout B now has both exercises", (await draftRow(page, REP_EX.name).count()) === 1 && (await draftRow(page, HOLD_EX.name).count()) === 1);
      await screenshotDraftPanel("scripts/.c5s4c-workout-b-exercises.png");

      const { data: exercisesInB } = await admin
        .from("prescription_exercises")
        .select("id, canonical_exercise_id")
        .eq("prescription_workout_id", workoutsAfterCreate[1].id);
      const holdExerciseIdInB = exercisesInB.find((e) => e.canonical_exercise_id === HOLD_EX.id).id;
      const repExerciseIdInB = exercisesInB.find((e) => e.canonical_exercise_id === REP_EX.id).id;

      // Seed a dosage row directly (skip full C5.4B UI flow) to prove a move preserves it.
      await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: holdExerciseIdInB, dosage_type: "hold", sets: 3, hold_duration_mode: "exact", hold_duration_exact_seconds: 30, load_type: "bodyweight" });

      await screenshotDraftPanel("scripts/.c5s4c-move-exercise-control.png");

      // Move HOLD_EX B -> A: no collision, should succeed and preserve dosage/identity.
      await draftRow(page, HOLD_EX.name).locator('[data-testid="move-to-workout"]').selectOption({ label: "Calf Focus" });
      await waitForCondition(async () => {
        const { data } = await admin.from("prescription_exercises").select("prescription_workout_id").eq("id", holdExerciseIdInB).single();
        return data.prescription_workout_id === workoutAId;
      }, 6000);
      const { data: movedExercise } = await admin.from("prescription_exercises").select("id, prescription_workout_id, status").eq("id", holdExerciseIdInB).single();
      check("moved exercise keeps its identity (same id)", movedExercise.id === holdExerciseIdInB);
      check("moved exercise now belongs to the target workout", movedExercise.prescription_workout_id === workoutAId);
      check("moved exercise status preserved (active)", movedExercise.status === "active");
      const { data: movedDosage } = await admin.from("prescription_exercise_dosage").select("prescription_exercise_id, hold_duration_exact_seconds").eq("prescription_exercise_id", holdExerciseIdInB).single();
      check("moved exercise's dosage row preserved untouched", movedDosage && Number(movedDosage.hold_duration_exact_seconds) === 30);
      const { count: remainingInB } = await admin.from("prescription_exercises").select("id", { count: "exact", head: true }).eq("prescription_workout_id", workoutsAfterCreate[1].id);
      check("source workout's ordering repaired (only 1 exercise remains in B)", remainingInB === 1);

      // Move REP_EX B -> A: COLLIDES (A already has REP_EX) -> must be rejected.
      await selectWorkout(page, "Workout B");
      await draftRow(page, REP_EX.name).locator('[data-testid="move-to-workout"]').selectOption({ label: "Calf Focus" });
      const collisionErrorShown = await waitForCondition(async () => (await page.getByText(/already exists in the target workout/).count()) > 0, 6000);
      check("colliding move shows a clinician-readable inline error", collisionErrorShown);
      const { data: repStillInB } = await admin.from("prescription_exercises").select("prescription_workout_id").eq("id", repExerciseIdInB).single();
      check("rejected move left the exercise in its original workout (no duplicate created)", repStillInB.prescription_workout_id === workoutsAfterCreate[1].id);
      const { count: aExerciseCount } = await admin.from("prescription_exercises").select("id", { count: "exact", head: true }).eq("prescription_workout_id", workoutAId);
      check("target workout did not gain a duplicate from the rejected move", aExerciseCount === 2); // REP_EX (original) + HOLD_EX (moved)

      // Reorder workouts: move Workout C left (swap with B)
      async function orderedLabels() {
        const { data } = await admin.from("prescription_workouts").select("label, order_index").eq("prescription_draft_id", draftId).order("order_index");
        return data.map((w) => w.label);
      }
      await selectWorkout(page, "Workout C");
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Move workout left" }).click();
      await waitForCondition(async () => (await orderedLabels())[1] === "Workout C", 6000);
      const workoutsAfterReorder = await orderedLabels();
      check("workout reorder persisted (C swapped left of B)", workoutsAfterReorder[1] === "Workout C" && workoutsAfterReorder[2] === "Workout B");
      // swap back for a predictable A/B/C order in later checks
      await page.getByRole("button", { name: "Move workout right" }).click();
      await waitForCondition(async () => (await orderedLabels())[2] === "Workout C", 6000);
      await page.waitForTimeout(700);

      // ===================== SEQUENCE AUTHORING =====================
      await page.locator('[data-testid="scheduling-mode-sequence"]').click();
      const sequenceSectionShown = await waitForCondition(async () => (await page.locator('[data-testid="sequence-authoring"]').count()) > 0, 6000);
      check("Sequence authoring section appears", sequenceSectionShown);
      const orderDisplay = await page.locator('[data-testid="sequence-order-display"]').innerText();
      check("workout order displayed as Calf Focus -> Workout B -> Workout C", orderDisplay.includes("Calf Focus") && orderDisplay.includes("→") && orderDisplay.includes("Workout C"), orderDisplay);

      await page.locator("#target-sessions").selectOption("4");
      await waitForCondition(async () => {
        const { data } = await admin.from("prescription_drafts").select("target_sessions_per_week").eq("id", draftId).single();
        return data.target_sessions_per_week === 4;
      }, 6000);
      const { data: draftAfterTarget } = await admin.from("prescription_drafts").select("scheduling_mode, target_sessions_per_week").eq("id", draftId).single();
      check("scheduling_mode saved as sequence", draftAfterTarget.scheduling_mode === "sequence");
      check("target_sessions_per_week saved (4)", draftAfterTarget.target_sessions_per_week === 4);
      const targetSelectSynced = await waitForCondition(async () => (await page.locator("#target-sessions").inputValue()) === "4", 6000);
      check("target-sessions <select> UI reflects the saved value", targetSelectSynced);
      await page.screenshot({ path: "scripts/.c5s4c-sequence-abc-target.png", fullPage: true });

      let validateResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/validate`);
      let validateBody = await validateResp.json();
      check("sequence_target_frequency_present passes with a target set", validateBody.rules.find((r) => r.rule === "sequence_target_frequency_present")?.passed === true);

      // Missing target considered incomplete
      await admin.from("prescription_drafts").update({ target_sessions_per_week: null }).eq("id", draftId);
      validateResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/validate`);
      validateBody = await validateResp.json();
      check("missing target -> sequence_target_frequency_present fails (publish validator rejects)", validateBody.rules.find((r) => r.rule === "sequence_target_frequency_present")?.passed === false);
      await admin.from("prescription_drafts").update({ target_sessions_per_week: 4 }).eq("id", draftId);

      // ===================== CALENDAR AUTHORING + WEEKDAY EXCLUSIVITY =====================
      await page.locator('[data-testid="scheduling-mode-calendar"]').click();
      await page.waitForTimeout(700);
      const { data: draftAfterCalendarSwitch } = await admin.from("prescription_drafts").select("scheduling_mode, target_sessions_per_week").eq("id", draftId).single();
      check("Sequence -> Calendar clears target_sessions_per_week server-side", draftAfterCalendarSwitch.scheduling_mode === "calendar" && draftAfterCalendarSwitch.target_sessions_per_week === null);

      async function workoutDays(label) {
        const { data } = await admin.from("prescription_workouts").select("days_of_week").eq("prescription_draft_id", draftId).eq("label", label).single();
        return (data.days_of_week ?? []).slice().sort();
      }

      await selectWorkout(page, "Calf Focus");
      await page.locator('[data-testid="weekday-button"][data-day="1"]').click(); // Monday
      await waitForCondition(async () => JSON.stringify(await workoutDays("Calf Focus")) === JSON.stringify([1]), 6000);
      await page.locator('[data-testid="weekday-button"][data-day="5"]').click(); // Friday
      await waitForCondition(async () => JSON.stringify(await workoutDays("Calf Focus")) === JSON.stringify([1, 5]), 6000);
      await selectWorkout(page, "Workout B");
      await page.waitForTimeout(300);
      await page.locator('[data-testid="weekday-button"][data-day="3"]').click(); // Wednesday
      await waitForCondition(async () => JSON.stringify(await workoutDays("Workout B")) === JSON.stringify([3]), 6000);

      const mondayButtonForB = page.locator('[data-testid="weekday-button"][data-day="1"]');
      check("Monday shows disabled/unavailable while viewing a DIFFERENT workout (client-side exclusivity)", await mondayButtonForB.isDisabled());

      const { data: workoutsAfterDays } = await admin.from("prescription_workouts").select("id, label, days_of_week").eq("prescription_draft_id", draftId).order("order_index");
      check("Calf Focus has Monday+Friday saved", JSON.stringify(workoutsAfterDays.find((w) => w.label === "Calf Focus").days_of_week?.slice().sort()) === JSON.stringify([1, 5]));
      check("Workout B has Wednesday saved", JSON.stringify(workoutsAfterDays.find((w) => w.label === "Workout B").days_of_week) === JSON.stringify([3]));

      // Direct conflicting server payload (bypass UI) -> must be rejected
      const workoutCId = workoutsAfterDays.find((w) => w.label === "Workout C").id;
      const conflictResp = await ctxOwner.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${workoutCId}`, { method: "PATCH", data: { daysOfWeek: [1] } });
      check("direct conflicting weekday payload rejected server-side (422)", conflictResp.status() === 422, `got ${conflictResp.status()}`);
      const { data: workoutCAfterConflict } = await admin.from("prescription_workouts").select("days_of_week").eq("id", workoutCId).single();
      check("Workout C's days_of_week unchanged after the rejected conflicting payload", workoutCAfterConflict.days_of_week === null);

      validateResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/validate`);
      validateBody = await validateResp.json();
      check("every workout requires >=1 day -> calendar_days_present fails while Workout C has none", validateBody.rules.find((r) => r.rule === "calendar_days_present")?.passed === false);
      check("calendar_target_frequency_absent passes (target is null in calendar mode)", validateBody.rules.find((r) => r.rule === "calendar_target_frequency_absent")?.passed === true);

      // Assign Workout C -> Sunday, then re-validate clean
      await selectWorkout(page, "Workout C");
      await page.locator('[data-testid="weekday-button"][data-day="0"]').click();
      await page.waitForTimeout(700);
      validateResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/validate`);
      validateBody = await validateResp.json();
      check("calendar_days_present passes once every workout has a day", validateBody.rules.find((r) => r.rule === "calendar_days_present")?.passed === true);
      check("calendar_weekdays_exclusive passes (no overlaps)", validateBody.rules.find((r) => r.rule === "calendar_weekdays_exclusive")?.passed === true);

      await page.screenshot({ path: "scripts/.c5s4c-calendar-abc.png", fullPage: true });

      // ===================== MODE-SWITCH CLEANUP: Calendar -> Sequence =====================
      const { count: exerciseCountBeforeSwitch } = await admin.from("prescription_exercises").select("id", { count: "exact", head: true }).in("prescription_workout_id", workoutsAfterDays.map((w) => w.id));
      await page.locator('[data-testid="scheduling-mode-sequence"]').click();
      await page.waitForTimeout(700);
      const { data: workoutsAfterCalToSeq } = await admin.from("prescription_workouts").select("id, label, order_index, days_of_week").eq("prescription_draft_id", draftId).order("order_index");
      check("Calendar -> Sequence clears days_of_week on ALL workouts", workoutsAfterCalToSeq.every((w) => w.days_of_week === null));
      check("Calendar -> Sequence preserves workouts/labels/order", workoutsAfterCalToSeq.map((w) => w.label).join(",") === "Calf Focus,Workout B,Workout C");
      const { count: exerciseCountAfterSwitch } = await admin.from("prescription_exercises").select("id", { count: "exact", head: true }).in("prescription_workout_id", workoutsAfterCalToSeq.map((w) => w.id));
      check("Calendar -> Sequence preserves exercise count (nothing cascaded)", exerciseCountBeforeSwitch === exerciseCountAfterSwitch);
      const { data: dosageStillThere } = await admin.from("prescription_exercise_dosage").select("id").eq("prescription_exercise_id", holdExerciseIdInB).maybeSingle();
      check("Calendar -> Sequence preserves dosage", !!dosageStillThere);

      // ===================== PHASE / PERFORMANCE FOCUS =====================
      await page.locator("#rehab-phase").selectOption("early");
      await page.waitForTimeout(700);
      let { data: draftAfterPhase } = await admin.from("prescription_drafts").select("phase").eq("id", draftId).single();
      check("Rehabilitation Phase saved", draftAfterPhase.phase === "early");

      async function currentFocusSet() {
        const { data } = await admin.from("prescription_draft_performance_focus").select("focus").eq("prescription_draft_id", draftId);
        return new Set(data.map((r) => r.focus));
      }

      const focusLabel = (text) => page.locator('[data-testid="scheduling-panel"] label').filter({ hasText: text });
      await focusLabel("Strength Development").click();
      await waitForCondition(async () => (await currentFocusSet()).has("strength_development"), 6000);
      await focusLabel("Maintenance").click();
      await waitForCondition(async () => (await currentFocusSet()).has("maintenance"), 6000);
      let focusSet = await currentFocusSet();
      check("multiple Performance Focus values saved (unordered set)", focusSet.has("strength_development") && focusSet.has("maintenance") && focusSet.size === 2);
      await page.screenshot({ path: "scripts/.c5s4c-phase-performance-focus.png", fullPage: true });

      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      check("Phase persists across reload", (await page.locator("#rehab-phase").inputValue()) === "early");
      const strengthChecked = await focusLabel("Strength Development").locator("input").isChecked().catch(() => false);
      check("Performance Focus checkbox state persists across reload", strengthChecked);

      await focusLabel("Strength Development").click();
      await waitForCondition(async () => !(await currentFocusSet()).has("strength_development"), 6000);
      focusSet = await currentFocusSet();
      check("removing one Performance Focus value leaves the other(s)", !focusSet.has("strength_development") && focusSet.has("maintenance"));

      // ===================== CLONE-ACTIVE PRESERVES SCHEDULING FIELDS =====================
      const cloneDraftResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${clonePatient.userId}/prescription-drafts`, {
        data: { source: "clone_active", sourceVersionId: cloneVersionId },
      });
      check("clone_active draft creation succeeds", cloneDraftResp.status() === 201, `got ${cloneDraftResp.status()}: ${await cloneDraftResp.text()}`);
      const { draftId: cloneDraftId } = await cloneDraftResp.json();
      const { data: clonedDraft } = await admin.from("prescription_drafts").select("scheduling_mode, target_sessions_per_week, phase").eq("id", cloneDraftId).single();
      check("clone_active copies scheduling_mode", clonedDraft.scheduling_mode === "sequence");
      check("clone_active copies target_sessions_per_week", clonedDraft.target_sessions_per_week === 3);
      check("clone_active copies phase", clonedDraft.phase === "early");
      const { data: clonedFocus } = await admin.from("prescription_draft_performance_focus").select("focus").eq("prescription_draft_id", cloneDraftId);
      check("clone_active copies performance focus", clonedFocus.length === 1 && clonedFocus[0].focus === "maintenance");
      const { data: clonedWorkouts } = await admin.from("prescription_workouts").select("label, order_index").eq("prescription_draft_id", cloneDraftId).order("order_index");
      check("clone_active copies workout structure/order/labels", clonedWorkouts.map((w) => w.label).join(",") === "Workout A,Workout B");

      // ===================== AUTHORIZATION =====================
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=Exercise Library");
      check("view-only clinician sees NO Add Workout button", (await otherPage.getByRole("button", { name: "+ Add Workout" }).count()) === 0);
      check("view-only clinician sees NO delete-workout control", (await otherPage.getByRole("button", { name: "Delete workout" }).count()) === 0);
      check("view-only clinician's scheduling-mode buttons are disabled", await otherPage.locator('[data-testid="scheduling-mode-calendar"]').isDisabled());
      await otherPage.screenshot({ path: "scripts/.c5s4c-view-only.png", fullPage: true });
      await otherPage.close();

      const unauthAddWorkout = await ctxOther.request.post(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/workouts`, { data: { orderIndex: 9 } });
      check("non-owning clinician direct add-workout call rejected", unauthAddWorkout.status() === 403, `got ${unauthAddWorkout.status()}`);
      const unauthRename = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${workoutAId}`, { method: "PATCH", data: { label: "Hacked" } });
      check("non-owning clinician direct rename call rejected", unauthRename.status() === 403, `got ${unauthRename.status()}`);
      const unauthDelete = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${workoutAId}`, { method: "DELETE" });
      check("non-owning clinician direct delete-workout call rejected", unauthDelete.status() === 403, `got ${unauthDelete.status()}`);
      const unauthMove = await ctxOther.request.post(`${BASE_URL}/api/clinician/prescription-exercises/${holdExerciseIdInB}/move`, { data: { targetWorkoutId: workoutCId } });
      check("non-owning clinician direct move-exercise call rejected", unauthMove.status() === 403, `got ${unauthMove.status()}`);

      // ===================== MOBILE LAYOUT =====================
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: /^Draft/ }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "scripts/.c5s4c-mobile-scheduling.png", fullPage: true });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);

      // ===================== WORKOUT DELETION =====================
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      async function workoutCount() {
        const { count } = await admin.from("prescription_workouts").select("id", { count: "exact", head: true }).eq("prescription_draft_id", draftId);
        return count;
      }

      // Populated delete (Workout B has 1 exercise: REP_EX)
      await selectWorkout(page, "Workout B");
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Delete workout" }).click();
      const confirmPanel = page.locator('[data-testid="delete-workout-confirm"]');
      await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
      check("populated-workout delete shows an explicit confirmation with exercise count", (await confirmPanel.innerText()).includes("1 exercise"));
      check("populated-workout delete copy mentions the active published prescription is unaffected", (await confirmPanel.innerText()).toLowerCase().includes("active published prescription"));
      await confirmPanel.scrollIntoViewIfNeeded();
      await page.locator('[data-testid="draft-panel"]').screenshot({ path: "scripts/.c5s4c-delete-confirm.png" });
      const countBeforeDeleteB = await workoutCount();
      await confirmPanel.getByRole("button", { name: "Delete Workout" }).click();
      await waitForCondition(async () => (await workoutCount()) === countBeforeDeleteB - 1, 6000);
      const { data: workoutBGone } = await admin.from("prescription_workouts").select("id").eq("id", workoutsAfterCalToSeq[1].id).maybeSingle();
      check("populated workout deleted after explicit confirmation", workoutBGone === null);
      const { data: repExerciseGone } = await admin.from("prescription_exercises").select("id").eq("id", repExerciseIdInB).maybeSingle();
      check("its contained exercise cascaded away with the workout", repExerciseGone === null);

      // Empty delete (Workout C has zero exercises)
      await selectWorkout(page, "Workout C");
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Delete workout" }).click();
      await page.locator('[data-testid="delete-workout-confirm"]').waitFor({ state: "visible", timeout: 5000 });
      const emptyConfirmText = await page.locator('[data-testid="delete-workout-confirm"]').innerText();
      check("empty-workout delete uses lighter confirmation copy (no exercise-count warning)", !emptyConfirmText.includes("exercise") || emptyConfirmText.toLowerCase().includes("empty"));
      const countBeforeDeleteC = await workoutCount();
      await page.locator('[data-testid="delete-workout-confirm"]').getByRole("button", { name: "Delete Workout" }).click();
      await waitForCondition(async () => (await workoutCount()) === countBeforeDeleteC - 1, 6000);
      check("empty workout deleted, exactly 1 workout remains", (await workoutCount()) === 1);

      // Delete the only remaining workout -> draft returns to zero-workout state
      await page.waitForSelector('[data-testid="workout-tab"]');
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Delete workout" }).click();
      await page.locator('[data-testid="delete-workout-confirm"]').waitFor({ state: "visible", timeout: 5000 });
      await page.locator('[data-testid="delete-workout-confirm"]').getByRole("button", { name: "Delete Workout" }).click();
      await waitForCondition(async () => (await workoutCount()) === 0, 6000);
      check("deleting the only workout leaves the draft with zero workouts", (await workoutCount()) === 0);
      const emptyStateShown = await waitForCondition(async () => (await page.getByText(/Add a workout to begin/).count()) > 0, 5000);
      check("empty-draft state clearly communicated (no fake workout rendered)", emptyStateShown);
      validateResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/prescription-drafts/${draftId}/validate`);
      validateBody = await validateResp.json();
      check("has_workout fails once the draft has zero workouts (publish would be blocked)", validateBody.rules.find((r) => r.rule === "has_workout")?.passed === false);

      await page.close();
      await ctxOwner.close();
      await ctxOther.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (patientPrescriptionId) await admin.from("patient_prescriptions").delete().eq("id", patientPrescriptionId);
    if (clonePatientPrescriptionId) await admin.from("patient_prescriptions").delete().eq("id", clonePatientPrescriptionId);
    if (cloneVersionId) await admin.from("prescription_versions").delete().eq("id", cloneVersionId);
    await admin.from("supervisor_patients").delete().in("patient_id", [patient.userId, clonePatient.userId]);
    const allUserIds = [owner.userId, otherSupervisor.userId, patient.userId, clonePatient.userId];
    await admin.from("organization_members").delete().in("user_id", allUserIds);
    await admin.from("profiles").delete().in("id", allUserIds);
    for (const uid of allUserIds) await admin.auth.admin.deleteUser(uid);

    const legacyDbTeardown = new DatabaseSync(LEGACY_DB_PATH);
    try {
      for (const [sup, pat] of [
        [legacyOwnerId, legacyPatientId],
        [legacyOtherId, legacyPatientId],
        [legacyOwnerId, legacyClonePatientId],
      ]) {
        if (sup != null && pat != null) legacyDbTeardown.prepare("DELETE FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?").run(sup, pat);
      }
      for (const uid of [legacyOwnerId, legacyOtherId, legacyPatientId, legacyClonePatientId]) {
        if (uid != null) legacyDbTeardown.prepare("DELETE FROM users WHERE id = ?").run(uid);
      }
    } finally {
      legacyDbTeardown.close();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
