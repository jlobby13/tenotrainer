// C5.4 Performance Pass — focused regression/behaviour verification for the
// optimistic builder interactions. Uses Playwright network routing to make
// the server deliberately SLOW (proving visual state no longer waits on
// persistence) or FAIL (proving rollback / no ghost state / feedback).
// Throwaway fixture users; real canonical exercises (read-only).
//
// Requires: `next dev` (or `next start`) on BASE_URL (default
// localhost:3000), web/.env.local populated, Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4PerformancePass.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const BASE_URL = process.argv[2] ?? "http://localhost:3000";
const LEGACY_DB_PATH = "../app/tenotrainer.db";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";
const SLOW_MS = 1500;
// "Immediate" budget for a visual change while its request is held for
// SLOW_MS. Generous enough for dev-mode rendering on a loaded machine.
const IMMEDIATE_MS = 400;

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
  const email = `c5perfv-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").upsert({ id: data.user.id, name: label });
  return { userId: data.user.id, email };
}
async function waitForCondition(fn, timeoutMs = 8000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
const dayBtn = (page, d) => page.locator(`[data-testid="weekday-button"][data-day="${d}"]`);
const isDayOn = async (page, d) => ((await dayBtn(page, d).getAttribute("class")) ?? "").includes("bg-brand-600");
const draftRow = (page, name) => page.locator('[data-testid="draft-exercise-row"]').filter({ has: page.locator('[data-testid="draft-exercise-name"]', { hasText: name }) });
const libraryCard = (page, name) => page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]').filter({ hasText: name });
const banner = (page) => page.locator("div.bg-red-50.border-b");
async function dbDays(workoutId) {
  const { data } = await admin.from("prescription_workouts").select("days_of_week").eq("id", workoutId).single();
  return data.days_of_week;
}
async function dbExerciseRows(workoutId) {
  const { data } = await admin.from("prescription_exercises").select("id, canonical_exercise_id, order_index").eq("prescription_workout_id", workoutId);
  return data ?? [];
}
// Times click → condition entirely inside the page (one animation frame resolution).
async function clickAndTime(page, selector, condSource) {
  return page.evaluate(
    ({ selector, condSource }) =>
      new Promise((resolve) => {
        const cond = new Function(`return (${condSource})`)();
        const t0 = performance.now();
        document.querySelector(selector).click();
        const tick = () => {
          if (cond()) resolve(performance.now() - t0);
          else if (performance.now() - t0 > 10000) resolve(null);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    { selector, condSource }
  );
}

async function main() {
  const { data: exercises } = await admin.from("canonical_exercises").select("id, legacy_ex_id, name").eq("visibility", "global").order("legacy_ex_id");
  const byLegacy = new Map(exercises.map((e) => [e.legacy_ex_id, e]));
  const SEED = ["ex_001", "ex_005", "ex_008"].map((l) => byLegacy.get(l));
  const ADD_SLOW = byLegacy.get("ex_002");
  const ADD_FAIL = byLegacy.get("ex_003");
  const ADD_ABORT = byLegacy.get("ex_006");
  const ADD_GAP = byLegacy.get("ex_007");

  const owner = await makeUser("owner");
  const other = await makeUser("other");
  const patient = await makeUser("patient");
  let legacy = {};
  let patientPrescriptionId;
  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const ins = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacy.owner = ins.run("c5perfv-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacy.other = ins.run("c5perfv-other", other.email, "supervisor", other.userId).lastInsertRowid;
    legacy.patient = ins.run("c5perfv-patient", patient.email, "patient", patient.userId).lastInsertRowid;
    const sp = legacyDb.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')");
    sp.run(legacy.owner, legacy.patient);
    sp.run(legacy.other, legacy.patient);
  } finally {
    legacyDb.close();
  }

  try {
    for (const [u, role] of [[owner, "clinician"], [other, "clinician"], [patient, "member"]]) {
      await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: u.userId, role });
    }
    for (const u of [owner, other]) await admin.from("supervisor_patients").insert({ supervisor_id: u.userId, patient_id: patient.userId, status: "active" });
    const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
    patientPrescriptionId = pp.id;
    const { data: draft } = await admin
      .from("prescription_drafts")
      .insert({ patient_prescription_id: pp.id, status: "editing", source: "empty", created_by: owner.userId, editing_clinician_id: owner.userId, updated_by: owner.userId, scheduling_mode: "calendar" })
      .select("id")
      .single();
    const { data: wA } = await admin.from("prescription_workouts").insert({ prescription_draft_id: draft.id, label: "Workout A", order_index: 0 }).select("id").single();
    const { data: wB } = await admin.from("prescription_workouts").insert({ prescription_draft_id: draft.id, label: "Workout B", order_index: 1, days_of_week: [2] }).select("id").single();
    for (const [i, ex] of SEED.entries()) {
      const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: wA.id, canonical_exercise_id: ex.id, order_index: i }).select("id").single();
      await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 10 });
    }

    const browser = await chromium.launch();
    try {
      const login = async (u) => {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const p = await ctx.newPage();
        await p.goto(`${BASE_URL}/login`);
        await p.fill("#email", u.email);
        await p.fill("#password", PASSWORD);
        await p.click('button[type="submit"]');
        await p.waitForLoadState("networkidle");
        await p.close();
        return ctx;
      };
      const ctx = await login(owner);
      const page = await ctx.newPage();
      const requests = [];
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith("/api/clinician/")) requests.push(`${r.method()} ${u.pathname.replace(/[0-9a-f-]{36}/g, ":id")}`);
      });
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForSelector('[data-testid="weekday-button"]', { timeout: 120000 });
      // The buttons are server-rendered; wait for hydration before clicking.
      await page.waitForLoadState("networkidle");
      const workoutPatchUrl = `**/api/clinician/prescription-workouts/${wA.id}`;
      const slowRoute = (url, methods = ["PATCH", "POST", "PUT"]) =>
        page.route(url, async (route) => {
          if (methods.includes(route.request().method())) await new Promise((r) => setTimeout(r, SLOW_MS));
          await route.continue();
        });

      // ===================== CALENDAR — immediate feedback, accurate persistence =====================
      await slowRoute(workoutPatchUrl, ["PATCH"]);
      requests.length = 0;
      const monMs = await clickAndTime(page, '[data-testid="weekday-button"][data-day="1"]', `() => document.querySelector('[data-testid="weekday-button"][data-day="1"]').className.includes("bg-brand-600")`);
      check(`weekday selection is visible immediately while the save is held for ${SLOW_MS}ms (${Math.round(monMs)}ms)`, monMs != null && monMs < IMMEDIATE_MS, `ms=${monMs}`);
      check("saving state is shown while the weekday write is in flight", await page.locator('[data-testid="weekday-save-status"]').isVisible());
      check("not yet persisted while in flight (no false 'saved')", (await dbDays(wA.id)) == null || !(await dbDays(wA.id)).includes(1));
      check("mode switch is locked while a weekday write is in flight", await page.locator('[data-testid="scheduling-mode-sequence"]').isDisabled());
      await waitForCondition(async () => (await page.locator('[data-testid="weekday-save-status"]').count()) === 0, 8000);
      check("weekday persisted after the write completes", JSON.stringify(await dbDays(wA.id)) === "[1]", JSON.stringify(await dbDays(wA.id)));
      check("weekday toggle performs no full-draft re-read", !requests.includes("GET /api/clinician/prescription-drafts/:id"), requests.join(", "));
      check("saving indicator clears after persistence", (await page.locator('[data-testid="weekday-save-status"]').count()) === 0);

      // rapid Wed + Fri + un-Mon while writes are slow: latest wins, in order
      requests.length = 0;
      const t0 = Date.now();
      await dayBtn(page, 3).click();
      await dayBtn(page, 5).click();
      await dayBtn(page, 1).click();
      const rapidVisibleMs = Date.now() - t0;
      check("rapid Wed/Fri/un-Mon all reflected immediately", (await isDayOn(page, 3)) && (await isDayOn(page, 5)) && !(await isDayOn(page, 1)), `elapsed=${rapidVisibleMs}ms`);
      check("rapid clicks are not blocked by a busy lock", rapidVisibleMs < 2 * IMMEDIATE_MS + 300, `elapsed=${rapidVisibleMs}ms`);
      await waitForCondition(async () => (await page.locator('[data-testid="weekday-save-status"]').count()) === 0, 15000);
      check("rapid toggles persist exactly the final selection [3,5]", JSON.stringify(await dbDays(wA.id)) === "[3,5]", JSON.stringify(await dbDays(wA.id)));
      const patches = requests.filter((r) => r === "PATCH /api/clinician/prescription-workouts/:id").length;
      check("rapid toggles coalesce (≤ 2 sequential PATCHes for 3 clicks, never concurrent)", patches >= 1 && patches <= 2, `patches=${patches}`);
      check("UI matches persisted state after rapid toggles", (await isDayOn(page, 3)) && (await isDayOn(page, 5)) && !(await isDayOn(page, 1)));
      check("day owned by Workout B still unavailable (exclusivity preserved)", await dayBtn(page, 2).isDisabled());
      await page.unroute(workoutPatchUrl);

      // failure → rollback + feedback
      await page.route(workoutPatchUrl, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        await new Promise((r) => setTimeout(r, 800)); // so the optimistic state is observable before the failure
        await route.fulfill({ status: 422, contentType: "application/json", body: '{"error":"VALIDATION_FAILED"}' });
      });
      await dayBtn(page, 4).click();
      check("failing weekday change still shows immediately", await isDayOn(page, 4));
      await waitForCondition(async () => !(await isDayOn(page, 4)), 6000);
      check("failed weekday save rolls back to the last saved days", !(await isDayOn(page, 4)) && (await isDayOn(page, 3)) && (await isDayOn(page, 5)));
      check("failed weekday save tells the clinician", (await banner(page).count()) === 1 && (await banner(page).innerText()).includes("Could not save the weekday assignment"));
      check("failed weekday save persisted nothing", JSON.stringify(await dbDays(wA.id)) === "[3,5]");
      await page.unroute(workoutPatchUrl);

      // overlay: an unrelated full-draft refresh landing mid-write must not undo the optimistic day
      await slowRoute(workoutPatchUrl, ["PATCH"]);
      await dayBtn(page, 6).click();
      await page.getByRole("button", { name: "Workout B" }).first().click().catch(() => {});
      const renameTarget = page.locator('[data-testid="workout-tab"]').filter({ hasText: "Workout B" }).first();
      await renameTarget.click();
      // Reorder workouts triggers a full refreshDraft() while the weekday write is held.
      await page.locator('[data-testid="workout-tabs"] button[aria-label*="left" i], [data-testid="workout-tabs"] button:has-text("←")').first().click();
      await page.waitForTimeout(900);
      await page.locator('[data-testid="workout-tab"]').filter({ hasText: "Workout A" }).first().click();
      check("a concurrent full-draft refresh does not visually undo an in-flight weekday change", await isDayOn(page, 6));
      await waitForCondition(async () => (await page.locator('[data-testid="weekday-save-status"]').count()) === 0, 8000);
      await page.waitForTimeout(300);
      check("in-flight weekday change persisted despite the concurrent refresh", JSON.stringify(await dbDays(wA.id)) === "[3,5,6]", JSON.stringify(await dbDays(wA.id)));
      check("UI still shows it after both settle", await isDayOn(page, 6));
      await page.unroute(workoutPatchUrl);
      // restore workout order A, B for the rest of the suite
      const tabsText = await page.locator('[data-testid="workout-tab"]').allInnerTexts();
      if (!tabsText[0].includes("Workout A")) {
        await page.locator('[data-testid="workout-tab"]').filter({ hasText: "Workout B" }).first().click();
        await page.locator('[data-testid="workout-tabs"] button:has-text("→")').first().click();
        await page.waitForTimeout(1500);
      }
      await page.locator('[data-testid="workout-tab"]').filter({ hasText: "Workout A" }).first().click();

      // ===================== ADD EXERCISE — immediate pending row =====================
      const exercisesUrl = `**/api/clinician/prescription-workouts/${wA.id}/exercises`;
      await slowRoute(exercisesUrl, ["POST"]);
      requests.length = 0;
      const addMs = await page.evaluate(
        ({ name }) =>
          new Promise((resolve) => {
            const card = [...document.querySelectorAll('[data-testid="library-panel"] [data-testid="exercise-card"]')].find((c) => c.dataset.exerciseName === name);
            const add = [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add");
            const t0 = performance.now();
            add.click();
            const tick = () => {
              if ([...document.querySelectorAll('[data-testid="draft-exercise-name"]')].some((n) => n.textContent.trim() === name)) resolve(performance.now() - t0);
              else if (performance.now() - t0 > 10000) resolve(null);
              else requestAnimationFrame(tick);
            };
            tick();
          }),
        { name: ADD_SLOW.name }
      );
      check(`added exercise is visible immediately while the save is held for ${SLOW_MS}ms (${Math.round(addMs)}ms)`, addMs != null && addMs < IMMEDIATE_MS, `ms=${addMs}`);
      const pendingRow = draftRow(page, ADD_SLOW.name);
      check("pending add is clearly marked", (await pendingRow.locator('[data-testid="pending-add-indicator"]').count()) === 1);
      check("pending add cannot be edited/moved/removed yet", (await pendingRow.locator('[data-testid="edit-dosage"]').count()) + (await pendingRow.locator('[data-testid="move-to-workout"]').count()) + (await pendingRow.locator('[aria-label="Remove from draft"]').count()) === 0);
      check("drag reorder paused while an add is pending", (await page.locator('[data-testid="drag-handle"]').count()) === 0);
      check("Library immediately shows the exercise as added (duplicate prevention)", (await libraryCard(page, ADD_SLOW.name).getByRole("button", { name: "Add", exact: true }).count()) === 0);
      await page.evaluate((name) => {
        const card = [...document.querySelectorAll('[data-testid="library-panel"] [data-testid="exercise-card"]')].find((c) => c.dataset.exerciseName === name);
        [...card.querySelectorAll("button")].filter((b) => /add/i.test(b.textContent)).forEach((b) => b.click());
      }, ADD_SLOW.name);
      check("not persisted while pending", (await dbExerciseRows(wA.id)).filter((r) => r.canonical_exercise_id === ADD_SLOW.id).length === 0);
      await waitForCondition(async () => (await pendingRow.locator('[data-testid="pending-add-indicator"]').count()) === 0, 8000);
      await page.waitForTimeout(300);
      const rowsAfterAdd = (await dbExerciseRows(wA.id)).filter((r) => r.canonical_exercise_id === ADD_SLOW.id);
      check("add persisted exactly once (repeat clicks while pending never duplicate)", rowsAfterAdd.length === 1, `rows=${rowsAfterAdd.length}`);
      check("exactly one POST for the add", requests.filter((r) => r === "POST /api/clinician/prescription-workouts/:id/exercises").length === 1, requests.join(", "));
      check("add performs no full-draft re-read", !requests.includes("GET /api/clinician/prescription-drafts/:id"), requests.join(", "));
      check("settled row becomes a normal, editable draft exercise", (await pendingRow.locator('[data-testid="edit-dosage"]').count()) === 1 && (await draftRow(page, ADD_SLOW.name).count()) === 1);
      check("settled row shows 'Dosage needed' (no dosage invented)", (await pendingRow.locator('[data-testid="dosage-summary"]').innerText()).includes("Dosage needed"));
      check("drag reorder available again after the add settles", (await page.locator('[data-testid="drag-handle"]').count()) > 0);
      await page.unroute(exercisesUrl);
      await pendingRow.locator('[data-testid="edit-dosage"]').click();
      check("newly added exercise opens its dosage editor (real id in use)", await pendingRow.locator('[data-testid="dosage-editor"]').isVisible());
      await pendingRow.locator('[data-testid="cancel-dosage"]').click();

      // failure → no ghost, feedback, Add available again
      await page.route(exercisesUrl, (route) => (route.request().method() === "POST" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"INTERNAL_ERROR"}' }) : route.continue()));
      await libraryCard(page, ADD_FAIL.name).getByRole("button", { name: "Add", exact: true }).click();
      await waitForCondition(async () => (await draftRow(page, ADD_FAIL.name).count()) === 0, 6000);
      check("failed add removes the pending row (no ghost)", (await draftRow(page, ADD_FAIL.name).count()) === 0);
      check("failed add tells the clinician it was not saved", (await banner(page).count()) === 1 && (await banner(page).innerText()).includes(`Could not add ${ADD_FAIL.name}`));
      check("failed add persisted nothing", (await dbExerciseRows(wA.id)).every((r) => r.canonical_exercise_id !== ADD_FAIL.id));
      check("failed exercise can be added again from the Library", (await libraryCard(page, ADD_FAIL.name).getByRole("button", { name: "Add", exact: true }).count()) === 1);
      await page.unroute(exercisesUrl);

      // network failure (ambiguous) → reload authoritative state, honest message
      await page.route(exercisesUrl, (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
      requests.length = 0;
      await libraryCard(page, ADD_ABORT.name).getByRole("button", { name: "Add", exact: true }).click();
      await waitForCondition(async () => (await banner(page).count()) === 1 && (await banner(page).innerText()).includes("Could not confirm"), 6000);
      check("network failure: honest 'could not confirm' message", (await banner(page).innerText()).includes(`Could not confirm ${ADD_ABORT.name} was added`));
      await page.waitForTimeout(1500);
      check("network failure: authoritative draft re-read", requests.includes("GET /api/clinician/prescription-drafts/:id"), requests.join(", "));
      check("network failure: no ghost row", (await draftRow(page, ADD_ABORT.name).count()) === 0 && (await dbExerciseRows(wA.id)).every((r) => r.canonical_exercise_id !== ADD_ABORT.id));
      await page.unroute(exercisesUrl);

      // order_index gap (after Move-out) no longer collides
      await draftRow(page, SEED[0].name).locator('[data-testid="move-to-workout"]').selectOption({ label: "Workout B" });
      await waitForCondition(async () => (await draftRow(page, SEED[0].name).count()) === 0, 8000);
      await libraryCard(page, ADD_GAP.name).getByRole("button", { name: "Add", exact: true }).click();
      await waitForCondition(async () => (await dbExerciseRows(wA.id)).some((r) => r.canonical_exercise_id === ADD_GAP.id), 8000);
      const gapRows = await dbExerciseRows(wA.id);
      check("add after a Move-out gap persists (order_index = max+1, no UNIQUE collision)", gapRows.some((r) => r.canonical_exercise_id === ADD_GAP.id) && new Set(gapRows.map((r) => r.order_index)).size === gapRows.length, JSON.stringify(gapRows.map((r) => r.order_index)));
      check("no add error shown for the gap case", (await banner(page).count()) === 0 || !(await banner(page).innerText()).includes(ADD_GAP.name));

      // ===================== PHASE / FOCUS =====================
      const draftUrl = `**/api/clinician/prescription-drafts/${draft.id}`;
      const phaseSelect = page.locator('[data-testid="scheduling-panel"] select').last();
      await page.route(draftUrl, async (route) => {
        if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, SLOW_MS));
        await route.continue();
      });
      requests.length = 0;
      await phaseSelect.selectOption("late");
      check("phase change shows immediately", (await phaseSelect.inputValue()) === "late");
      await page.waitForTimeout(SLOW_MS + 1200);
      const { data: dAfter } = await admin.from("prescription_drafts").select("phase").eq("id", draft.id).single();
      check("phase persisted", dAfter.phase === "late");
      check("phase change performs no full-draft re-read", !requests.includes("GET /api/clinician/prescription-drafts/:id"), requests.join(", "));
      const focusBoxes = page.locator('[data-testid="scheduling-panel"] input[type="checkbox"]');
      await focusBoxes.nth(0).click();
      await focusBoxes.nth(1).click();
      await focusBoxes.nth(2).click();
      await focusBoxes.nth(1).click();
      check("rapid Performance Focus toggles reflected immediately", (await focusBoxes.nth(0).isChecked()) && !(await focusBoxes.nth(1).isChecked()) && (await focusBoxes.nth(2).isChecked()));
      await page.waitForTimeout(3 * SLOW_MS + 2000);
      const { data: focusRows } = await admin.from("prescription_draft_performance_focus").select("focus").eq("prescription_draft_id", draft.id);
      check("rapid Performance Focus toggles persist the final selection", focusRows.length === 2, JSON.stringify(focusRows));
      await page.unroute(draftUrl);
      await page.route(draftUrl, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : route.continue()));
      await phaseSelect.selectOption("early");
      await waitForCondition(async () => (await phaseSelect.inputValue()) === "late", 6000);
      check("failed phase save rolls back to the saved phase", (await phaseSelect.inputValue()) === "late");
      check("failed phase save tells the clinician", (await banner(page).innerText()).includes("Could not save the phase"));
      await page.unroute(draftUrl);

      // ===================== SAVE DOSAGE — no re-read, summary + reload consistent =====================
      const saveTarget = SEED[1].name;
      await draftRow(page, saveTarget).locator('[data-testid="edit-dosage"]').click();
      await draftRow(page, saveTarget).locator('[data-testid="dosage-field-sets"]').fill("5");
      requests.length = 0;
      await draftRow(page, saveTarget).locator('[data-testid="save-dosage"]').click();
      await waitForCondition(async () => (await draftRow(page, saveTarget).locator('[data-testid="dosage-editor"]').count()) === 0, 8000);
      await page.waitForTimeout(400);
      check("Save dosage collapses and shows the saved value", (await draftRow(page, saveTarget).locator('[data-testid="summary-sets"]').innerText()).replace(/\s+/g, " ") === "5 sets");
      check("Save dosage performs no full-draft re-read", !requests.includes("GET /api/clinician/prescription-drafts/:id"), requests.join(", "));
      await draftRow(page, saveTarget).locator('[data-testid="edit-dosage"]').click();
      check("re-opening after save is clean (saved baseline updated locally)", (await draftRow(page, saveTarget).locator('[data-testid="unsaved-indicator"]').count()) === 0 && (await draftRow(page, saveTarget).locator('[data-testid="dosage-field-sets"]').inputValue()) === "5");
      await draftRow(page, saveTarget).locator('[data-testid="cancel-dosage"]').click();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="weekday-button"]', { timeout: 60000 });
      await page.waitForLoadState("networkidle");
      check("after reload, the authoritative draft matches what was shown", (await draftRow(page, saveTarget).locator('[data-testid="summary-sets"]').innerText()).replace(/\s+/g, " ") === "5 sets" && (await isDayOn(page, 3)) && (await isDayOn(page, 5)) && (await isDayOn(page, 6)) && (await draftRow(page, ADD_SLOW.name).count()) === 1);

      check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

      // ===================== VIEW-ONLY =====================
      const otherCtx = await login(other);
      const op = await otherCtx.newPage();
      await op.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await op.waitForSelector('[data-testid="weekday-button"]', { timeout: 60000 });
      check("view-only: weekday buttons disabled", await dayBtn(op, 1).isDisabled());
      check("view-only: Library Add unavailable", (await op.getByRole("button", { name: "Add", exact: true }).first().isDisabled().catch(() => true)) === true);
      const forged = await otherCtx.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${wA.id}`, { method: "PATCH", data: { daysOfWeek: [0] } });
      check("view-only: direct weekday PATCH rejected (403)", forged.status() === 403, `status=${forged.status()}`);
      const forgedAdd = await otherCtx.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${wA.id}/exercises`, { method: "POST", data: { canonicalExerciseId: ADD_FAIL.id, orderIndex: 99 } });
      check("view-only: direct add rejected (403)", forgedAdd.status() === 403, `status=${forgedAdd.status()}`);
      check("rejected forged writes changed nothing", JSON.stringify(await dbDays(wA.id)) === "[3,5,6]" && (await dbExerciseRows(wA.id)).every((r) => r.canonical_exercise_id !== ADD_FAIL.id));
      const conflict = await ctx.request.fetch(`${BASE_URL}/api/clinician/prescription-workouts/${wA.id}`, { method: "PATCH", data: { daysOfWeek: [2, 3] } });
      check("server still rejects a weekday owned by another workout (422)", conflict.status() === 422, `status=${conflict.status()}`);
      await op.close();
      await otherCtx.close();
      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (patientPrescriptionId) await admin.from("patient_prescriptions").delete().eq("id", patientPrescriptionId);
    await admin.from("supervisor_patients").delete().eq("patient_id", patient.userId);
    const ids = [owner.userId, other.userId, patient.userId];
    await admin.from("organization_members").delete().in("user_id", ids);
    await admin.from("profiles").delete().in("id", ids);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    const d = new DatabaseSync(LEGACY_DB_PATH);
    try {
      d.exec(`DELETE FROM supervisor_patients WHERE supervisor_id IN (${legacy.owner}, ${legacy.other})`);
      d.exec(`DELETE FROM users WHERE id IN (${legacy.owner}, ${legacy.other}, ${legacy.patient})`);
    } finally {
      d.close();
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
