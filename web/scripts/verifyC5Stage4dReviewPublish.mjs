// C5.4D — Prescription Review → Validation → Publish. Live end-to-end
// verification over real authenticated HTTP + Playwright, using entirely
// throwaway fixture users and patients (never real clinical data). Mirrors
// the C5.3/C5.4 verification conventions (makeUser/addOrgMember/loginContext,
// throwaway legacy SQLite supervisor rows for the high-consequence check,
// full teardown in `finally`). Real canonical exercises are read only; the
// one private exercise created for the inaccessible-exercise case is a
// throwaway row deleted in teardown.
//
// Two servers, because the publish gate is an environment variable read by
// the server process and must never be weakened to make a test pass:
//   GATE_OFF_URL (default http://localhost:3000) — C5_PRESCRIPTION_PUBLISH_ENABLED
//     unset (the default-safe configuration). Review rendering + gate-disabled.
//   GATE_ON_URL  (default http://localhost:3001) — the same build started
//     with C5_PRESCRIPTION_PUBLISH_ENABLED=true, e.g.
//       C5_PRESCRIPTION_PUBLISH_ENABLED=true npx next start -p 3001
// The script probes both and refuses to run if either gate state is wrong.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage4dReviewPublish.mjs [gateOffUrl] [gateOnUrl] [screenshotDir]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const OFF = process.argv[2] ?? "http://localhost:3000";
const ON = process.argv[3] ?? "http://localhost:3001";
const SHOTS = process.argv[4] ?? null;
const LEGACY_DB_PATH = "../app/tenotrainer.db";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
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
function section(title) {
  console.log(`\n--- ${title} ---`);
}

const createdUsers = [];
const legacyUserIds = [];
const legacyLinkIds = [];
const createdExerciseIds = [];

async function makeUser(label) {
  const email = `c54d-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  createdUsers.push(userId);
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, name: label });
  if (profileError) throw profileError;
  return { userId, email, label };
}
async function addOrgMember(userId, role) {
  const { error } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  if (error) throw error;
}
function legacyDb() {
  return new DatabaseSync(LEGACY_DB_PATH);
}
function legacyUser(db, user, role) {
  const id = db.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)").run(`c54d-${user.label}`, user.email, role, user.userId).lastInsertRowid;
  legacyUserIds.push(id);
  return id;
}
function legacyLink(db, supervisorLegacyId, patientLegacyId) {
  const id = db.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')").run(supervisorLegacyId, patientLegacyId).lastInsertRowid;
  legacyLinkIds.push(id);
  return id;
}
async function supervise(clinician, patient) {
  const { error } = await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: patient.userId, status: "active" });
  if (error) throw error;
}
async function seedClinicalState(patient) {
  const { error } = await admin.from("prescription_versions").insert({ user_id: patient.userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" });
  if (error) throw error;
}
async function loginContext(browser, email, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${ON}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.close();
  return context;
}
async function waitFor(fn, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
// Grows the viewport to the page height instead of using fullPage capture,
// so the sticky action bar renders where a user actually sees it (bottom).
// `viewportOnly` keeps the real viewport (for overlays like the dialog).
async function shot(page, name, { viewportOnly = false } = {}) {
  if (!SHOTS) return;
  const original = page.viewportSize();
  if (!viewportOnly) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: original.width, height: Math.max(height, original.height) });
  }
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  if (!viewportOnly) await page.setViewportSize(original);
}

// ---- API helpers (always as a logged-in browser context) ----
async function api(ctx, method, url, data) {
  const res = await ctx.request.fetch(url, { method, data, failOnStatusCode: false });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status(), body };
}
async function must(ctx, method, url, data) {
  const r = await api(ctx, method, url, data);
  if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// Builds a draft entirely through the real C5.3/C5.4 API routes.
async function buildDraft(ctx, patient, spec) {
  const { draftId } = await must(ctx, "POST", `${ON}/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: spec.source ?? "empty", sourceVersionId: spec.sourceVersionId });
  await must(ctx, "PATCH", `${ON}/api/clinician/prescription-drafts/${draftId}`, {
    schedulingMode: spec.mode,
    targetSessionsPerWeek: spec.target ?? null,
    phase: spec.phase ?? null,
    performanceFocuses: spec.focuses ?? [],
  });
  const workouts = [];
  for (const [wi, w] of spec.workouts.entries()) {
    const { workoutId } = await must(ctx, "POST", `${ON}/api/clinician/prescription-drafts/${draftId}/workouts`, { label: w.label, orderIndex: wi, daysOfWeek: w.days ?? null });
    const exercises = [];
    for (const [ei, e] of w.exercises.entries()) {
      const { exerciseId } = await must(ctx, "POST", `${ON}/api/clinician/prescription-workouts/${workoutId}/exercises`, {
        canonicalExerciseId: e.ex.id,
        orderIndex: ei,
        additionalInstructions: e.instructions ?? null,
      });
      if (e.dosage) await must(ctx, "PUT", `${ON}/api/clinician/prescription-exercises/${exerciseId}/dosage`, { dosage: { dosageType: "repetition", ...e.dosage } });
      exercises.push(exerciseId);
    }
    workouts.push({ workoutId, exercises });
  }
  return { draftId, workouts };
}

// Deterministic DB snapshot of a draft's or version's full content.
async function contentSnapshot(kind, id) {
  const ownerCol = kind === "draft" ? "prescription_draft_id" : "prescription_version_id";
  const header =
    kind === "draft"
      ? (await admin.from("prescription_drafts").select("*").eq("id", id).single()).data
      : (await admin.from("prescription_versions").select("*").eq("id", id).single()).data;
  const { data: ws } = await admin.from("prescription_workouts").select("*, prescription_exercises(*, prescription_exercise_dosage(*))").eq(ownerCol, id);
  const focusTable = kind === "draft" ? "prescription_draft_performance_focus" : "prescription_version_performance_focus";
  const focusCol = kind === "draft" ? "prescription_draft_id" : "prescription_version_id";
  const { data: focuses } = await admin.from(focusTable).select("focus").eq(focusCol, id);
  const workouts = (ws ?? [])
    .sort((a, b) => a.order_index - b.order_index)
    .map((w) => ({ ...w, prescription_exercises: (w.prescription_exercises ?? []).sort((a, b) => a.order_index - b.order_index) }));
  return JSON.stringify({ header, workouts, focuses: (focuses ?? []).map((f) => f.focus).sort() });
}
// Content only (no ids/timestamps/owner columns) for draft-vs-version equality.
async function portableContent(kind, id) {
  const raw = JSON.parse(await contentSnapshot(kind, id));
  const strip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  return JSON.stringify({
    phase: raw.header.phase,
    mode: raw.header.scheduling_mode,
    target: raw.header.target_sessions_per_week,
    focuses: raw.focuses,
    workouts: raw.workouts.map((w) => ({
      ...strip(w, ["id", "prescription_draft_id", "prescription_version_id", "created_at", "updated_at", "prescription_exercises"]),
      exercises: w.prescription_exercises.map((e) => {
        const d = Array.isArray(e.prescription_exercise_dosage) ? e.prescription_exercise_dosage[0] : e.prescription_exercise_dosage;
        return {
          ...strip(e, ["id", "prescription_workout_id", "created_at", "updated_at", "prescription_exercise_dosage"]),
          dosage: d ? strip(d, ["id", "prescription_exercise_id", "created_at", "updated_at"]) : null,
        };
      }),
    })),
  });
}
async function c5Versions(patient) {
  const { data: pp } = await admin.from("patient_prescriptions").select("id, current_prescription_version_id").eq("patient_id", patient.userId).maybeSingle();
  if (!pp) return { pp: null, versions: [] };
  const { data } = await admin.from("prescription_versions").select("id, version_number").eq("patient_prescription_id", pp.id).order("version_number");
  return { pp, versions: data ?? [] };
}
async function draftStatus(draftId) {
  const { data } = await admin.from("prescription_drafts").select("status").eq("id", draftId).single();
  return data.status;
}

// Reads the rendered program back out of the page.
async function readProgram(page) {
  return page.locator('[data-testid="program-workout"]').evaluateAll((els) =>
    els.map((w) => ({
      label: w.getAttribute("data-workout-label"),
      days: Array.from(w.querySelectorAll('[data-testid="workout-days"] span')).map((s) => s.textContent.trim()),
      exercises: Array.from(w.querySelectorAll('[data-testid="program-exercise"]')).map((e) => ({
        name: e.getAttribute("data-exercise-name"),
        headline: e.querySelector('[data-testid="dosage-headline"]')?.textContent.trim() ?? null,
        details: Array.from(e.querySelectorAll('[data-testid="dosage-detail"]')).map((x) => x.textContent.trim()),
        modifiers: Array.from(e.querySelectorAll('[data-testid="dosage-modifier"]')).map((x) => x.textContent.trim()),
        instructions: e.querySelector('[data-testid="program-instructions"]')?.textContent.trim() ?? null,
        missing: !!e.querySelector('[data-testid="dosage-missing"]'),
        hasDosage: !!e.querySelector('[data-testid="program-dosage"]'),
      })),
    }))
  );
}
async function issueRules(page) {
  return page.locator('[data-testid="validation-issue"]').evaluateAll((els) =>
    els.map((el) => ({
      rule: el.getAttribute("data-rule"),
      context: el.querySelector('[data-testid="issue-context"]')?.textContent.trim() ?? null,
      message: el.querySelector('[data-testid="issue-message"]')?.textContent.trim() ?? null,
      href: el.querySelector('[data-testid="issue-action"]')?.getAttribute("href") ?? null,
      kind: el.querySelector('[data-testid="issue-action"]')?.getAttribute("data-action-kind") ?? null,
    }))
  );
}
async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}
async function openReview(ctx, base, patient) {
  const page = await ctx.newPage();
  const resp = await page.goto(`${base}/clinician/patients/${patient.userId}/prescription/review`);
  await page.waitForLoadState("networkidle");
  return { page, status: resp.status() };
}
async function confirmPublish(page, { dblclick = false } = {}) {
  await page.click('[data-testid="publish-prescription"]');
  await page.waitForSelector('[data-testid="publish-dialog"]');
  if (dblclick) await page.dblclick('[data-testid="publish-confirm"]');
  else await page.click('[data-testid="publish-confirm"]');
}
async function waitOutcome(page) {
  await page.waitForSelector('[data-testid="publish-success"], [data-testid="publish-error"], [data-testid="publish-unconfirmed"]', { timeout: 20000 });
}

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  // ---- canonical exercises (read-only) ----
  const { data: lib } = await admin.from("canonical_exercises").select("id, name").eq("active", true).eq("visibility", "global").order("name");
  const { data: refRows } = await admin.from("exercise_reference_dosage").select("exercise_id");
  const refIds = new Set((refRows ?? []).map((r) => r.exercise_id));
  const withRef = lib.find((e) => refIds.has(e.id));
  const plain = lib.filter((e) => e.id !== withRef.id);
  const E = plain.slice(0, 10);
  if (E.length < 10 || !withRef) throw new Error("not enough canonical exercises for fixtures");

  // ---- fixture users ----
  const A = await makeUser("owner");
  const B = await makeUser("viewonly");
  const C = await makeUser("unrelated");
  const P = {};
  for (const k of ["p1", "p2", "p3", "p4", "p5", "p6"]) P[k] = await makeUser(k);

  const db = legacyDb();
  let legacyLinkA5 = null;
  let legacyA = null;
  let legacyP5 = null;
  try {
    legacyA = legacyUser(db, A, "supervisor");
    const legacyB = legacyUser(db, B, "supervisor");
    legacyUser(db, C, "supervisor");
    for (const k of Object.keys(P)) {
      const lp = legacyUser(db, P[k], "patient");
      const link = legacyLink(db, legacyA, lp);
      if (k === "p5") {
        legacyLinkA5 = link;
        legacyP5 = lp;
      }
      if (k === "p1") legacyLink(db, legacyB, lp);
    }
  } finally {
    db.close();
  }
  for (const u of [A, B, C]) await addOrgMember(u.userId, "clinician");
  for (const k of Object.keys(P)) {
    await addOrgMember(P[k].userId, "member");
    await supervise(A, P[k]);
  }
  await supervise(B, P.p1);
  for (const k of ["p1", "p2", "p4", "p5", "p6"]) await seedClinicalState(P[k]);

  const browser = await chromium.launch();
  try {
    const ctxA = await loginContext(browser, A.email);
    const ctxB = await loginContext(browser, B.email);
    const ctxC = await loginContext(browser, C.email);
    const ctxAMobile = await loginContext(browser, A.email, MOBILE);

    section("Environment gate probes");
    const probeOff = await api(ctxA, "POST", `${OFF}/api/clinician/prescription-drafts/${randomUUID()}/publish`);
    const probeOn = await api(ctxA, "POST", `${ON}/api/clinician/prescription-drafts/${randomUUID()}/publish`);
    check("gate-off server refuses publish before anything else (403 PUBLISH_DISABLED)", probeOff.status === 403 && probeOff.body?.error === "PUBLISH_DISABLED", JSON.stringify(probeOff));
    check("gate-on server passes the gate (unknown draft -> 404 DRAFT_NOT_FOUND)", probeOn.status === 404 && probeOn.body?.error === "DRAFT_NOT_FOUND", JSON.stringify(probeOn));
    if (probeOff.body?.error !== "PUBLISH_DISABLED" || probeOn.body?.error !== "DRAFT_NOT_FOUND") throw new Error("gate configuration not as required — aborting");

    // =====================================================================
    section("REVIEW — no draft (Review never creates one)");
    {
      const { page } = await openReview(ctxA, OFF, P.p6);
      check("no-draft state rendered", await page.locator('[data-testid="review-no-draft"]').isVisible());
      const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", P.p6.userId).maybeSingle();
      check("opening Review created no patient_prescriptions row / draft", pp === null);
      await page.close();
    }

    // =====================================================================
    section("REVIEW — valid Sequence prescription, every dosage dimension");
    const p1Spec = {
      mode: "sequence",
      target: 3,
      phase: "middle",
      focuses: ["energy_storage", "strength_development"],
      workouts: [
        {
          label: "Strength",
          exercises: [
            { ex: E[0], dosage: { sets: 4, repsMode: "exact", repsExact: 8, loadType: "external", loadMode: "exact", loadValueExact: 45, loadUnit: "lb", eccentricDurationSeconds: 3, rpe: 7 }, instructions: "Keep heel directly under knee." },
            { ex: E[1], dosage: { sets: 3, repsMode: "range", repsMin: 8, repsMax: 12, loadType: "bodyweight", concentricDurationSeconds: 2, repHoldDurationSeconds: 1, restSeconds: 90, side: "left", rom: "Full range" } },
            { ex: E[2], dosage: { sets: 3, contactsMode: "exact", contactsExact: 20, loadType: "not_applicable" }, instructions: "Quick contacts, stay tall." },
          ],
        },
        {
          label: "Capacity",
          exercises: [
            { ex: E[3], dosage: { sets: 3, holdDurationMode: "range", holdDurationMinSeconds: 30, holdDurationMaxSeconds: 45, loadType: "external", loadMode: "range", loadValueMin: 20, loadValueMax: 25, loadUnit: "kg", rir: 2, assistanceLevel: "minimal" } },
            { ex: E[4], dosage: { sets: 2, distanceMode: "exact", distanceExactValue: 400, distanceUnit: "m", loadType: "not_applicable", restSeconds: 120 } },
            { ex: E[5], dosage: { timeDurationMode: "exact", timeDurationExactSeconds: 600, intervalWorkSeconds: 30, intervalRecoverySeconds: 30, intervalRounds: 8, loadType: "assisted", tempoDescription: "slow and controlled" } },
          ],
        },
      ],
    };
    const p1 = await buildDraft(ctxA, P.p1, p1Spec);
    const p1Before = await contentSnapshot("draft", p1.draftId);
    let p1ReviewProgram;
    {
      const { page } = await openReview(ctxA, OFF, P.p1);
      check("title + subtitle", (await page.locator("h1").textContent()) === "Prescription Review" && (await page.textContent("main")).includes("Review the complete program before publishing it."));
      check("Ready to publish ✓ shown", (await page.locator('[data-testid="validation-ready"]').textContent()).includes("Ready to publish ✓"));
      check("summary: phase Middle", (await page.locator('[data-testid="summary-phase"]').textContent()).includes("Middle"));
      const focusText = await page.locator('[data-testid="summary-focus"]').textContent();
      check("summary: both performance focuses, fixed order", focusText.indexOf("Strength Development") < focusText.indexOf("Energy Storage") && focusText.includes("Energy Storage"), focusText);
      check("summary: Sequence, 2 workouts, 6 exercises",
        (await page.locator('[data-testid="summary-schedule-mode"]').textContent()).includes("Sequence") &&
          (await page.locator('[data-testid="summary-workout-count"]').textContent()).includes("2") &&
          (await page.locator('[data-testid="summary-exercise-count"]').textContent()).includes("6"));
      const seqText = await page.locator('[data-testid="schedule-sequence"]').textContent();
      check("Sequence shows target sessions/week and order, no weekdays", seqText.includes("3 sessions per week") && seqText.includes("A → B") && seqText.includes("Not tied to specific weekdays"), seqText);
      check("Sequence renders no calendar/weekday elements", (await page.locator('[data-testid="calendar-day"], [data-testid="workout-days"]').count()) === 0);
      const prog = await readProgram(page);
      p1ReviewProgram = prog;
      check("workouts in A/B order with labels", prog.map((w) => w.label).join("|") === "Strength|Capacity", JSON.stringify(prog.map((w) => w.label)));
      check("exercise order preserved", prog.flatMap((w) => w.exercises.map((e) => e.name)).join("|") === E.slice(0, 6).map((e) => e.name).join("|"));
      const [w0, w1] = prog;
      const x = (w, i) => w.exercises[i];
      check("exact reps + external lb load: 4 × 8 · 45 lb", x(w0, 0).headline === "4 × 8" && x(w0, 0).details.includes("45 lb"), JSON.stringify(x(w0, 0)));
      check("eccentric tempo + RPE: '3 sec lowering', 'RPE 7'", x(w0, 0).modifiers.includes("3 sec lowering") && x(w0, 0).modifiers.includes("RPE 7"), JSON.stringify(x(w0, 0).modifiers));
      check("instructions shown", x(w0, 0).instructions === "Keep heel directly under knee.");
      check("rep range + bodyweight + rest: 3 × 8–12 · Bodyweight · Rest 1 min 30 sec", x(w0, 1).headline === "3 × 8–12" && x(w0, 1).details.includes("Bodyweight") && x(w0, 1).details.includes("Rest 1 min 30 sec"), JSON.stringify(x(w0, 1)));
      check("concentric/pause tempo, side, ROM", ["2 sec lifting", "1 sec pause", "Left side", "ROM: Full range"].every((m) => x(w0, 1).modifiers.includes(m)), JSON.stringify(x(w0, 1).modifiers));
      check("contacts: 3 × 20 contacts, no load shown for N/A", x(w0, 2).headline === "3 × 20 contacts" && x(w0, 2).details.length === 0, JSON.stringify(x(w0, 2)));
      check("hold range + kg load range: 3 × 30–45 sec hold · 20–25 kg", x(w1, 0).headline === "3 × 30–45 sec hold" && x(w1, 0).details.includes("20–25 kg"), JSON.stringify(x(w1, 0)));
      check("RIR + assistance", x(w1, 0).modifiers.includes("RIR 2") && x(w1, 0).modifiers.includes("Minimal assistance"), JSON.stringify(x(w1, 0).modifiers));
      check("distance: 2 × 400 m · Rest 2 min", x(w1, 1).headline === "2 × 400 m" && x(w1, 1).details.includes("Rest 2 min"), JSON.stringify(x(w1, 1)));
      check("total duration + interval + assisted + tempo description",
        x(w1, 2).headline === "10 min" && x(w1, 2).details.includes("30 sec work / 30 sec recovery / 8 rounds") && x(w1, 2).details.includes("Assisted") && x(w1, 2).modifiers.includes("Tempo: slow and controlled"),
        JSON.stringify(x(w1, 2)));
      const allText = prog.flatMap((w) => w.exercises.flatMap((e) => [e.headline, ...e.details, ...e.modifiers])).filter(Boolean).join(" | ");
      check("no fake zeros / null / undefined / NaN in dosage", !/(^|[^0-9.])0([^0-9.]|$)|null|undefined|NaN/.test(allText), allText);
      check("absent optional values absent (no RPE/RIR/ROM where unset)", x(w0, 2).modifiers.length === 0 && x(w1, 1).modifiers.length === 0);
      check("no exercise renders 'No dosage saved'", prog.every((w) => w.exercises.every((e) => !e.missing)));
      check("Review has no editing controls (no inputs/selects)", (await page.locator("main input, main select, main textarea").count()) === 0);
      await shot(page, "01-review-sequence-desktop");

      // Gate disabled on this server.
      check("gate off: Publish button disabled", await page.locator('[data-testid="publish-prescription"]').isDisabled());
      check("gate off: explains publishing is not enabled", (await page.locator('[data-testid="publish-blocked-reason"]').textContent()).includes("not enabled"));
      await page.close();
    }
    check("Review rendering did not mutate the draft (full content + updated_at identical)", (await contentSnapshot("draft", p1.draftId)) === p1Before);
    {
      const r = await api(ctxA, "POST", `${OFF}/api/clinician/prescription-drafts/${p1.draftId}/publish`, { expectedFingerprint: "x" });
      check("gate off: direct HTTP publish -> 403 PUBLISH_DISABLED", r.status === 403 && r.body?.error === "PUBLISH_DISABLED", JSON.stringify(r));
      check("gate off: draft still editing, no version created", (await draftStatus(p1.draftId)) === "editing" && (await c5Versions(P.p1)).versions.length === 0);
    }

    // =====================================================================
    section("ACCESS — view-only and unrelated clinicians");
    {
      const { page, status } = await openReview(ctxB, ON, P.p1);
      check("view-only clinician can open Review (200)", status === 200);
      check("view-only: Publish disabled", await page.locator('[data-testid="publish-prescription"]').isDisabled());
      check("view-only: explains only the editing clinician can publish", (await page.locator('[data-testid="publish-blocked-reason"]').textContent()).includes("Only the editing clinician"));
      check("view-only: edit action is 'View Draft'", (await page.locator('[data-testid="edit-prescription"]').textContent()).includes("View Draft"));
      await page.close();
      const r = await api(ctxB, "POST", `${ON}/api/clinician/prescription-drafts/${p1.draftId}/publish`, {});
      check("view-only direct HTTP publish -> 403 DRAFT_NOT_OWNED_BY_CALLER", r.status === 403 && r.body?.error === "DRAFT_NOT_OWNED_BY_CALLER", JSON.stringify(r));
      const o = await api(ctxB, "GET", `${ON}/api/clinician/prescription-drafts/${p1.draftId}/publication`);
      check("view-only may read publication status (read tier)", o.status === 200 && o.body?.status === "editing", JSON.stringify(o));
    }
    {
      const { page, status } = await openReview(ctxC, ON, P.p1);
      check("unrelated clinician: Review page 404", status === 404);
      await page.close();
      const r = await api(ctxC, "POST", `${ON}/api/clinician/prescription-drafts/${p1.draftId}/publish`, {});
      check("unrelated clinician direct HTTP publish -> 403 PATIENT_NOT_AUTHORIZED", r.status === 403 && r.body?.error === "PATIENT_NOT_AUTHORIZED", JSON.stringify(r));
      const o = await api(ctxC, "GET", `${ON}/api/clinician/prescription-drafts/${p1.draftId}/publication`);
      check("unrelated clinician: publication status -> 403", o.status === 403, JSON.stringify(o));
      const anon = await browser.newContext();
      const ar = await anon.request.post(`${ON}/api/clinician/prescription-drafts/${p1.draftId}/publish`, { failOnStatusCode: false, maxRedirects: 0 });
      check("unauthenticated publish never succeeds", ar.status() !== 200, `status ${ar.status()}`);
      await anon.close();
      check("no version created by any rejected attempt", (await c5Versions(P.p1)).versions.length === 0);
    }

    // =====================================================================
    section("BUILDER — Review entry point");
    {
      const page = await ctxA.newPage();
      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/builder`);
      await page.waitForLoadState("networkidle");
      const entry = page.locator('[data-testid="review-prescription"]');
      check("clean draft: Review Prescription is an enabled link", (await entry.evaluate((el) => el.tagName)) === "A");
      // Make one dosage dirty (no save).
      const row = page.locator(`[data-exercise-id="${p1.workouts[0].exercises[0]}"]`);
      await row.locator('[data-testid="edit-dosage"]').click();
      await row.locator('[data-testid="dosage-field-sets"]').fill("6");
      await waitFor(async () => (await page.locator('[data-testid="review-prescription"]').evaluate((el) => el.tagName)) === "BUTTON");
      check("unsaved dosage: Review held back (disabled) with explanation",
        (await page.locator('[data-testid="review-prescription"]').isDisabled()) && (await page.locator('[data-testid="review-prescription"]').getAttribute("title")).includes("unsaved"));
      await row.locator('[data-testid="cancel-dosage"]').click();
      await waitFor(async () => (await page.locator('[data-testid="review-prescription"]').evaluate((el) => el.tagName)) === "A");
      await page.click('[data-testid="review-prescription"]');
      await page.waitForURL(/\/prescription\/review$/);
      check("Review Prescription navigates to the review route", page.url().endsWith(`/clinician/patients/${P.p1.userId}/prescription/review`));
      await page.click('[data-testid="edit-prescription"]');
      await page.waitForURL(/\/prescription\/builder/);
      check("Edit Prescription returns to the builder", page.url().includes("/prescription/builder"));
      await page.close();
      check("builder round trip lost nothing (draft unchanged)", (await contentSnapshot("draft", p1.draftId)) === p1Before);
    }

    // =====================================================================
    section("REVIEW — valid Calendar prescription, absent optional metadata");
    const p2 = await buildDraft(ctxA, P.p2, {
      mode: "calendar",
      workouts: [
        { label: null, days: [1, 3], exercises: [{ ex: E[6], dosage: { sets: 3, repsMode: "exact", repsExact: 10, loadType: "not_applicable" } }] },
        { label: null, days: [2, 4], exercises: [{ ex: E[7], dosage: { sets: 2, repsMode: "exact", repsExact: 12, loadType: "bodyweight" } }] },
        { label: "Plyo", days: [6], exercises: [{ ex: E[8], dosage: { sets: 3, contactsMode: "range", contactsMin: 15, contactsMax: 20, loadType: "not_applicable" } }] },
      ],
    });
    {
      const { page } = await openReview(ctxA, ON, P.p2);
      const days = await page.locator('[data-testid="calendar-day"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-day")}:${e.getAttribute("data-workouts")}`));
      check("weekly calendar shows actual assigned weekdays", days.join(" ") === "Mon:A Tue:B Wed:A Thu:B Fri: Sat:C Sun:", days.join(" "));
      const prog = await readProgram(page);
      check("unnamed workouts fall back to Workout A/B, A/B/C order kept", prog.map((w) => w.label).join("|") === "Workout A|Workout B|Plyo");
      check("per-workout weekday chips", prog.map((w) => w.days.join(",")).join("|") === "Mon,Wed|Tue,Thu|Sat", JSON.stringify(prog.map((w) => w.days)));
      check("absent Phase / Performance Focus not shown", (await page.locator('[data-testid="summary-phase"], [data-testid="summary-focus"]').count()) === 0);
      check("Calendar shows no sessions/week target", (await page.locator('[data-testid="schedule-sequence"], [data-testid="schedule-target"]').count()) === 0);
      check("contact range: 3 × 15–20 contacts", prog[2].exercises[0].headline === "3 × 15–20 contacts");
      check("Ready to publish on gate-on server, Publish enabled", (await page.locator('[data-testid="validation-ready"]').isVisible()) && (await page.locator('[data-testid="publish-prescription"]').isEnabled()));
      await shot(page, "02-review-calendar-desktop");
      await page.close();
    }
    {
      const page = await ctxAMobile.newPage();
      await page.goto(`${ON}/clinician/patients/${P.p2.userId}/prescription/review`);
      await page.waitForLoadState("networkidle");
      check("mobile Review: no horizontal overflow", await noHorizontalOverflow(page));
      const bar = page.locator('[data-testid="review-action-bar"]');
      const box = await bar.boundingBox();
      check("mobile Review: action bar pinned within the viewport", box && box.y + box.height <= MOBILE.height + 1 && box.y >= 0, JSON.stringify(box));
      await shot(page, "07-review-mobile", { viewportOnly: true });
      await shot(page, "07c-review-mobile-full");
      await page.click('[data-testid="publish-prescription"]');
      const dialog = page.locator('[data-testid="publish-dialog"]');
      await dialog.waitFor();
      const dbox = await dialog.boundingBox();
      check("mobile: confirmation dialog fully within the viewport", dbox && dbox.x >= 0 && dbox.x + dbox.width <= MOBILE.width && dbox.y >= 0 && dbox.y + dbox.height <= MOBILE.height, JSON.stringify(dbox));
      await shot(page, "07b-publish-dialog-mobile", { viewportOnly: true });
      await page.click('[data-testid="publish-cancel"]');
      check("mobile: Cancel closes the dialog without publishing", (await dialog.count()) === 0 && (await c5Versions(P.p2)).versions.length === 0);
      await page.close();
    }

    // =====================================================================
    section("VALIDATION — blocking issues");
    const p3 = await buildDraft(ctxA, P.p3, {
      mode: null,
      workouts: [
        {
          label: "Main",
          exercises: [
            { ex: withRef, dosage: null }, // has library reference dosage, no saved dosage
            { ex: E[0], dosage: { sets: 3, repsMode: "exact", repsExact: 10, loadType: "not_applicable" } },
            { ex: E[1], dosage: { sets: 3, repsMode: "exact", repsExact: 10, loadType: "not_applicable" } },
          ],
        },
        { label: "Empty", exercises: [] },
      ],
    });
    // A pre-existing invalid row the API can no longer write (RPE and RIR
    // together — permitted by the DB, rejected by the shared validator).
    await admin.from("prescription_exercise_dosage").update({ rpe: 7, rir: 2 }).eq("prescription_exercise_id", p3.workouts[0].exercises[2]);
    const p3Before = await contentSnapshot("draft", p3.draftId);
    {
      const { page } = await openReview(ctxA, ON, P.p3);
      const issues = await issueRules(page);
      const rules = issues.map((i) => i.rule);
      check("multiple simultaneous issues listed", issues.length === 5, JSON.stringify(issues, null, 1));
      check("issues read in program order (prescription-level, then A by exercise, then B)",
        rules.join(",") === "scheduling_mode_present,has_prior_clinical_state,active_exercises_have_dosage,active_exercise_dosage_valid,workouts_have_active_exercise", rules.join(","));
      check("'5 issues need attention' header", (await page.locator('[data-testid="validation-issues"] > p').first().textContent()).includes("5 issues need attention"));
      check("scheduling mode missing", rules.includes("scheduling_mode_present"));
      const missing = issues.find((i) => i.rule === "active_exercises_have_dosage");
      check("missing dosage names workout + exercise", missing?.context === `Main · ${withRef.name}` && missing?.message === "No dosage saved.", JSON.stringify(missing));
      check("missing dosage -> Edit exercise deep link", missing?.kind === "exercise" && missing.href.includes(`workout=${p3.workouts[0].workoutId}`) && missing.href.includes(`exercise=${p3.workouts[0].exercises[0]}`), missing?.href);
      const invalid = issues.find((i) => i.rule === "active_exercise_dosage_valid");
      check("invalid saved dosage located + explained", invalid?.context === `Main · ${E[1].name}` && invalid.message.includes("either RPE or RIR"), JSON.stringify(invalid));
      const empty = issues.find((i) => i.rule === "workouts_have_active_exercise");
      check("empty workout located", empty?.context === "Empty" && empty.message.includes("no exercises") && empty.kind === "prescription", JSON.stringify(empty));
      const prior = issues.find((i) => i.rule === "has_prior_clinical_state");
      check("missing clinical stage record surfaced (RPC rule), no fake edit link", !!prior && prior.href === null, JSON.stringify(prior));
      const schedule = issues.find((i) => i.rule === "scheduling_mode_present");
      check("scheduling issue -> Edit schedule link", schedule?.kind === "schedule" && schedule.href.includes("focus=schedule"));
      const prog = await readProgram(page);
      const refRow = prog[0].exercises[0];
      check("reference dosage never shown as prescription dosage", refRow.missing && !refRow.hasDosage, JSON.stringify(refRow));
      check("Publish disabled while issues exist", await page.locator('[data-testid="publish-prescription"]').isDisabled());
      check("blocked reason points at the issues", (await page.locator('[data-testid="publish-blocked-reason"]').textContent()).includes("Resolve the issues"));
      await shot(page, "03-validation-errors-desktop");
      // Issue navigation — exercise deep link opens that exercise's editor.
      await page.click(`[data-testid="validation-issue"][data-rule="active_exercises_have_dosage"] [data-testid="issue-action"]`);
      await page.waitForURL(/\/prescription\/builder\?/);
      const row = page.locator(`[data-exercise-id="${p3.workouts[0].exercises[0]}"]`);
      await row.waitFor();
      check("Edit exercise -> builder opens that exercise's dosage editor", await row.locator('[data-testid="dosage-editor"]').isVisible());
      check("Edit exercise -> correct workout selected", (await page.locator('[data-testid="workout-tab"][aria-current="true"]').getAttribute("data-workout-label")) === "Main");
      await page.close();
    }
    {
      const r = await api(ctxA, "POST", `${ON}/api/clinician/prescription-drafts/${p3.draftId}/publish`, {});
      check("server rejects invalid draft even when called directly (422 VALIDATION_FAILED)", r.status === 422 && r.body?.error === "VALIDATION_FAILED", JSON.stringify(r));
      check("no version for invalid draft", (await c5Versions(P.p3)).versions.length === 0);
    }
    check("Review + issue navigation did not mutate the invalid draft", (await contentSnapshot("draft", p3.draftId)) === p3Before);
    {
      const mpage = await ctxAMobile.newPage();
      await mpage.goto(`${ON}/clinician/patients/${P.p3.userId}/prescription/review`);
      await mpage.waitForLoadState("networkidle");
      check("mobile: validation issues without horizontal overflow", await noHorizontalOverflow(mpage));
      await shot(mpage, "03b-validation-errors-mobile");
      await mpage.close();
    }
    // Invalid Sequence scheduling.
    await must(ctxA, "PATCH", `${ON}/api/clinician/prescription-drafts/${p3.draftId}`, { schedulingMode: "sequence", targetSessionsPerWeek: null });
    {
      const { page } = await openReview(ctxA, ON, P.p3);
      const issue = (await issueRules(page)).find((i) => i.rule === "sequence_target_frequency_present");
      check("Sequence without target sessions/week -> blocking issue + Edit schedule", issue?.kind === "schedule" && issue.message.includes("sessions per week"), JSON.stringify(issue));
      await page.close();
    }
    // Invalid Calendar scheduling: one workout without days, then a weekday on two workouts.
    await must(ctxA, "PATCH", `${ON}/api/clinician/prescription-drafts/${p3.draftId}`, { schedulingMode: "calendar" });
    await must(ctxA, "PATCH", `${ON}/api/clinician/prescription-workouts/${p3.workouts[0].workoutId}`, { daysOfWeek: [1] });
    {
      const { page } = await openReview(ctxA, ON, P.p3);
      const issue = (await issueRules(page)).find((i) => i.rule === "calendar_days_present");
      check("Calendar workout without weekday -> located issue", issue?.context === "Empty" && issue.message === "No weekday assigned." && issue.href.includes("focus=weekdays"), JSON.stringify(issue));
      await page.click(`[data-testid="validation-issue"][data-rule="calendar_days_present"] [data-testid="issue-action"]`);
      await page.waitForURL(/focus=weekdays/);
      await page.locator('[data-testid="weekday-assignment"]').waitFor();
      check("Edit schedule -> builder on that workout's weekday assignment", (await page.locator('[data-testid="workout-tab"][aria-current="true"]').getAttribute("data-workout-label")) === "Empty");
      await page.close();
    }
    await admin.from("prescription_workouts").update({ days_of_week: [1] }).eq("id", p3.workouts[1].workoutId); // API refuses this; DB permits
    {
      const { page } = await openReview(ctxA, ON, P.p3);
      const issue = (await issueRules(page)).find((i) => i.rule === "calendar_weekdays_exclusive");
      check("weekday on two workouts -> located issue", issue?.message === "Monday is assigned to more than one workout (Main, Empty).", JSON.stringify(issue));
      await page.close();
    }
    // Inaccessible exercise: a throwaway PRIVATE exercise owned by another clinician.
    {
      const { data: privateEx, error } = await admin
        .from("canonical_exercises")
        .insert({ name: `c54d private ${Date.now()}`, visibility: "private", owner_clinician_id: C.userId, active: true })
        .select("id, name")
        .single();
      if (error) {
        check("inaccessible exercise reproducible (private exercise fixture)", false, `could not create fixture: ${error.message}`);
      } else {
        createdExerciseIds.push(privateEx.id);
        await admin.from("prescription_exercises").insert({ prescription_workout_id: p3.workouts[0].workoutId, canonical_exercise_id: privateEx.id, order_index: 10 });
        const { page } = await openReview(ctxA, ON, P.p3);
        const issue = (await issueRules(page)).find((i) => i.rule === "exercises_active_and_accessible");
        check("inaccessible exercise located by name + Edit exercise", issue?.context === `Main · ${privateEx.name}` && issue.kind === "exercise", JSON.stringify(issue));
        await page.close();
      }
    }

    // =====================================================================
    section("PUBLISH — first publication (gate on)");
    let v1Id = null;
    {
      const { page } = await openReview(ctxA, ON, P.p1);
      let publishRequests = 0;
      page.on("request", (req) => {
        if (req.method() === "POST" && req.url().endsWith(`/prescription-drafts/${p1.draftId}/publish`)) publishRequests++;
      });
      await page.click('[data-testid="publish-prescription"]');
      const dialogText = await page.locator('[data-testid="publish-dialog"]').textContent();
      check("confirmation copy",
        dialogText.includes("Publish this prescription?") &&
          dialogText.includes("This will make this version the patient's current prescription. Published versions cannot be edited.") &&
          dialogText.includes("Future changes will require creating a new draft and publishing a new version."), dialogText);
      check("confirmation does not require typing", (await page.locator('[data-testid="publish-dialog"] input').count()) === 0);
      await shot(page, "04-publish-confirmation-desktop", { viewportOnly: true });
      await page.click('[data-testid="publish-cancel"]');
      check("Cancel closes dialog, nothing published", (await page.locator('[data-testid="publish-dialog"]').count()) === 0 && (await c5Versions(P.p1)).versions.length === 0);
      await confirmPublish(page, { dblclick: true });
      await waitOutcome(page);
      check("success state shown", await page.locator('[data-testid="publish-success"]').isVisible());
      check("'Version 1 is now the patient's current prescription.'", (await page.locator('[data-testid="publish-success-version"]').textContent()) === "Version 1 is now the patient's current prescription.");
      check("first publication described naturally", (await page.locator('[data-testid="publish-success-history"]').textContent()).includes("first published prescription"));
      const successText = await page.locator('[data-testid="publish-success"]').textContent();
      check("success copy makes no patient-runtime claims", !/can now see|Today's Rehab|next workout/i.test(successText), successText);
      check("double-click sent exactly one publish request", publishRequests === 1, `requests: ${publishRequests}`);
      await shot(page, "05-publish-success-desktop");

      const { pp, versions } = await c5Versions(P.p1);
      check("exactly one C5 version, number 1", versions.length === 1 && versions[0].version_number === 1, JSON.stringify(versions));
      v1Id = versions[0]?.id;
      check("current pointer -> version 1", pp.current_prescription_version_id === v1Id);
      check("draft lifecycle: draft status 'published'", (await draftStatus(p1.draftId)) === "published");
      check("published content == reviewed draft content", (await portableContent("version", v1Id)) === (await portableContent("draft", p1.draftId)));
      const o = await api(ctxA, "GET", `${ON}/api/clinician/prescription-drafts/${p1.draftId}/publication`);
      check("publication outcome identifies version 1 as current", o.body?.status === "published" && o.body?.version?.id === v1Id && o.body.version.versionNumber === 1 && o.body.version.isCurrent === true, JSON.stringify(o.body));

      await page.click('[data-testid="view-published"]');
      await page.waitForURL(/\/prescription\/versions\//);
      await page.waitForLoadState("networkidle");
      check("read-only view: Current status, version 1", (await page.locator('[data-testid="version-status"]').getAttribute("data-status")) === "current" && (await page.locator("h1").textContent()).includes("Version 1"));
      check("read-only view: publication timestamp + publisher", /Published .+ by owner/.test(await page.locator('[data-testid="version-published-meta"]').textContent()));
      const viewProg = await readProgram(page);
      check("read-only view renders exactly what Review showed", JSON.stringify(viewProg) === JSON.stringify(p1ReviewProgram));
      check("read-only view has no editing controls", (await page.locator("main input:not([type=hidden]), main select, main textarea").count()) === 0);
      await shot(page, "06-published-readonly-desktop");

      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/review`);
      check("refresh after publication: Review shows no draft + current version", (await page.locator('[data-testid="review-no-draft"]').textContent()).includes("Version 1"));
      await page.close();
    }

    // =====================================================================
    section("PUBLISH — replacement version via Edit Active");
    {
      const v1Before = await contentSnapshot("version", v1Id);
      const page = await ctxA.newPage();
      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/versions/${v1Id}`);
      await page.click('[data-testid="edit-active"]');
      await page.waitForURL(/\/prescription\/builder/);
      const { data: newDraft } = await admin.from("prescription_drafts").select("*").eq("status", "editing").eq("based_on_prescription_version_id", v1Id).single();
      check("Edit Active created a clone_active draft based on v1 (C5.3 flow)", newDraft?.source === "clone_active" && newDraft.stale_base_prescription_version_id === v1Id);
      const { data: draftWorkouts } = await admin.from("prescription_workouts").select("id, order_index, prescription_exercises(id, order_index)").eq("prescription_draft_id", newDraft.id).order("order_index");
      const firstEx = draftWorkouts[0].prescription_exercises.sort((a, b) => a.order_index - b.order_index)[0].id;
      await must(ctxA, "PUT", `${ON}/api/clinician/prescription-exercises/${firstEx}/dosage`, {
        dosage: { dosageType: "repetition", sets: 5, repsMode: "exact", repsExact: 8, loadType: "external", loadMode: "exact", loadValueExact: 50, loadUnit: "lb", eccentricDurationSeconds: 3, rpe: 8 },
      });
      await must(ctxA, "PATCH", `${ON}/api/clinician/prescription-exercises/${firstEx}`, { additionalInstructions: "Updated cue." });
      check("draft open: version page offers the draft, not a second Edit Active", await (async () => {
        await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/versions/${v1Id}`);
        return (await page.locator('[data-testid="edit-active"]').count()) === 0 && (await page.locator('[data-testid="open-draft"]').count()) === 1;
      })());
      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/review`);
      await page.waitForLoadState("networkidle");
      await confirmPublish(page);
      await waitOutcome(page);
      check("'Version 2 is now the patient's current prescription.'", (await page.locator('[data-testid="publish-success-version"]').textContent()) === "Version 2 is now the patient's current prescription.");
      check("replacement copy: Version 1 remains in history unchanged", (await page.locator('[data-testid="publish-success-history"]').textContent()).includes("Version 1 remains in the prescription history, unchanged."));
      const { pp, versions } = await c5Versions(P.p1);
      const v2Id = versions.find((v) => v.version_number === 2)?.id;
      check("two versions; current pointer -> version 2", versions.length === 2 && pp.current_prescription_version_id === v2Id);
      check("version 1 content byte-identical after replacement", (await contentSnapshot("version", v1Id)) === v1Before);
      check("replacement draft lifecycle: published", (await draftStatus(newDraft.id)) === "published");

      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/versions/${v1Id}`);
      const v1Prog = await readProgram(page);
      check("historical v1 page: Historical, old dosage + instructions (not draft/current values)",
        (await page.locator('[data-testid="version-status"]').getAttribute("data-status")) === "historical" &&
          v1Prog[0].exercises[0].headline === "4 × 8" && v1Prog[0].exercises[0].details.includes("45 lb") && v1Prog[0].exercises[0].instructions === "Keep heel directly under knee.",
        JSON.stringify(v1Prog[0].exercises[0]));
      check("historical version offers no Edit Active", (await page.locator('[data-testid="edit-active"]').count()) === 0);
      await shot(page, "06b-published-historical-desktop");
      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/versions/${v2Id}`);
      const v2Prog = await readProgram(page);
      check("current v2 page shows new dosage", v2Prog[0].exercises[0].headline === "5 × 8" && v2Prog[0].exercises[0].details.includes("50 lb") && v2Prog[0].exercises[0].instructions === "Updated cue.");
      await page.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription`);
      check("overview lists both versions in history", (await page.locator('[data-testid="version-history-link"]').count()) === 2);
      const vb = await ctxB.newPage();
      const vbResp = await vb.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/versions/${v1Id}`);
      check("supervising view-only clinician can inspect history (200)", vbResp.status() === 200);
      await vb.close();
      const vc = await ctxC.newPage();
      const vcResp = await vc.goto(`${ON}/clinician/patients/${P.p1.userId}/prescription/versions/${v1Id}`);
      check("unrelated clinician cannot read a published version (404)", vcResp.status() === 404);
      await vc.close();
      // Publication timestamps render in the VIEWER's timezone; the server
      // HTML carries an explicit UTC fallback; hydration stays clean.
      {
        const html = await (await ctxA.request.get(`${OFF}/clinician/patients/${P.p1.userId}/prescription/versions/${v1Id}`)).text();
        check("server HTML carries an explicit UTC fallback (no server-timezone formatting)", /<time[^>]*data-localized="false"[^>]*>[^<]* UTC<\/time>/.test(html));
        const storageState = await ctxA.storageState();
        for (const [tz, viewport, base, label] of [
          ["Pacific/Auckland", DESKTOP, OFF, "desktop, dev server"],
          ["America/Los_Angeles", MOBILE, OFF, "mobile, dev server"],
          ["Asia/Kolkata", DESKTOP, ON, "desktop, production build"],
        ]) {
          const tctx = await browser.newContext({ viewport, timezoneId: tz, storageState });
          const tpage = await tctx.newPage();
          const errors = [];
          tpage.on("console", (m) => {
            if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
          });
          tpage.on("pageerror", (e) => errors.push(String(e)));
          for (const [vid, which] of [[v2Id, "current"], [v1Id, "historical"]]) {
            await tpage.goto(`${base}/clinician/patients/${P.p1.userId}/prescription/versions/${vid}`);
            await tpage.waitForLoadState("networkidle");
            const t = tpage.locator('[data-testid="version-published-meta"] [data-testid="local-datetime"]');
            await waitFor(async () => (await t.getAttribute("data-localized")) === "true");
            const iso = await t.getAttribute("datetime");
            const expected = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
            const text = await t.textContent();
            check(`publication time in viewer timezone: ${which} version, ${tz} (${label})`, text === expected, `got "${text}" expected "${expected}"`);
          }
          await tpage.goto(`${base}/clinician/patients/${P.p1.userId}/prescription`);
          await tpage.waitForLoadState("networkidle");
          const times = tpage.locator('[data-testid="local-datetime"]');
          await waitFor(async () => (await times.evaluateAll((els) => els.every((e) => e.getAttribute("data-localized") === "true"))));
          const histOk = await times.evaluateAll((els, zone) =>
            els.length >= 3 && els.every((e) => e.textContent === new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(e.getAttribute("datetime")))),
            tz);
          check(`overview Active card + Version History in viewer timezone (${tz})`, histOk);
          check(`no hydration errors/warnings (${tz}, ${label})`, !errors.some((e) => /hydrat|did not match|server rendered|Minified React error #(418|423|425)/i.test(e)), errors.join(" | "));
          if (viewport === MOBILE) check(`mobile published view: no horizontal overflow (${tz})`, await noHorizontalOverflow(tpage));
          await tctx.close();
        }
      }
      const wrong = await ctxA.newPage();
      const wrongResp = await wrong.goto(`${ON}/clinician/patients/${P.p2.userId}/prescription/versions/${v1Id}`);
      check("version id from another patient is not readable under this patient (404)", wrongResp.status() === 404);
      await wrong.close();
      await page.close();
    }

    // =====================================================================
    section("CONCURRENCY — draft changed after Review loaded; stale base");
    const p4 = await buildDraft(ctxA, P.p4, {
      mode: "sequence",
      target: 2,
      workouts: [{ label: "Only", exercises: [{ ex: E[9], dosage: { sets: 3, repsMode: "exact", repsExact: 10, loadType: "not_applicable" } }] }],
    });
    {
      const { page } = await openReview(ctxA, ON, P.p4);
      // Clinician edits the draft elsewhere (another tab) after Review loaded.
      await must(ctxA, "PUT", `${ON}/api/clinician/prescription-exercises/${p4.workouts[0].exercises[0]}/dosage`, { dosage: { dosageType: "repetition", sets: 4, repsMode: "exact", repsExact: 10, loadType: "not_applicable" } });
      await confirmPublish(page);
      await waitOutcome(page);
      check("stale review: publish refused with explanation", (await page.locator('[data-testid="publish-error"]').textContent()).includes("changed after you opened Review"));
      check("stale review: no success reported, no version created", (await page.locator('[data-testid="publish-success"]').count()) === 0 && (await c5Versions(P.p4)).versions.length === 0);
      check("stale review: draft untouched and still editing", (await draftStatus(p4.draftId)) === "editing");
      const refreshed = await waitFor(async () => (await page.locator('[data-testid="dosage-headline"]').first().textContent()) === "4 × 10");
      check("stale review: Review reloaded the current draft (4 × 10)", refreshed);
      await confirmPublish(page);
      await waitOutcome(page);
      check("after re-review, publish succeeds", await page.locator('[data-testid="publish-success"]').isVisible());
      const { versions } = await c5Versions(P.p4);
      const { data: d } = await admin.from("prescription_workouts").select("prescription_exercises(prescription_exercise_dosage(sets))").eq("prescription_version_id", versions[0].id).single();
      const sets = d.prescription_exercises[0].prescription_exercise_dosage?.sets ?? d.prescription_exercises[0].prescription_exercise_dosage?.[0]?.sets;
      check("published the re-reviewed (current) content, not the stale one", sets === 4, `sets=${sets}`);
      await page.close();
    }
    {
      const { data: pp } = await admin.from("patient_prescriptions").select("id, current_prescription_version_id").eq("patient_id", P.p4.userId).single();
      const realCurrent = pp.current_prescription_version_id;
      const { draftId: staleDraftId } = await must(ctxA, "POST", `${ON}/api/clinician/patients/${P.p4.userId}/prescription-drafts`, { source: "clone_active", sourceVersionId: realCurrent });
      // Simulate the current pointer moving after this draft was started.
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      try {
        const { page } = await openReview(ctxA, ON, P.p4);
        const issue = (await issueRules(page)).find((i) => i.rule === "draft_base_current");
        check("stale base surfaced as a blocking issue in Review", !!issue && issue.kind === "overview", JSON.stringify(issue));
        check("stale base: Publish disabled", await page.locator('[data-testid="publish-prescription"]').isDisabled());
        await page.close();
        const r = await api(ctxA, "POST", `${ON}/api/clinician/prescription-drafts/${staleDraftId}/publish`, {});
        check("stale base: direct publish -> 409 DRAFT_STALE_BASE (C5.3 RPC semantics)", r.status === 409 && r.body?.error === "DRAFT_STALE_BASE", JSON.stringify(r));
        check("stale base: draft still editing", (await draftStatus(staleDraftId)) === "editing");
      } finally {
        await admin.from("patient_prescriptions").update({ current_prescription_version_id: realCurrent }).eq("id", pp.id);
      }
    }

    // =====================================================================
    section("FAILURE MODES — server error, network, authorization, supervision, ambiguous response");
    const p5 = await buildDraft(ctxA, P.p5, {
      mode: "sequence",
      target: 3,
      workouts: [{ label: "Only", exercises: [{ ex: E[2], dosage: { sets: 3, contactsMode: "exact", contactsExact: 20, loadType: "not_applicable" } }] }],
    });
    const publishUrl = `**/api/clinician/prescription-drafts/${p5.draftId}/publish`;
    const publicationUrl = `**/api/clinician/prescription-drafts/${p5.draftId}/publication`;
    {
      const { page } = await openReview(ctxA, ON, P.p5);
      // (a) Server failure before anything happened.
      await page.route(publishUrl, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "INTERNAL_ERROR" }) }));
      await confirmPublish(page);
      await waitOutcome(page);
      check("server error: reconciled to 'did not complete … nothing was published'", (await page.locator('[data-testid="publish-error"]').textContent()).includes("did not complete"));
      check("server error: informed retry allowed (button enabled)", await page.locator('[data-testid="publish-prescription"]').isEnabled());
      check("server error: no version", (await c5Versions(P.p5)).versions.length === 0);
      await page.unroute(publishUrl);
      // (b) Network failure before the request reached the server.
      await page.route(publishUrl, (route) => route.abort("failed"));
      await confirmPublish(page);
      await waitOutcome(page);
      check("network failure before send: reconciled, nothing published, retry allowed",
        (await page.locator('[data-testid="publish-error"]').textContent()).includes("did not complete") && (await c5Versions(P.p5)).versions.length === 0);
      await page.unroute(publishUrl);
      // (c) Legacy authorization lost after Review loaded.
      const db2 = legacyDb();
      db2.prepare("DELETE FROM supervisor_patients WHERE id = ?").run(legacyLinkA5);
      db2.close();
      try {
        await confirmPublish(page);
        await waitOutcome(page);
        check("authorization loss: refused with explanation, nothing published",
          (await page.locator('[data-testid="publish-error"]').textContent()).includes("could not be authorized") && (await c5Versions(P.p5)).versions.length === 0);
      } finally {
        const db3 = legacyDb();
        legacyLinkA5 = db3.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')").run(legacyA, legacyP5).lastInsertRowid;
        legacyLinkIds.push(legacyLinkA5);
        db3.close();
      }
      // (d) Postgres supervision lost after Review loaded.
      await admin.from("supervisor_patients").update({ status: "inactive" }).eq("supervisor_id", A.userId).eq("patient_id", P.p5.userId);
      try {
        await confirmPublish(page);
        await waitOutcome(page);
        check("supervision loss: refused, nothing published",
          (await page.locator('[data-testid="publish-error"]').textContent()).includes("could not be authorized") && (await c5Versions(P.p5)).versions.length === 0);
        const r404 = await ctxA.newPage();
        check("supervision loss: Review itself is no longer reachable (404)", (await r404.goto(`${ON}/clinician/patients/${P.p5.userId}/prescription/review`)).status() === 404);
        await r404.close();
      } finally {
        await admin.from("supervisor_patients").update({ status: "active" }).eq("supervisor_id", A.userId).eq("patient_id", P.p5.userId);
      }
      // (e) Publication succeeds but the response is lost AND reconciliation is
      // briefly unreachable: must not claim success or failure, must not retry.
      let forwarded = 0;
      await page.route(publishUrl, async (route) => {
        forwarded++;
        await route.fetch();
        await route.abort("failed");
      });
      await page.route(publicationUrl, (route) => route.abort("failed"));
      await confirmPublish(page);
      await waitOutcome(page);
      check("lost response + reconcile unreachable: 'couldn't confirm' shown", await page.locator('[data-testid="publish-unconfirmed"]').isVisible());
      check("unconfirmed: Publish disabled (no blind retry)", await page.locator('[data-testid="publish-prescription"]').isDisabled());
      check("unconfirmed: exactly one publish attempt reached the server", forwarded === 1);
      await page.unroute(publicationUrl);
      await page.click('[data-testid="publish-check-again"]');
      await waitOutcome(page);
      check("reconciliation recovers the true published state", (await page.locator('[data-testid="publish-success-version"]').textContent()) === "Version 1 is now the patient's current prescription.");
      check("recovered success says the server confirmed it", await page.locator('[data-testid="publish-success-recovered"]').isVisible());
      check("exactly one version created", (await c5Versions(P.p5)).versions.length === 1);
      await page.unroute(publishUrl);
      await page.close();
    }
    // (f) Response lost, reconciliation reachable -> straight to true state.
    {
      const p6 = await buildDraft(ctxA, P.p6, {
        mode: "sequence",
        target: 1,
        workouts: [{ label: "Only", exercises: [{ ex: E[3], dosage: { sets: 2, repsMode: "exact", repsExact: 5, loadType: "bodyweight" } }] }],
      });
      const { page } = await openReview(ctxA, ON, P.p6);
      await page.route(`**/api/clinician/prescription-drafts/${p6.draftId}/publish`, async (route) => {
        await route.fetch();
        await route.abort("failed");
      });
      await confirmPublish(page);
      await waitOutcome(page);
      check("lost response: reconciled to true success (Version 1) without retry", (await page.locator('[data-testid="publish-success-version"]').textContent()) === "Version 1 is now the patient's current prescription." && (await c5Versions(P.p6)).versions.length === 1);
      await page.close();
    }
    // (g) Two simultaneous HTTP publishes of the same draft.
    {
      const [r1, r2] = await Promise.all([
        api(ctxA, "POST", `${ON}/api/clinician/prescription-drafts/${p2.draftId}/publish`, {}),
        api(ctxA, "POST", `${ON}/api/clinician/prescription-drafts/${p2.draftId}/publish`, {}),
      ]);
      const oks = [r1, r2].filter((r) => r.status === 200).length;
      check("concurrent double publish: exactly one succeeds", oks === 1, JSON.stringify([r1, r2]));
      check("concurrent double publish: loser gets a structured refusal", [r1, r2].some((r) => r.status === 409 || r.status === 404), JSON.stringify([r1, r2]));
      check("concurrent double publish: exactly one version", (await c5Versions(P.p2)).versions.length === 1);
      const { versions } = await c5Versions(P.p2);
      const page = await ctxA.newPage();
      await page.goto(`${ON}/clinician/patients/${P.p2.userId}/prescription/versions/${versions[0].id}`);
      const days = await page.locator('[data-testid="calendar-day"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-day")}:${e.getAttribute("data-workouts")}`));
      check("published Calendar version keeps its weekly schedule", days.join(" ") === "Mon:A Tue:B Wed:A Thu:B Fri: Sat:C Sun:", days.join(" "));
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

async function teardown() {
  for (const userId of createdUsers) {
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("notifications").delete().eq("patient_id", userId);
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
  }
  if (createdExerciseIds.length) await admin.from("canonical_exercises").delete().in("id", createdExerciseIds);
  await admin.from("supervisor_patients").delete().in("supervisor_id", createdUsers);
  await admin.from("organization_members").delete().in("user_id", createdUsers);
  await admin.from("profiles").delete().in("id", createdUsers);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  const db = legacyDb();
  try {
    for (const id of legacyLinkIds) db.prepare("DELETE FROM supervisor_patients WHERE id = ?").run(id);
    for (const id of legacyUserIds) db.prepare("DELETE FROM users WHERE id = ?").run(id);
  } finally {
    db.close();
  }
  const { count } = await admin.from("prescription_versions").select("id", { count: "exact", head: true }).in("user_id", createdUsers);
  console.log(`\nteardown: fixture users removed; remaining fixture versions: ${count ?? 0}`);
}

try {
  await main();
} catch (err) {
  fail++;
  console.error("ERROR", err);
} finally {
  await teardown().catch((e) => console.error("teardown error", e));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
