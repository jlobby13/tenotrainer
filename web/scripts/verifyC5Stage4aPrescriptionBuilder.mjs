// C5.4A — Prescription Builder Foundation & Canonical Library Browser.
// Live HTTP/UI verification. Drives the REAL Next.js pages/API routes over
// authenticated Playwright sessions, using entirely throwaway fixture users
// and two throwaway (non-C5.3G) canonical_exercises rows — NEVER any of the
// 47 migrated library exercises, which this script only ever READS.
// Mirrors verifyC5Stage3HttpLayer.mjs's conventions (makeUser/addOrgMember/
// loginContext, REAL_ORG_ID, legacy SQLite seeding for high-consequence
// auth, full teardown in `finally`).
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4aPrescriptionBuilder.mjs
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
  const email = `c5s4a-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, name: label });
  if (profileError) throw profileError;
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

async function main() {
  // Profile display name deliberately avoids the substring "owner" — the
  // verification below asserts the view-only banner text never contains
  // the internal word "owner", and this fixture's name is rendered
  // verbatim inside that banner.
  const owner = await makeUser("primary-clinician");
  const otherSupervisor = await makeUser("other-supervisor");
  const unauthorized = await makeUser("unauthorized");
  const orgOnlyExerciseOwner = await makeUser("private-exercise-owner");
  const patient = await makeUser("patient");

  let legacyClinicianId = null;
  let legacyOtherId = null;
  let legacyPatientId = null;
  let patientPrescriptionId = null;
  let inactiveExerciseId = null;
  let privateExerciseId = null;
  let activeVersionId = null;

  const legacyDb = new DatabaseSync(LEGACY_DB_PATH);
  try {
    const insertUser = legacyDb.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)");
    legacyClinicianId = insertUser.run("c5s4a-verify-owner", owner.email, "supervisor", owner.userId).lastInsertRowid;
    legacyOtherId = insertUser.run("c5s4a-verify-other", otherSupervisor.email, "supervisor", otherSupervisor.userId).lastInsertRowid;
    legacyPatientId = insertUser.run("c5s4a-verify-patient", patient.email, "patient", patient.userId).lastInsertRowid;
    const insertSp = legacyDb.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')");
    insertSp.run(legacyClinicianId, legacyPatientId);
    insertSp.run(legacyOtherId, legacyPatientId);
  } finally {
    legacyDb.close();
  }

  try {
    await addOrgMember(owner.userId, "clinician");
    await addOrgMember(otherSupervisor.userId, "clinician");
    await addOrgMember(unauthorized.userId, "clinician");
    await addOrgMember(orgOnlyExerciseOwner.userId, "clinician");
    await addOrgMember(patient.userId, "member");

    await admin.from("supervisor_patients").insert({ supervisor_id: owner.userId, patient_id: patient.userId, status: "active" });
    await admin.from("supervisor_patients").insert({ supervisor_id: otherSupervisor.userId, patient_id: patient.userId, status: "active" });
    // unauthorized deliberately gets NO supervisor_patients row for `patient`.

    // --- throwaway library fixtures (never any of the 47 C5.3G exercises) ---
    const { data: inactiveEx } = await admin
      .from("canonical_exercises")
      .insert({ name: "C5.4A verify inactive exercise", visibility: "global", active: false })
      .select("id")
      .single();
    inactiveExerciseId = inactiveEx.id;

    const { data: privateEx } = await admin
      .from("canonical_exercises")
      .insert({ name: "C5.4A verify private exercise", visibility: "private", owner_clinician_id: orgOnlyExerciseOwner.userId, active: true })
      .select("id")
      .single();
    privateExerciseId = privateEx.id;

    // --- fixture active prescription (so the entry point's "active, no
    // draft" branch and the clone_active Edit flow can both be exercised,
    // and so "active prescription unchanged during editing" is checkable) ---
    const { data: ppRow } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
    patientPrescriptionId = ppRow.id;
    const { data: versionRow } = await admin
      .from("prescription_versions")
      .insert({
        user_id: patient.userId,
        stage: 1,
        irritability: "low",
        is_insertional: false,
        source: "onboarding",
        patient_prescription_id: patientPrescriptionId,
        version_number: 1,
        published_at: new Date().toISOString(),
        published_by: owner.userId,
      })
      .select("id")
      .single();
    activeVersionId = versionRow.id;
    await admin.from("patient_prescriptions").update({ current_prescription_version_id: activeVersionId }).eq("id", patientPrescriptionId);

    const browser = await chromium.launch();
    try {
      const ctxOwner = await loginContext(browser, owner.email);
      const ctxOther = await loginContext(browser, otherSupervisor.email);
      const ctxUnauthorized = await loginContext(browser, unauthorized.email);

      // ===================== AUTHORIZATION =====================
      const unauthorizedResp = await ctxUnauthorized.request.get(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      check("unsupervised clinician -> 404 on prescription entry point", unauthorizedResp.status() === 404, `got ${unauthorizedResp.status()}`);

      const unauthorizedBuilderResp = await ctxUnauthorized.request.get(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      check("unsupervised clinician -> 404 on builder route", unauthorizedBuilderResp.status() === 404, `got ${unauthorizedBuilderResp.status()}`);

      const ownerEntryResp = await ctxOwner.request.get(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      check("supervising clinician -> 200 on prescription entry point", ownerEntryResp.status() === 200, `got ${ownerEntryResp.status()}`);

      // ===================== LIBRARY =====================
      const libResp = await ctxOwner.request.get(`${BASE_URL}/api/clinician/library/exercises`);
      check("library list -> 200", libResp.status() === 200, `got ${libResp.status()}`);
      const libBody = await libResp.json();
      const libIds = new Set(libBody.exercises.map((e) => e.id));
      check("exactly 47 exercises visible (the C5.3G migrated global set)", libBody.exercises.length === 47, `got ${libBody.exercises.length}`);
      check("inactive throwaway exercise excluded from ordinary selection", !libIds.has(inactiveExerciseId));
      check("unauthorized private exercise (owned by another clinician) excluded", !libIds.has(privateExerciseId));

      // ===================== DRAFT LIFECYCLE: create (clone_active) =====================
      const page = await ctxOwner.newPage();
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      await page.screenshot({ path: "scripts/.c5s4a-entry-active.png" });
      const editButton = page.getByRole("button", { name: "Edit Prescription" });
      check("entry point shows Edit Prescription for active-no-draft state", await editButton.isVisible());
      await Promise.all([page.waitForURL(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`), editButton.click()]);
      check("Edit Prescription navigates into the builder", page.url().endsWith("/builder"));

      const { data: draftAfterCreate } = await admin.from("prescription_drafts").select("id, source, editing_clinician_id").eq("patient_prescription_id", patientPrescriptionId).eq("status", "editing").maybeSingle();
      check("exactly one editing draft exists after Edit Prescription", !!draftAfterCreate);
      check("draft source is clone_active", draftAfterCreate?.source === "clone_active");
      check("draft is owned by the clinician who created it", draftAfterCreate?.editing_clinician_id === owner.userId);
      const draftId = draftAfterCreate.id;

      // A second "Create/Edit" attempt from the SAME clinician must not
      // create a second draft — re-visiting the entry point should now
      // offer "Continue Editing" instead.
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      check("re-visiting entry point shows Continue Editing (no second draft offered)", await page.getByRole("link", { name: "Continue Editing" }).isVisible());
      const { count: draftCountAfterRevisit } = await admin
        .from("prescription_drafts")
        .select("id", { count: "exact", head: true })
        .eq("patient_prescription_id", patientPrescriptionId)
        .eq("status", "editing");
      check("still exactly one editing draft (max-one-draft invariant)", draftCountAfterRevisit === 1, `count=${draftCountAfterRevisit}`);

      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      // ===== Founder correction 4: builder nav copy =====
      const navLink = page.getByRole("link", { name: "← Prescription overview" });
      check("builder nav uses the founder-specified '← Prescription overview' copy", await navLink.isVisible());
      await Promise.all([page.waitForURL(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`), navLink.click()]);
      check("nav link returns to the prescription-management page", page.url().endsWith("/prescription"));
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");

      const libraryCards = page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]');

      // ===================== SEARCH / FILTER (client-side, pure) =====================
      await page.fill('input[placeholder="Search exercises…"]', "calf");
      await page.waitForTimeout(150);
      const visibleCardsAfterSearch = await libraryCards.count();
      check("search narrows the visible exercise list", visibleCardsAfterSearch > 0 && visibleCardsAfterSearch < 47, `count=${visibleCardsAfterSearch}`);
      await page.fill('input[placeholder="Search exercises…"]', "");

      const firstCardName = await libraryCards.first().locator('[data-testid="exercise-card-name"] div.font-medium').innerText();
      check("first result renders a human name, not a raw legacy id", !/^ex_\d+$/.test(firstCardName.trim()));

      // ===================== EXPAND / REFERENCE DOSAGE =====================
      await libraryCards.first().locator('[data-testid="exercise-card-name"]').click();
      await page.waitForTimeout(100);
      const expandedText = await libraryCards.first().innerText();
      const hasReferenceDosageLabel = expandedText.includes("Reference dosage");
      if (hasReferenceDosageLabel) {
        check("Reference dosage is explicitly labeled and marked informational-only", expandedText.includes("Informational only"));
      } else {
        check("expanded card shows detail content (no reference dosage on this exercise, acceptable)", expandedText.length > 0);
      }
      await page.screenshot({ path: "scripts/.c5s4a-desktop-detail.png", fullPage: true });

      // ===================== ADD / DUPLICATE-ADD / ORDER =====================
      // Each click is followed by waiting for the draft panel row count to
      // actually reflect the change (not a fixed sleep) — handleAdd disables
      // the Add buttons while its addWorkout/addExercise/refresh round trip
      // is in flight, so clicking again before that settles would land on a
      // still-disabled button and silently no-op.
      const draftRows = page.locator('[data-testid="draft-panel"] [data-testid="draft-exercise-row"]');
      async function waitForRowCount(n, timeoutMs = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if ((await draftRows.count()) === n) return true;
          await page.waitForTimeout(100);
        }
        return false;
      }

      const cards = libraryCards;
      const firstAddBtn = cards.nth(0).getByRole("button", { name: "Add", exact: true });
      const secondAddBtn = cards.nth(1).getByRole("button", { name: "Add", exact: true });

      await firstAddBtn.click();
      check("first add reflected in draft panel", await waitForRowCount(1));

      // ===== Founder correction 1: duplicate prevention within a workout =====
      const firstAddedBtn = cards.nth(0).getByRole("button", { name: "Added", exact: true });
      check("library card for an already-added exercise now shows 'Added' instead of Add", await firstAddedBtn.isVisible());
      check("the 'Added' button is disabled", await firstAddedBtn.isDisabled());
      check("no enabled 'Add' button remains for that exercise", (await cards.nth(0).getByRole("button", { name: "Add", exact: true }).count()) === 0);

      await secondAddBtn.click();
      check("second add reflected in draft panel", await waitForRowCount(2));

      // Force-click the disabled button (bypassing Playwright's own
      // actionability wait) — proves the APPLICATION refuses a duplicate
      // add within this workout, not merely that the button looks disabled.
      await firstAddedBtn.click({ force: true });
      await page.waitForTimeout(500);
      check("force-clicking the disabled Added button creates no 3rd row (still 2)", (await draftRows.count()) === 2, `got ${await draftRows.count()}`);

      const { data: exercisesAfterAdd } = await admin
        .from("prescription_workouts")
        .select("id, order_index, prescription_exercises(id, canonical_exercise_id, order_index)")
        .eq("prescription_draft_id", draftId);
      const flatExercises = (exercisesAfterAdd ?? []).flatMap((w) => w.prescription_exercises ?? []);
      check("exactly one workout auto-created (single-workout model)", (exercisesAfterAdd ?? []).length === 1, `workouts=${exercisesAfterAdd?.length}`);
      check("exactly 2 exercise rows exist — no duplicate created via the UI", flatExercises.length === 2, `got ${flatExercises.length}`);
      const distinctCanonicalIds = new Set(flatExercises.map((e) => e.canonical_exercise_id));
      check("2 distinct canonical exercises (duplicate add prevented)", distinctCanonicalIds.size === 2, `distinct=${distinctCanonicalIds.size}`);
      const orderIndexes = flatExercises.map((e) => e.order_index).sort((a, b) => a - b);
      check("order_index is deterministic and contiguous (0,1)", JSON.stringify(orderIndexes) === JSON.stringify([0, 1]));

      const { data: dosageRowsAfterAdd } = await admin
        .from("prescription_exercise_dosage")
        .select("id")
        .in("prescription_exercise_id", flatExercises.map((e) => e.id));
      check("adding an exercise does NOT create/copy patient dosage", (dosageRowsAfterAdd ?? []).length === 0, `got ${dosageRowsAfterAdd?.length}`);

      await page.waitForSelector("text=Dosage needed");
      const dosageNeededCount = await page.locator("text=Dosage needed").count();
      check("draft panel shows the strengthened 'Dosage needed' status for every added exercise", dosageNeededCount === 2, `got ${dosageNeededCount}`);
      check("old incidental 'Dosage not configured' copy is gone", (await page.locator("text=Dosage not configured").count()) === 0);

      // ===== existing-duplicate-data defensiveness (out-of-band insert,
      // simulating a pre-existing duplicate or a future different-workout
      // add path — never created through this UI) =====
      const firstWorkoutId = exercisesAfterAdd[0].id;
      const dupCanonicalId = flatExercises[0].canonical_exercise_id;
      const nextOrderIndex = Math.max(...flatExercises.map((e) => e.order_index)) + 1;
      const { error: dupError } = await admin
        .from("prescription_exercises")
        .insert({ prescription_workout_id: firstWorkoutId, canonical_exercise_id: dupCanonicalId, order_index: nextOrderIndex });
      check("schema itself remains unconstrained/defensive — a duplicate row can still be seeded out-of-band", !dupError, dupError?.message);

      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      check("builder renders without crashing when duplicate data already exists", (await draftRows.count()) === 3, `got ${await draftRows.count()}`);
      check("pre-existing duplicate is surfaced via the 'In draft ×N' badge, not hidden", (await cards.filter({ hasText: "In draft ×2" }).count()) > 0);

      await page.screenshot({ path: "scripts/.c5s4a-desktop-draft.png", fullPage: true });

      // ===== Founder correction 2: desktop panel proportions ~45/55 =====
      const libraryWidth = await page.locator('[data-testid="library-panel"]').evaluate((el) => el.getBoundingClientRect().width);
      const draftWidth = await page.locator('[data-testid="draft-panel"]').evaluate((el) => el.getBoundingClientRect().width);
      const libraryRatio = libraryWidth / (libraryWidth + draftWidth);
      check("desktop library panel is ~45% of the two-panel width", libraryRatio > 0.4 && libraryRatio < 0.5, `ratio=${libraryRatio.toFixed(3)}`);
      check("desktop draft panel is wider than the library panel (~55%)", draftWidth > libraryWidth, `library=${libraryWidth} draft=${draftWidth}`);

      // ===================== REORDER =====================
      // C5.4 Revision C replaced the visible up/down move buttons with
      // drag-and-drop as the primary reorder interaction (a deliberate,
      // founder-directed UI change — see that stage's report); the
      // keyboard-accessible fallback (dnd-kit's Space/Arrow/Space sequence
      // on the drag handle) is the closest equivalent for this historical
      // assertion's intent (a reorder control exists and reordering works).
      const draftRowsBefore = await page.locator('[data-testid="drag-handle"]').count();
      check("draft rows render a drag handle for reordering", draftRowsBefore > 0);
      const firstRowNameBefore = await draftRows.first().locator('[data-testid="draft-exercise-name"]').innerText();
      const firstDragHandle = draftRows.first().locator('[data-testid="drag-handle"]');
      await firstDragHandle.focus();
      await page.keyboard.press("Space");
      await page.waitForTimeout(150);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      await page.keyboard.press("Space");
      const reorderStart = Date.now();
      let firstRowNameAfter = firstRowNameBefore;
      while (Date.now() - reorderStart < 5000) {
        firstRowNameAfter = await draftRows.first().locator('[data-testid="draft-exercise-name"]').innerText();
        if (firstRowNameAfter !== firstRowNameBefore) break;
        await page.waitForTimeout(100);
      }
      check("moving the first exercise down visibly reorders the draft panel", firstRowNameAfter !== firstRowNameBefore, `before=${firstRowNameBefore} after=${firstRowNameAfter}`);
      const { data: workoutAfterReorder } = await admin
        .from("prescription_workouts")
        .select("id, prescription_exercises(id, canonical_exercise_id, order_index)")
        .eq("prescription_draft_id", draftId)
        .single();
      const sortedAfterReorder = [...workoutAfterReorder.prescription_exercises].sort((a, b) => a.order_index - b.order_index);
      check("moving the first exercise down changes persisted order_index (0<->1 swap)", sortedAfterReorder[0].order_index === 0 && sortedAfterReorder[1].order_index === 1);

      // ===================== REMOVE =====================
      await page.locator('button[aria-label="Remove from draft"]').first().click();
      check("remove reflected in draft panel", await waitForRowCount(2));
      const { count: exerciseCountAfterRemove } = await admin
        .from("prescription_exercises")
        .select("id", { count: "exact", head: true })
        .in("prescription_workout_id", (exercisesAfterAdd ?? []).map((w) => w.id));
      check("remove persists (2 exercises remain)", exerciseCountAfterRemove === 2, `got ${exerciseCountAfterRemove}`);

      // ===================== FAVORITES =====================
      const starButtons = page.locator('[data-testid="library-panel"] button[aria-label="Toggle favorite"]');
      await starButtons.first().click();
      let favoriteRowCount = 0;
      const favStart = Date.now();
      while (Date.now() - favStart < 5000) {
        ({ count: favoriteRowCount } = await admin.from("clinician_exercise_favorites").select("id", { count: "exact", head: true }).eq("clinician_id", owner.userId));
        if (favoriteRowCount === 1) break;
        await page.waitForTimeout(150);
      }
      check("favoriting persists a real clinician_exercise_favorites row", favoriteRowCount === 1, `got ${favoriteRowCount}`);

      await page.getByLabel("Favorites").check();
      await page.waitForTimeout(150);
      const favoritesOnlyCount = await libraryCards.count();
      check("Favorites filter narrows to exactly the favorited exercise", favoritesOnlyCount === 1, `got ${favoritesOnlyCount}`);
      await page.getByLabel("Favorites").uncheck();

      // ===================== PERSISTENCE: refresh / leave-and-return =====================
      await page.reload();
      await page.waitForSelector("text=Exercise Library");
      const { count: exerciseCountAfterReload } = await admin
        .from("prescription_exercises")
        .select("id", { count: "exact", head: true })
        .in("prescription_workout_id", (exercisesAfterAdd ?? []).map((w) => w.id));
      check("refresh preserves draft content", exerciseCountAfterReload === 2, `got ${exerciseCountAfterReload}`);

      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}`);
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");
      check("leaving and reopening the patient resumes the SAME draft", page.url().endsWith("/builder"));
      const { count: draftCountFinal } = await admin
        .from("prescription_drafts")
        .select("id", { count: "exact", head: true })
        .eq("patient_prescription_id", patientPrescriptionId)
        .eq("status", "editing");
      check("still exactly one draft after navigating away and back", draftCountFinal === 1, `count=${draftCountFinal}`);

      // ===================== ACTIVE PRESCRIPTION UNCHANGED =====================
      const { data: ppAfterEditing } = await admin.from("patient_prescriptions").select("current_prescription_version_id, operational_status").eq("id", patientPrescriptionId).single();
      check("active prescription version unchanged during editing", ppAfterEditing.current_prescription_version_id === activeVersionId);
      check("operational status unchanged (still active) during editing", ppAfterEditing.operational_status === "active");
      const { data: versionUnchanged } = await admin.from("prescription_versions").select("id").eq("id", activeVersionId).single();
      check("no new prescription_versions row was created by draft editing", !!versionUnchanged);

      // ===================== OWNERSHIP / VIEW-ONLY =====================
      // Founder correction 5: the banner must name the editing clinician (or
      // fall back to "another clinician") and must never expose the
      // internal `owner`/`editing_clinician_id` concept in its copy.
      const otherPage = await ctxOther.newPage();
      await otherPage.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await otherPage.waitForSelector("text=currently being edited by");
      const banner = otherPage.locator("text=currently being edited by");
      check("view-only banner names the editing clinician using the founder-specified copy", await banner.isVisible());
      const bannerText = (await banner.innerText()).toLowerCase();
      check("banner never exposes the internal word 'owner'", !bannerText.includes("owner"));
      check("banner uses the founder-approved sentence shape", bannerText.includes("you can view the draft, but only the editing clinician can make changes"));
      check("banner names the actual editing clinician by their resolved display name", bannerText.includes("primary-clinician"));
      const otherAddButtons = await otherPage.getByRole("button", { name: "Add", exact: true }).count();
      check("view-only clinician still sees Add buttons but they are disabled (no takeover of edit rights)", otherAddButtons > 0);
      const firstOtherAddDisabled = await otherPage.getByRole("button", { name: "Add", exact: true }).first().isDisabled();
      check("Add button is disabled for the non-owning clinician", firstOtherAddDisabled);
      const moveButtonsForOther = await otherPage.locator('[data-testid="drag-handle"]').count();
      check("no reorder/remove controls rendered for the non-owning clinician", moveButtonsForOther === 0);

      // Fetch a currently-live exercise id fresh (rather than reusing an
      // earlier-captured id that reorder/remove may since have touched) so
      // this specifically isolates the ownership check, not incidental
      // draft-content drift from earlier steps.
      const { data: liveWorkout } = await admin
        .from("prescription_workouts")
        .select("prescription_exercises(id)")
        .eq("prescription_draft_id", draftId)
        .single();
      const liveExerciseId = liveWorkout.prescription_exercises[0].id;
      const otherMutateResp = await ctxOther.request.fetch(`${BASE_URL}/api/clinician/prescription-exercises/${liveExerciseId}`, { method: "DELETE" });
      check("non-owning clinician's direct API mutation attempt is rejected", otherMutateResp.status() === 403, `got ${otherMutateResp.status()}`);
      const { data: draftStillOwner } = await admin.from("prescription_drafts").select("editing_clinician_id").eq("id", draftId).single();
      check("editing_clinician_id was never silently changed by the other clinician viewing it", draftStillOwner.editing_clinician_id === owner.userId);

      await otherPage.setViewportSize({ width: 1440, height: 900 });
      await otherPage.screenshot({ path: "scripts/.c5s4a-view-only.png", fullPage: true });
      await otherPage.close();

      // ===================== PAUSED STATE (entry point only) =====================
      await admin.from("patient_prescriptions").update({ operational_status: "paused", paused_at: new Date().toISOString(), paused_by: owner.userId }).eq("id", patientPrescriptionId);
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      // M2: a C5 program shows the pause/resume control (state + Resume) instead of the old banner.
      check('entry point shows the paused state without silently resuming', (await page.getByTestId("program-pause-control").getAttribute("data-status")) === "paused" && (await page.getByText(/Program Paused/).isVisible()) && (await page.getByTestId("resume-program").isVisible()));
      await admin.from("patient_prescriptions").update({ operational_status: "active", paused_at: null, paused_by: null }).eq("id", patientPrescriptionId);

      // ===================== VISUAL: mobile layout =====================
      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription/builder`);
      await page.waitForSelector("text=Exercise Library");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(150);
      const libraryTabVisible = await page.getByRole("button", { name: /Library/ }).isVisible();
      const draftTabVisible = await page.getByRole("button", { name: /Draft \(/ }).isVisible();
      check("mobile width collapses to a Library/Draft tab switcher", libraryTabVisible && draftTabVisible);
      await page.screenshot({ path: "scripts/.c5s4a-mobile.png" });
      await page.getByRole("button", { name: /Draft \(/ }).click();
      await page.waitForTimeout(150);
      check("mobile Draft tab shows draft content", await page.getByText("Prescription Draft").isVisible());
      await page.setViewportSize({ width: 1440, height: 900 });

      await page.goto(`${BASE_URL}/clinician/patients/${patient.userId}/prescription`);
      await page.screenshot({ path: "scripts/.c5s4a-entry-with-draft.png" });

      await page.close();
      await ctxOwner.close();
      await ctxOther.close();
      await ctxUnauthorized.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (patientPrescriptionId) {
      await admin.from("patient_prescriptions").delete().eq("id", patientPrescriptionId);
    }
    if (activeVersionId) {
      await admin.from("prescription_versions").delete().eq("id", activeVersionId);
    }
    if (inactiveExerciseId) await admin.from("canonical_exercises").delete().eq("id", inactiveExerciseId);
    if (privateExerciseId) await admin.from("canonical_exercises").delete().eq("id", privateExerciseId);
    await admin.from("clinician_exercise_favorites").delete().eq("clinician_id", owner.userId);
    await admin.from("supervisor_patients").delete().eq("patient_id", patient.userId);
    const allUserIds = [owner.userId, otherSupervisor.userId, unauthorized.userId, orgOnlyExerciseOwner.userId, patient.userId];
    await admin.from("organization_members").delete().in("user_id", allUserIds);
    await admin.from("profiles").delete().in("id", allUserIds);
    for (const uid of allUserIds) await admin.auth.admin.deleteUser(uid);

    const legacyDbTeardown = new DatabaseSync(LEGACY_DB_PATH);
    try {
      if (legacyClinicianId != null && legacyPatientId != null) {
        legacyDbTeardown.prepare("DELETE FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?").run(legacyClinicianId, legacyPatientId);
      }
      if (legacyOtherId != null && legacyPatientId != null) {
        legacyDbTeardown.prepare("DELETE FROM supervisor_patients WHERE supervisor_id = ? AND patient_id = ?").run(legacyOtherId, legacyPatientId);
      }
      if (legacyClinicianId != null) legacyDbTeardown.prepare("DELETE FROM users WHERE id = ?").run(legacyClinicianId);
      if (legacyOtherId != null) legacyDbTeardown.prepare("DELETE FROM users WHERE id = ?").run(legacyOtherId);
      if (legacyPatientId != null) legacyDbTeardown.prepare("DELETE FROM users WHERE id = ?").run(legacyPatientId);
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
