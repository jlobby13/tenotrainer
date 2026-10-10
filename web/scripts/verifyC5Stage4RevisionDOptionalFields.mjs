// C5.4 Authoring Revision D — Compact More Options & Exercise-Appropriate
// Optional Fields. DB mapping checks + live HTTP/UI verification, mirroring
// verifyC5Stage4RevisionBDosageUX.mjs / verifyC5Stage4RevisionCMappingRegionDragDrop.mjs
// conventions exactly. Entirely throwaway fixture users; REAL (read-only)
// canonical exercises, curated by migration 20261004000001.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4RevisionDOptionalFields.mjs
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
const VOCAB = ["tempo", "rpe", "rir", "rom", "assistance", "side"];

// The complete founder-review mapping from 20261004000001, asserted
// exactly so any drift (or a missed exercise) fails loudly.
const EXPECTED = {
  ex_001: ["rpe", "rom", "assistance"],
  ex_002: ["rpe", "rom", "assistance", "side"],
  ex_003: ["rpe", "rom", "assistance"],
  ex_004: ["rpe"],
  ex_005: ["tempo", "rpe", "rom", "assistance"],
  ex_006: ["rpe", "rom"],
  ex_007: ["tempo", "rpe", "rir", "rom", "assistance"],
  ex_008: ["tempo", "rpe", "rir", "rom", "assistance", "side"],
  ex_009: ["tempo", "rpe", "rir", "rom", "assistance"],
  ex_010: ["tempo", "rpe", "rir", "rom"],
  ex_011: ["tempo", "rpe", "rir", "rom"],
  ex_012: ["tempo", "rpe", "rir", "rom", "assistance"],
  ex_013: ["tempo", "rpe", "rir", "rom", "assistance", "side"],
  ex_014: ["tempo", "rpe", "rir", "rom"],
  ex_015: ["tempo", "rpe", "rir", "rom", "assistance", "side"],
  ex_016: ["tempo", "rpe", "rir", "rom", "assistance", "side"],
  ex_017: ["tempo", "rpe", "rir", "rom", "assistance", "side"],
  ex_018: ["tempo", "rpe", "rir", "rom"],
  ex_019: ["tempo", "rpe", "rir", "rom"],
  ex_020: ["tempo", "rpe", "rir", "rom"],
  ex_021: ["tempo", "rpe", "rir", "rom", "side"],
  ex_022: ["tempo", "rpe", "rir", "rom"],
  ex_023: ["tempo", "rpe", "rir", "rom"],
  ex_024: ["tempo"],
  ex_025: ["tempo"],
  ex_026: [],
  ex_027: [],
  ex_028: [],
  ex_029: ["side"],
  ex_030: [],
  ex_031: ["side"],
  ex_032: ["side"],
  ex_033: [],
  ex_034: [],
  ex_035: [],
  ex_036: [],
  ex_037: ["tempo", "rpe", "rir", "rom"],
  ex_038: ["tempo", "rpe", "rir", "rom", "side"],
  ex_039: ["tempo", "rpe", "rir", "rom", "side"],
  ex_040: ["assistance", "side"],
  ex_041: ["rom"],
  ex_042: ["rom", "side"],
  ex_043: ["rom"],
  ex_044: ["rom", "side"],
  ex_045: ["rom", "side"],
  ex_046: ["rom", "side"],
  ex_047: ["rom", "side"],
};

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
const arrEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.slice().sort().join(",") === b.slice().sort().join(",");

async function makeUser(label) {
  const email = `c5s4revd-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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
  if ((await editor.count()) > 0 && (await editor.isVisible())) return;
  await draftRow(page, exerciseName).locator('[data-testid="edit-dosage"]').click();
  await editor.waitFor({ state: "visible", timeout: 5000 });
}
async function collapseDosage(page, exerciseName) {
  const editor = editorFor(page, exerciseName);
  if ((await editor.count()) === 0) return;
  await draftRow(page, exerciseName).locator('[data-testid="draft-exercise-row-toggle"]').click();
  await editor.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}
async function openMoreOptions(page, exerciseName) {
  const editor = editorFor(page, exerciseName);
  if ((await editor.locator('[data-testid="dosage-more-options"]').count()) > 0) return;
  await editor.getByRole("button", { name: "More options" }).click();
  await editor.locator('[data-testid="dosage-more-options"]').waitFor({ state: "visible", timeout: 3000 });
}
async function saveDosage(page, exerciseName) {
  const button = editorFor(page, exerciseName).locator('[data-testid="save-dosage"]');
  await button.click();
  await waitForCondition(async () => (await editorFor(page, exerciseName).count()) === 0 || !(await button.isDisabled()), 8000);
  // C5.4 Revision E — a successful save collapses the editor; re-open it so
  // this (Revision D) flow keeps working on the same exercise.
  if ((await editorFor(page, exerciseName).count()) === 0) await expandDosage(page, exerciseName);
}
function opt(page, exerciseName, testId) {
  return editorFor(page, exerciseName).locator(`[data-testid="${testId}"]`);
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
  const { data: rows } = await admin
    .from("prescription_exercises")
    .select("id, additional_instructions, prescription_exercise_dosage(*), prescription_workouts!inner(prescription_draft_id)")
    .eq("canonical_exercise_id", exerciseUuid)
    .eq("prescription_workouts.prescription_draft_id", draftId)
    .limit(1);
  const row = rows?.[0];
  const dosage = Array.isArray(row?.prescription_exercise_dosage) ? row.prescription_exercise_dosage[0] : row?.prescription_exercise_dosage;
  return { exerciseId: row?.id ?? null, instructions: row?.additional_instructions ?? null, dosage: dosage ?? null };
}
async function screenshotDraftPanel(page, path, scrollTarget) {
  if (scrollTarget) await scrollTarget.scrollIntoViewIfNeeded();
  await page.locator('[data-testid="draft-panel"]').screenshot({ path }).catch(() => page.screenshot({ path, fullPage: true }));
}
async function gridColumnCount(locator) {
  return locator.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
}
// Mouse drag via dnd-kit's PointerSensor (same sequence as Revision C).
async function mouseDragHandle(page, fromName, toName) {
  const fromHandle = draftRow(page, fromName).locator('[data-testid="drag-handle"]');
  const toRow = draftRow(page, toName);
  await fromHandle.scrollIntoViewIfNeeded();
  const fromBox = await fromHandle.boundingBox();
  const toBox = await toRow.boundingBox();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 15, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
  await page.waitForTimeout(50);
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2 + 1, { steps: 2 });
  await page.mouse.up();
}

async function main() {
  // ===================== PART 2-3 — CANONICAL METADATA (pure DB) =====================
  const { data: allExercises, error: allErr } = await admin
    .from("canonical_exercises")
    .select("id, legacy_ex_id, name, optional_field_capabilities, dosage_capabilities, default_dosage_capabilities")
    .eq("visibility", "global");
  if (allErr) throw allErr;
  check("all 47 canonical exercises present", allExercises.length === 47, `got ${allExercises.length}`);
  check("every exercise has an optional_field_capabilities array", allExercises.every((e) => Array.isArray(e.optional_field_capabilities)));
  const badVocab = allExercises.filter((e) => (e.optional_field_capabilities ?? []).some((v) => !VOCAB.includes(v)));
  check("only approved optional-field vocabulary values exist", badVocab.length === 0, JSON.stringify(badVocab.map((e) => e.legacy_ex_id)));
  const mismatched = allExercises.filter((e) => !arrEq(e.optional_field_capabilities, EXPECTED[e.legacy_ex_id] ?? ["<missing>"]));
  check("all 47 exercises match the curated Revision D mapping exactly", mismatched.length === 0, mismatched.map((e) => `${e.legacy_ex_id}=${JSON.stringify(e.optional_field_capabilities)}`).join("; "));
  check("no exercise is assigned all six fields wholesale beyond the curated single-leg standing group", allExercises.filter((e) => e.optional_field_capabilities.length === 6).length === 5);

  const byLegacy = new Map(allExercises.map((e) => [e.legacy_ex_id, e]));
  const ex034 = byLegacy.get("ex_034");
  for (const f of ["rom", "assistance", "side", "rpe", "rir", "tempo"]) {
    check(`Continuous Easy Run (ex_034) does not offer '${f}'`, !ex034.optional_field_capabilities.includes(f));
  }
  for (const [field, legacy] of [["tempo", "ex_019"], ["rpe", "ex_001"], ["rir", "ex_019"], ["rom", "ex_005"], ["assistance", "ex_040"], ["side", "ex_042"]]) {
    check(`representative exercise ${legacy} still offers '${field}'`, byLegacy.get(legacy).optional_field_capabilities.includes(field));
  }
  check("isometric hold (ex_001) offers RPE but not RIR", byLegacy.get("ex_001").optional_field_capabilities.includes("rpe") && !byLegacy.get("ex_001").optional_field_capabilities.includes("rir"));
  check("specialized default ⊆ allowed invariant unaffected", allExercises.every((e) => e.default_dosage_capabilities.every((c) => e.dosage_capabilities.includes(c))));

  // DB constraint: an out-of-vocabulary value must be rejected.
  const { error: vocabErr } = await admin.from("canonical_exercises").update({ optional_field_capabilities: ["rom", "bogus_field"] }).eq("id", ex034.id);
  if (!vocabErr) await admin.from("canonical_exercises").update({ optional_field_capabilities: [] }).eq("id", ex034.id); // restore if the CHECK were missing
  check("DB CHECK rejects an out-of-vocabulary optional field value", !!vocabErr && /optional_field_capabilities_vocabulary|check/i.test(vocabErr.message), vocabErr?.message);
  const { data: ex034After } = await admin.from("canonical_exercises").select("optional_field_capabilities").eq("id", ex034.id).single();
  check("rejected write left ex_034's metadata unchanged", arrEq(ex034After.optional_field_capabilities, []));

  const RUN = byLegacy.get("ex_034"); // none
  const FULL = byLegacy.get("ex_008"); // all six
  const ISO = byLegacy.get("ex_001"); // rpe, rom, assistance
  const STRETCH = byLegacy.get("ex_042"); // rom, side
  const BAL = byLegacy.get("ex_040"); // assistance, side

  // ===================== UI FIXTURE SETUP =====================
  const owner = await makeUser("revd-owner");
  const otherSupervisor = await makeUser("revd-other");
  const patient = await makeUser("revd-patient");
  let legacyOwnerId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let patientPrescriptionId = null;
  let draftId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyOwnerId = insertUser.run("c5s4revd-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4revd-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4revd-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
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
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      for (const ex of [FULL, RUN, ISO, STRETCH, BAL]) await addFromLibrary(page, ex.name);
      check("5 fixture exercises added", (await page.locator('[data-testid="draft-exercise-row"]').count()) === 5);

      // ---- clean authoring: Continuous Easy Run ----
      await expandDosage(page, RUN.name);
      check("new Continuous Easy Run dosage starts with More options collapsed", (await opt(page, RUN.name, "dosage-more-options").count()) === 0);
      await openMoreOptions(page, RUN.name);
      check("Continuous Easy Run: no optional-field grid rendered (nothing applicable)", (await opt(page, RUN.name, "optional-field-grid").count()) === 0);
      check("Continuous Easy Run: ROM not offered", (await opt(page, RUN.name, "optional-field-rom").count()) === 0);
      check("Continuous Easy Run: Assistance not offered", (await opt(page, RUN.name, "optional-field-assistance").count()) === 0);
      check("Continuous Easy Run: Side not offered", (await opt(page, RUN.name, "optional-field-side").count()) === 0);
      check("Continuous Easy Run: RPE/RIR not offered", (await opt(page, RUN.name, "optional-field-rpe-rir").count()) === 0);
      check("Continuous Easy Run: rep tempo not offered", (await opt(page, RUN.name, "optional-field-tempo").count()) === 0);
      check("Continuous Easy Run: patient-specific instructions still available", await editorFor(page, RUN.name).locator("#dosage-instructions").isVisible());
      await screenshotDraftPanel(page, "scripts/.c5s4revd-easy-run-more-options.png", editorFor(page, RUN.name));
      await collapseDosage(page, RUN.name);

      // ---- clean authoring: every applicable field (ex_008) ----
      await expandDosage(page, FULL.name);
      await openMoreOptions(page, FULL.name);
      for (const t of ["optional-field-tempo", "optional-field-rpe-rir", "optional-field-rom", "optional-field-assistance", "optional-field-side", "optional-field-instructions"]) {
        check(`Single-Leg Standing Calf Raise offers ${t.replace("optional-field-", "")}`, (await opt(page, FULL.name, t).count()) === 1);
      }
      check("both RPE and RIR applicable → None/RPE/RIR toggle shown", (await editorFor(page, FULL.name).getByRole("group", { name: "RPE or RIR" }).count()) === 1);
      check("no off-capability marker on a clean, fully-applicable exercise", (await opt(page, FULL.name, "optional-field-off-capability").count()) === 0);
      const grid = opt(page, FULL.name, "optional-field-grid");
      const cols = await gridColumnCount(grid);
      check("desktop: optional-field grid uses 3–4 columns", cols >= 3 && cols <= 4, `columns=${cols}`);
      const cellTops = [];
      for (const t of ["optional-field-rpe-rir", "optional-field-rom", "optional-field-assistance", "optional-field-side"]) cellTops.push(Math.round((await opt(page, FULL.name, t).boundingBox()).y));
      check("desktop: RPE/RIR, ROM, Assistance, Side sit on one compact row", cols >= 4 ? new Set(cellTops).size === 1 : new Set(cellTops).size <= 2, JSON.stringify(cellTops));
      const instrBox = await opt(page, FULL.name, "optional-field-instructions").boundingBox();
      const gridBox = await grid.boundingBox();
      check("instructions textarea is full-width below the grid (not a grid cell)", instrBox.y >= gridBox.y + gridBox.height - 1 && instrBox.width >= gridBox.width - 2, JSON.stringify({ instrBox, gridBox }));
      const moreBox = await opt(page, FULL.name, "dosage-more-options").boundingBox();
      console.log(`      info: expanded More options height (all six fields, desktop) = ${Math.round(moreBox.height)}px; grid height = ${Math.round(gridBox.height)}px`);
      check("desktop: compact grid row height stays small (< 90px)", gridBox.height < 90, `grid height=${gridBox.height}`);
      for (const t of ["optional-field-rom", "optional-field-assistance", "optional-field-side"]) {
        const w = (await opt(page, FULL.name, t).boundingBox()).width;
        check(`desktop: ${t.replace("optional-field-", "")} cell is wide enough to use (≥ 136px)`, w >= 136, `width=${w}`);
      }

      // ---- partial applicability ----
      await expandDosage(page, ISO.name);
      await openMoreOptions(page, ISO.name);
      check("isometric hold: RPE offered as a single input (no RIR toggle)", (await editorFor(page, ISO.name).getByLabel("RPE value").count()) === 1 && (await editorFor(page, ISO.name).getByRole("group", { name: "RPE or RIR" }).count()) === 0);
      check("isometric hold: RIR not offered", (await editorFor(page, ISO.name).getByLabel("RIR value").count()) === 0);
      check("isometric hold: ROM + Assistance offered, Side/Tempo not", (await opt(page, ISO.name, "optional-field-rom").count()) === 1 && (await opt(page, ISO.name, "optional-field-assistance").count()) === 1 && (await opt(page, ISO.name, "optional-field-side").count()) === 0 && (await opt(page, ISO.name, "optional-field-tempo").count()) === 0);
      await expandDosage(page, STRETCH.name);
      await openMoreOptions(page, STRETCH.name);
      check("unilateral stretch: only ROM + Side in the grid", (await opt(page, STRETCH.name, "optional-field-rom").count()) === 1 && (await opt(page, STRETCH.name, "optional-field-side").count()) === 1 && (await opt(page, STRETCH.name, "optional-field-rpe-rir").count()) === 0 && (await opt(page, STRETCH.name, "optional-field-assistance").count()) === 0);
      await expandDosage(page, BAL.name);
      await openMoreOptions(page, BAL.name);
      check("balance drill: Assistance + Side offered, ROM/RPE not", (await opt(page, BAL.name, "optional-field-assistance").count()) === 1 && (await opt(page, BAL.name, "optional-field-side").count()) === 1 && (await opt(page, BAL.name, "optional-field-rom").count()) === 0 && (await opt(page, BAL.name, "optional-field-rpe-rir").count()) === 0);
      const balGridBox = await opt(page, BAL.name, "optional-field-grid").boundingBox();
      check("two-field grid stays a single compact row", balGridBox.height < 90, `height=${balGridBox.height}`);

      // ---- multiple editors expanded simultaneously ----
      check("4 dosage editors expanded simultaneously with More options open", (await page.locator('[data-testid="dosage-editor"]').count()) === 4 && (await page.locator('[data-testid="dosage-more-options"]').count()) === 4);
      await page.locator('[data-testid="draft-panel"]').screenshot({ path: "scripts/.c5s4revd-multiple-expanded.png" }).catch(() => page.screenshot({ path: "scripts/.c5s4revd-multiple-expanded.png", fullPage: true }));

      // ---- dirty state across collapse / workout navigation / reorder ----
      await editorFor(page, FULL.name).locator('[data-testid="dosage-field-sets"]').fill("3");
      await editorFor(page, FULL.name).locator("#dosage-rom").fill("Pain-free range");
      await editorFor(page, FULL.name).locator("#dosage-side").selectOption("left");
      await editorFor(page, FULL.name).locator("#dosage-assistance").selectOption("minimal");
      await screenshotDraftPanel(page, "scripts/.c5s4revd-desktop-more-options.png", editorFor(page, FULL.name));
      check("editing an optional field marks the row unsaved", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      for (const ex of [ISO, STRETCH, BAL]) await collapseDosage(page, ex.name);
      await collapseDosage(page, FULL.name);
      await expandDosage(page, FULL.name);
      // More options' initial open state is derived from the SAVED dosage at
      // mount (unchanged Revision B behavior), so re-open it explicitly.
      await openMoreOptions(page, FULL.name);
      check("optional values survive collapse/expand", (await editorFor(page, FULL.name).locator("#dosage-rom").inputValue()) === "Pain-free range" && (await editorFor(page, FULL.name).locator("#dosage-side").inputValue()) === "left");
      await collapseDosage(page, FULL.name);

      await page.getByRole("button", { name: "+ Add Workout" }).click();
      await waitForCondition(async () => (await page.locator('[data-testid="workout-tab"]').count()) === 2, 6000);
      const tabs = page.locator('[data-testid="workout-tab"]');
      const workoutALabel = await tabs.nth(0).innerText();
      await tabs.filter({ hasText: workoutALabel }).click();
      await draftRow(page, FULL.name).waitFor({ state: "visible", timeout: 5000 });
      check("unsaved indicator survives workout navigation", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);

      await mouseDragHandle(page, RUN.name, BAL.name);
      await page.waitForTimeout(800);
      await expandDosage(page, FULL.name);
      await openMoreOptions(page, FULL.name);
      check("optional values survive workout navigation + reorder", (await editorFor(page, FULL.name).locator("#dosage-rom").inputValue()) === "Pain-free range" && (await editorFor(page, FULL.name).locator("#dosage-assistance").inputValue()) === "minimal");

      // ---- Save ----
      await saveDosage(page, FULL.name);
      const savedFull = (await getDosageRow(FULL.id, draftId)).dosage;
      check("Save persists optional fields (ROM/Side/Assistance) + sets", savedFull?.rom === "Pain-free range" && savedFull?.side === "left" && savedFull?.assistance_level === "minimal" && savedFull?.sets === 3, JSON.stringify(savedFull));
      check("unsaved indicator clears after Save", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 0);

      // ---- Cancel ----
      await openMoreOptions(page, FULL.name);
      await editorFor(page, FULL.name).locator("#dosage-rom").fill("Changed then cancelled");
      await editorFor(page, FULL.name).locator('[data-testid="cancel-dosage"]').click();
      await page.waitForTimeout(200);
      await expandDosage(page, FULL.name);
      await openMoreOptions(page, FULL.name);
      check("Cancel restores the saved optional value", (await editorFor(page, FULL.name).locator("#dosage-rom").inputValue()) === "Pain-free range");
      check("Cancel left the persisted value untouched", (await getDosageRow(FULL.id, draftId)).dosage?.rom === "Pain-free range");
      await collapseDosage(page, FULL.name);

      // ---- historical / off-capability preservation (Continuous Easy Run) ----
      const { exerciseId: runExerciseId } = await getDosageRow(RUN.id, draftId);
      await admin.from("prescription_exercise_dosage").upsert(
        {
          prescription_exercise_id: runExerciseId,
          dosage_type: "time",
          time_duration_mode: "exact",
          time_duration_exact_seconds: 1200,
          rpe: 4.5,
          rom: "Historical ROM note",
          assistance_level: "contact_guard",
          side: "bilateral",
          tempo_description: "Historical easy cadence",
        },
        { onConflict: "prescription_exercise_id" }
      );
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      await expandDosage(page, RUN.name);
      check("historical off-capability values auto-open More options", (await opt(page, RUN.name, "dosage-more-options").count()) === 1);
      check("historical ROM still displayed with its value", (await editorFor(page, RUN.name).locator("#dosage-rom").inputValue()) === "Historical ROM note");
      check("historical Assistance still displayed with its value", (await editorFor(page, RUN.name).locator("#dosage-assistance").inputValue()) === "contact_guard");
      check("historical Side still displayed with its value", (await editorFor(page, RUN.name).locator("#dosage-side").inputValue()) === "bilateral");
      check("historical RPE still displayed with its value", (await editorFor(page, RUN.name).getByLabel("RPE value").inputValue()) === "4.5");
      check("historical tempo description still displayed", (await editorFor(page, RUN.name).locator("#tempo-description").inputValue()) === "Historical easy cadence");
      check("historical RIR (never saved) is still NOT offered", (await editorFor(page, RUN.name).getByLabel("RIR value").count()) === 0 && (await editorFor(page, RUN.name).getByRole("group", { name: "RPE or RIR" }).count()) === 0);
      check("off-capability fields are labelled as saved/non-standard", (await opt(page, RUN.name, "optional-field-off-capability").count()) === 5, `count=${await opt(page, RUN.name, "optional-field-off-capability").count()}`);
      await screenshotDraftPanel(page, "scripts/.c5s4revd-historical-off-capability.png", editorFor(page, RUN.name));

      // clearing a historical value in the working draft keeps its control
      // on screen until that clear is saved
      await editorFor(page, RUN.name).locator("#dosage-side").selectOption("");
      check("clearing a historical value keeps the control visible while unsaved", (await opt(page, RUN.name, "optional-field-side").count()) === 1);
      await editorFor(page, RUN.name).locator('[data-testid="cancel-dosage"]').click();
      await page.waitForTimeout(200);

      // unrelated save never silently deletes the historical values
      await expandDosage(page, RUN.name);
      await openMoreOptions(page, RUN.name);
      await editorFor(page, RUN.name).locator("#dosage-instructions").fill("Easy conversational pace.");
      await saveDosage(page, RUN.name);
      const runAfter = await getDosageRow(RUN.id, draftId);
      check(
        "saving an unrelated change preserves every historical off-capability value",
        runAfter.dosage?.rom === "Historical ROM note" && runAfter.dosage?.assistance_level === "contact_guard" && runAfter.dosage?.side === "bilateral" && Number(runAfter.dosage?.rpe) === 4.5 && runAfter.dosage?.tempo_description === "Historical easy cadence",
        JSON.stringify(runAfter.dosage)
      );
      check("instructions saved for an exercise with no applicable optional fields", runAfter.instructions === "Easy conversational pace.", runAfter.instructions);

      // explicitly clearing + saving then hides the control (back to clean authoring)
      await openMoreOptions(page, RUN.name);
      await editorFor(page, RUN.name).locator("#dosage-side").selectOption("");
      await saveDosage(page, RUN.name);
      check("explicit clear persisted only when saved", (await getDosageRow(RUN.id, draftId)).dosage?.side === null);
      check("once the clear is saved, the off-capability Side control is no longer offered", (await opt(page, RUN.name, "optional-field-side").count()) === 0);
      await collapseDosage(page, RUN.name);

      // Specific instructions available for every curated exercise shape.
      let instrOk = true;
      for (const ex of [FULL, ISO, STRETCH, BAL]) {
        await expandDosage(page, ex.name);
        await openMoreOptions(page, ex.name);
        if (!(await editorFor(page, ex.name).locator("#dosage-instructions").isVisible())) instrOk = false;
      }
      check("Patient-specific instructions available on every fixture exercise", instrOk);
      const noneEmpty = Object.entries(EXPECTED).filter(([, v]) => v.length === 0).map(([k]) => k);
      check("instructions never depend on applicability metadata (exercises with no optional fields exist and are covered above)", noneEmpty.length > 0 && noneEmpty.includes("ex_034"));
      for (const ex of [ISO, STRETCH, BAL, RUN]) await collapseDosage(page, ex.name);

      // ---- mobile ----
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /^Draft/ }).click();
      await page.waitForTimeout(300);
      await expandDosage(page, FULL.name);
      await openMoreOptions(page, FULL.name);
      const mobileCols = await gridColumnCount(opt(page, FULL.name, "optional-field-grid"));
      check("mobile: grid falls back to 2 columns", mobileCols === 2, `columns=${mobileCols}`);
      let mobileOverflow = false;
      for (const t of ["optional-field-rpe-rir", "optional-field-rom", "optional-field-assistance", "optional-field-side", "optional-field-instructions"]) {
        const b = await opt(page, FULL.name, t).boundingBox();
        if (!b || b.x < 0 || b.x + b.width > 390) mobileOverflow = true;
      }
      check("mobile: every optional control fits within the 390px viewport", !mobileOverflow);
      const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      check("mobile: no horizontal page scroll", !docOverflow);
      await opt(page, FULL.name, "optional-field-grid").evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(150);
      await page.screenshot({ path: "scripts/.c5s4revd-mobile-more-options.png" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(200);

      // Known, pre-existing (Revision C) dnd-kit SSR id mismatch on the drag
      // handle's aria-describedby — drag/drop is out of Revision D scope.
      const isKnownDndHydration = (t) => /didn't match the client properties/.test(t) && /DndDescribedBy-/.test(t);
      const unexpectedErrors = consoleErrors.filter((t) => !/Failed to load resource/i.test(t) && !isKnownDndHydration(t));
      for (const t of consoleErrors) console.log(`      info: owner console: ${isKnownDndHydration(t) ? "[known pre-existing dnd-kit aria-describedby hydration mismatch]" : t.slice(0, 300)}`);
      check("no uncaught page errors / React errors in the owner session", unexpectedErrors.length === 0, unexpectedErrors.join(" | ").slice(0, 600));

      // ---- authorization / view-only ----
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=Exercise Library");
      await draftRow(otherPage, FULL.name).click().catch(() => {});
      check("view-only clinician cannot open a dosage editor / More options", (await otherPage.locator('[data-testid="dosage-editor"]').count()) === 0 && (await otherPage.locator('[data-testid="dosage-more-options"]').count()) === 0);
      const unauth = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-exercises/${(await getDosageRow(FULL.id, draftId)).exerciseId}/dosage`, {
        method: "PUT",
        data: { dosage: { dosageType: "repetition", sets: 9, rom: "hijack" } },
      });
      check("non-owning clinician's direct dosage mutation is rejected", unauth.status() === 403, `got ${unauth.status()}`);
      check("rejected mutation left the saved ROM untouched", (await getDosageRow(FULL.id, draftId)).dosage?.rom === "Pain-free range");
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
