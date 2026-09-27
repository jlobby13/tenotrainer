// C5.4B — Exercise Dosage Authoring. Live HTTP/UI verification. Drives the
// REAL Next.js pages/API routes over authenticated Playwright sessions,
// using entirely throwaway fixture users and REAL (read-only, never
// mutated) canonical exercises from the C5.3G migrated library. Mirrors
// verifyC5Stage4aPrescriptionBuilder.mjs's conventions exactly.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4bDosageAuthoring.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = "http://localhost:3000";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";

// Real, permanently-migrated C5.3G canonical exercises (deterministic
// UUIDv5 — see 20260921000001's header). READ-ONLY here: this script never
// inserts/updates/deletes canonical_exercises or exercise_reference_dosage.
const REP_EX = { id: "8b1bf121-fa02-5e64-9a1d-61deaf7e8c70", name: "Double-Leg Calf Isometric Hold" };
const HOLD_EX = { id: "a09d5f06-4e1c-534e-8e28-521ded8d679b", name: "Single-Leg Calf Isometric Hold" };
const CONTACT_EX = { id: "105e9b07-0895-5dff-be29-b1d00fda34e3", name: "Bent-Knee Calf Isometric Hold" };
const DISTANCE_EX = { id: "29459eea-e973-51d4-970e-fad1d9e582e0", name: "Seated Isometric Plantarflexion" };
const TIME_EX = { id: "3e5afb82-94ca-5e00-839b-7e6f69ab0984", name: "Supported Standing Calf Raise — Partial Range" };
const CANCEL_EX = { id: "4d67ba9e-b524-535b-9325-e14aa24acbdd", name: "Balance and Frontal-Plane Control Drills" }; // no reference dosage (approved C5.3G omission)
const CLONE_EX = { id: "2782f1b4-3b8c-5575-a25c-06b809e116fd", name: "Leg Press Calf Raise — Short-Range Isometric" };

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
  const email = `c5s4b-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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

function draftRow(page, exerciseName) {
  return page.locator('[data-testid="draft-exercise-row"]').filter({ hasText: exerciseName });
}
async function openEditor(page, exerciseName) {
  const row = draftRow(page, exerciseName);
  await row.locator('[data-testid="dosage-affordance"]').click();
  const editor = row.locator('[data-testid="dosage-editor"]');
  await editor.waitFor({ state: "visible" });
  return { row, editor };
}
function moreOptionsToggle(editor) {
  return editor.getByRole("button", { name: "More options" });
}
async function isMoreOptionsOpen(editor) {
  return (await moreOptionsToggle(editor).getAttribute("aria-expanded")) === "true";
}
async function ensureMoreOptionsOpen(editor) {
  if (!(await isMoreOptionsOpen(editor))) await moreOptionsToggle(editor).click();
}
async function setDuration(editor, label, min, sec) {
  if (min != null) await editor.getByLabel(`${label} minutes`).fill(String(min));
  if (sec != null) await editor.getByLabel(`${label} seconds`).fill(String(sec));
}
async function saveAndWaitClosed(row, editor) {
  await editor.getByRole("button", { name: "Save dosage" }).click();
  await editor.waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
}

async function main() {
  const owner = await makeUser("dosage-owner");
  const otherSupervisor = await makeUser("dosage-other");
  const patient = await makeUser("dosage-patient");
  const clonePatient = await makeUser("dosage-clone-patient");

  let legacyOwnerId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let legacyClonePatientId = null;
  let patientPrescriptionId = null;
  let draftId = null;
  let workoutId = null;
  const exerciseIdByName = {};
  let clonePatientPrescriptionId = null;
  let cloneVersionId = null;
  let cloneDraftId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyOwnerId = insertUser.run("c5s4b-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4b-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4b-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
    legacyClonePatientId = insertUser.run("c5s4b-verify-clone-patient", clonePatient.email, "patient", clonePatient.userId).lastInsertRowid;
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

    // --- primary fixture draft: empty prescription, one workout, 6 exercises (no dosage yet) ---
    const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
    patientPrescriptionId = pp.id;
    const { data: draftRowData } = await admin
      .from("prescription_drafts")
      .insert({ patient_prescription_id: patientPrescriptionId, status: "editing", source: "empty", created_by: owner.userId, editing_clinician_id: owner.userId, updated_by: owner.userId })
      .select("id")
      .single();
    draftId = draftRowData.id;
    const { data: workoutRow } = await admin.from("prescription_workouts").insert({ prescription_draft_id: draftId, order_index: 0 }).select("id").single();
    workoutId = workoutRow.id;

    const exercisesToSeed = [REP_EX, HOLD_EX, CONTACT_EX, DISTANCE_EX, TIME_EX, CANCEL_EX];
    for (let i = 0; i < exercisesToSeed.length; i++) {
      const { data: peRow } = await admin
        .from("prescription_exercises")
        .insert({ prescription_workout_id: workoutId, canonical_exercise_id: exercisesToSeed[i].id, order_index: i })
        .select("id")
        .single();
      exerciseIdByName[exercisesToSeed[i].name] = peRow.id;
    }

    // --- clone-active fixture: a SEPARATE patient with a real published
    // version carrying a real dosage, so the "cloned active dosage loads
    // correctly" + "active Rx unchanged during draft editing" checks are
    // against genuine C5.3 publish-shaped data, not a hand-rolled draft. ---
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
      })
      .select("id")
      .single();
    cloneVersionId = cloneVersion.id;
    await admin.from("patient_prescriptions").update({ current_prescription_version_id: cloneVersionId }).eq("id", clonePatientPrescriptionId);
    const { data: cloneWorkout } = await admin.from("prescription_workouts").insert({ prescription_version_id: cloneVersionId, order_index: 0 }).select("id").single();
    const { data: cloneExercise } = await admin
      .from("prescription_exercises")
      .insert({ prescription_workout_id: cloneWorkout.id, canonical_exercise_id: CLONE_EX.id, order_index: 0 })
      .select("id")
      .single();
    await admin.from("prescription_exercise_dosage").insert({
      prescription_exercise_id: cloneExercise.id,
      dosage_type: "repetition",
      sets: 3,
      reps_mode: "exact",
      reps_exact: 12,
      load_type: "bodyweight",
      rest_seconds: 45,
    });

    const browser = await chromium.launch();
    try {
      const ctxOwner = await loginContext(browser, owner.email);
      const ctxOther = await loginContext(browser, otherSupervisor.email);
      const page = await ctxOwner.newPage();
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");
      await page.locator('[data-testid="draft-panel"]').getByText("Draft").first().isVisible().catch(() => {});

      // ===================== REPETITION: exact -> range (also = edit-existing) =====================
      {
        const { row, editor } = await openEditor(page, REP_EX.name);
        check("reference dosage shown in editor context for an exercise that has one", await editor.getByText("Reference dosage").isVisible());
        check(
          "reference dosage carries the informational-only warning inside the editor",
          await editor.getByText(/Informational only/).isVisible()
        );
        for (const forbidden of ["Apply", "Copy reference", "Use this", "Autofill"]) {
          check(`no "${forbidden}" one-click affordance exists in the editor`, (await editor.getByRole("button", { name: forbidden }).count()) === 0);
        }
        check("new exercise's dosage type starts unselected (never auto-picked from reference)", await editor.locator("#dosage-type").inputValue() === "");

        await editor.locator("#dosage-type").selectOption("repetition");
        await editor.locator("#dosage-sets").fill("3");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await editor.getByLabel("Exact reps").fill("10");
        await editor.locator("#dosage-load-type").selectOption("bodyweight");
        await setDuration(editor, "Rest", 1, 0);
        await saveAndWaitClosed(row, editor);

        const summary = row.locator('[data-testid="dosage-affordance"]');
        check("repetition exact summary renders correctly", (await summary.innerText()).trim() === "3 × 10 · Bodyweight · 60s rest", await summary.innerText());

        const { data: dbRow } = await admin.from("prescription_exercise_dosage").select("*").eq("prescription_exercise_id", exerciseIdByName[REP_EX.name]).single();
        check("repetition exact persisted correctly (DB)", dbRow.dosage_type === "repetition" && dbRow.reps_mode === "exact" && dbRow.reps_exact === 10 && dbRow.load_type === "bodyweight" && Number(dbRow.rest_seconds) === 60);

        // Edit existing -> switch to range + external load lb (also proves reload-then-edit)
        await page.reload();
        await page.waitForSelector("text=Exercise Library");
        const { row: row2, editor: editor2 } = await openEditor(page, REP_EX.name);
        check("editing a dosage with NO advanced values starts More options COLLAPSED", !(await isMoreOptionsOpen(editor2)));
        check("editing existing dosage loads persisted values (mode)", await editor2.locator("#dosage-type").inputValue() === "repetition");
        check("editing existing dosage loads persisted exact value", await editor2.getByLabel("Exact reps").inputValue() === "10");
        await editor2.getByRole("button", { name: "Range", exact: true }).click();
        await editor2.getByLabel("Minimum reps").fill("8");
        await editor2.getByLabel("Maximum reps").fill("12");
        await editor2.locator("#dosage-load-type").selectOption("external");
        await editor2.getByLabel("Load value").fill("25");
        await editor2.getByLabel("Load unit").selectOption("lb");
        await setDuration(editor2, "Rest", 1, 30);
        await saveAndWaitClosed(row2, editor2);

        const summary2 = row2.locator('[data-testid="dosage-affordance"]');
        check("repetition range summary renders correctly", (await summary2.innerText()).trim() === "3 × 8–12 · 25 lb · 90s rest", await summary2.innerText());
        const { data: dbRow2 } = await admin.from("prescription_exercise_dosage").select("*").eq("prescription_exercise_id", exerciseIdByName[REP_EX.name]).single();
        check(
          "repetition range persisted correctly and exact fields cleared",
          dbRow2.reps_mode === "range" && dbRow2.reps_min === 8 && dbRow2.reps_max === 12 && dbRow2.reps_exact === null && dbRow2.load_unit === "lb" && Number(dbRow2.load_value_exact) === 25
        );
        check("clinician-entered unit (lb) preserved, not silently converted", dbRow2.load_unit === "lb");
        check("DB-owned derived kg value computed automatically (internal only)", Math.abs(Number(dbRow2.load_value_kg_derived) - 11.3398) < 0.01);

        // ===== dosage-type switch: Repetition -> Hold on the SAME exercise =====
        const { row: row3, editor: editor3 } = await openEditor(page, REP_EX.name);
        await editor3.locator("#dosage-type").selectOption("hold");
        await editor3.locator("#dosage-sets").fill("2");
        await editor3.getByRole("button", { name: "Exact", exact: true }).click();
        await setDuration(editor3, "Duration", 0, 20);
        await saveAndWaitClosed(row3, editor3);
        const { data: switchedRow } = await admin.from("prescription_exercise_dosage").select("*").eq("prescription_exercise_id", exerciseIdByName[REP_EX.name]).single();
        check(
          "type switch Repetition->Hold clears ALL stale repetition fields",
          switchedRow.dosage_type === "hold" &&
            switchedRow.reps_mode === null &&
            switchedRow.reps_exact === null &&
            switchedRow.reps_min === null &&
            switchedRow.reps_max === null &&
            Number(switchedRow.hold_duration_exact_seconds) === 20
        );
        check("type switch preserves type-independent fields (sets updated, not stale)", switchedRow.sets === 2);
        check("type switch PRESERVES shared optional fields (rest) rather than wiping them", Number(switchedRow.rest_seconds) === 90);
      }

      // ===================== HOLD: exact, then load-type coverage (external kg, assisted) =====================
      {
        const { row, editor } = await openEditor(page, HOLD_EX.name);
        await editor.locator("#dosage-type").selectOption("hold");
        await editor.locator("#dosage-sets").fill("4");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await setDuration(editor, "Duration", 0, 30);
        await editor.locator("#dosage-load-type").selectOption("external");
        await editor.getByLabel("Load value").fill("20");
        await editor.getByLabel("Load unit").selectOption("lb");
        await setDuration(editor, "Rest", 1, 0);
        await saveAndWaitClosed(row, editor);
        const summary = row.locator('[data-testid="dosage-affordance"]');
        check("hold exact summary renders correctly", (await summary.innerText()).trim() === "4 × 30s hold · 20 lb · 60s rest", await summary.innerText());

        // External kg
        const { row: row2, editor: editor2 } = await openEditor(page, HOLD_EX.name);
        await editor2.locator("#dosage-load-type").selectOption("external");
        await editor2.getByLabel("Load value").fill("9");
        await editor2.getByLabel("Load unit").selectOption("kg");
        await saveAndWaitClosed(row2, editor2);
        const { data: kgRow } = await admin.from("prescription_exercise_dosage").select("load_unit, load_value_exact, load_value_kg_derived").eq("prescription_exercise_id", exerciseIdByName[HOLD_EX.name]).single();
        check("external load kg preserved verbatim (no forced conversion)", kgRow.load_unit === "kg" && Number(kgRow.load_value_exact) === 9);
        check("derived kg column matches authored kg value directly", Math.abs(Number(kgRow.load_value_kg_derived) - 9) < 0.0001);

        // Assisted (no fake zero-load)
        const { row: row3, editor: editor3 } = await openEditor(page, HOLD_EX.name);
        await editor3.locator("#dosage-load-type").selectOption("assisted");
        await saveAndWaitClosed(row3, editor3);
        const { data: assistedRow } = await admin.from("prescription_exercise_dosage").select("load_type, load_value_exact, load_unit").eq("prescription_exercise_id", exerciseIdByName[HOLD_EX.name]).single();
        check("Assisted load carries no numeric value (no fake 0)", assistedRow.load_type === "assisted" && assistedRow.load_value_exact === null && assistedRow.load_unit === null);
        const summary3 = row3.locator('[data-testid="dosage-affordance"]');
        check("Assisted renders in the summary without a fabricated number", (await summary3.innerText()).includes("Assisted"));
      }

      // ===================== CONTACT: exact, plus RPE/RIR mutual exclusion =====================
      {
        const { row, editor } = await openEditor(page, CONTACT_EX.name);
        await editor.locator("#dosage-type").selectOption("contact");
        check("new dosage with no advanced values starts with More options COLLAPSED", !(await isMoreOptionsOpen(editor)));
        check("Load remains visible while More options is collapsed", await editor.locator("#dosage-load-type").isVisible());
        check("Rest remains visible while More options is collapsed", await editor.getByText("Rest (optional)").isVisible());
        await editor.locator("#dosage-sets").fill("3");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await editor.getByLabel("Exact contacts").fill("20");
        await setDuration(editor, "Rest", 2, 0);
        await ensureMoreOptionsOpen(editor);
        await editor.getByRole("button", { name: "RPE", exact: true }).click();
        await editor.getByLabel("RPE value").fill("7");
        await saveAndWaitClosed(row, editor);
        const summary = row.locator('[data-testid="dosage-affordance"]');
        check("contact exact summary renders correctly", (await summary.innerText()).trim() === "3 × 20 contacts · 2 min rest", await summary.innerText());
        const { data: rpeRow } = await admin.from("prescription_exercise_dosage").select("rpe, rir").eq("prescription_exercise_id", exerciseIdByName[CONTACT_EX.name]).single();
        check("RPE persisted, RIR left null", Number(rpeRow.rpe) === 7 && rpeRow.rir === null);

        // Switch RPE -> RIR: RPE must be cleared. This dosage now HAS an
        // advanced value (RPE=7), so reopening must start EXPANDED.
        const { row: row2, editor: editor2 } = await openEditor(page, CONTACT_EX.name);
        check("editing a dosage that already has an advanced value (RPE) starts More options EXPANDED", await isMoreOptionsOpen(editor2));
        await editor2.getByRole("button", { name: "RIR", exact: true }).click();
        await editor2.getByLabel("RIR value").fill("2");
        await saveAndWaitClosed(row2, editor2);
        const { data: rirRow } = await admin.from("prescription_exercise_dosage").select("rpe, rir").eq("prescription_exercise_id", exerciseIdByName[CONTACT_EX.name]).single();
        check("switching to RIR clears RPE (mutual exclusion honored on save)", rirRow.rpe === null && rirRow.rir === 2);
      }

      // ===================== DISTANCE: exact + full optional-field coverage =====================
      {
        const { row, editor } = await openEditor(page, DISTANCE_EX.name);
        await editor.locator("#dosage-type").selectOption("distance");
        await editor.locator("#dosage-sets").fill("4");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await editor.getByLabel("Exact distance").fill("60");
        await editor.getByLabel("Unit").selectOption("m");
        await setDuration(editor, "Rest", 2, 0);
        await ensureMoreOptionsOpen(editor);
        await editor.locator("#dosage-rom").fill("Full range, pain-free only");
        await editor.locator("#dosage-assistance").selectOption("moderate");
        await editor.locator("#dosage-side").selectOption("left");
        await editor.locator("#dosage-instructions").fill("Use countertop support if needed.");
        // Collapse BEFORE saving — collapsing must never clear values, and
        // the collapsed values must still persist normally on Save.
        await moreOptionsToggle(editor).click();
        check("collapsing More options hides (does not remove) the advanced fields", await editor.locator("#dosage-rom").isHidden());
        await ensureMoreOptionsOpen(editor);
        check("re-expanding after a collapse shows the value UNCHANGED (never cleared)", (await editor.locator("#dosage-rom").inputValue()) === "Full range, pain-free only");
        await moreOptionsToggle(editor).click();
        await saveAndWaitClosed(row, editor);
        const summary = row.locator('[data-testid="dosage-affordance"]');
        check("distance exact summary renders correctly", (await summary.innerText()).trim() === "4 × 60 m · 2 min rest", await summary.innerText());

        const { data: dRow } = await admin.from("prescription_exercise_dosage").select("*").eq("prescription_exercise_id", exerciseIdByName[DISTANCE_EX.name]).single();
        check("distance unit persisted exactly as entered (m)", dRow.distance_unit === "m");
        check("derived meters value correct for unit m (identity)", Math.abs(Number(dRow.distance_value_m_derived) - 60) < 0.0001);
        check("ROM persisted as free text", dRow.rom === "Full range, pain-free only");
        check("Assistance persisted using locked vocabulary", dRow.assistance_level === "moderate");
        check("Side persisted using locked vocabulary (patient-specific, not library laterality)", dRow.side === "left");

        const { data: peRow } = await admin.from("prescription_exercises").select("additional_instructions").eq("id", exerciseIdByName[DISTANCE_EX.name]).single();
        check("patient-specific instructions persisted separately from dosage", peRow.additional_instructions === "Use countertop support if needed.");

        // Distance in a different unit (km) — derived-meters correctness across units
        const { row: row2, editor: editor2 } = await openEditor(page, DISTANCE_EX.name);
        check(
          "editing a dosage with saved ROM/assistance/side/instructions starts More options EXPANDED",
          await isMoreOptionsOpen(editor2)
        );
        check("all advanced fields remain correctly populated on edit (ROM)", (await editor2.locator("#dosage-rom").inputValue()) === "Full range, pain-free only");
        check("all advanced fields remain correctly populated on edit (Assistance)", (await editor2.locator("#dosage-assistance").inputValue()) === "moderate");
        check("all advanced fields remain correctly populated on edit (Side)", (await editor2.locator("#dosage-side").inputValue()) === "left");
        check(
          "all advanced fields remain correctly populated on edit (instructions)",
          (await editor2.locator("#dosage-instructions").inputValue()) === "Use countertop support if needed."
        );
        await editor2.getByRole("button", { name: "Range", exact: true }).click();
        await editor2.getByLabel("Minimum distance").fill("0.5");
        await editor2.getByLabel("Maximum distance").fill("1");
        await editor2.getByLabel("Unit").selectOption("km");
        await saveAndWaitClosed(row2, editor2);
        const summary2 = row2.locator('[data-testid="dosage-affordance"]');
        check("distance range summary with km unit renders correctly", (await summary2.innerText()).trim() === "4 × 0.5–1 km · 2 min rest", await summary2.innerText());
        const { data: kmRow } = await admin.from("prescription_exercise_dosage").select("distance_min_value, distance_max_value, distance_value_m_derived").eq("prescription_exercise_id", exerciseIdByName[DISTANCE_EX.name]).single();
        check(
          "range values persisted exactly (0.5-1 km), derived-meters column correctly NULL for ranges (GENERATED formula is exact-only)",
          Number(kmRow.distance_min_value) === 0.5 && Number(kmRow.distance_max_value) === 1 && kmRow.distance_value_m_derived === null
        );
      }

      // ===================== TIME: continuous, then interval representation =====================
      {
        const { row, editor } = await openEditor(page, TIME_EX.name);
        await editor.locator("#dosage-type").selectOption("time");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await setDuration(editor, "Duration", 20, 0);
        check("redundant trailing 'Duration' helper word removed (Field heading already says it)", (await editor.getByText("Duration", { exact: true }).count()) === 0);
        check("min/sec unit context remains clear despite trailing-word removal", (await editor.getByText("min", { exact: true }).count()) > 0 && (await editor.getByText("sec", { exact: true }).count()) > 0);
        await saveAndWaitClosed(row, editor);
        const { data: contRow } = await admin.from("prescription_exercise_dosage").select("*").eq("prescription_exercise_id", exerciseIdByName[TIME_EX.name]).single();
        check("time continuous representation persisted (20 min = 1200s)", contRow.time_duration_mode === "exact" && Number(contRow.time_duration_exact_seconds) === 1200);
        check("time type does not require sets", contRow.sets === null);
        const summary = row.locator('[data-testid="dosage-affordance"]');
        check("time continuous summary renders correctly", (await summary.innerText()).trim().includes("20 min"), await summary.innerText());

        // Switch to interval-only representation — continuous fields must clear
        const { row: row2, editor: editor2 } = await openEditor(page, TIME_EX.name);
        await editor2.getByRole("group", { name: "Exact or range" }).getByRole("button", { name: "None", exact: true }).click();
        await setDuration(editor2, "Work", 1, 0);
        await setDuration(editor2, "Recovery", 2, 0);
        check("redundant trailing 'Work'/'Recovery' helper words removed", (await editor2.getByText("Work", { exact: true }).count()) === 0 && (await editor2.getByText("Recovery", { exact: true }).count()) === 0);
        await editor2.locator("#interval-rounds").fill("3");
        await saveAndWaitClosed(row2, editor2);
        const { data: intervalRow } = await admin.from("prescription_exercise_dosage").select("*").eq("prescription_exercise_id", exerciseIdByName[TIME_EX.name]).single();
        check(
          "switching to interval-only clears the continuous duration fields",
          intervalRow.time_duration_mode === null && intervalRow.time_duration_exact_seconds === null
        );
        check(
          "interval work/recovery/rounds persisted correctly",
          Number(intervalRow.interval_work_seconds) === 60 && Number(intervalRow.interval_recovery_seconds) === 120 && intervalRow.interval_rounds === 3
        );
        const summary2 = row2.locator('[data-testid="dosage-affordance"]');
        const summaryText2 = await summary2.innerText();
        check("interval summary reflects work/recovery/rounds", summaryText2.includes("work") && summaryText2.includes("recovery") && summaryText2.includes("3 rounds"), summaryText2);
      }

      // ===================== CANCEL BEHAVIOR (no reference dosage exercise) =====================
      {
        const { row, editor } = await openEditor(page, CANCEL_EX.name);
        check("exercise with no reference dosage omits the reference section", (await editor.getByText("Reference dosage").count()) === 0);
        await editor.locator("#dosage-type").selectOption("repetition");
        await editor.locator("#dosage-sets").fill("5");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await editor.getByLabel("Exact reps").fill("8");
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await editor.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
        const summary = row.locator('[data-testid="dosage-affordance"]');
        check("Cancel returns the row to 'Dosage needed'", (await summary.innerText()).trim() === "Dosage needed");
        const { data: cancelRow } = await admin.from("prescription_exercise_dosage").select("id").eq("prescription_exercise_id", exerciseIdByName[CANCEL_EX.name]).maybeSingle();
        check("Cancel never persisted a dosage row", cancelRow === null);
      }

      // ===================== MALFORMED DIRECT API PAYLOAD (bypasses client entirely) =====================
      {
        const minMaxResp = await ctxOwner.request.put(`${BASE_URL}/api/clinician/prescription-exercises/${exerciseIdByName[CANCEL_EX.name]}/dosage`, {
          data: { dosage: { dosageType: "repetition", sets: 3, repsMode: "range", repsMin: 10, repsMax: 5, loadType: "not_applicable" } },
        });
        check("malformed payload (min>max) rejected server-side", minMaxResp.status() === 422, `got ${minMaxResp.status()}`);
        const bothRpeRirResp = await ctxOwner.request.put(`${BASE_URL}/api/clinician/prescription-exercises/${exerciseIdByName[CANCEL_EX.name]}/dosage`, {
          data: { dosage: { dosageType: "repetition", sets: 3, repsMode: "exact", repsExact: 10, loadType: "not_applicable", rpe: 7, rir: 2 } },
        });
        check("malformed payload (RPE + RIR both set) rejected server-side", bothRpeRirResp.status() === 422, `got ${bothRpeRirResp.status()}`);
        const { data: stillNoRow } = await admin.from("prescription_exercise_dosage").select("id").eq("prescription_exercise_id", exerciseIdByName[CANCEL_EX.name]).maybeSingle();
        check("rejected malformed payloads left no dosage row behind", stillNoRow === null);
      }

      // ===================== PERSISTENCE ACROSS REFRESH =====================
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      const repSummaryAfterReload = await draftRow(page, REP_EX.name).locator('[data-testid="dosage-affordance"]').innerText();
      check("dosage summaries persist across refresh", repSummaryAfterReload.trim().startsWith("2 × 20s hold"), repSummaryAfterReload);

      // ===================== CLONED-ACTIVE DOSAGE =====================
      const cloneDraftResp = await ctxOwner.request.post(`${BASE_URL}/api/clinician/patients/${clonePatient.userId}/prescription-drafts`, {
        data: { source: "clone_active", sourceVersionId: cloneVersionId },
      });
      check("clone_active draft creation succeeds", cloneDraftResp.status() === 201, `got ${cloneDraftResp.status()}: ${await cloneDraftResp.text()}`);
      const cloneDraftBody = await cloneDraftResp.json();
      cloneDraftId = cloneDraftBody.draftId;

      await page.goto(`${BASE_URL}/clinician/patients/${clonePatient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");
      const cloneSummary = draftRow(page, CLONE_EX.name).locator('[data-testid="dosage-affordance"]');
      check("cloned draft exercise shows its cloned-from-active dosage immediately", (await cloneSummary.innerText()).trim() === "3 × 12 · Bodyweight · 45s rest", await cloneSummary.innerText());

      const { row: cloneRow, editor: cloneEditor } = await openEditor(page, CLONE_EX.name);
      check("editor loads the cloned dosage's persisted values", (await cloneEditor.getByLabel("Exact reps").inputValue()) === "12");
      await cloneEditor.getByLabel("Exact reps").fill("15");
      await saveAndWaitClosed(cloneRow, cloneEditor);

      const { data: activeVersionDosage } = await admin
        .from("prescription_exercise_dosage")
        .select("reps_exact")
        .eq("prescription_exercise_id", cloneExercise.id)
        .single();
      check("editing the CLONED draft dosage does NOT change the active published version's dosage", activeVersionDosage.reps_exact === 12, `got ${activeVersionDosage.reps_exact}`);
      const { data: activePpAfter } = await admin.from("patient_prescriptions").select("current_prescription_version_id").eq("id", clonePatientPrescriptionId).single();
      check("active prescription version pointer unchanged during draft editing", activePpAfter.current_prescription_version_id === cloneVersionId);

      await page.screenshot({ path: "scripts/.c5s4b-edit-existing.png", fullPage: true });

      // ===================== VIEW-ONLY CLINICIAN =====================
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=Exercise Library");
      const otherRow = otherPage.locator('[data-testid="draft-exercise-row"]').filter({ hasText: DISTANCE_EX.name });
      const readonlySummaryText = await otherRow.getByTestId("dosage-summary-readonly").innerText();
      check("view-only clinician sees the persisted dosage summary as plain text", readonlySummaryText.includes("km") && readonlySummaryText.includes("min rest"), readonlySummaryText);
      check("view-only clinician has no clickable dosage-affordance button", (await otherRow.getByTestId("dosage-affordance").count()) === 0);

      const otherPutResp = await ctxOther.request.put(`${BASE_URL}/api/clinician/prescription-exercises/${exerciseIdByName[DISTANCE_EX.name]}/dosage`, {
        data: { dosage: { dosageType: "repetition", sets: 1, repsMode: "exact", repsExact: 1, loadType: "not_applicable" } },
      });
      check("non-owning clinician's direct dosage API mutation is rejected", otherPutResp.status() === 403, `got ${otherPutResp.status()}`);
      const { data: unchangedDistance } = await admin.from("prescription_exercise_dosage").select("dosage_type").eq("prescription_exercise_id", exerciseIdByName[DISTANCE_EX.name]).single();
      check("distance dosage unchanged after the rejected non-owner mutation attempt", unchangedDistance.dosage_type === "distance");

      await otherPage.setViewportSize({ width: 1440, height: 900 });
      await otherPage.screenshot({ path: "scripts/.c5s4b-view-only.png", fullPage: true });
      await otherPage.close();

      // ===================== VISUAL: completed draft summaries =====================
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");
      await page.screenshot({ path: "scripts/.c5s4b-desktop-summaries.png", fullPage: true });

      // ===================== VISUAL: new repetition dosage, collapsed then expanded =====================
      {
        const { row, editor } = await openEditor(page, CANCEL_EX.name);
        await editor.locator("#dosage-type").selectOption("repetition");
        await editor.locator("#dosage-sets").fill("3");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await editor.getByLabel("Exact reps").fill("10");
        check("routine repetition authoring is understandable without opening More options", !(await isMoreOptionsOpen(editor)));
        await editor.scrollIntoViewIfNeeded();
        await page.screenshot({ path: "scripts/.c5s4b-repetition-collapsed.png", fullPage: true });

        await ensureMoreOptionsOpen(editor);
        await page.screenshot({ path: "scripts/.c5s4b-repetition-expanded.png", fullPage: true });

        // Same session, switch to Distance to capture its own collapsed
        // core-fields-only view (collapse More options again first).
        await moreOptionsToggle(editor).click();
        await editor.locator("#dosage-type").selectOption("distance");
        await editor.locator("#dosage-sets").fill("4");
        await editor.getByRole("button", { name: "Exact", exact: true }).click();
        await editor.getByLabel("Exact distance").fill("60");
        await editor.getByLabel("Unit").selectOption("m");
        await page.screenshot({ path: "scripts/.c5s4b-distance-collapsed.png", fullPage: true });

        // Discard entirely — CANCEL_EX must remain undosaged for the
        // existing Cancel-behavior assertions below to hold.
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        void row;
      }

      // ===================== VISUAL: Time editor (existing dosage, no advanced values -> collapsed) =====================
      {
        const { row, editor } = await openEditor(page, TIME_EX.name);
        check("existing Time dosage with no advanced values still starts collapsed", !(await isMoreOptionsOpen(editor)));
        await editor.scrollIntoViewIfNeeded();
        await page.screenshot({ path: "scripts/.c5s4b-time-collapsed.png", fullPage: true });
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        void row;
      }

      // ===================== VISUAL: existing dosage WITH an advanced value -> auto-expanded =====================
      {
        const { row, editor } = await openEditor(page, CONTACT_EX.name);
        check("existing Contact dosage with a saved advanced value (RIR) auto-expands", await isMoreOptionsOpen(editor));
        await editor.scrollIntoViewIfNeeded();
        await page.screenshot({ path: "scripts/.c5s4b-existing-advanced-expanded.png", fullPage: true });
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        void row;
      }

      // ===================== VISUAL: mobile, collapsed then expanded =====================
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /Draft \(/ }).click();
      await page.waitForTimeout(150);
      const { editor: mobileEditor } = await openEditor(page, HOLD_EX.name);
      check("mobile editor also starts collapsed when the dosage has no advanced values", !(await isMoreOptionsOpen(mobileEditor)));
      await mobileEditor.scrollIntoViewIfNeeded();
      const overflowXCollapsed = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check("no horizontal overflow in the mobile dosage editor (collapsed)", !overflowXCollapsed);
      await page.screenshot({ path: "scripts/.c5s4b-mobile-collapsed.png" });

      await ensureMoreOptionsOpen(mobileEditor);
      await mobileEditor.scrollIntoViewIfNeeded();
      const overflowXExpanded = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check("no horizontal overflow in the mobile dosage editor (expanded)", !overflowXExpanded);
      await page.screenshot({ path: "scripts/.c5s4b-mobile-expanded.png" });
      await mobileEditor.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });

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
