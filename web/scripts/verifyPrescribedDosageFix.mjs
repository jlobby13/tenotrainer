// Milestone 6, Stage 2 founder-acceptance patch — live-browser verification
// of the prescribed-dosage semantic fix (getPrescribedSet / SetTracker).
//
// Drives the REAL Active Rehab Session UI (not just the pure-function unit
// tests in lib/__tests__/activeSession.test.ts) for one hold-based exercise
// and one rep-based exercise, confirms:
//   - the hold-based exercise shows "Log Set" (never a one-tap "Complete
//     Set" that would submit a fabricated number), its edit input starts
//     EMPTY, and the submit button is disabled until a real number is typed
//   - the rep-based exercise's existing one-tap "Complete Set" behavior is
//     completely unchanged
//   - once both exercises finish, the real M2->M3 handoff
//     (SessionResponseFlow's automatic bootstrap()) creates a real
//     rehab_sessions row and submits real set_outcomes rows via the actual
//     server route — inspected directly in Postgres afterward
//   - /patient/progress's Loading History then displays that same real
//     session's frozen prescription correctly
//
// A real onboarded legacy-FastAPI user is needed only to satisfy
// /patient/session's page-level has_onboarding/has_plan gate — the actual
// exercises exercised in this test are injected directly into localStorage
// (the same schema SessionPlayer itself reads via loadSession()), so this
// test is not at the mercy of whatever the live rule engine would have
// picked for this patient's stage/irritability.
//
// Requires: `next dev` on localhost:3000, FastAPI bridge on localhost:8000,
// web/.env.local populated, Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyPrescribedDosageFix.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import Database from "node:sqlite";

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
const legacyDb = new Database.DatabaseSync("../app/tenotrainer.db");

function genUuid() {
  return crypto.randomUUID();
}

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

async function main() {
  const email = `m6-dosage-fix-verify-${Date.now()}@example.invalid`.toLowerCase();
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = created.user.id;
  let legacyUserId = null;
  const browser = await chromium.launch();

  try {
    await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });
    await admin.from("prescription_versions").insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" });

    // Legacy SQLite: minimal onboarded patient so /patient/session's
    // has_onboarding/has_plan gate passes. Its actual session_plan content
    // is irrelevant — the injected localStorage session below fully
    // overrides which exercises the test drives.
    const info = legacyDb
      .prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, 'patient', ?)")
      .run("Dosage Fix Verify", email, userId);
    legacyUserId = Number(info.lastInsertRowid);
    legacyDb
      .prepare(
        "INSERT INTO onboarding_assessments (user_id, morning_stiffness, pain_at_rest, pain_with_activity, pain_after_activity, next_day_pain, calf_raise_reps, injury_duration, stage, irritability, functional_tests, goals) VALUES (?, 2, 2, 3, 3, 2, 15, '3-6 months', 1, 'low', '{}', '{}')"
      )
      .run(legacyUserId);
    const planInfo = legacyDb
      .prepare("INSERT INTO rehab_plans (user_id, stage, irritability, decision, exercises, citations) VALUES (?, 1, 'low', 'STAY', '[]', '[]')")
      .run(legacyUserId);
    const legacyPlanId = Number(planInfo.lastInsertRowid);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#email", email);
    await page.fill("#password", PASSWORD);
    await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);

    // Inject a fully-controlled Active Rehab session directly into
    // localStorage — same schema SessionPlayer's own loadSession() reads.
    // Exercise 0 is hold-based (non-numeric reps_or_hold_time); exercise 1
    // is rep-based (plain numeric), each with exactly one set.
    const nowIso = new Date().toISOString();
    const localSession = {
      schemaVersion: 2,
      sessionInstanceId: genUuid(),
      patientId: String(legacyUserId),
      planId: String(legacyPlanId),
      prescriptionInstanceKey: `verify-dosage-fix:${genUuid()}`,
      startedAt: nowIso,
      lastUpdatedAt: nowIso,
      pausedAt: null,
      completedAt: null,
      status: "active",
      prescriptionSnapshot: {
        takenAt: nowIso,
        exercises: [
          {
            exercise: {
              ex_id: "ex_hold_live",
              name: "Double-Leg Calf Isometric Hold",
              category: "isometric",
              loading_profile: "isometric",
              setup_instructions: null,
              execution_cues: [],
              patient_facing_explanation: null,
            },
            reason: "test fixture",
            dosage: { sets: 1, reps_or_hold_time: "45s hold", tempo: "hold", rest: "3s" },
          },
          {
            exercise: {
              ex_id: "ex_rep_live",
              name: "Eccentric Heel Drop",
              category: "eccentric_biased",
              loading_profile: "eccentric_biased",
              setup_instructions: null,
              execution_cues: [],
              patient_facing_explanation: null,
            },
            reason: "test fixture",
            dosage: { sets: 1, reps_or_hold_time: 10, tempo: "2-0-6", rest: "3s" },
          },
        ],
      },
      exerciseStates: [
        { exerciseId: "ex_hold_live", status: "not_started", startedAt: null, completedAt: null, setOutcomes: [], problemReports: [] },
        { exerciseId: "ex_rep_live", status: "not_started", startedAt: null, completedAt: null, setOutcomes: [], problemReports: [] },
      ],
      currentExerciseIndex: 0,
    };
    await page.evaluate(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: `tenotrainer.activeSession.v2.${legacyUserId}`, value: JSON.stringify(localSession) }
    );

    await page.goto(`${BASE_URL}/patient/session`);
    await page.getByText("Resume Session").click();

    // --- Exercise 0: hold-based. Must show "Log Set", never a fabricated one-tap default. ---
    await page.waitForSelector("text=Double-Leg Calf Isometric Hold");
    const holdBodyText = await page.locator("main, div").first().innerText().catch(() => page.textContent("body"));
    check("hold exercise: shows 'Log Set', not a one-tap 'Complete Set'", await page.getByRole("button", { name: "Log Set" }).isVisible());
    check("hold exercise: does NOT show a one-tap 'Complete Set' button", (await page.getByRole("button", { name: "Complete Set" }).count()) === 0);

    await page.getByRole("button", { name: "Log Set" }).click();
    const repsInput = page.locator('input[type="number"]').first();
    const prefillValue = await repsInput.inputValue();
    check("hold exercise: edit input starts EMPTY, never prefilled with a parsed number (e.g. 45)", prefillValue === "", `got "${prefillValue}"`);

    const submitButton = page.getByRole("button", { name: "Complete Set" });
    check("hold exercise: submit is disabled with no value entered (no fallback to a fabricated number)", await submitButton.isDisabled());

    await repsInput.fill("40");
    check("hold exercise: submit enables once a real number is typed", !(await submitButton.isDisabled()));
    await submitButton.click();

    // --- Exercise transition ---
    await page.getByText("Next Exercise").click();

    // --- Exercise 1: rep-based. One-tap "Complete Set" must be unchanged. ---
    await page.waitForSelector("text=Eccentric Heel Drop");
    check("rep exercise: one-tap 'Complete Set' still present (unchanged)", await page.getByRole("button", { name: "Complete Set" }).isVisible());
    check("rep exercise: no 'Log Set' shown (it has a genuine numeric prescription)", (await page.getByRole("button", { name: "Log Set" }).count()) === 0);
    await page.getByRole("button", { name: "Complete Set" }).click();

    // --- M2 -> M3 handoff: SessionResponseFlow auto-bootstraps for real. ---
    // Poll rather than a fixed sleep — the real createRehabSession +
    // exercises-complete POSTs race the test script, not just render timing.
    let sessionRow = null;
    let setRows = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const { data } = await admin
        .from("rehab_sessions")
        .select("id")
        .eq("user_id", userId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        const { data: rows } = await admin.from("set_outcomes").select("exercise_id, prescribed_reps, actual_reps").eq("rehab_session_id", data.id);
        if (rows && rows.length >= 2) {
          sessionRow = data;
          setRows = rows;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    check("M3: a real rehab_sessions row was created via the actual handoff", Boolean(sessionRow));

    if (sessionRow) {
      const holdRow = setRows?.find((r) => r.exercise_id === "ex_hold_live");
      const repRow = setRows?.find((r) => r.exercise_id === "ex_rep_live");
      check("M3 set_outcomes: hold exercise stored prescribed_reps = NULL (never the fabricated 45)", holdRow && holdRow.prescribed_reps === null, JSON.stringify(holdRow));
      check("M3 set_outcomes: hold exercise stored the patient's real typed actual_reps (40)", holdRow && holdRow.actual_reps === 40, JSON.stringify(holdRow));
      check("M3 set_outcomes: rep exercise stored the real numeric prescribed_reps (10)", repRow && repRow.prescribed_reps === 10, JSON.stringify(repRow));
      check("M3 set_outcomes: rep exercise stored the real numeric actual_reps (10, from the one-tap default)", repRow && repRow.actual_reps === 10, JSON.stringify(repRow));

      // --- M6 Loading History: this same real session displayed correctly. ---
      await page.goto(`${BASE_URL}/patient/progress`);
      await page.waitForSelector("text=Loading History");
      const progressText = await page.locator("main").innerText();
      check("M6 Loading History: shows the hold exercise's real recorded value with 's held' unit", progressText.includes("40s held"), progressText);
      check("M6 Loading History: shows the rep exercise's real recorded value with 'reps' unit", progressText.includes("10 reps"), progressText);
      check("M6 Loading History: hold exercise's prescription text ('45s hold') shown, never a fabricated number", progressText.includes("45s hold"), progressText);
    }

    await context.close();
  } finally {
    await browser.close();
    // Teardown
    const sessionIds = (await admin.from("rehab_sessions").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
    if (sessionIds.length > 0) {
      await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
      await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("set_outcomes").delete().in("rehab_session_id", sessionIds);
      await admin.from("session_guidance_contexts").delete().in("rehab_session_id", sessionIds);
      await admin.from("cautious_return_contexts").delete().in("rehab_session_id", sessionIds);
    }
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    await admin.from("organization_members").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    if (legacyUserId != null) {
      legacyDb.prepare("DELETE FROM onboarding_assessments WHERE user_id = ?").run(legacyUserId);
      legacyDb.prepare("DELETE FROM rehab_plans WHERE user_id = ?").run(legacyUserId);
      legacyDb.prepare("DELETE FROM users WHERE id = ?").run(legacyUserId);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
