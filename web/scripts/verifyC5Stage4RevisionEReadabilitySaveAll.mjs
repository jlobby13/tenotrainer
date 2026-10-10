// C5.4 Authoring Revision E — Prescription Readability & Efficient Dosage
// Saving. Live HTTP/UI verification, mirroring
// verifyC5Stage4RevisionDOptionalFields.mjs conventions exactly. Entirely
// throwaway fixture users; REAL (read-only) canonical exercises.
//
// Covers: Save → collapse; failed save stays open; Edit affordance (no
// dirty on open, Cancel restores, Save collapses); Add Parameter removed;
// capability-driven fields (incl. formerly Add-parameter-only allowed
// dimensions) still editable; historical off-capability values preserved;
// saved summary chips (More options values, instructions, no fake values);
// Save All dosing (disabled when clean, saves only dirty, partial failure);
// multi-editor independence across move/reorder; desktop + mobile
// readability; view-only behaviour.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4RevisionEReadabilitySaveAll.mjs
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
const CAP_TESTIDS = { reps: "dosage-field-reps", hold: "dosage-field-hold", contacts: "dosage-field-contacts", distance: "dosage-field-distance", interval_time: "dosage-field-interval-time" };

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
  const email = `c5s4reve-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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
  return page.locator('[data-testid="draft-exercise-row"]').filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: exerciseName }) });
}
function editorFor(page, exerciseName) {
  return draftRow(page, exerciseName).locator('[data-testid="dosage-editor"]');
}
function field(page, exerciseName, testId) {
  return editorFor(page, exerciseName).locator(`[data-testid="${testId}"]`);
}
function summary(page, exerciseName) {
  return draftRow(page, exerciseName).locator('[data-testid="dosage-summary"]');
}
function chip(page, exerciseName, key) {
  return draftRow(page, exerciseName).locator(`[data-testid="summary-${key}"]`);
}
async function isOpen(page, exerciseName) {
  return (await editorFor(page, exerciseName).count()) > 0;
}
// Opens via the explicit Edit / Add dosage control (Revision E).
async function openEditor(page, exerciseName) {
  if (await isOpen(page, exerciseName)) return;
  await draftRow(page, exerciseName).locator('[data-testid="edit-dosage"]').click();
  await editorFor(page, exerciseName).waitFor({ state: "visible", timeout: 5000 });
}
async function openMoreOptions(page, exerciseName) {
  const editor = editorFor(page, exerciseName);
  if ((await editor.locator('[data-testid="dosage-more-options"]').count()) > 0) return;
  await editor.getByRole("button", { name: "More options" }).click();
  await editor.locator('[data-testid="dosage-more-options"]').waitFor({ state: "visible", timeout: 3000 });
}
async function clickSave(page, exerciseName) {
  await editorFor(page, exerciseName).locator('[data-testid="save-dosage"]').click();
}
async function waitForCollapse(page, exerciseName, timeoutMs = 8000) {
  return waitForCondition(async () => !(await isOpen(page, exerciseName)), timeoutMs);
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
async function orderedRowNames(page) {
  return page.locator('[data-testid="draft-exercise-row"] [data-testid="draft-exercise-name"]').allInnerTexts();
}
async function waitForSaveAllIdle(page) {
  const btn = page.locator('[data-testid="save-all-dosing"]');
  await waitForCondition(async () => (await btn.innerText()).trim() === "Save all dosing", 15000);
}
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
  const { data: allExercises, error: allErr } = await admin
    .from("canonical_exercises")
    .select("id, legacy_ex_id, name, optional_field_capabilities, dosage_capabilities, default_dosage_capabilities")
    .eq("visibility", "global");
  if (allErr) throw allErr;
  const byLegacy = new Map(allExercises.map((e) => [e.legacy_ex_id, e]));
  // Capability metadata is read-only here — snapshot it to prove Revision E
  // changed nothing about the 47-exercise mapping.
  const capabilitySnapshot = JSON.stringify(allExercises.map((e) => [e.legacy_ex_id, e.dosage_capabilities, e.default_dosage_capabilities, e.optional_field_capabilities]).sort());

  const FULL = byLegacy.get("ex_008"); // reps; all six optional fields
  const ISO = byLegacy.get("ex_001"); // isometric hold; rpe/rom/assistance
  const RUN = byLegacy.get("ex_034"); // default interval_time, allowed + distance
  const POGO = byLegacy.get("ex_028"); // default contacts, allowed + reps
  const STRETCH = byLegacy.get("ex_042"); // rom, side
  const FIXTURES = [FULL, ISO, RUN, POGO, STRETCH];

  const owner = await makeUser("reve-owner");
  const otherSupervisor = await makeUser("reve-other");
  const patient = await makeUser("reve-patient");
  let legacyOwnerId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let patientPrescriptionId = null;
  let draftId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyOwnerId = insertUser.run("c5s4reve-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4reve-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4reve-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
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
      // Every dosage PUT the page sends, by prescription-exercise id — proves
      // Save All writes only dirty exercises.
      const dosagePuts = [];
      page.on("request", (req) => {
        const m = req.url().match(/\/api\/clinician\/prescription-exercises\/([^/]+)\/dosage$/);
        if (m && req.method() === "PUT") dosagePuts.push(m[1]);
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      for (const ex of FIXTURES) await addFromLibrary(page, ex.name);
      check("5 fixture exercises added", (await page.locator('[data-testid="draft-exercise-row"]').count()) === 5);
      const exId = {};
      for (const ex of FIXTURES) exId[ex.legacy_ex_id] = (await getDosageRow(ex.id, draftId)).exerciseId;

      const saveAll = page.locator('[data-testid="save-all-dosing"]');
      check("Save all dosing control is shown to the editing clinician", (await saveAll.count()) === 1);
      check("Save all dosing is disabled with no dirty dosage edits", await saveAll.isDisabled());

      // ===================== ADD PARAMETER REMOVED / CAPABILITY FIELDS =====================
      // New, never-dosed rows still open from the card itself.
      for (const ex of FIXTURES) {
        await draftRow(page, ex.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
        await editorFor(page, ex.name).waitFor({ state: "visible", timeout: 5000 });
      }
      check("all 5 editors open simultaneously (multi-editor preserved)", (await page.locator('[data-testid="dosage-editor"]').count()) === 5);
      check("Add Parameter control no longer appears in any editor", (await page.locator('[data-testid="add-parameter"]').count()) === 0 && (await page.getByText("+ Add parameter").count()) === 0);
      check("no remove-parameter (×) controls remain", (await page.locator('[data-testid="remove-parameter"]').count()) === 0);
      for (const ex of FIXTURES) {
        const shown = [];
        for (const [cap, tid] of Object.entries(CAP_TESTIDS)) if ((await field(page, ex.name, tid).count()) > 0) shown.push(cap);
        const allowed = ex.dosage_capabilities.slice().sort();
        check(`${ex.legacy_ex_id}: editor shows exactly the curated allowed dimensions (${allowed.join(", ")})`, shown.slice().sort().join(",") === allowed.join(","), `shown=${shown.join(",")}`);
      }
      check("Continuous Easy Run: Distance (allowed, formerly Add-parameter-only) is directly editable", (await field(page, RUN.name, "dosage-field-distance").count()) === 1);
      check("Bilateral Pogos: Reps (allowed, formerly Add-parameter-only) is directly editable", (await field(page, POGO.name, "dosage-field-reps").count()) === 1);
      check("isometric hold: Distance/Contacts still NOT offered (outside allowed set)", (await field(page, ISO.name, "dosage-field-distance").count()) + (await field(page, ISO.name, "dosage-field-contacts").count()) === 0);
      await openMoreOptions(page, FULL.name);
      for (const t of ["optional-field-tempo", "optional-field-rpe-rir", "optional-field-rom", "optional-field-assistance", "optional-field-side", "optional-field-instructions"]) {
        check(`Revision D optional field still offered on ${FULL.legacy_ex_id}: ${t.replace("optional-field-", "")}`, (await field(page, FULL.name, t).count()) === 1);
      }
      await openMoreOptions(page, RUN.name);
      check("Revision D: Continuous Easy Run still offers no RPE/RIR (no session-RPE reinterpretation)", (await field(page, RUN.name, "optional-field-rpe-rir").count()) === 0);
      check("Revision D: instructions available even with no applicable optional fields", (await editorFor(page, RUN.name).locator("#dosage-instructions").count()) === 1);
      for (const ex of [ISO, RUN, POGO, STRETCH]) await editorFor(page, ex.name).locator('[data-testid="cancel-dosage"]').click();
      await waitForCondition(async () => (await page.locator('[data-testid="dosage-editor"]').count()) === 1, 3000);

      // ===================== INDIVIDUAL SAVE → COLLAPSE =====================
      await field(page, FULL.name, "dosage-field-sets").fill("3");
      await field(page, FULL.name, "dosage-field-reps").getByRole("button", { name: "Exact", exact: true }).click();
      await field(page, FULL.name, "dosage-field-reps").getByLabel("Exact reps").fill("12");
      await field(page, FULL.name, "dosage-field-load").getByLabel("Load type").selectOption("external");
      await field(page, FULL.name, "dosage-field-load").getByLabel("Load value").fill("40");
      await field(page, FULL.name, "dosage-field-load").getByLabel("Load unit").selectOption("lb");
      await field(page, FULL.name, "dosage-field-rest").getByLabel("Rest seconds").fill("90");
      await openMoreOptions(page, FULL.name);
      await editorFor(page, FULL.name).getByRole("group", { name: "RPE or RIR" }).getByRole("button", { name: "RPE", exact: true }).click();
      await editorFor(page, FULL.name).getByLabel("RPE value").fill("7");
      await editorFor(page, FULL.name).locator("#dosage-rom").fill("Partial");
      await editorFor(page, FULL.name).locator("#dosage-side").selectOption("left");
      await editorFor(page, FULL.name).locator("#dosage-instructions").fill("Use the wall for balance. Stop if pain exceeds 4/10 and let me know at the next visit.");
      check("Save all dosing enables once an exercise is dirty", !(await saveAll.isDisabled()));
      await clickSave(page, FULL.name);
      check("successful Save dosage collapses the editor", await waitForCollapse(page, FULL.name));
      const fullSaved = (await getDosageRow(FULL.id, draftId)).dosage;
      check(
        "saved values persisted (sets/reps/load/rest/RPE/ROM/side)",
        fullSaved?.sets === 3 && fullSaved?.reps_exact === 12 && Number(fullSaved?.load_value_exact) === 40 && fullSaved?.load_unit === "lb" && fullSaved?.rest_seconds === 90 && Number(fullSaved?.rpe) === 7 && fullSaved?.rom === "Partial" && fullSaved?.side === "left",
        JSON.stringify(fullSaved)
      );
      check("collapsed card shows a saved prescription summary", (await summary(page, FULL.name).count()) === 1);
      const chipText = async (key) => ((await chip(page, FULL.name, key).count()) ? (await chip(page, FULL.name, key).innerText()).replace(/\s+/g, " ").trim() : null);
      check("summary: Sets", (await chipText("sets")) === "3 sets", await chipText("sets"));
      check("summary: Reps", (await chipText("reps")) === "12 reps", await chipText("reps"));
      check("summary: Load", (await chipText("load")) === "40 lb", await chipText("load"));
      check("summary: Rest", (await chipText("rest")) === "90s rest", await chipText("rest"));
      check("summary: More-options RPE visible without reopening", (await chipText("rpe")) === "RPE 7", await chipText("rpe"));
      check("summary: More-options ROM visible without reopening", (await chipText("rom")) === "ROM Partial", await chipText("rom"));
      check("summary: More-options Side visible without reopening", (await chipText("side")) === "Left side", await chipText("side"));
      const instr = draftRow(page, FULL.name).locator('[data-testid="summary-instructions"]');
      check("summary: instructions shown in the collapsed card", (await instr.count()) === 1 && (await instr.innerText()).includes("Use the wall for balance"));
      check("summary: instructions visually separated from the metric chips", (await instr.evaluate((el) => el.tagName)) === "P" && (await summary(page, FULL.name).locator("ul li").filter({ hasText: "Use the wall" }).count()) === 0);
      check("summary: absent fields (RIR, tempo, assistance) produce no chips", (await chip(page, FULL.name, "rir").count()) + (await chip(page, FULL.name, "tempo").count()) + (await chip(page, FULL.name, "assistance").count()) === 0);
      check("summary: no fabricated hold/contacts/distance/duration chips", (await chip(page, FULL.name, "hold").count()) + (await chip(page, FULL.name, "contacts").count()) + (await chip(page, FULL.name, "distance").count()) + (await chip(page, FULL.name, "duration").count()) === 0);
      check("no unsaved indicator after successful save", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 0);
      check("Save all dosing disabled again once nothing is dirty", await saveAll.isDisabled());
      await screenshotDraftPanel(page, "scripts/.c5s4reve-saved-standard.png", draftRow(page, FULL.name));
      await draftRow(page, FULL.name).screenshot({ path: "scripts/.c5s4reve-saved-more-options.png" });

      // ---- readability (desktop) ----
      const setsChipValue = chip(page, FULL.name, "sets").locator("span").first();
      const fontPx = await setsChipValue.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      const fontWeight = await setsChipValue.evaluate((el) => Number(getComputedStyle(el).fontWeight));
      check("desktop: primary dosage values are prominent (≥ 15px, semibold)", fontPx >= 15 && fontWeight >= 600, `font=${fontPx}px weight=${fontWeight}`);
      const color = await setsChipValue.evaluate((el) => getComputedStyle(el).color);
      // Computed colour may be rgb()/lab()/oklch() depending on the engine;
      // compare perceptual lightness (gray-900 ≈ L 8–21, gray-500 ≈ L 47–55).
      const lightness = await setsChipValue.evaluate((el) => {
        const c = document.createElement("canvas").getContext("2d");
        c.fillStyle = getComputedStyle(el).color;
        c.fillRect(0, 0, 1, 1);
        const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
        const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        return 116 * Math.cbrt(y) - 16;
      });
      check("desktop: primary values use high-contrast text (not gray-400/500)", lightness < 30, `${color} L=${lightness.toFixed(1)}`);
      const nameBox = await draftRow(page, FULL.name).locator('[data-testid="draft-exercise-name"]').boundingBox();
      const summaryBox = await summary(page, FULL.name).boundingBox();
      check("hierarchy: saved prescription sits directly below the exercise name", summaryBox.y >= nameBox.y + nameBox.height - 1 && summaryBox.y - (nameBox.y + nameBox.height) < 20, JSON.stringify({ nameBox, summaryBox }));
      const rowBox = await draftRow(page, FULL.name).boundingBox();
      check("desktop: collapsed saved card stays compact (< 170px tall) with 7 values + instructions", rowBox.height < 170, `height=${rowBox.height}`);
      console.log(`      info: desktop collapsed card height = ${Math.round(rowBox.height)}px`);

      // ===================== EDIT AFFORDANCE =====================
      const editBtn = draftRow(page, FULL.name).locator('[data-testid="edit-dosage"]');
      check("saved card has an Edit control", (await editBtn.count()) === 1);
      check("Edit control has an accessible label", (await editBtn.getAttribute("aria-label")) === `Edit dosage for ${FULL.name}`);
      await draftRow(page, FULL.name).locator('[data-testid="draft-exercise-name"]').click();
      await page.waitForTimeout(250);
      check("clicking a saved card body does NOT open the editor (editing is intentional)", !(await isOpen(page, FULL.name)));
      await openEditor(page, FULL.name);
      check("Edit opens the complete editor", (await editorFor(page, FULL.name).count()) === 1);
      check("Edit populates from the saved dosage", (await field(page, FULL.name, "dosage-field-sets").inputValue()) === "3" && (await field(page, FULL.name, "dosage-field-reps").getByLabel("Exact reps").inputValue()) === "12");
      check("opening Edit alone does not mark the dosage dirty", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 0 && (await editorFor(page, FULL.name).locator('[data-testid="dosage-editor-unsaved"]').count()) === 0);
      check("opening Edit alone leaves Save all dosing disabled", await saveAll.isDisabled());
      check("Edit control is hidden while the editor is open", (await editBtn.count()) === 0);
      await openMoreOptions(page, FULL.name);
      await screenshotDraftPanel(page, "scripts/.c5s4reve-edit-state.png", editorFor(page, FULL.name));

      // Edit → change → Cancel
      await field(page, FULL.name, "dosage-field-sets").fill("4");
      check("an actual value change creates dirty state", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      await editorFor(page, FULL.name).locator('[data-testid="cancel-dosage"]').click();
      check("Cancel collapses the editor", await waitForCollapse(page, FULL.name, 3000));
      check("Cancel restores the saved prescription in the summary", (await chipText("sets")) === "3 sets");
      check("Cancel clears dirty state", (await draftRow(page, FULL.name).locator('[data-testid="unsaved-indicator"]').count()) === 0);
      check("Cancel did not write anything", (await getDosageRow(FULL.id, draftId)).dosage?.sets === 3);
      await openEditor(page, FULL.name);
      check("re-opening after Cancel shows the saved value", (await field(page, FULL.name, "dosage-field-sets").inputValue()) === "3");

      // Edit → change → Save
      await field(page, FULL.name, "dosage-field-sets").fill("5");
      await clickSave(page, FULL.name);
      check("Edit → change → Save collapses again", await waitForCollapse(page, FULL.name));
      check("Edit → change → Save persisted", (await getDosageRow(FULL.id, draftId)).dosage?.sets === 5);
      check("summary reflects the newly saved value", (await chipText("sets")) === "5 sets");

      // Opening Edit on other dosage shapes must not create dirty state
      // either (durations/ranges round-trip through their inputs).
      await page.locator('[data-testid="draft-exercise-row-toggle"]').filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: STRETCH.name }) }).click();
      await editorFor(page, STRETCH.name).waitFor({ state: "visible", timeout: 5000 });
      await field(page, STRETCH.name, "dosage-field-sets").fill("2");
      await field(page, STRETCH.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click();
      await field(page, STRETCH.name, "dosage-field-hold").getByLabel("Hold minutes").fill("1");
      await field(page, STRETCH.name, "dosage-field-hold").getByLabel("Hold seconds").fill("15");
      await openMoreOptions(page, STRETCH.name);
      await editorFor(page, STRETCH.name).locator("#dosage-side").selectOption("both_sides_separately");
      await clickSave(page, STRETCH.name);
      check("hold-based exercise: save collapses", await waitForCollapse(page, STRETCH.name));
      check("summary: hold duration shown", ((await chip(page, STRETCH.name, "hold").innerText()) || "").replace(/\s+/g, " ").includes("75s hold"), await chip(page, STRETCH.name, "hold").innerText());
      await openEditor(page, STRETCH.name);
      check("Edit on a hold/duration dosage does not create dirty state", (await draftRow(page, STRETCH.name).locator('[data-testid="unsaved-indicator"]').count()) === 0 && (await saveAll.isDisabled()));
      await editorFor(page, STRETCH.name).locator('[data-testid="cancel-dosage"]').click();
      await waitForCollapse(page, STRETCH.name, 3000);

      // ===================== FAILED INDIVIDUAL SAVE STAYS OPEN =====================
      await page.locator('[data-testid="draft-exercise-row-toggle"]').filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: ISO.name }) }).click();
      await editorFor(page, ISO.name).waitFor({ state: "visible", timeout: 5000 });
      await field(page, ISO.name, "dosage-field-sets").fill("4");
      await field(page, ISO.name, "dosage-field-hold").getByRole("button", { name: "Exact", exact: true }).click(); // exact mode, no value → invalid
      await clickSave(page, ISO.name);
      await page.waitForTimeout(600);
      check("failed (validation) save keeps the editor open", await isOpen(page, ISO.name));
      check("failed save surfaces an error", (await editorFor(page, ISO.name).locator('[data-testid="dosage-save-error"]').count()) === 1);
      check("failed save shows the field-level validation message", (await editorFor(page, ISO.name).locator("p.text-red-600").count()) >= 2);
      check("failed save preserves the entered working values", (await field(page, ISO.name, "dosage-field-sets").inputValue()) === "4");
      check("failed save wrote nothing", (await getDosageRow(ISO.id, draftId)).dosage === null);
      check("failed exercise still marked unsaved", (await draftRow(page, ISO.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      // Persistence failure (server rejects) also stays open.
      await page.route(`**/api/clinician/prescription-exercises/${exId.ex_001}/dosage`, (route) =>
        route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : route.continue()
      );
      await field(page, ISO.name, "dosage-field-hold").getByLabel("Hold seconds").fill("30");
      await clickSave(page, ISO.name);
      await waitForCondition(async () => (await editorFor(page, ISO.name).locator('[data-testid="dosage-save-error"]').count()) === 1, 5000);
      check("failed (server) save keeps the editor open with an error", (await isOpen(page, ISO.name)) && (await editorFor(page, ISO.name).locator('[data-testid="dosage-save-error"]').innerText()).length > 0);
      check("failed (server) save preserves working values", (await field(page, ISO.name, "dosage-field-hold").getByLabel("Hold seconds").inputValue()) === "30");
      await page.unroute(`**/api/clinician/prescription-exercises/${exId.ex_001}/dosage`);

      // ===================== SAVE ALL — HAPPY PATH =====================
      // ISO (open, valid now), RUN (collapsed after edit), POGO (open) dirty;
      // FULL and STRETCH saved & unchanged.
      await page.locator('[data-testid="draft-exercise-row-toggle"]').filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: RUN.name }) }).click();
      await editorFor(page, RUN.name).waitFor({ state: "visible", timeout: 5000 });
      await field(page, RUN.name, "dosage-field-interval-time").getByRole("button", { name: "Exact", exact: true }).click();
      await field(page, RUN.name, "dosage-field-interval-time").getByLabel("Duration minutes").fill("20");
      await field(page, RUN.name, "dosage-field-distance").getByRole("button", { name: "Exact", exact: true }).click();
      await field(page, RUN.name, "dosage-field-distance").getByLabel("Exact distance").fill("3");
      await editorFor(page, RUN.name).getByLabel("Distance unit").selectOption("km");
      // Collapse RUN via its header — working values must survive.
      await draftRow(page, RUN.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
      await waitForCollapse(page, RUN.name, 3000);
      check("collapsing an unsaved editor keeps it dirty (not discarded)", (await draftRow(page, RUN.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      await page.locator('[data-testid="draft-exercise-row-toggle"]').filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: POGO.name }) }).click();
      await editorFor(page, POGO.name).waitFor({ state: "visible", timeout: 5000 });
      await field(page, POGO.name, "dosage-field-sets").fill("3");
      await field(page, POGO.name, "dosage-field-contacts").getByRole("button", { name: "Exact", exact: true }).click();
      await field(page, POGO.name, "dosage-field-contacts").getByLabel("Exact contacts").fill("20");
      check("three independent dirty exercises", (await page.locator('[data-testid="unsaved-indicator"]').count()) === 3);
      check("dirty count shown next to Save all dosing", (await page.locator('[data-testid="save-all-dirty-count"]').innerText()).includes("3 unsaved"));
      check("multiple unsaved editors hold independent values", (await field(page, ISO.name, "dosage-field-sets").inputValue()) === "4" && (await field(page, POGO.name, "dosage-field-sets").inputValue()) === "3");
      await page.locator('[data-testid="draft-panel"]').screenshot({ path: "scripts/.c5s4reve-multiple-dirty-before-save-all.png" });

      dosagePuts.length = 0;
      await saveAll.click();
      check("Save all dosing shows a saving state", (await saveAll.isDisabled()) || (await saveAll.innerText()).includes("Saving"));
      await waitForSaveAllIdle(page);
      await page.locator('[data-testid="save-all-result"]').waitFor({ state: "visible", timeout: 8000 });
      const putIds = new Set(dosagePuts);
      check("Save All wrote exactly the 3 dirty exercises", putIds.size === 3 && putIds.has(exId.ex_001) && putIds.has(exId.ex_034) && putIds.has(exId.ex_028), JSON.stringify(dosagePuts));
      check("Save All did not rewrite unchanged exercises", !putIds.has(exId.ex_008) && !putIds.has(exId.ex_042));
      check("Save All sent no duplicate submissions", dosagePuts.length === 3, `puts=${dosagePuts.length}`);
      const [isoAfter, runAfter, pogoAfter] = await Promise.all([getDosageRow(ISO.id, draftId), getDosageRow(RUN.id, draftId), getDosageRow(POGO.id, draftId)]);
      check("Save All persisted ISO", isoAfter.dosage?.sets === 4 && Number(isoAfter.dosage?.hold_duration_exact_seconds) === 30, JSON.stringify(isoAfter.dosage));
      check("Save All persisted RUN (incl. allowed Distance)", runAfter.dosage?.time_duration_exact_seconds === 1200 && Number(runAfter.dosage?.distance_exact_value) === 3 && runAfter.dosage?.distance_unit === "km", JSON.stringify(runAfter.dosage));
      check("Save All persisted POGO", pogoAfter.dosage?.sets === 3 && pogoAfter.dosage?.contacts_exact === 20, JSON.stringify(pogoAfter.dosage));
      check("successful exercises collapse after Save All", (await page.locator('[data-testid="dosage-editor"]').count()) === 0);
      check("no unsaved indicators remain", (await page.locator('[data-testid="unsaved-indicator"]').count()) === 0);
      check("success feedback shown", (await page.locator('[data-testid="save-all-result"]').getAttribute("data-outcome")) === "success" && (await page.locator('[data-testid="save-all-result"]').innerText()).includes("Saved 3 dosages"));
      check("Save all dosing disabled after everything saved", await saveAll.isDisabled());
      check("RUN summary: duration + distance chips, and no fabricated load/rest/sets", (await chip(page, RUN.name, "duration").count()) === 1 && (await chip(page, RUN.name, "distance").innerText()).includes("3 km") && (await chip(page, RUN.name, "load").count()) + (await chip(page, RUN.name, "rest").count()) + (await chip(page, RUN.name, "sets").count()) === 0);
      check("UNKNOWN/null not converted: RUN rest/sets still null in DB", runAfter.dosage?.rest_seconds === null && runAfter.dosage?.sets === null);
      await page.locator('[data-testid="draft-panel"]').screenshot({ path: "scripts/.c5s4reve-after-save-all.png" });

      // ===================== SAVE ALL — PARTIAL FAILURE =====================
      await openEditor(page, FULL.name);
      await field(page, FULL.name, "dosage-field-sets").fill("6"); // valid
      await openEditor(page, ISO.name);
      await field(page, ISO.name, "dosage-field-hold").getByLabel("Hold seconds").fill(""); // invalid (exact w/o value)
      await field(page, ISO.name, "dosage-field-sets").fill("9");
      await openEditor(page, POGO.name);
      await field(page, POGO.name, "dosage-field-contacts").getByLabel("Exact contacts").fill("30"); // valid, but server will fail
      await page.route(`**/api/clinician/prescription-exercises/${exId.ex_028}/dosage`, (route) =>
        route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : route.continue()
      );
      dosagePuts.length = 0;
      await saveAll.click();
      await waitForSaveAllIdle(page);
      await page.locator('[data-testid="save-all-result"]').waitFor({ state: "visible", timeout: 8000 });
      const result = page.locator('[data-testid="save-all-result"]');
      check("partial failure reported as partial", (await result.getAttribute("data-outcome")) === "partial", await result.getAttribute("data-outcome"));
      const resultText = await result.innerText();
      check("partial result names both failed exercises", resultText.includes(ISO.name) && resultText.includes(POGO.name) && !resultText.includes(FULL.name), resultText);
      check("partial result counts the successful save", resultText.includes("Saved 1 dosage"), resultText);
      check("successful exercise in a partial batch collapses + persists", !(await isOpen(page, FULL.name)) && (await getDosageRow(FULL.id, draftId)).dosage?.sets === 6);
      check("validation-failed exercise stays open with error", (await isOpen(page, ISO.name)) && (await editorFor(page, ISO.name).locator('[data-testid="dosage-save-error"]').count()) === 1);
      check("validation-failed exercise keeps its working values", (await field(page, ISO.name, "dosage-field-sets").inputValue()) === "9");
      check("server-failed exercise stays open with error", (await isOpen(page, POGO.name)) && (await editorFor(page, POGO.name).locator('[data-testid="dosage-save-error"]').count()) === 1);
      check("server-failed exercise keeps its working values", (await field(page, POGO.name, "dosage-field-contacts").getByLabel("Exact contacts").inputValue()) === "30");
      check("failed exercises do NOT appear saved (still unsaved)", (await draftRow(page, ISO.name).locator('[data-testid="unsaved-indicator"]').count()) === 1 && (await draftRow(page, POGO.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      check("failed rows are visually flagged", (await draftRow(page, ISO.name).getAttribute("data-save-failed")) === "true" && (await draftRow(page, POGO.name).getAttribute("data-save-failed")) === "true");
      check("failed exercises unchanged in DB", (await getDosageRow(ISO.id, draftId)).dosage?.sets === 4 && (await getDosageRow(POGO.id, draftId)).dosage?.contacts_exact === 20);
      check("validation failure never reached the server", !dosagePuts.includes(exId.ex_001));
      check("Save all dosing re-enabled for retry", !(await saveAll.isDisabled()));
      await page.locator('[data-testid="draft-panel"]').screenshot({ path: "scripts/.c5s4reve-save-all-partial-failure.png" });
      await page.unroute(`**/api/clinician/prescription-exercises/${exId.ex_028}/dosage`);
      await field(page, ISO.name, "dosage-field-hold").getByLabel("Hold seconds").fill("45");
      await saveAll.click();
      await waitForSaveAllIdle(page);
      await waitForCondition(async () => (await page.locator('[data-testid="dosage-editor"]').count()) === 0, 5000);
      check("retry Save All saves the previously-failed exercises", (await getDosageRow(ISO.id, draftId)).dosage?.sets === 9 && (await getDosageRow(POGO.id, draftId)).dosage?.contacts_exact === 30);
      check("retry clears the failure banner to success", (await page.locator('[data-testid="save-all-result"]').getAttribute("data-outcome")) === "success");

      // ===================== WORKING STATE / MOVE / REORDER SAFETY =====================
      await openEditor(page, FULL.name);
      await field(page, FULL.name, "dosage-field-sets").fill("7");
      await openEditor(page, STRETCH.name);
      await field(page, STRETCH.name, "dosage-field-sets").fill("8");
      await openEditor(page, RUN.name);
      await field(page, RUN.name, "dosage-field-interval-time").getByLabel("Duration minutes").fill("25");
      // Saving one exercise must not disturb another's unsaved working state.
      await clickSave(page, RUN.name);
      await waitForCollapse(page, RUN.name);
      check("saving one exercise leaves other open editors' unsaved values intact", (await field(page, FULL.name, "dosage-field-sets").inputValue()) === "7" && (await field(page, STRETCH.name, "dosage-field-sets").inputValue()) === "8");
      check("other editors stay open after an unrelated save collapses", (await isOpen(page, FULL.name)) && (await isOpen(page, STRETCH.name)));
      // reorder
      const before = await orderedRowNames(page);
      await mouseDragHandle(page, POGO.name, before[0]);
      await waitForCondition(async () => JSON.stringify(await orderedRowNames(page)) !== JSON.stringify(before), 4000);
      check("drag reorder happened", JSON.stringify(await orderedRowNames(page)) !== JSON.stringify(before));
      check("reorder keeps unsaved values", (await field(page, FULL.name, "dosage-field-sets").inputValue()) === "7" && (await field(page, STRETCH.name, "dosage-field-sets").inputValue()) === "8");
      // move STRETCH (dirty, open) to a new workout
      await page.getByRole("button", { name: "+ Add Workout" }).click();
      await waitForCondition(async () => (await page.locator('[data-testid="workout-tab"]').count()) === 2, 6000);
      const tabs = page.locator('[data-testid="workout-tab"]');
      const workoutALabel = (await tabs.nth(0).innerText()).trim();
      const workoutBLabel = (await tabs.nth(1).innerText()).trim();
      await tabs.nth(0).click();
      await draftRow(page, STRETCH.name).waitFor({ state: "visible", timeout: 5000 });
      await draftRow(page, STRETCH.name).locator('[data-testid="move-to-workout"]').selectOption({ index: 1 });
      await waitForCondition(async () => (await draftRow(page, STRETCH.name).count()) === 0, 6000);
      check("dirty exercise moved out of Workout A", (await draftRow(page, STRETCH.name).count()) === 0);
      check("Workout A's other unsaved editor unaffected by the move", (await field(page, FULL.name, "dosage-field-sets").inputValue()) === "7");
      await tabs.filter({ hasText: workoutBLabel.split("\n")[0] }).first().click();
      await draftRow(page, STRETCH.name).waitFor({ state: "visible", timeout: 5000 });
      check("moved exercise keeps its unsaved value + editor", (await isOpen(page, STRETCH.name)) && (await field(page, STRETCH.name, "dosage-field-sets").inputValue()) === "8");
      // Save All from Workout B saves the dirty exercise in Workout A too.
      dosagePuts.length = 0;
      await saveAll.click();
      await waitForSaveAllIdle(page);
      check("Save All saves dirty exercises across workouts", (await getDosageRow(FULL.id, draftId)).dosage?.sets === 7 && (await getDosageRow(STRETCH.id, draftId)).dosage?.sets === 8);
      check("Save All across workouts wrote only the 2 dirty exercises", new Set(dosagePuts).size === 2, JSON.stringify(dosagePuts));
      await tabs.filter({ hasText: workoutALabel.split("\n")[0] }).first().click();
      await draftRow(page, FULL.name).waitFor({ state: "visible", timeout: 5000 });
      check("Workout A exercise collapsed after Save All from another workout", !(await isOpen(page, FULL.name)));

      // ===================== HISTORICAL / OFF-CAPABILITY PRESERVATION =====================
      await admin.from("prescription_exercise_dosage").upsert(
        {
          prescription_exercise_id: exId.ex_001,
          dosage_type: "hold",
          sets: 2,
          hold_duration_mode: "exact",
          hold_duration_exact_seconds: 30,
          distance_mode: "exact",
          distance_exact_value: 10,
          distance_unit: "m",
          rir: 2,
          side: "right",
          tempo_description: "Historical slow tempo",
        },
        { onConflict: "prescription_exercise_id" }
      );
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      await draftRow(page, ISO.name).waitFor({ state: "visible", timeout: 5000 });
      check("historical off-capability values appear in the collapsed summary", (await chip(page, ISO.name, "distance").innerText()).includes("10 m") && (await chip(page, ISO.name, "rir").count()) === 1 && (await chip(page, ISO.name, "side").count()) === 1 && (await chip(page, ISO.name, "tempo").count()) === 1);
      check("RPE and RIR remain distinct in the summary (RIR not shown as RPE)", (await chip(page, ISO.name, "rpe").count()) === 0 && (await chip(page, ISO.name, "rir").innerText()).replace(/\s+/g, " ").trim() === "RIR 2");
      await openEditor(page, ISO.name);
      check("historical off-allowed Distance still editable and labelled", (await field(page, ISO.name, "dosage-field-distance").count()) === 1 && (await field(page, ISO.name, "capability-off-allowed").count()) === 1);
      check("historical off-capability optional values still labelled (Revision D)", (await field(page, ISO.name, "optional-field-off-capability").count()) >= 2);
      check("opening a historical dosage does not mark it dirty", (await draftRow(page, ISO.name).locator('[data-testid="unsaved-indicator"]').count()) === 0);
      await openMoreOptions(page, ISO.name);
      await editorFor(page, ISO.name).locator("#dosage-instructions").fill("Keep knee soft.");
      await clickSave(page, ISO.name);
      await waitForCollapse(page, ISO.name);
      const histAfter = await getDosageRow(ISO.id, draftId);
      check(
        "an unrelated save preserves every historical off-capability value",
        Number(histAfter.dosage?.distance_exact_value) === 10 && histAfter.dosage?.distance_unit === "m" && Number(histAfter.dosage?.rir) === 2 && histAfter.dosage?.side === "right" && histAfter.dosage?.tempo_description === "Historical slow tempo",
        JSON.stringify(histAfter.dosage)
      );
      check("instructions-only edit saved without rewriting the dosage row", histAfter.instructions === "Keep knee soft.");

      // ===================== MOBILE =====================
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /^Draft/ }).click();
      await page.waitForTimeout(300);
      await draftRow(page, FULL.name).scrollIntoViewIfNeeded();
      const mFont = await chip(page, FULL.name, "sets").locator("span").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      check("mobile: primary dosage values stay prominent (≥ 15px)", mFont >= 15, `font=${mFont}`);
      let overflow = false;
      for (const key of ["sets", "reps", "load", "rest", "rpe", "rom", "side"]) {
        const b = await chip(page, FULL.name, key).boundingBox();
        if (!b || b.x < 0 || b.x + b.width > 390) overflow = true;
      }
      check("mobile: every summary chip fits within the 390px viewport", !overflow);
      check("mobile: no horizontal page scroll", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
      const clippedNames = await page.locator('[data-testid="draft-exercise-name"]').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis").length);
      check("mobile: exercise names are not truncated", clippedNames === 0, `clipped=${clippedNames}`);
      check("mobile: Edit control visible on saved card", await draftRow(page, FULL.name).locator('[data-testid="edit-dosage"]').isVisible());
      check("mobile: Save all dosing reachable", await saveAll.isVisible());
      const mRow = await draftRow(page, FULL.name).boundingBox();
      check("mobile: collapsed saved card stays compact (< 230px)", mRow.height < 230, `height=${mRow.height}`);
      console.log(`      info: mobile collapsed card height = ${Math.round(mRow.height)}px`);
      await page.screenshot({ path: "scripts/.c5s4reve-mobile-collapsed.png" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(200);

      const isKnownDndHydration = (t) => /didn't match the client properties/.test(t) && /DndDescribedBy-/.test(t);
      const unexpectedErrors = consoleErrors.filter((t) => !/Failed to load resource/i.test(t) && !isKnownDndHydration(t));
      for (const t of consoleErrors) console.log(`      info: owner console: ${isKnownDndHydration(t) ? "[known pre-existing dnd-kit aria-describedby hydration mismatch]" : t.slice(0, 200)}`);
      check("no uncaught page errors / React errors in the owner session", unexpectedErrors.length === 0, unexpectedErrors.join(" | ").slice(0, 600));

      // ===================== VIEW-ONLY / AUTHORIZATION =====================
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=Exercise Library");
      await draftRow(otherPage, FULL.name).waitFor({ state: "visible", timeout: 5000 });
      check("view-only clinician sees the saved prescription summary", (await chip(otherPage, FULL.name, "sets").count()) === 1);
      check("view-only clinician has no Edit control", (await otherPage.locator('[data-testid="edit-dosage"]').count()) === 0);
      check("view-only clinician has no Save all dosing control", (await otherPage.locator('[data-testid="save-all-dosing"]').count()) === 0);
      await draftRow(otherPage, FULL.name).click().catch(() => {});
      check("view-only clinician cannot open a dosage editor", (await otherPage.locator('[data-testid="dosage-editor"]').count()) === 0);
      const unauth = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-exercises/${exId.ex_008}/dosage`, { method: "PUT", data: { dosage: { dosageType: "repetition", sets: 99 } } });
      check("non-owning clinician's direct dosage mutation is rejected", unauth.status() === 403, `got ${unauth.status()}`);
      await otherPage.screenshot({ path: "scripts/.c5s4reve-view-only.png" });
      await otherPage.close();

      // ===================== METADATA UNCHANGED / NOT PUBLISHED =====================
      const { data: afterExercises } = await admin.from("canonical_exercises").select("legacy_ex_id, dosage_capabilities, default_dosage_capabilities, optional_field_capabilities").eq("visibility", "global");
      check("47-exercise capability mapping unchanged", JSON.stringify(afterExercises.map((e) => [e.legacy_ex_id, e.dosage_capabilities, e.default_dosage_capabilities, e.optional_field_capabilities]).sort()) === capabilitySnapshot);
      const { data: draftAfter } = await admin.from("prescription_drafts").select("status").eq("id", draftId).single();
      check("Save All never publishes — draft still 'editing'", draftAfter.status === "editing", draftAfter.status);

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
