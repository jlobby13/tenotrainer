// C5.4 Authoring Revision C — Clinical Mapping Finalization, Region
// Filtering & Drag-and-Drop. Live HTTP/UI verification, mirroring
// verifyC5Stage4RevisionBDosageUX.mjs's conventions exactly. Entirely
// throwaway fixture users; REAL (read-only for clinical-mapping/region
// checks) canonical exercises from the C5.3G library, corrected/tagged by
// migrations 20261002000001 and 20261003000001.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4RevisionCMappingRegionDragDrop.mjs
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
const APPROVED_REGIONS = ["calf_achilles", "foot_ankle", "knee", "hip", "core_trunk", "whole_lower_extremity_general"];

// Real, permanently-migrated C5.3G canonical exercises (deterministic
// UUIDv5). READ-ONLY here — dosage_capabilities/body_part come from the
// Revision C migrations, never mutated by this script.
const DRAG_EX_1 = { id: "8b1bf121-fa02-5e64-9a1d-61deaf7e8c70", name: "Double-Leg Calf Isometric Hold" }; // ex_001, calf_achilles
const DRAG_EX_2 = { id: "a09d5f06-4e1c-534e-8e28-521ded8d679b", name: "Single-Leg Calf Isometric Hold" }; // ex_002, calf_achilles
const DRAG_EX_3 = { id: "105e9b07-0895-5dff-be29-b1d00fda34e3", name: "Bent-Knee Calf Isometric Hold" }; // ex_003, calf_achilles (NOT tagged 'knee' — a position, not a target)
const CALF_ISO = { id: "8b1bf121-fa02-5e64-9a1d-61deaf7e8c70", name: "Double-Leg Calf Isometric Hold" }; // category=symptom_modulation, loading=isometric
const CALF_STRETCH = { id: "14f8d27a-cf0d-5da6-8594-40699a2bbd86", name: "Standing Gastrocnemius Wall Stretch (Bilateral, Straight Knee)" }; // ex_041, calf_achilles, stretching/flexibility_mobility, hold-only
const FOOT_ANKLE_EX = { id: "1048a69b-b600-5a1f-9da7-e6af5c020039", name: "Tibialis Posterior Strengthening" }; // ex_038, foot_ankle only
const HIP_EX = { id: "646223c2-dc83-5db0-b4af-73fc82e6347c", name: "Hip Abductor Strengthening" }; // ex_039, hip only
const FOOT_HIP_EX = { id: "4d67ba9e-b524-535b-9325-e14aa24acbdd", name: "Balance and Frontal-Plane Control Drills" }; // ex_040, foot_ankle+hip
const DRAG_EX_NAME_TO_ID = { [DRAG_EX_1.name]: DRAG_EX_1.id, [DRAG_EX_2.name]: DRAG_EX_2.id, [DRAG_EX_3.name]: DRAG_EX_3.id };

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
  const email = `c5s4revc-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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
function libraryCard(page, exerciseName) {
  return page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]').filter({ hasText: exerciseName });
}
async function addFromLibrary(page, exerciseName) {
  const card = libraryCard(page, exerciseName);
  await card.getByRole("button", { name: "Add", exact: true }).click();
  await waitForCondition(async () => (await draftRow(page, exerciseName).count()) >= 1, 5000);
  // C5.4 Performance Pass — the row appears immediately as a pending add;
  // "added" for the purposes of this suite means persisted.
  await waitForCondition(async () => (await draftRow(page, exerciseName).locator('[data-testid="pending-add-indicator"]').count()) === 0, 8000);
}
async function orderedRowNames(page) {
  const rows = page.locator('[data-testid="draft-exercise-row"]');
  const n = await rows.count();
  const names = [];
  for (let i = 0; i < n; i++) {
    // C5.4 Revision E — the name now has its own dedicated element.
    names.push((await rows.nth(i).locator('[data-testid="draft-exercise-name"]').innerText()).trim());
  }
  return names;
}
async function orderedIndexNames(draftId) {
  const { data: workout } = await admin
    .from("prescription_workouts")
    .select("prescription_exercises(id, canonical_exercise_id, order_index)")
    .eq("prescription_draft_id", draftId)
    .single();
  return workout.prescription_exercises.slice().sort((a, b) => a.order_index - b.order_index);
}
async function openRegionFilter(page) {
  await page.locator('[data-testid="region-filter-toggle"]').click();
}
async function selectRegion(page, label) {
  await page.locator('[role="listbox"][aria-label="Filter by region"]').getByText(label, { exact: true }).click();
}
async function closeRegionPopover(page) {
  // clicking the fixed overlay backdrop closes it without touching filters
  await page.mouse.click(5, 5);
}
// Manual pointer-event drag: dnd-kit's PointerSensor listens for real
// pointer events, which Playwright's mouse.move/down/up dispatch natively
// in Chromium — a plain locator.dragTo() (HTML5 DnD) does NOT reliably
// trigger it, hence the explicit multi-step sequence (exceeds the 8px
// activationConstraint distance, gives collision detection intermediate
// positions to react to).
async function mouseDragHandle(page, fromName, toName, midDragScreenshotPath) {
  const fromHandle = draftRow(page, fromName).locator('[data-testid="drag-handle"]');
  const toRow = draftRow(page, toName);
  const fromBox = await fromHandle.boundingBox();
  const toBox = await toRow.boundingBox();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 15, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 12 });
  await page.waitForTimeout(50);
  if (midDragScreenshotPath) {
    // captured mid-drag (pointer still down, dnd-kit's live transform-based
    // insertion feedback visible) before completing the drop below
    await page.screenshot({ path: midDragScreenshotPath, fullPage: true });
  }
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2 + 1, { steps: 2 });
  await page.mouse.up();
}
async function keyboardDragHandle(page, exerciseName, key, times = 1) {
  const handle = draftRow(page, exerciseName).locator('[data-testid="drag-handle"]');
  await handle.focus();
  await page.keyboard.press("Space");
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(50);
  }
  await page.keyboard.press("Space");
}

async function main() {
  // ===================== PART 0/1-2 — CLINICAL MAPPING & REGION DATA (pure DB) =====================
  const { data: allExercises, error: allErr } = await admin
    .from("canonical_exercises")
    .select("legacy_ex_id, dosage_capabilities, default_dosage_capabilities, body_part");
  if (allErr) throw allErr;
  check("all 47 canonical exercises present", allExercises.length === 47, `got ${allExercises.length}`);

  const subsetOk = allExercises.every((e) => (e.default_dosage_capabilities ?? []).every((c) => (e.dosage_capabilities ?? []).includes(c)));
  check("default_dosage_capabilities is a subset of dosage_capabilities for all 47 exercises", subsetOk);

  const byLegacyId = new Map(allExercises.map((e) => [e.legacy_ex_id, e]));
  const arrEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.slice().sort().join(",") === b.slice().sort().join(",");

  const ex012 = byLegacyId.get("ex_012");
  check("ex_012 allowed dosage capabilities narrowed to reps only", arrEq(ex012.dosage_capabilities, ["reps"]), JSON.stringify(ex012));
  check("ex_012 default dosage capabilities is reps", arrEq(ex012.default_dosage_capabilities, ["reps"]));

  for (const id of ["ex_041", "ex_042", "ex_043", "ex_044", "ex_045", "ex_047"]) {
    const e = byLegacyId.get(id);
    check(`${id} allowed dosage capabilities narrowed to hold only`, arrEq(e.dosage_capabilities, ["hold"]), JSON.stringify(e));
    check(`${id} default dosage capabilities is hold`, arrEq(e.default_dosage_capabilities, ["hold"]));
  }

  const ex046 = byLegacyId.get("ex_046");
  check("ex_046 default dosage capabilities remains hold", arrEq(ex046.default_dosage_capabilities, ["hold"]), JSON.stringify(ex046));
  check("ex_046 allowed dosage capabilities remains hold+reps (unchanged)", arrEq(ex046.dosage_capabilities.slice().sort(), ["hold", "reps"]));

  // Existing founder-approved reactive/running mappings retained unchanged.
  const ex026 = byLegacyId.get("ex_026");
  check("ex_026 mapping retained (default=interval_time, allowed=interval_time+reps)", arrEq(ex026.default_dosage_capabilities, ["interval_time"]) && arrEq(ex026.dosage_capabilities.slice().sort(), ["interval_time", "reps"]));
  for (const id of ["ex_027", "ex_028", "ex_029", "ex_030", "ex_031", "ex_032"]) {
    const e = byLegacyId.get(id);
    check(`${id} mapping retained (default=contacts, allowed=contacts+reps)`, arrEq(e.default_dosage_capabilities, ["contacts"]) && arrEq(e.dosage_capabilities.slice().sort(), ["contacts", "reps"]), JSON.stringify(e));
  }
  for (const id of ["ex_034", "ex_036"]) {
    const e = byLegacyId.get(id);
    check(`${id} mapping retained (default=interval_time, allowed=interval_time+distance)`, arrEq(e.default_dosage_capabilities, ["interval_time"]) && arrEq(e.dosage_capabilities.slice().sort(), ["distance", "interval_time"]), JSON.stringify(e));
  }

  const missingRegion = allExercises.filter((e) => !Array.isArray(e.body_part) || e.body_part.length === 0);
  check("all 47 exercises have at least one body_part region tag", missingRegion.length === 0, `missing: ${missingRegion.map((e) => e.legacy_ex_id).join(",")}`);
  const badVocab = allExercises.filter((e) => (e.body_part ?? []).some((r) => !APPROVED_REGIONS.includes(r)));
  check("only approved region vocabulary values exist anywhere in body_part", badVocab.length === 0, JSON.stringify(badVocab));
  const multiTagRows = allExercises.filter((e) => (e.body_part ?? []).length >= 2);
  check("at least one exercise carries multiple region tags (multi-tag supported)", multiTagRows.length >= 2, `count=${multiTagRows.length}`);
  check("Bent-Knee-named exercises are NOT tagged 'knee' (position, not target)", !(byLegacyId.get("ex_003").body_part ?? []).includes("knee"));

  // ===================== UI / DRAG-AND-DROP FIXTURE SETUP =====================
  const owner = await makeUser("revc-owner");
  const otherSupervisor = await makeUser("revc-other");
  const patient = await makeUser("revc-patient");

  let legacyOwnerId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let patientPrescriptionId = null;
  let draftId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyOwnerId = insertUser.run("c5s4revc-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4revc-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4revc-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
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

      // ===================== PART 3-4 — REGION FILTERING =====================
      check("Region filter control is present", (await page.locator('[data-testid="region-filter-toggle"]').count()) === 1);
      check("Category filter remains present but visually secondary", (await page.locator('[data-testid="category-filter-secondary"]').count()) === 1);
      check("no region filter active initially — no chips rendered", (await page.locator('[data-testid="region-filter-chips"]').count()) === 0);

      // Region alone.
      await openRegionFilter(page);
      await selectRegion(page, "Hip");
      await closeRegionPopover(page);
      await page.waitForTimeout(150);
      check("Region=Hip shows Hip Abductor Strengthening", (await libraryCard(page, HIP_EX.name).count()) === 1);
      check("Region=Hip shows Balance and Frontal-Plane Control Drills (hip+foot_ankle)", (await libraryCard(page, FOOT_HIP_EX.name).count()) === 1);
      check("Region=Hip hides a foot_ankle-only exercise", (await libraryCard(page, FOOT_ANKLE_EX.name).count()) === 0);
      check("Region=Hip hides a calf_achilles-only exercise", (await libraryCard(page, CALF_ISO.name).count()) === 0);
      check("Region filter toggle visually indicates an active selection", /border-brand-400|bg-brand-50/.test((await page.locator('[data-testid="region-filter-toggle"]').getAttribute("class")) ?? ""));
      check("active region shown as a removable chip", (await page.locator('[data-testid="region-filter-chips"]').filter({ hasText: "Hip" }).count()) === 1);

      // Multi-region OR.
      await openRegionFilter(page);
      await selectRegion(page, "Foot / Ankle");
      await closeRegionPopover(page);
      await page.waitForTimeout(150);
      check("Region=Hip OR Foot/Ankle now also shows the foot_ankle-only exercise", (await libraryCard(page, FOOT_ANKLE_EX.name).count()) === 1);
      check("Region=Hip OR Foot/Ankle still shows the hip-only exercise", (await libraryCard(page, HIP_EX.name).count()) === 1);
      check("Region filter shows count badge for 2 selected regions", (await page.locator('[data-testid="region-filter-toggle"]').innerText()).includes("2"));

      // Clear filter.
      await page.locator('[data-testid="region-filter-clear"]').click();
      await page.waitForTimeout(150);
      check("Clear removes all region chips", (await page.locator('[data-testid="region-filter-chips"]').count()) === 0);
      check("after clearing, a previously-hidden calf exercise reappears", (await libraryCard(page, CALF_ISO.name).count()) === 1);

      // Region + Loading Profile AND.
      await openRegionFilter(page);
      await selectRegion(page, "Calf / Achilles");
      await closeRegionPopover(page);
      await page.locator('[data-testid="primary-filters"] select').selectOption({ label: "Stretching" });
      await page.waitForTimeout(150);
      check("Region=Calf/Achilles AND Loading Profile=Stretching shows the stretch", (await libraryCard(page, CALF_STRETCH.name).count()) === 1);
      check("Region=Calf/Achilles AND Loading Profile=Stretching excludes the isometric exercise", (await libraryCard(page, CALF_ISO.name).count()) === 0);
      await page.screenshot({ path: "scripts/.c5s4revc-region-loading-profile-combined.png", fullPage: true });
      // reset loading profile
      await page.locator('[data-testid="primary-filters"] select').nth(0).selectOption({ label: "All loading profiles" });
      await page.waitForTimeout(150);

      // Region + text AND.
      await page.fill('input[placeholder="Search exercises…"]', "");
      await page.locator('[data-testid="region-filter-clear"]').click();
      await page.waitForTimeout(100);
      await openRegionFilter(page);
      await selectRegion(page, "Hip");
      await closeRegionPopover(page);
      await page.fill('input[placeholder="Search exercises…"]', "Balance");
      await page.waitForTimeout(150);
      check("Region=Hip AND text='Balance' shows only the matching drill", (await libraryCard(page, FOOT_HIP_EX.name).count()) === 1 && (await libraryCard(page, HIP_EX.name).count()) === 0);

      // No-result state.
      await page.fill('input[placeholder="Search exercises…"]', "zzz-no-such-exercise-zzz");
      await page.waitForTimeout(150);
      check("Region+text combination with no matches shows the empty state", (await page.locator("text=No exercises match these filters.").count()) === 1);
      await page.fill('input[placeholder="Search exercises…"]', "");

      // Region + Category AND (Category remains active).
      await page.locator('[data-testid="region-filter-clear"]').click();
      await openRegionFilter(page);
      await selectRegion(page, "Calf / Achilles");
      await closeRegionPopover(page);
      await page.locator('[data-testid="category-filter-secondary"]').selectOption({ label: "Flexibility Mobility" });
      await page.waitForTimeout(150);
      check("Region=Calf/Achilles AND Category=flexibility shows the stretch", (await libraryCard(page, CALF_STRETCH.name).count()) === 1);
      check("Region=Calf/Achilles AND Category=flexibility excludes the isometric exercise", (await libraryCard(page, CALF_ISO.name).count()) === 0);
      await page.locator('[data-testid="category-filter-secondary"]').selectOption({ label: "All" });
      await page.locator('[data-testid="region-filter-clear"]').click();
      await page.waitForTimeout(150);

      // Mobile usability.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(200);
      const toggleBox = await page.locator('[data-testid="region-filter-toggle"]').boundingBox();
      check("Region filter toggle fits within a 390px mobile viewport without horizontal overflow", !!toggleBox && toggleBox.x + toggleBox.width <= 390, JSON.stringify(toggleBox));
      await openRegionFilter(page);
      const popoverBox = await page.locator('[role="listbox"][aria-label="Filter by region"]').boundingBox();
      check("mobile region popover is a small anchored control, not a full-screen takeover", !!popoverBox && popoverBox.width < 390 * 0.8, JSON.stringify(popoverBox));
      await page.screenshot({ path: "scripts/.c5s4revc-mobile-region-filter.png", fullPage: true });
      await closeRegionPopover(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(150);

      await page.screenshot({ path: "scripts/.c5s4revc-desktop-library-region.png", fullPage: true });
      await openRegionFilter(page);
      await selectRegion(page, "Calf / Achilles");
      await closeRegionPopover(page);
      await page.waitForTimeout(150);
      await page.screenshot({ path: "scripts/.c5s4revc-calf-achilles-selected.png", fullPage: true });
      await openRegionFilter(page);
      await selectRegion(page, "Hip");
      await closeRegionPopover(page);
      await page.waitForTimeout(150);
      await page.screenshot({ path: "scripts/.c5s4revc-multi-region-selected.png", fullPage: true });
      await page.locator('[data-testid="region-filter-clear"]').click();
      await page.waitForTimeout(150);

      // ===================== PART 5-11 — DRAG AND DROP =====================
      await addFromLibrary(page, DRAG_EX_1.name);
      await addFromLibrary(page, DRAG_EX_2.name);
      await addFromLibrary(page, DRAG_EX_3.name);
      check("3 fixture exercises added in insertion order", JSON.stringify(await orderedRowNames(page)) === JSON.stringify([DRAG_EX_1.name, DRAG_EX_2.name, DRAG_EX_3.name]));
      check("a drag handle renders on each owner-visible row", (await page.locator('[data-testid="drag-handle"]').count()) === 3);
      await page.screenshot({ path: "scripts/.c5s4revc-drag-handle.png", fullPage: true });

      // Mouse drag: move exercise 1 down past exercise 3.
      await mouseDragHandle(page, DRAG_EX_1.name, DRAG_EX_3.name, "scripts/.c5s4revc-mid-drag-feedback.png");
      await waitForCondition(async () => (await orderedRowNames(page))[2] === DRAG_EX_1.name, 4000);
      const afterMouseDrag = await orderedRowNames(page);
      check("mouse drag moves exercise 1 to the end", JSON.stringify(afterMouseDrag) === JSON.stringify([DRAG_EX_2.name, DRAG_EX_3.name, DRAG_EX_1.name]), JSON.stringify(afterMouseDrag));
      await waitForCondition(async () => {
        const rows = await orderedIndexNames(draftId);
        return rows[2]?.canonical_exercise_id === DRAG_EX_1.id;
      }, 4000);
      const persistedAfterMouseDrag = await orderedIndexNames(draftId);
      check(
        "mouse-dragged order is persisted server-side (order_index)",
        persistedAfterMouseDrag[0].canonical_exercise_id === DRAG_EX_2.id && persistedAfterMouseDrag[1].canonical_exercise_id === DRAG_EX_3.id && persistedAfterMouseDrag[2].canonical_exercise_id === DRAG_EX_1.id,
        JSON.stringify(persistedAfterMouseDrag)
      );

      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      check("reordered order survives a full page refresh", JSON.stringify(await orderedRowNames(page)) === JSON.stringify([DRAG_EX_2.name, DRAG_EX_3.name, DRAG_EX_1.name]));

      // ===== Part 9: unsaved dosage survives reorder =====
      await draftRow(page, DRAG_EX_3.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
      const editor3 = draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-editor"]');
      await editor3.waitFor({ state: "visible", timeout: 5000 });
      const setsField3 = editor3.locator('[data-testid="dosage-field-sets"]');
      await setsField3.fill("3");
      check("dosage editor shows dirty/unsaved indicator before reorder", (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);

      await mouseDragHandle(page, DRAG_EX_2.name, DRAG_EX_1.name);
      await waitForCondition(async () => (await orderedRowNames(page))[0] !== DRAG_EX_2.name, 4000);
      const afterSecondDrag = await orderedRowNames(page);
      check("second drag actually reordered the list", afterSecondDrag[0] !== DRAG_EX_2.name, JSON.stringify(afterSecondDrag));
      check("unsaved dosage indicator survives an UNRELATED exercise's reorder", (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="unsaved-indicator"]').count()) === 1);
      check("dosage editor for the dirty exercise remains expanded after reorder", (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-editor"]').count()) === 1);
      check("unsaved value itself is preserved (not reset) after reorder", (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-field-sets"]').inputValue()) === "3");

      // ===== Part 10: multiple expanded editors survive reorder =====
      await draftRow(page, DRAG_EX_1.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
      const editor1 = draftRow(page, DRAG_EX_1.name).locator('[data-testid="dosage-editor"]');
      await editor1.waitFor({ state: "visible", timeout: 5000 });
      const setsField1 = editor1.locator('[data-testid="dosage-field-sets"]');
      await setsField1.fill("5");
      check("two dosage editors are simultaneously expanded", (await page.locator('[data-testid="dosage-editor"]').count()) === 2);

      await mouseDragHandle(page, DRAG_EX_1.name, DRAG_EX_2.name);
      await page.waitForTimeout(600);
      check("both dosage editors remain expanded after a further reorder", (await page.locator('[data-testid="dosage-editor"]').count()) === 2);
      check("exercise 3's unsaved value survived a second, unrelated reorder", (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-field-sets"]').inputValue()) === "3");
      check("exercise 1's unsaved value survived its own reorder", (await draftRow(page, DRAG_EX_1.name).locator('[data-testid="dosage-field-sets"]').inputValue()) === "5");

      // ===== Save after reorder persists dosage correctly =====
      const saveButton1 = editor1.locator('[data-testid="save-dosage"]');
      await saveButton1.click();
      // C5.4 Revision E — a successful save collapses the editor (button gone).
      await waitForCondition(async () => (await saveButton1.count()) === 0 || !(await saveButton1.isDisabled()), 8000);
      const { data: savedRow1 } = await admin
        .from("prescription_exercises")
        .select("id, prescription_exercise_dosage(*)")
        .eq("canonical_exercise_id", DRAG_EX_1.id)
        .eq("prescription_workouts.prescription_draft_id", draftId);
      const { data: pe1Rows } = await admin
        .from("prescription_exercises")
        .select("id, canonical_exercise_id, prescription_exercise_dosage(sets), prescription_workouts!inner(prescription_draft_id)")
        .eq("canonical_exercise_id", DRAG_EX_1.id)
        .eq("prescription_workouts.prescription_draft_id", draftId)
        .limit(1);
      const dosage1 = Array.isArray(pe1Rows?.[0]?.prescription_exercise_dosage) ? pe1Rows[0].prescription_exercise_dosage[0] : pe1Rows?.[0]?.prescription_exercise_dosage;
      check("saving dosage after a reorder persists the correct value against the correct exercise", dosage1?.sets === 5, JSON.stringify(dosage1));
      await page.screenshot({ path: "scripts/.c5s4revc-multiple-expanded-after-reorder.png", fullPage: true });

      // ===== Keyboard reorder (Part 8) =====
      // Revision C found that keyboard reordering could no-op when the
      // dragged row or its neighbour had a tall, expanded dosage editor.
      // C5.4 Closeout fixed that with a custom coordinateGetter (DraftPanel's
      // makeSteppedKeyboardCoordinates); expanded clean/dirty keyboard
      // reordering is covered by verifyC5Stage4Closeout.mjs. This check keeps
      // the collapsed path, and keeps proving that collapsing is independent
      // of dosage working state (Revision B's whole point — see BuilderShell's
      // header): collapsing here does not discard exercise 3's still-unsaved
      // value; we verify it reopens intact after.
      await draftRow(page, DRAG_EX_1.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
      await draftRow(page, DRAG_EX_3.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
      await waitForCondition(async () => (await page.locator('[data-testid="dosage-editor"]').count()) === 0, 3000);

      const beforeKeyboard = await orderedRowNames(page);
      const keyboardDirection = "ArrowDown";
      await keyboardDragHandle(page, beforeKeyboard[0], keyboardDirection, 1);
      await waitForCondition(async () => (await orderedRowNames(page))[0] !== beforeKeyboard[0], 4000);
      const afterKeyboard = await orderedRowNames(page);
      check(
        "keyboard reorder (Space, ArrowDown, Space) moves the focused collapsed exercise down one position",
        afterKeyboard[1] === beforeKeyboard[0] && afterKeyboard[0] === beforeKeyboard[1],
        JSON.stringify({ beforeKeyboard, afterKeyboard })
      );
      const expectedKeyboardIds = afterKeyboard.map((n) => DRAG_EX_NAME_TO_ID[n]).join(",");
      await waitForCondition(async () => (await orderedIndexNames(draftId)).map((r) => r.canonical_exercise_id).join(",") === expectedKeyboardIds, 4000);
      const persistedAfterKeyboard = await orderedIndexNames(draftId);
      check(
        "keyboard-reordered order is persisted server-side too",
        persistedAfterKeyboard.map((r) => r.canonical_exercise_id).join(",") === expectedKeyboardIds,
        JSON.stringify(persistedAfterKeyboard)
      );

      // Re-expand exercise 3 to confirm collapsing it for the keyboard test
      // above never touched its still-unsaved value.
      await draftRow(page, DRAG_EX_3.name).locator('[data-testid="draft-exercise-row-toggle"]').click();
      await draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-editor"]').waitFor({ state: "visible", timeout: 5000 });
      check(
        "unsaved dosage value survives an intervening collapse/expand + keyboard reorder of OTHER rows",
        (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-field-sets"]').inputValue()) === "3"
      );

      // ===== Reorder failure handling (Part 11) =====
      const beforeFailure = await orderedRowNames(page);
      await page.route("**/api/clinician/prescription-workouts/*/exercises/reorder", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure" }) }));
      await mouseDragHandle(page, beforeFailure[0], beforeFailure[2]);
      await page.waitForTimeout(800);
      check("a failed reorder surfaces a visible error message rather than silently lying", (await page.locator("text=Could not save the new exercise order").count()) === 1);
      const afterFailedDrag = await orderedRowNames(page);
      check("a failed reorder rolls back to the authoritative pre-drag order in the UI", JSON.stringify(afterFailedDrag) === JSON.stringify(beforeFailure), JSON.stringify({ beforeFailure, afterFailedDrag }));
      const persistedAfterFailure = await orderedIndexNames(draftId);
      check(
        "a failed reorder never persisted the attempted order server-side",
        persistedAfterFailure.map((r) => r.canonical_exercise_id).join(",") === persistedAfterKeyboard.map((r) => r.canonical_exercise_id).join(","),
        JSON.stringify(persistedAfterFailure)
      );
      check("unsaved dosage on exercise 3 (if still dirty) is untouched by the failed reorder attempt", (await draftRow(page, DRAG_EX_3.name).locator('[data-testid="dosage-field-sets"]').inputValue()) === "3");
      await page.unroute("**/api/clinician/prescription-workouts/*/exercises/reorder");

      // Cancel exercise 3's dosage so it doesn't interfere with cleanup/other assertions.
      await draftRow(page, DRAG_EX_3.name).locator('[data-testid="cancel-dosage"]').click().catch(() => {});

      await page.screenshot({ path: "scripts/.c5s4revc-reordered-list.png", fullPage: true });

      // Screenshot: mobile prescription list with drag affordance.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /^Draft/ }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "scripts/.c5s4revc-mobile-drag-affordance.png", fullPage: true });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForTimeout(150);

      // ===================== AUTHORIZATION =====================
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=Exercise Library");
      check("view-only clinician sees no drag handles at all", (await otherPage.locator('[data-testid="drag-handle"]').count()) === 0);
      await otherPage.screenshot({ path: "scripts/.c5s4revc-view-only.png", fullPage: true });

      const liveWorkout = await orderedIndexNames(draftId);
      const otherReorderResp = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${(await admin.from("prescription_workouts").select("id").eq("prescription_draft_id", draftId).single()).data.id}/exercises/reorder`, {
        method: "POST",
        data: { orderedExerciseIds: liveWorkout.map((r) => r.id).reverse() },
      });
      check("non-owning clinician's direct reorder API call is rejected", otherReorderResp.status() === 403, `got ${otherReorderResp.status()}`);
      const unchangedAfterUnauthorized = await orderedIndexNames(draftId);
      check("order_index unaffected by the rejected unauthorized reorder attempt", JSON.stringify(unchangedAfterUnauthorized.map((r) => r.canonical_exercise_id)) === JSON.stringify(liveWorkout.map((r) => r.canonical_exercise_id)));
      await otherPage.close();

      await page.screenshot({ path: "scripts/.c5s4revc-desktop-overall.png", fullPage: true });

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
