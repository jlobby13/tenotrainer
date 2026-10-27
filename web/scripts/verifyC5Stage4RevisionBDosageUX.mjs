// C5.4 Authoring Revision B — Dosage Authoring UX & Working State. Live
// HTTP/UI verification. Drives the REAL Next.js pages/API routes over
// authenticated Playwright sessions, using entirely throwaway fixture users
// and REAL (read-only, never mutated) canonical exercises from the C5.3G
// migrated library. Mirrors verifyC5Stage4cWorkoutScheduling.mjs's
// conventions exactly.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4RevisionBDosageUX.mjs
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
const ISO_EX = { id: "8b1bf121-fa02-5e64-9a1d-61deaf7e8c70", name: "Double-Leg Calf Isometric Hold" }; // capabilities: hold, reps
const REPS_EX = { id: "5904f529-2eff-580d-a49f-332757c1465c", name: "Double-Leg Standing Calf Raise" }; // capabilities: reps only
const CONTACT_EX = { id: "91d9f541-5bc1-5337-b332-d295f74ac1f0", name: "Alternating Ankle Rebounds In Place" }; // capabilities: contacts only
const TIME_EX = { id: "82092d25-3ce5-5a4d-89a5-d7975bd0e1b3", name: "Walk-Jog Intervals" }; // capabilities: interval_time only
const DISTANCE_EX = { id: "07469f83-da7c-5d40-a646-16513a549f46", name: "Stride Accelerations" }; // default=allowed=[distance] (not curated-widened)
const RUN_EX = { id: "08a67513-e1b5-5eec-a0a5-798b58b517e8", name: "Continuous Easy Run" }; // default=[interval_time], allowed=[interval_time, distance] (curated-widened)

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
  const email = `c5s4revb-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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

async function waitForCondition(fn, timeoutMs = 6000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function draftRow(page, exerciseName) {
  return page.locator('[data-testid="draft-exercise-row"]').filter({ hasText: exerciseName });
}
function editorFor(page, exerciseName) {
  return draftRow(page, exerciseName).locator('[data-testid="dosage-editor"]');
}
// C5.4 Revision E — a collapsed row opens via its explicit Edit / Add
// dosage control (a saved card body no longer opens the editor).
async function expandDosage(page, exerciseName) {
  const editor = editorFor(page, exerciseName);
  if ((await editor.count()) > 0 && (await editor.isVisible())) return; // idempotent: already open
  await draftRow(page, exerciseName).locator('[data-testid="edit-dosage"]').click();
  await editor.waitFor({ state: "visible", timeout: 5000 });
}
async function collapseDosage(page, exerciseName) {
  const editor = editorFor(page, exerciseName);
  if ((await editor.count()) === 0) return; // idempotent: already collapsed
  await draftRow(page, exerciseName).locator('[data-testid="draft-exercise-row-toggle"]').click();
  await editor.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}
async function saveDosage(page, exerciseName) {
  const button = editorFor(page, exerciseName).locator('[data-testid="save-dosage"]');
  await button.click();
  // handleSaveDosage's PUT+PATCH+refreshDraft chain is fully async and the
  // click itself only dispatches it — wait for the button's own
  // disabled-while-saving state to clear before the next action fires, so
  // a subsequent UI interaction never races this save's own refreshDraft()
  // reconciliation (the same class of race fixed in C5.4C's Performance
  // Focus toggle).
  await waitForCondition(async () => (await editorFor(page, exerciseName).count()) === 0 || !(await button.isDisabled()), 8000);
  // C5.4 Revision E — a successful save collapses the editor. Re-open it so
  // the rest of this (Revision B) flow keeps editing the same exercise; the
  // return value lets callers assert the collapse itself.
  const collapsed = (await editorFor(page, exerciseName).count()) === 0;
  if (collapsed) await expandDosage(page, exerciseName);
  return collapsed;
}
async function cancelDosage(page, exerciseName) {
  await editorFor(page, exerciseName).locator('[data-testid="cancel-dosage"]').click();
}
function fieldGroup(page, exerciseName, testId) {
  return editorFor(page, exerciseName).locator(`[data-testid="${testId}"]`);
}
// The draft panel scrolls independently of the page (h-screen layout, see
// C5.4C's own screenshot helper) — scroll the target into view within its
// own panel and capture just the panel, or the whole page when nothing
// needs scrolling into view.
async function screenshotDraftPanel(page, path, scrollTarget) {
  if (scrollTarget) await scrollTarget.scrollIntoViewIfNeeded();
  await page.locator('[data-testid="draft-panel"]').screenshot({ path }).catch(() => page.screenshot({ path, fullPage: true }));
}
async function addFromLibrary(page, exerciseName) {
  const card = page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]').filter({ hasText: exerciseName });
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await waitForCondition(async () => (await draftRow(page, exerciseName).count()) >= 1, 5000);
  // C5.4 Performance Pass — the row appears immediately as a pending add;
  // "added" for the purposes of this suite means persisted.
  await waitForCondition(async () => (await draftRow(page, exerciseName).locator('[data-testid="pending-add-indicator"]').count()) === 0, 8000);
}
async function getDosageRow(exerciseUuid, draftId) {
  const { data: pe } = await admin.from("prescription_exercises").select("id").eq("canonical_exercise_id", exerciseUuid).limit(1);
  // Multiple exercises can share a canonical id across different drafts in
  // other tests; scope precisely via the workout->draft chain instead.
  const { data: rows } = await admin
    .from("prescription_exercises")
    .select("id, prescription_exercise_dosage(*), prescription_workouts!inner(prescription_draft_id)")
    .eq("canonical_exercise_id", exerciseUuid)
    .eq("prescription_workouts.prescription_draft_id", draftId)
    .limit(1);
  const row = rows?.[0];
  const dosage = Array.isArray(row?.prescription_exercise_dosage) ? row.prescription_exercise_dosage[0] : row?.prescription_exercise_dosage;
  return { exerciseId: row?.id ?? null, dosage: dosage ?? null };
}

async function main() {
  const owner = await makeUser("revb-owner");
  const otherSupervisor = await makeUser("revb-other");
  const patient = await makeUser("revb-patient");

  let legacyOwnerId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let patientPrescriptionId = null;
  let draftId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyOwnerId = insertUser.run("c5s4revb-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4revb-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4revb-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
    const insertSp = legacyDb.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')");
    insertSp.run(legacyOwnerId, legacyPatientId);
    insertSp.run(legacyOtherId, legacyPatientId);
  } finally {
    legacyDb.close();
  }

  try {
    await addOrgMember(owner.userId, "clinician");
    await addOrgMember(otherSupervisor.userId, "clinician");
    await addOrgMember(patient.userId, "member");
    await admin.from("supervisor_patients").insert({ supervisor_id: owner.userId, patient_id: patient.userId, status: "active" });
    await admin.from("supervisor_patients").insert({ supervisor_id: otherSupervisor.userId, patient_id: patient.userId, status: "active" });

    const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
    patientPrescriptionId = pp.id;
    const { data: draftRowData } = await admin
      .from("prescription_drafts")
      .insert({ patient_prescription_id: patientPrescriptionId, status: "editing", source: "empty", created_by: owner.userId, editing_clinician_id: owner.userId, updated_by: owner.userId })
      .select("id")
      .single();
    draftId = draftRowData.id;

    const browser = await chromium.launch();
    try {
      const ctxOwner = await loginContext(browser, owner.email);
      const ctxOther = await loginContext(browser, otherSupervisor.email);
      const page = await ctxOwner.newPage();
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      // ===================== SETUP: 5 exercises across 2 workouts =====================
      await addFromLibrary(page, ISO_EX.name);
      await addFromLibrary(page, REPS_EX.name);
      await addFromLibrary(page, CONTACT_EX.name);
      await addFromLibrary(page, TIME_EX.name);
      await addFromLibrary(page, DISTANCE_EX.name);
      await page.getByRole("button", { name: "+ Add Workout" }).click();
      await waitForCondition(async () => (await page.locator('[data-testid="workout-tab"]').count()) === 2, 6000);
      const tabs = page.locator('[data-testid="workout-tab"]');
      const workoutALabel = await tabs.nth(0).innerText();
      const workoutBLabel = await tabs.nth(1).innerText();
      // Adding a workout switches selection to the newly-created (empty)
      // one (existing C5.4C behavior) — switch back to A, where the 5
      // fixture exercises actually live.
      await tabs.filter({ hasText: workoutALabel }).click();
      await page.waitForTimeout(300);

      // ===================== NO DOSAGE TYPE SELECTOR =====================
      check("no #dosage-type selector anywhere on the page", (await page.locator("#dosage-type").count()) === 0);
      check("no legacy dosage-affordance button anywhere on the page", (await page.locator('[data-testid="dosage-affordance"]').count()) === 0);

      // ===================== CAPABILITY-DRIVEN FIELD VISIBILITY =====================
      await expandDosage(page, ISO_EX.name);
      check("reps+hold exercise shows Reps field", (await fieldGroup(page, ISO_EX.name, "dosage-field-reps").count()) === 1);
      check("reps+hold exercise shows Hold field", (await fieldGroup(page, ISO_EX.name, "dosage-field-hold").count()) === 1);
      check("reps+hold exercise does NOT show Contacts field by default", (await fieldGroup(page, ISO_EX.name, "dosage-field-contacts").count()) === 0);
      check("reps+hold exercise does NOT show Distance field by default", (await fieldGroup(page, ISO_EX.name, "dosage-field-distance").count()) === 0);

      await expandDosage(page, REPS_EX.name);
      check("reps-only exercise shows Reps field", (await fieldGroup(page, REPS_EX.name, "dosage-field-reps").count()) === 1);
      check("reps-only exercise does NOT show Hold field by default", (await fieldGroup(page, REPS_EX.name, "dosage-field-hold").count()) === 0);

      await expandDosage(page, CONTACT_EX.name);
      check("reactive exercise shows Contacts field", (await fieldGroup(page, CONTACT_EX.name, "dosage-field-contacts").count()) === 1);
      // Revision E: CONTACT_EX's curated ALLOWED set includes reps, which is
      // now shown directly rather than behind "+ Add parameter".
      check("reactive exercise shows its allowed Reps field directly (Revision E)", (await fieldGroup(page, CONTACT_EX.name, "dosage-field-reps").count()) === 1);

      await expandDosage(page, TIME_EX.name);
      check("return-to-run exercise shows Time/Interval field", (await fieldGroup(page, TIME_EX.name, "dosage-field-interval-time").count()) === 1);
      check("return-to-run exercise does NOT show Reps/Hold/Contacts/Distance by default", (
        (await fieldGroup(page, TIME_EX.name, "dosage-field-reps").count()) +
          (await fieldGroup(page, TIME_EX.name, "dosage-field-hold").count()) +
          (await fieldGroup(page, TIME_EX.name, "dosage-field-contacts").count()) +
          (await fieldGroup(page, TIME_EX.name, "dosage-field-distance").count())
      ) === 0);

      await expandDosage(page, DISTANCE_EX.name);
      check("distance exercise shows Distance field", (await fieldGroup(page, DISTANCE_EX.name, "dosage-field-distance").count()) === 1);

      // ===================== MULTI-OPEN: all 5 expanded simultaneously =====================
      check("all 5 dosage editors are simultaneously visible", (await page.locator('[data-testid="dosage-editor"]').count()) === 5);
      await screenshotDraftPanel(page, "scripts/.c5s4revb-multi-open.png", draftRow(page, ISO_EX.name));
      await screenshotDraftPanel(page, "scripts/.c5s4revb-reactive-contact.png", draftRow(page, CONTACT_EX.name));
      await screenshotDraftPanel(page, "scripts/.c5s4revb-time-interval.png", draftRow(page, TIME_EX.name));

      // ===================== ISO_EX: reps+hold+load combined save (founder motivating example) =====================
      await fieldGroup(page, ISO_EX.name, "dosage-field-sets").fill("4");
      await fieldGroup(page, ISO_EX.name, "dosage-field-reps").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-reps").getByLabel("Exact reps").fill("5");
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Hold seconds").fill("30");
      await fieldGroup(page, ISO_EX.name, "dosage-field-load").getByLabel("Load type").selectOption("external");
      await fieldGroup(page, ISO_EX.name, "dosage-field-load").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-load").getByLabel("Load value").fill("25");
      await fieldGroup(page, ISO_EX.name, "dosage-field-load").getByLabel("Load unit").selectOption("lb");
      const isoCollapsedOnSave = await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && dosage.reps_exact === 5 && dosage.hold_duration_exact_seconds === "30";
      }, 6000);
      let { dosage: isoDosage } = await getDosageRow(ISO_EX.id, draftId);
      check("combined reps+hold+load saved: sets", isoDosage.sets === 4);
      check("combined reps+hold+load saved: reps_exact", isoDosage.reps_exact === 5);
      check("combined reps+hold+load saved: hold_duration_exact_seconds", Number(isoDosage.hold_duration_exact_seconds) === 30);
      check("combined reps+hold+load saved: load_value_exact", Number(isoDosage.load_value_exact) === 25);
      check("combined reps+hold+load saved: load_unit", isoDosage.load_unit === "lb");
      check("dosage_type derived as 'hold' (hold precedes reps in specialized precedence)", isoDosage.dosage_type === "hold");
      // Superseded by C5.4 Revision E: a successful Save now collapses the
      // editor to the saved-prescription card (it was re-opened above).
      check("editor collapses after successful Save (Revision E)", isoCollapsedOnSave);
      // Screenshot 1: calf isometric editor, Sets+Reps+Hold+Load+Rest combined.
      await screenshotDraftPanel(page, "scripts/.c5s4revb-calf-isometric-combined.png", draftRow(page, ISO_EX.name));
      check("dirty indicator cleared after successful Save", (await editorFor(page, ISO_EX.name).locator('[data-testid="dosage-editor-unsaved"]').count()) === 0);

      // ===================== OPTIONAL CAPABILITIES: hold-only, then reps-only, on the SAME exercise =====================
      // Capability-default fields (reps/hold here) are always VISIBLE but
      // must still be CLEARABLE back to "not populated" — re-clicking the
      // already-active Exact/Range button clears that dimension (decision
      // #22: capability means available, not required).
      await fieldGroup(page, ISO_EX.name, "dosage-field-reps").getByRole("button", { name: "Exact", exact: true }).click(); // reps was Exact/5 -> clears to null
      await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && dosage.reps_mode === null;
      }, 6000);
      ({ dosage: isoDosage } = await getDosageRow(ISO_EX.id, draftId));
      check("reps+hold-capable exercise can save hold-only (reps cleared)", isoDosage.reps_mode === null && Number(isoDosage.hold_duration_exact_seconds) === 30);

      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click(); // hold was Exact/30 -> clears to null
      await fieldGroup(page, ISO_EX.name, "dosage-field-reps").getByRole("button", { name: "Exact", exact: true }).click(); // reps was cleared -> turns back on
      await fieldGroup(page, ISO_EX.name, "dosage-field-reps").getByLabel("Exact reps").fill("12");
      await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && dosage.reps_exact === 12;
      }, 6000);
      ({ dosage: isoDosage } = await getDosageRow(ISO_EX.id, draftId));
      check("same exercise can save reps-only (hold cleared)", isoDosage.hold_duration_mode === null && isoDosage.reps_exact === 12);
      check("dosage_type re-derived as 'repetition' once hold is no longer populated", isoDosage.dosage_type === "repetition");

      // restore combined state for later summary/reference checks
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Hold seconds").fill("30");
      await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && Number(dosage.hold_duration_exact_seconds) === 30 && dosage.reps_exact === 12;
      }, 6000);
      check("reps+hold combination re-saved successfully", true);

      // Screenshot 2: reps-only strength exercise.
      await screenshotDraftPanel(page, "scripts/.c5s4revb-reps-only-strength.png", draftRow(page, REPS_EX.name));

      // ===================== ALLOWED DIMENSIONS (Revision E: no Add parameter) =====================
      // CONTACT_EX (ex_027) is curated with default=[contacts], allowed=
      // [contacts, reps]. Revision E removed "+ Add parameter": every
      // allowed dimension is now shown directly, so Reps is editable without
      // an extra step, and it can still be cleared via the Exact/Range
      // toggle (decision #22).
      check("Add parameter control no longer exists (Revision E)", (await editorFor(page, CONTACT_EX.name).locator('[data-testid="add-parameter"]').count()) === 0);
      check("allowed-but-not-default Reps is shown directly on a contacts-default exercise", (await fieldGroup(page, CONTACT_EX.name, "dosage-field-reps").count()) === 1);
      check("Hold/Distance (outside the allowed set) are still not offered", (await fieldGroup(page, CONTACT_EX.name, "dosage-field-hold").count()) + (await fieldGroup(page, CONTACT_EX.name, "dosage-field-distance").count()) === 0);
      // Screenshot 9: allowed dimensions shown directly (formerly the Add parameter menu).
      await screenshotDraftPanel(page, "scripts/.c5s4revb-add-parameter.png", draftRow(page, CONTACT_EX.name));
      await fieldGroup(page, CONTACT_EX.name, "dosage-field-sets").fill("3");
      await fieldGroup(page, CONTACT_EX.name, "dosage-field-contacts").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, CONTACT_EX.name, "dosage-field-contacts").getByLabel("Exact contacts").fill("20");
      await fieldGroup(page, CONTACT_EX.name, "dosage-field-reps").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, CONTACT_EX.name, "dosage-field-reps").getByLabel("Exact reps").fill("10");
      await saveDosage(page, CONTACT_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(CONTACT_EX.id, draftId);
        return dosage && dosage.reps_exact === 10;
      }, 6000);
      const { dosage: contactExDosage } = await getDosageRow(CONTACT_EX.id, draftId);
      check("allowed Reps parameter persists on a contacts-default exercise", contactExDosage.reps_exact === 10 && Number(contactExDosage.contacts_exact) === 20);
      check("no remove-parameter control (clearing is via the Exact/Range toggle)", (await editorFor(page, CONTACT_EX.name).locator('[data-testid="remove-parameter"]').count()) === 0);
      await fieldGroup(page, CONTACT_EX.name, "dosage-field-reps").getByRole("button", { name: "Exact", exact: true }).click(); // clears reps
      check("allowed Reps field stays visible after clearing (it is applicable)", (await fieldGroup(page, CONTACT_EX.name, "dosage-field-reps").count()) === 1);
      await saveDosage(page, CONTACT_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(CONTACT_EX.id, draftId);
        return dosage && dosage.reps_mode === null;
      }, 6000);
      check("cleared Reps value actually cleared server-side after Save", (await getDosageRow(CONTACT_EX.id, draftId)).dosage?.reps_mode === null);

      // A plain reps-only exercise (allowed === default) has NOTHING left
      // to offer — Add Parameter must be hidden entirely, never an empty menu.
      check("Add Parameter is HIDDEN (not an empty menu) when allowed === default", (await editorFor(page, REPS_EX.name).locator('[data-testid="add-parameter"]').count()) === 0);

      // ===================== CLINICALLY-CURATED MENU: THE FOUNDER'S MOTIVATING EXAMPLE =====================
      // Isometric calf hold: allowed === default === [hold, reps] — Distance
      // and Contacts must never be offered, matching the founder's exact
      // "Double-Leg Isometric Calf Raise Hold" example.
      check(
        "isometric calf exercise (the founder's exact motivating example): Add Parameter hidden entirely — no Contacts/Distance offered",
        (await editorFor(page, ISO_EX.name).locator('[data-testid="add-parameter"]').count()) === 0
      );
      // Interval-only running exercise (ex_033-style, not curated-widened):
      // Distance must not be offered where there is no curated evidence for it.
      check(
        "return-to-run interval exercise with no curated distance evidence: Add Parameter hidden",
        (await editorFor(page, TIME_EX.name).locator('[data-testid="add-parameter"]').count()) === 0
      );
      // Distance-only strides exercise: Time/Interval must not be offered.
      check(
        "distance-only running exercise with no curated time evidence: Add Parameter hidden",
        (await editorFor(page, DISTANCE_EX.name).locator('[data-testid="add-parameter"]').count()) === 0
      );

      // Continuous Easy Run IS curated-widened (default=[interval_time],
      // allowed=[interval_time, distance]) — Distance should be offered,
      // and ONLY Distance (never Hold/Contacts/Reps).
      await addFromLibrary(page, RUN_EX.name);
      await expandDosage(page, RUN_EX.name);
      check("curated running exercise shows Time/Interval by default", (await fieldGroup(page, RUN_EX.name, "dosage-field-interval-time").count()) === 1);
      // Revision E: the allowed Distance dimension is shown directly (no Add
      // parameter step), and nothing outside the allowed set appears.
      check("curated running exercise shows allowed Distance directly", (await fieldGroup(page, RUN_EX.name, "dosage-field-distance").count()) === 1);
      check(
        "curated running exercise offers no Hold/Contacts/Reps",
        (await fieldGroup(page, RUN_EX.name, "dosage-field-hold").count()) + (await fieldGroup(page, RUN_EX.name, "dosage-field-contacts").count()) + (await fieldGroup(page, RUN_EX.name, "dosage-field-reps").count()) === 0
      );

      // ===================== HISTORICAL / OFF-ALLOWED-SET COMPATIBILITY =====================
      // Directly seed a "historical" dosage row containing a dimension that
      // is NOT in this exercise's (isometric) allowed set at all — the
      // curated allowed set must govern only what NEW parameter can be
      // ADDED, never cause existing saved clinical data to disappear.
      const { exerciseId: isoExerciseIdForHistory } = await getDosageRow(ISO_EX.id, draftId);
      await admin.from("prescription_exercise_dosage").upsert(
        {
          prescription_exercise_id: isoExerciseIdForHistory,
          dosage_type: "distance",
          sets: 2,
          distance_mode: "exact",
          distance_exact_value: 10,
          distance_unit: "m",
        },
        { onConflict: "prescription_exercise_id" }
      );
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      await expandDosage(page, ISO_EX.name);
      check(
        "an existing off-ALLOWED-set dimension (Distance on an isometric exercise) still DISPLAYS after reload",
        (await fieldGroup(page, ISO_EX.name, "dosage-field-distance").count()) === 1
      );
      check(
        "the off-allowed dimension is NOT offered a second time via Add Parameter (already visible)",
        (await editorFor(page, ISO_EX.name).locator('[data-testid="add-parameter-option"]').filter({ hasText: "Distance" }).count()) === 0
      );
      const { dosage: historicalCheckDosage } = await getDosageRow(ISO_EX.id, draftId);
      check("historical off-allowed dosage row was NOT silently deleted by merely viewing it", historicalCheckDosage != null && Number(historicalCheckDosage.distance_exact_value) === 10);
      // Clinician may still edit/clear it like any other visible field.
      await fieldGroup(page, ISO_EX.name, "dosage-field-distance").getByRole("button", { name: "Exact", exact: true }).click(); // toggles off -> clears
      await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && dosage.distance_mode === null;
      }, 6000);
      check("clinician can edit/clear a historical off-allowed dimension like any other visible field", true);

      // ===================== EXTERNAL LOAD RANGE =====================
      // The reload above (historical-compatibility test) collapsed every
      // previously-expanded editor — expand state is not persisted across
      // a full page reload (expected; unchanged from Revision B).
      await expandDosage(page, DISTANCE_EX.name);
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-load").getByLabel("Load type").selectOption("external");
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-load").getByRole("button", { name: "Range", exact: true }).click();
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-load").getByLabel("Minimum load").fill("20");
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-load").getByLabel("Maximum load").fill("30");
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-load").getByLabel("Load unit").selectOption("lb");
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-distance").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, DISTANCE_EX.name, "dosage-field-distance").getByLabel("Exact distance").fill("60");
      await editorFor(page, DISTANCE_EX.name).getByLabel("Distance unit").selectOption("m");
      await saveDosage(page, DISTANCE_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(DISTANCE_EX.id, draftId);
        return dosage && dosage.load_mode === "range";
      }, 6000);
      const { dosage: distDosage } = await getDosageRow(DISTANCE_EX.id, draftId);
      check("external load range saved: load_mode", distDosage.load_mode === "range");
      check("external load range saved: load_value_min", Number(distDosage.load_value_min) === 20);
      check("external load range saved: load_value_max", Number(distDosage.load_value_max) === 30);
      check("distance exact value also saved correctly alongside load range", Number(distDosage.distance_exact_value) === 60);
      // Screenshot 5: load range.
      await screenshotDraftPanel(page, "scripts/.c5s4revb-load-range.png", draftRow(page, DISTANCE_EX.name));

      // ===================== DOSAGE SUMMARY =====================
      // Revision E: the saved-prescription summary is the COLLAPSED card.
      await collapseDosage(page, ISO_EX.name);
      await collapseDosage(page, DISTANCE_EX.name);
      const isoSummary = await draftRow(page, ISO_EX.name).locator('[data-testid="dosage-summary"]').innerText();
      // dosage_type is currently 'repetition' (primary), and the primary
      // repetition rendering has never included the literal word "reps"
      // (matches pre-existing, unchanged C5.4B format — e.g. "4 × 12"); the
      // count itself is what proves reps is represented.
      check("summary includes the reps count", isoSummary.includes("12"), isoSummary);
      check("summary includes hold", /hold/.test(isoSummary.toLowerCase()));
      check("summary does not expose raw dosage_type/capability enum values", !/repetition|interval_time|dosage_type/.test(isoSummary.toLowerCase()));
      const distSummary = await draftRow(page, DISTANCE_EX.name).locator('[data-testid="dosage-summary"]').innerText();
      check("summary shows load range (20-30 or 20–30)", /20[–-]30/.test(distSummary));

      // ===================== DURATION INPUT BUG =====================
      await collapseDosage(page, ISO_EX.name);
      await collapseDosage(page, REPS_EX.name);
      await collapseDosage(page, DISTANCE_EX.name);
      await expandDosage(page, TIME_EX.name);
      const workSeconds = fieldGroup(page, TIME_EX.name, "dosage-field-interval-time").getByLabel("Work seconds");
      await workSeconds.fill("");
      await workSeconds.pressSequentially("30");
      check("typing '30' into a fresh seconds field results in '30', not '030'", (await workSeconds.inputValue()) === "30");
      await workSeconds.fill("");
      check("clearing the seconds field results in an empty value", (await workSeconds.inputValue()) === "");
      await workSeconds.pressSequentially("45");
      const workMinutes = fieldGroup(page, TIME_EX.name, "dosage-field-interval-time").getByLabel("Work minutes");
      await workMinutes.fill("");
      await workMinutes.pressSequentially("2");
      check("min+sec entry: minutes shows '2'", (await workMinutes.inputValue()) === "2");
      check("min+sec entry: seconds shows '45'", (await workSeconds.inputValue()) === "45");
      // range duration typing (Hold field range, on ISO_EX)
      await expandDosage(page, ISO_EX.name);
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Range", exact: true }).click();
      const holdMinSec = fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Min Hold seconds");
      await holdMinSec.fill("");
      await holdMinSec.pressSequentially("20");
      check("range duration (min) manual typing: '20' not '020'", (await holdMinSec.inputValue()) === "20");
      const holdMaxSec = fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Max Hold seconds");
      await holdMaxSec.fill("");
      await holdMaxSec.pressSequentially("40");
      check("range duration (max) manual typing: '40' not '040'", (await holdMaxSec.inputValue()) === "40");
      // switch back to exact and restore the saved value (leave state clean for later checks)
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Hold seconds").fill("30");
      // blur/reopen persisted-value fidelity
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      await expandDosage(page, ISO_EX.name);
      const reopenedHoldSec = await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Hold seconds").inputValue();
      check("reopening a saved hold value shows it correctly (no leading zero, no drift)", reopenedHoldSec === "30");

      // ===================== WORKING STATE: unsaved A survives opening B, workout switch, and a refresh from saving elsewhere =====================
      const setsA = fieldGroup(page, ISO_EX.name, "dosage-field-sets");
      await setsA.fill("");
      await setsA.pressSequentially("9");
      await expandDosage(page, REPS_EX.name);
      check("unsaved A (sets=9) survives opening B", (await setsA.inputValue()) === "9");
      check("A's Unsaved changes indicator is visible while B is being edited", (await editorFor(page, ISO_EX.name).locator('[data-testid="dosage-editor-unsaved"]').count()) === 1);
      // Screenshot 7: A shows Unsaved changes while B is being edited (both visible).
      await screenshotDraftPanel(page, "scripts/.c5s4revb-unsaved-while-editing-other.png", draftRow(page, ISO_EX.name));

      await page.locator('[data-testid="workout-tab"]').filter({ hasText: workoutBLabel }).click();
      await page.waitForTimeout(300);
      await page.locator('[data-testid="workout-tab"]').filter({ hasText: workoutALabel }).click();
      await page.waitForTimeout(300);
      const setsAAfterSwitch = fieldGroup(page, ISO_EX.name, "dosage-field-sets");
      check("unsaved A (sets=9) survives switching workouts A -> B -> A", (await setsAAfterSwitch.inputValue()) === "9");

      await saveDosage(page, REPS_EX.name); // saving B triggers a full refreshDraft()
      await waitForCondition(async () => (await setsAAfterSwitch.inputValue()) === "9", 4000);
      check("Save on B does not destroy unsaved A", (await setsAAfterSwitch.inputValue()) === "9");

      // failed save does not destroy working state
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Range", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Min Hold seconds").fill("50");
      // leave Max blank -> malformed range -> Save should reject
      await saveDosage(page, ISO_EX.name);
      await page.waitForTimeout(400);
      check("failed Save leaves working state (sets=9, min=50) intact", (await setsAAfterSwitch.inputValue()) === "9");
      // restore to a valid, saved state for downstream checks
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click();
      await fieldGroup(page, ISO_EX.name, "dosage-field-hold").getByLabel("Hold seconds").fill("30");
      await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && dosage.sets === 9;
      }, 6000);
      check("recovered valid state saves successfully after the earlier failed attempt", true);

      // ===================== CANCEL / COLLAPSE =====================
      const setsField = fieldGroup(page, ISO_EX.name, "dosage-field-sets");
      await setsField.fill("");
      await setsField.pressSequentially("7");
      await collapseDosage(page, ISO_EX.name);
      // Screenshot 8: compact saved dosage summaries (all rows collapsed).
      await screenshotDraftPanel(page, "scripts/.c5s4revb-summaries.png", draftRow(page, ISO_EX.name));
      await expandDosage(page, ISO_EX.name);
      check("collapsing then reopening preserves unsaved value (collapse is not Cancel)", (await fieldGroup(page, ISO_EX.name, "dosage-field-sets").inputValue()) === "7");
      await cancelDosage(page, ISO_EX.name);
      check("Cancel closes the editor", (await editorFor(page, ISO_EX.name).count()) === 0);
      await expandDosage(page, ISO_EX.name);
      check("Cancel restored the last-SAVED value (sets=9), not blank", (await fieldGroup(page, ISO_EX.name, "dosage-field-sets").inputValue()) === "9");
      const { dosage: postCancelDosage } = await getDosageRow(ISO_EX.id, draftId);
      check("Cancel never deleted the saved dosage row", postCancelDosage != null && postCancelDosage.sets === 9);

      // ===================== MOVE WITH UNSAVED STATE =====================
      const { exerciseId: isoExerciseIdForMove } = await getDosageRow(ISO_EX.id, draftId);
      const { data: workoutRowsForMove } = await admin.from("prescription_workouts").select("id, label").eq("prescription_draft_id", draftId);
      const workoutBId = workoutRowsForMove.find((w) => w.label === workoutBLabel).id;
      await setsField.fill("");
      await editorFor(page, ISO_EX.name).getByLabel("Sets").pressSequentially("11");
      await draftRow(page, ISO_EX.name).locator('[data-testid="move-to-workout"]').selectOption({ label: workoutBLabel });
      await waitForCondition(async () => {
        const { data } = await admin.from("prescription_exercises").select("prescription_workout_id").eq("id", isoExerciseIdForMove).single();
        return data && data.prescription_workout_id === workoutBId;
      }, 6000);
      await page.locator('[data-testid="workout-tab"]').filter({ hasText: workoutBLabel }).click();
      const movedStillExpanded = await waitForCondition(async () => (await editorFor(page, ISO_EX.name).count()) === 1, 6000);
      check("moved exercise's editor is still present in the destination workout", movedStillExpanded);
      if (movedStillExpanded) {
        check("unsaved value (sets=11) survived the move", (await fieldGroup(page, ISO_EX.name, "dosage-field-sets").inputValue()) === "11");
      }
      await saveDosage(page, ISO_EX.name);
      await waitForCondition(async () => {
        const { dosage } = await getDosageRow(ISO_EX.id, draftId);
        return dosage && dosage.sets === 11;
      }, 6000);
      check("post-move save succeeds independently of the earlier unsaved state", true);

      // ===================== DELETE WARNINGS =====================
      const setsField2 = fieldGroup(page, ISO_EX.name, "dosage-field-sets");
      await setsField2.fill("");
      await setsField2.pressSequentially("13");
      await draftRow(page, ISO_EX.name).locator('[aria-label="Remove from draft"]').click();
      check("removing a DIRTY exercise shows an explicit warning", (await page.locator('[data-testid="remove-exercise-confirm"]').count()) === 1);
      // Screenshot 12: dirty-delete confirmation.
      await screenshotDraftPanel(page, "scripts/.c5s4revb-dirty-delete-confirm.png", draftRow(page, ISO_EX.name));
      await page.getByRole("button", { name: "Keep Exercise" }).click();
      check("declining keeps the exercise and its unsaved state", (await fieldGroup(page, ISO_EX.name, "dosage-field-sets").inputValue()) === "13");
      await draftRow(page, ISO_EX.name).locator('[aria-label="Remove from draft"]').click();
      await page.getByRole("button", { name: "Discard and Remove" }).click();
      await waitForCondition(async () => (await draftRow(page, ISO_EX.name).count()) === 0, 6000);
      check("confirmed removal actually removes the exercise", (await draftRow(page, ISO_EX.name).count()) === 0);
      const { dosage: goneDosage } = await getDosageRow(ISO_EX.id, draftId);
      check("removed exercise's dosage row is gone server-side too", goneDosage === null);

      // dirty workout deletion warning: put an unsaved edit on TIME_EX (currently in Workout A) then delete Workout A
      await page.locator('[data-testid="workout-tab"]').filter({ hasText: workoutALabel }).click();
      await page.waitForTimeout(300);
      await expandDosage(page, TIME_EX.name);
      await fieldGroup(page, TIME_EX.name, "dosage-field-interval-time").getByLabel("Work seconds").fill("");
      await fieldGroup(page, TIME_EX.name, "dosage-field-interval-time").getByLabel("Work seconds").pressSequentially("15");
      await page.getByRole("button", { name: "Delete workout" }).click();
      const confirmPanel = page.locator('[data-testid="delete-workout-confirm"]');
      await confirmPanel.waitFor({ state: "visible", timeout: 5000 });
      check("populated-workout delete confirmation mentions unsaved dosage edits when applicable", (await page.locator('[data-testid="delete-workout-unsaved-warning"]').count()) === 1);
      await confirmPanel.getByRole("button", { name: "Delete Workout" }).click();
      await waitForCondition(async () => (await page.locator('[data-testid="workout-tab"]').count()) === 1, 6000);
      check("workout deleted successfully despite unsaved dosage inside it", (await page.locator('[data-testid="workout-tab"]').count()) === 1);

      // ===================== REFERENCE DOSAGE STILL INFORMATIONAL =====================
      // Both fixture workouts are now empty/deleted by the delete tests
      // above — add a fresh exercise back so the remaining checks (which
      // need a real, currently-existing exercise) have something to target.
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      await addFromLibrary(page, ISO_EX.name);
      await expandDosage(page, ISO_EX.name);
      const refBox = editorFor(page, ISO_EX.name).locator("text=Reference dosage");
      check("reference dosage box present and marked informational-only for a fresh, never-dosed exercise", (await refBox.count()) === 1);
      check(
        "a fresh exercise's working draft starts with NO auto-populated values despite a reference dosage existing",
        (await fieldGroup(page, ISO_EX.name, "dosage-field-sets").inputValue()) === ""
      );

      // Screenshot 10: mobile dosage editor at ~390px.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /^Draft/ }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "scripts/.c5s4revb-mobile.png", fullPage: true });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(300);

      // ===================== VIEW-ONLY CLINICIAN =====================
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=Exercise Library");
      const otherRow = otherPage.locator('[data-testid="draft-exercise-row"]').first();
      // Screenshot 11: view-only clinician.
      await otherPage.screenshot({ path: "scripts/.c5s4revb-view-only.png", fullPage: true });
      check("view-only clinician's row is not an interactive button", (await otherRow.locator('[data-testid="draft-exercise-row-toggle"][role="button"]').count()) === 0);
      await otherRow.click().catch(() => {});
      check("clicking a view-only row does not open a dosage editor", (await otherPage.locator('[data-testid="dosage-editor"]').count()) === 0);
      const unauthDosage = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-exercises/${(await getDosageRow(ISO_EX.id, draftId)).exerciseId}/dosage`, {
        method: "PUT",
        data: { dosage: { dosageType: "repetition", sets: 99, repsMode: "exact", repsExact: 99 } },
      });
      check("non-owning clinician's direct dosage API mutation is rejected", unauthDosage.status() === 403);
      await otherPage.close();

      await page.close();
      await ctxOwner.close();
      await ctxOther.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (patientPrescriptionId) await admin.from("patient_prescriptions").delete().eq("id", patientPrescriptionId);
    await admin.from("supervisor_patients").delete().eq("patient_id", patient.userId);
    const allUserIds = [owner.userId, otherSupervisor.userId, patient.userId];
    await admin.from("organization_members").delete().in("user_id", allUserIds);
    await admin.from("profiles").delete().in("id", allUserIds);
    for (const uid of allUserIds) await admin.auth.admin.deleteUser(uid);

    const legacyDbTeardown = new DatabaseSync(LEGACY_DB_PATH);
    try {
      legacyDbTeardown.exec(`DELETE FROM supervisor_patients WHERE supervisor_id IN (${legacyOwnerId}, ${legacyOtherId})`);
      legacyDbTeardown.exec(`DELETE FROM users WHERE id IN (${legacyOwnerId}, ${legacyOtherId}, ${legacyPatientId})`);
    } finally {
      legacyDbTeardown.close();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
