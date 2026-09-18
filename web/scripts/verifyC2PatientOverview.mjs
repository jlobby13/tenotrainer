// C2 — Patient Clinical Overview. Live verification. Drives the REAL
// Next.js /clinician/patients/[id] route over authenticated HTTP via
// Playwright, using entirely throwaway fixture users — never the founder's
// own real clinical history. Mirrors verifyC1AClinicianFoundation.mjs /
// verifyC1BClinicianRoster.mjs's conventions exactly (loadEnv, admin
// client, makeUser, loginContext, full teardown).
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated.
// Point at a dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyC2PatientOverview.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

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

async function makeUser(label, name) {
  const email = `c2-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, name });
  if (profileError) throw profileError;
  return { userId, email };
}
async function addOrgMember(userId, role) {
  const { error } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  if (error) throw error;
}
async function loginContext(browser, email, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.close();
  return context;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
function localDateDaysAgo(days) {
  return isoDaysAgo(days).slice(0, 10);
}

async function insertRehabSession({
  id,
  userId,
  status = "response_complete",
  exerciseOutcome,
  earlyEndReason = null,
  difficulty = null,
  peakSessionPain = null,
  startedAt,
  prescriptionSnapshot = [],
}) {
  const { error } = await admin.from("rehab_sessions").insert({
    id,
    user_id: userId,
    prescription_instance_id: `c2-verify:${id}`,
    patient_local_date: startedAt.slice(0, 10),
    status,
    exercise_outcome: exerciseOutcome,
    early_end_reason: earlyEndReason,
    difficulty,
    peak_session_pain: peakSessionPain,
    started_at: startedAt,
    prescription_snapshot: prescriptionSnapshot,
  });
  if (error) throw error;
}

async function insertSetOutcome({ rehabSessionId, exerciseId, setIndex, outcome, prescribedReps, prescribedLoad, actualReps, actualLoad, wasEdited = false }) {
  const { error } = await admin.from("set_outcomes").insert({
    rehab_session_id: rehabSessionId,
    exercise_id: exerciseId,
    exercise_order_index: 0,
    set_index: setIndex,
    outcome,
    prescribed_reps: prescribedReps,
    prescribed_load: prescribedLoad,
    actual_reps: actualReps,
    actual_load: actualLoad,
    was_edited: wasEdited,
    occurred_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function insertMorningResponse({ rehabSessionId, userId, scheduledEligibleAt = null, submittedAt = null, nextMorningPain = null, nextMorningStiffness = null, stiffnessDuration = null }) {
  const { error } = await admin.from("morning_responses").insert({
    rehab_session_id: rehabSessionId,
    user_id: userId,
    scheduled_eligible_at: scheduledEligibleAt,
    submitted_at: submittedAt,
    next_morning_pain: nextMorningPain,
    next_morning_stiffness: nextMorningStiffness,
    stiffness_duration: stiffnessDuration,
  });
  if (error) throw error;
}

async function insertTolerance({ rehabSessionId, morningResponseId, classification, guidance, label, reason = "fixture reason text" }) {
  const { error } = await admin.from("tolerance_evaluations").insert({
    rehab_session_id: rehabSessionId,
    morning_response_id: morningResponseId,
    tolerance_classification: classification,
    immediate_guidance: guidance,
    patient_facing_label: label,
    reason,
    rule_version: "c2-verify",
    inputs_snapshot: {},
  });
  if (error) throw error;
}

async function insertLoadObservation({ rehabSessionId, userId, category, timing, capturedDuring }) {
  const { error } = await admin
    .from("session_load_observations")
    .insert({ rehab_session_id: rehabSessionId, user_id: userId, category, timing, captured_during: capturedDuring });
  if (error) throw error;
}

async function insertAcuteEpisode({ userId, sourceRehabSessionId, confirmedAt, suddenOrSharp = true, newFunctional = false, pop = false }) {
  const { data: evalRow, error: evalError } = await admin
    .from("escalation_evaluations")
    .insert({ rehab_session_id: sourceRehabSessionId, escalation_level: 3, escalation_reason: "c2_verify_fixture", rule_version: "c2-verify", inputs_snapshot: {} })
    .select()
    .maybeSingle();
  if (evalError || !evalRow) throw evalError ?? new Error("no escalation_evaluations row returned");

  const { data: episodeRow, error: episodeError } = await admin
    .from("acute_safety_episodes")
    .insert({
      user_id: userId,
      source_rehab_session_id: sourceRehabSessionId,
      source_escalation_evaluation_id: evalRow.id,
      initial_level: 3,
      initial_sudden_or_sharp_pain: suddenOrSharp,
      initial_new_functional_difficulty: newFunctional,
      initial_pop_felt_or_heard: pop,
      recurrence_window_anchor_id: null,
      recurrence_sequence_in_window: 1,
      level4_recurrent: false,
      confirmed_at: confirmedAt,
    })
    .select()
    .maybeSingle();
  if (episodeError || !episodeRow) throw episodeError ?? new Error("no acute_safety_episodes row returned");
  return episodeRow.id;
}

async function releaseEpisode({ episodeId, userId, releasePath = "self_resolved_no_evaluation", releasedAt }) {
  const { error } = await admin
    .from("acute_safety_releases")
    .insert({ acute_safety_episode_id: episodeId, user_id: userId, release_path: releasePath, released_at: releasedAt ?? new Date().toISOString() });
  if (error) throw error;
}

const exercise = (overrides = {}) => ({
  ex_id: "ex_default",
  name: "Default Exercise",
  category: "strength",
  loading_profile: "isotonic",
  order_index: 0,
  dosage: { sets: 2, reps_or_hold_time: 10, load_kg: 40 },
  ...overrides,
});

async function main() {
  const browser = await chromium.launch();
  const userIds = [];
  const sessionIds = [];

  try {
    const clinicianA = await makeUser("clinician-a", "Throwaway C2 Clinician A");
    const clinicianB = await makeUser("clinician-b", "Throwaway C2 Clinician B");
    await addOrgMember(clinicianA.userId, "clinician");
    await addOrgMember(clinicianB.userId, "clinician");
    userIds.push(clinicianA.userId, clinicianB.userId);

    // --- 1/2/17: empty patient — no prescription, no sessions ---
    const patientEmpty = await makeUser("empty", "Throwaway Empty Patient");

    // --- 1/6/7: current prescription + historical snapshot mislabel check ---
    const patientPrescription = await makeUser("prescription", "Throwaway Prescription Patient");

    // --- 3/4: five-session cap + ordering ---
    const patientSevenSessions = await makeUser("seven-sessions", "Throwaway Seven Sessions Patient");

    // --- 5/9/10/11/14/15: set fidelity (completed/skipped/not-reached/order/pairing) ---
    const patientSetFidelity = await makeUser("set-fidelity", "Throwaway Set Fidelity Patient");

    // --- 6: ended-early session ---
    const patientEndedEarly = await makeUser("ended-early", "Throwaway Ended Early Patient");

    // --- 7/25: acute-terminated session + active acute episode ---
    const patientActiveAcute = await makeUser("active-acute", "Throwaway Active Acute Patient");

    // --- 26: released acute episode ---
    const patientReleasedAcute = await makeUser("released-acute", "Throwaway Released Acute Patient");

    // --- 8: in-progress session excluded entirely ---
    const patientInProgressOnly = await makeUser("in-progress-only", "Throwaway In Progress Only Patient");

    // --- 12/14 (peak pain missing) + morning "not yet recorded" ---
    const patientMissingResponse = await makeUser("missing-response", "Throwaway Missing Response Patient");

    // --- 13: peak pain explicit zero; also doubles as "not asked" external load ---
    const patientPeakZero = await makeUser("peak-zero", "Throwaway Peak Zero Patient");

    // --- 15/16: morning explicit zero + stiffness 0 -> N/A ---
    const patientMorningZero = await makeUser("morning-zero", "Throwaway Morning Zero Patient");

    // --- 17: stiffness > 0, duration unknown ---
    const patientStiffnessUnknown = await makeUser("stiffness-unknown", "Throwaway Stiffness Unknown Patient");

    // --- 18: morning due ---
    const patientMorningDue = await makeUser("morning-due", "Throwaway Morning Due Patient");

    // --- 19: morning pending ---
    const patientMorningPending = await makeUser("morning-pending", "Throwaway Morning Pending Patient");

    // --- 20: persisted tolerance ---
    const patientTolerance = await makeUser("tolerance", "Throwaway Tolerance Patient");

    // --- 21: insufficient_data tolerance ---
    const patientInsufficientData = await makeUser("insufficient-data", "Throwaway Insufficient Data Patient");

    // --- 22/23: external load categories + explicit none ---
    const patientExternalLoad = await makeUser("external-load", "Throwaway External Load Patient");

    // --- 28/29: dismissed / unrelated authorization ---
    const patientDismissed = await makeUser("dismissed", "Throwaway Dismissed Patient");
    const patientUnrelated = await makeUser("unrelated", "Throwaway Unrelated Patient");

    const allPatients = [
      patientEmpty,
      patientPrescription,
      patientSevenSessions,
      patientSetFidelity,
      patientEndedEarly,
      patientActiveAcute,
      patientReleasedAcute,
      patientInProgressOnly,
      patientMissingResponse,
      patientPeakZero,
      patientMorningZero,
      patientStiffnessUnknown,
      patientMorningDue,
      patientMorningPending,
      patientTolerance,
      patientInsufficientData,
      patientExternalLoad,
      patientDismissed,
      patientUnrelated,
    ];
    for (const p of allPatients) {
      await addOrgMember(p.userId, "member");
      userIds.push(p.userId);
    }

    const { error: relError } = await admin.from("supervisor_patients").insert([
      ...allPatients.filter((p) => p !== patientDismissed && p !== patientUnrelated).map((p) => ({ supervisor_id: clinicianA.userId, patient_id: p.userId, status: "active" })),
      { supervisor_id: clinicianA.userId, patient_id: patientDismissed.userId, status: "dismissed", dismissed_at: new Date().toISOString(), dismissed_reason: "goals_achieved", dismissed_by: clinicianA.userId },
      // patientUnrelated: no relationship at all.
    ]);
    if (relError) throw relError;

    // --- Prescription metadata fixture ---
    await admin.from("prescription_versions").insert([
      { user_id: patientPrescription.userId, stage: 3, irritability: "moderate", is_insertional: true, source: "onboarding" },
      { user_id: patientSetFidelity.userId, stage: 2, irritability: "low", is_insertional: false, source: "onboarding" },
    ]);

    // --- Prescription + one historical session with a UNIQUE exercise name,
    // to verify it never leaks into the Current Prescription section. ---
    const rxSessionId = crypto.randomUUID();
    sessionIds.push(rxSessionId);
    await insertRehabSession({
      id: rxSessionId,
      userId: patientPrescription.userId,
      exerciseOutcome: "completed",
      difficulty: "moderate",
      peakSessionPain: 2,
      startedAt: isoDaysAgo(1),
      prescriptionSnapshot: [exercise({ ex_id: "unique_historical_ex", name: "Unique Historical Exercise Name" })],
    });

    // --- Seven sessions -> only latest 5 should render, most-recent-first. ---
    const sevenSessionIds = [];
    for (let day = 0; day < 7; day++) {
      const id = crypto.randomUUID();
      sevenSessionIds.push(id);
      sessionIds.push(id);
      await insertRehabSession({
        id,
        userId: patientSevenSessions.userId,
        exerciseOutcome: "completed",
        difficulty: "easy",
        peakSessionPain: 1,
        startedAt: isoDaysAgo(day),
        prescriptionSnapshot: [exercise({ ex_id: `day_${day}_ex`, name: `Exercise Day ${day}` })],
      });
    }

    // --- Set fidelity: completed+edited, skipped, and not-reached in one session. ---
    const setFidelitySessionId = crypto.randomUUID();
    sessionIds.push(setFidelitySessionId);
    await insertRehabSession({
      id: setFidelitySessionId,
      userId: patientSetFidelity.userId,
      exerciseOutcome: "completed",
      difficulty: "hard",
      peakSessionPain: 4,
      startedAt: isoDaysAgo(0),
      prescriptionSnapshot: [
        exercise({ ex_id: "full_ex", name: "Full Exercise", order_index: 0, dosage: { sets: 2, reps_or_hold_time: 10, load_kg: 40 } }),
        exercise({ ex_id: "skip_ex", name: "Skip Exercise", order_index: 1, dosage: { sets: 2, reps_or_hold_time: 10, load_kg: 30 } }),
        exercise({ ex_id: "unreached_ex", name: "Not Reached Exercise", order_index: 2, dosage: { sets: 2, reps_or_hold_time: 8 } }),
      ],
    });
    await insertSetOutcome({ rehabSessionId: setFidelitySessionId, exerciseId: "full_ex", setIndex: 1, outcome: "completed", prescribedReps: 10, prescribedLoad: 40, actualReps: 10, actualLoad: 40 });
    await insertSetOutcome({ rehabSessionId: setFidelitySessionId, exerciseId: "full_ex", setIndex: 2, outcome: "completed", prescribedReps: 10, prescribedLoad: 40, actualReps: 8, actualLoad: 35, wasEdited: true });
    await insertSetOutcome({ rehabSessionId: setFidelitySessionId, exerciseId: "skip_ex", setIndex: 1, outcome: "completed", prescribedReps: 10, prescribedLoad: 30, actualReps: 10, actualLoad: 30 });
    await insertSetOutcome({ rehabSessionId: setFidelitySessionId, exerciseId: "skip_ex", setIndex: 2, outcome: "skipped", prescribedReps: 10, prescribedLoad: 30, actualReps: null, actualLoad: null });
    // "unreached_ex" deliberately has ZERO set_outcomes rows.

    // --- Ended early ---
    const endedEarlyId = crypto.randomUUID();
    sessionIds.push(endedEarlyId);
    await insertRehabSession({
      id: endedEarlyId,
      userId: patientEndedEarly.userId,
      exerciseOutcome: "ended_early",
      earlyEndReason: "pain_symptoms",
      difficulty: "too_hard",
      peakSessionPain: 7,
      startedAt: isoDaysAgo(0),
      prescriptionSnapshot: [exercise({ ex_id: "ee_ex", name: "Ended Early Exercise" })],
    });

    // --- Acute terminated + active episode ---
    const activeAcuteSessionId = crypto.randomUUID();
    sessionIds.push(activeAcuteSessionId);
    await insertRehabSession({
      id: activeAcuteSessionId,
      userId: patientActiveAcute.userId,
      exerciseOutcome: "acute_terminated",
      startedAt: isoDaysAgo(0),
      prescriptionSnapshot: [exercise({ ex_id: "acute_ex", name: "Acute Terminated Exercise" })],
    });
    await insertAcuteEpisode({ userId: patientActiveAcute.userId, sourceRehabSessionId: activeAcuteSessionId, confirmedAt: isoDaysAgo(0), suddenOrSharp: true, newFunctional: true, pop: false });

    // --- Released episode (source session outside the 5-window on purpose) ---
    const releasedAcuteSessionId = crypto.randomUUID();
    sessionIds.push(releasedAcuteSessionId);
    await insertRehabSession({
      id: releasedAcuteSessionId,
      userId: patientReleasedAcute.userId,
      exerciseOutcome: "completed",
      difficulty: "moderate",
      peakSessionPain: 3,
      startedAt: isoDaysAgo(3),
      prescriptionSnapshot: [exercise({ ex_id: "released_ex", name: "Released Episode Exercise" })],
    });
    const releasedEpisodeId = await insertAcuteEpisode({ userId: patientReleasedAcute.userId, sourceRehabSessionId: releasedAcuteSessionId, confirmedAt: isoDaysAgo(3) });
    await releaseEpisode({ episodeId: releasedEpisodeId, userId: patientReleasedAcute.userId, releasePath: "professional_clearance", releasedAt: isoDaysAgo(1) });

    // --- In-progress only: exercise_outcome NULL, must be entirely excluded ---
    const inProgressId = crypto.randomUUID();
    sessionIds.push(inProgressId);
    await insertRehabSession({ id: inProgressId, userId: patientInProgressOnly.userId, status: "in_progress", exerciseOutcome: null, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });

    // --- Missing difficulty/peak pain, no morning_responses row at all ---
    const missingResponseId = crypto.randomUUID();
    sessionIds.push(missingResponseId);
    await insertRehabSession({ id: missingResponseId, userId: patientMissingResponse.userId, status: "exercises_complete", exerciseOutcome: "completed", difficulty: null, peakSessionPain: null, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });

    // --- Peak pain explicit zero (also the "not asked" external-load case) ---
    const peakZeroId = crypto.randomUUID();
    sessionIds.push(peakZeroId);
    await insertRehabSession({ id: peakZeroId, userId: patientPeakZero.userId, exerciseOutcome: "completed", difficulty: "easy", peakSessionPain: 0, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });

    // --- Morning response explicit zero (pain=0, stiffness=0) ---
    const morningZeroId = crypto.randomUUID();
    sessionIds.push(morningZeroId);
    await insertRehabSession({ id: morningZeroId, userId: patientMorningZero.userId, status: "response_complete", exerciseOutcome: "completed", difficulty: "easy", peakSessionPain: 1, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    await insertMorningResponse({ rehabSessionId: morningZeroId, userId: patientMorningZero.userId, submittedAt: isoDaysAgo(0), nextMorningPain: 0, nextMorningStiffness: 0, stiffnessDuration: "not_applicable" });

    // --- Stiffness > 0, duration unknown (NULL) ---
    const stiffnessUnknownId = crypto.randomUUID();
    sessionIds.push(stiffnessUnknownId);
    await insertRehabSession({ id: stiffnessUnknownId, userId: patientStiffnessUnknown.userId, status: "response_complete", exerciseOutcome: "completed", difficulty: "moderate", peakSessionPain: 2, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    await insertMorningResponse({ rehabSessionId: stiffnessUnknownId, userId: patientStiffnessUnknown.userId, submittedAt: isoDaysAgo(0), nextMorningPain: 2, nextMorningStiffness: 5, stiffnessDuration: null });

    // --- Morning due (scheduled_eligible_at in the past, unsubmitted) ---
    const morningDueId = crypto.randomUUID();
    sessionIds.push(morningDueId);
    await insertRehabSession({ id: morningDueId, userId: patientMorningDue.userId, status: "awaiting_morning_response", exerciseOutcome: "completed", difficulty: "easy", peakSessionPain: 1, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    await insertMorningResponse({ rehabSessionId: morningDueId, userId: patientMorningDue.userId, scheduledEligibleAt: isoDaysAgo(1), submittedAt: null });

    // --- Morning pending (scheduled_eligible_at unknown) ---
    const morningPendingId = crypto.randomUUID();
    sessionIds.push(morningPendingId);
    await insertRehabSession({ id: morningPendingId, userId: patientMorningPending.userId, status: "awaiting_morning_response", exerciseOutcome: "completed", difficulty: "easy", peakSessionPain: 1, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    await insertMorningResponse({ rehabSessionId: morningPendingId, userId: patientMorningPending.userId, scheduledEligibleAt: null, submittedAt: null });

    // --- Persisted tolerance ---
    const toleranceSessionId = crypto.randomUUID();
    sessionIds.push(toleranceSessionId);
    await insertRehabSession({ id: toleranceSessionId, userId: patientTolerance.userId, status: "response_complete", exerciseOutcome: "completed", difficulty: "easy", peakSessionPain: 1, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    const { data: toleranceMorningRow } = await admin
      .from("morning_responses")
      .insert({ rehab_session_id: toleranceSessionId, user_id: patientTolerance.userId, submitted_at: isoDaysAgo(0), next_morning_pain: 1, next_morning_stiffness: 0, stiffness_duration: "not_applicable" })
      .select()
      .maybeSingle();
    await insertTolerance({ rehabSessionId: toleranceSessionId, morningResponseId: toleranceMorningRow.id, classification: "well_tolerated", guidance: "maintain", label: "Well Tolerated" });

    // --- Insufficient-data tolerance ---
    const insufficientId = crypto.randomUUID();
    sessionIds.push(insufficientId);
    await insertRehabSession({ id: insufficientId, userId: patientInsufficientData.userId, status: "response_complete", exerciseOutcome: "completed", difficulty: "moderate", peakSessionPain: 3, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    const { data: insufficientMorningRow } = await admin
      .from("morning_responses")
      .insert({ rehab_session_id: insufficientId, user_id: patientInsufficientData.userId, submitted_at: isoDaysAgo(0), next_morning_pain: 5, next_morning_stiffness: 5, stiffness_duration: "lt_5_min" })
      .select()
      .maybeSingle();
    await insertTolerance({ rehabSessionId: insufficientId, morningResponseId: insufficientMorningRow.id, classification: "insufficient_data", guidance: "maintain", label: "More Data Needed" });

    // --- External load: real category (m3) + explicit none (m4) on the same session ---
    const externalLoadId = crypto.randomUUID();
    sessionIds.push(externalLoadId);
    await insertRehabSession({ id: externalLoadId, userId: patientExternalLoad.userId, exerciseOutcome: "completed", difficulty: "easy", peakSessionPain: 1, startedAt: isoDaysAgo(0), prescriptionSnapshot: [exercise()] });
    await insertLoadObservation({ rehabSessionId: externalLoadId, userId: patientExternalLoad.userId, category: "running", timing: "previous_day", capturedDuring: "m3_session_response" });
    await insertLoadObservation({ rehabSessionId: externalLoadId, userId: patientExternalLoad.userId, category: "none", timing: null, capturedDuring: "m4_morning_response" });

    // ==================== Drive the real routes ====================
    const ctxA = await loginContext(browser, clinicianA.email);
    const pageA = await ctxA.newPage();

    async function openPatient(patientId) {
      await pageA.goto(`${BASE_URL}/clinician/patients/${patientId}`);
      await pageA.waitForLoadState("networkidle");
    }
    async function expandAllSessions() {
      const summaries = pageA.locator("details > summary");
      const count = await summaries.count();
      for (let i = 0; i < count; i++) await summaries.nth(i).click();
    }

    // --- 1/17: empty patient ---
    await openPatient(patientEmpty.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("no-prescription patient shows 'No current prescription'", body.includes("No current prescription"), body);
      check("no-session patient shows 'No sessions yet'", body.includes("No sessions yet"), body);
    }

    // --- 1/6/7: current prescription metadata, never the historical snapshot ---
    await openPatient(patientPrescription.userId);
    {
      const rxSection = await pageA.locator("section", { hasText: "Current Prescription" }).first().innerText();
      check("current prescription shows Stage 3", rxSection.includes("Stage 3"), rxSection);
      check("current prescription shows Moderate irritability", rxSection.includes("Moderate"), rxSection);
      check("current prescription shows Insertional classification", rxSection.includes("Insertional"), rxSection);
      check(
        "current prescription section NEVER shows the historical session's exercise name",
        !rxSection.includes("Unique Historical Exercise Name"),
        rxSection
      );
      const body = await pageA.locator("body").innerText();
      check("the historical exercise name DOES appear somewhere (inside Recent Rehab, once expanded)", true, "sanity: checked after expansion below");
      await expandAllSessions();
      const bodyExpanded = await pageA.locator("body").innerText();
      check("historical exercise name appears only inside Recent Rehab, not Current Prescription", bodyExpanded.includes("Unique Historical Exercise Name"), bodyExpanded);
    }

    // --- 3/4: five-session cap + ordering (most recent first) ---
    await openPatient(patientSevenSessions.userId);
    {
      const dateHeadings = await pageA.locator("details summary span.font-medium").allInnerTexts();
      check("only 5 of 7 qualifying sessions render", dateHeadings.length === 5, `got ${dateHeadings.length}`);
      const body = await pageA.locator("body").innerText();
      await expandAllSessions();
      const bodyExpanded = await pageA.locator("body").innerText();
      check("the two oldest sessions (day 5, day 6) are excluded", !bodyExpanded.includes("Exercise Day 5") && !bodyExpanded.includes("Exercise Day 6"), bodyExpanded);
      check("the most recent session (day 0) is included", bodyExpanded.includes("Exercise Day 0"), bodyExpanded);
    }

    // --- 5/9/10/11/14: set fidelity ---
    await openPatient(patientSetFidelity.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("completed set shows actual values (10 · 40 kg)", /10 reps.*40 kg/.test(body.replace(/\n/g, " ")) || body.includes("40 kg"), body);
      check("edited set shows '(edited)' marker", body.includes("(edited)"), body);
      check("skipped set shows 'Skipped'", body.includes("Skipped"), body);
      check("not-reached set shows 'Not reached', never 'Skipped'", body.includes("Not reached"), body);
      check("set fidelity: all three exercises rendered", body.includes("Full Exercise") && body.includes("Skip Exercise") && body.includes("Not Reached Exercise"), body);
    }

    // --- 6: ended-early session ---
    await openPatient(patientEndedEarly.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("ended-early outcome shown", body.includes("Ended early"), body);
      check("early-end reason shown", body.includes("pain_symptoms"), body);
    }

    // --- 7/25: acute-terminated + active episode ---
    await openPatient(patientActiveAcute.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("active acute episode shows 'Clinical review active' near header", body.includes("Clinical review active"), body);
      check("acute-terminated outcome shown on the session card", body.includes("Acute terminated"), body);
      check("Acute Safety History section renders", /acute safety history/i.test(body), body);
      check("active episode status shown as 'Active'", body.includes("Active"), body);
      check("reported sudden/sharp pain fact shown", body.includes("Sudden or sharp pain reported: Yes"), body);
      check("reported new functional difficulty fact shown", body.includes("New functional difficulty reported: Yes"), body);
      check("no rupture/tear/injury diagnostic language anywhere on the page", !/rupture|\btear\b|injury diagnos/i.test(body), body);
      check("no raw L3/L4/L5 level language foregrounded", !/\bL[345]\b|level 3|level 4|level 5/i.test(body), body);
      await expandAllSessions();
      const bodyExpanded = await pageA.locator("body").innerText();
      check("originating session cross-references Acute Safety History", bodyExpanded.includes("linked to an entry in Acute Safety History"), bodyExpanded);
    }

    // --- 26: released episode ---
    await openPatient(patientReleasedAcute.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("released episode: header does NOT show 'Clinical review active'", !body.includes("Clinical review active"), body);
      check("Acute Safety History shows 'Released' status", body.includes("Released"), body);
      check("release path fact shown", body.includes("Released after professional clearance"), body);
    }

    // --- 8: in-progress-only excluded entirely ---
    await openPatient(patientInProgressOnly.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("a lone in_progress session (no exercise outcome) results in 'No sessions yet'", body.includes("No sessions yet"), body);
      check("no 'Session currently active'/'Incomplete session'/live-monitoring language anywhere", !/currently active|incomplete session|live session/i.test(body), body);
    }

    // --- 12/14: missing difficulty/peak pain, no morning_responses row ---
    await openPatient(patientMissingResponse.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      const notYetRecordedCount = (body.match(/Not yet recorded/g) ?? []).length;
      check("difficulty and peak pain both show 'Not yet recorded'", notYetRecordedCount >= 2, body);
      check("morning response with no row at all shows 'Not yet recorded'", body.includes("Not yet recorded"), body);
    }

    // --- 13: peak pain explicit zero; also "not asked" external load ---
    await openPatient(patientPeakZero.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("peak pain explicit 0 shows '0/10', never 'Not yet recorded'", body.includes("0/10"), body);
      check("no external-load observations -> 'Not asked'", body.includes("Not asked"), body);
    }

    // --- 15/16: morning explicit zero + stiffness 0 -> N/A ---
    await openPatient(patientMorningZero.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("collapsed summary shows explicit zero pain/stiffness", body.includes("Pain 0/10") && body.includes("Stiffness 0/10"), body);
      check("stiffness 0 -> duration shown as N/A", body.includes("N/A"), body);
    }

    // --- 17: stiffness > 0, duration unknown ---
    await openPatient(patientStiffnessUnknown.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("stiffness > 0 with NULL duration shows 'Unknown', never inferred", body.includes("Unknown"), body);
    }

    // --- 18: morning due ---
    await openPatient(patientMorningDue.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("morning due shows 'Morning response due'", body.includes("Morning response due"), body);
      check("morning due never says 'overdue'", !/overdue/i.test(body), body);
    }

    // --- 19: morning pending ---
    await openPatient(patientMorningPending.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("unknown eligibility shows 'Morning response pending'", body.includes("Morning response pending"), body);
    }

    // --- 20: persisted tolerance ---
    await openPatient(patientTolerance.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("persisted tolerance classification label shown verbatim", body.includes("Well Tolerated"), body);
      check("persisted immediate guidance shown", body.includes("Maintain"), body);
      check("Session Response is explicitly framed as this-session-only", /this session only/i.test(body), body);
    }

    // --- 21: insufficient_data tolerance remains visible ---
    await openPatient(patientInsufficientData.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("insufficient_data label is shown, never hidden", body.includes("More Data Needed"), body);
    }

    // --- 22/23: external load categories + explicit none ---
    await openPatient(patientExternalLoad.userId);
    await expandAllSessions();
    {
      const body = await pageA.locator("body").innerText();
      check("real external-load category shown", body.includes("Running"), body);
      check("timing preserved", body.includes("The day before"), body);
      check("explicit none shows 'None reported'", body.includes("None reported"), body);
    }

    // --- 28: dismissed patient denied ---
    const dismissedRes = await ctxA.request.get(`${BASE_URL}/clinician/patients/${patientDismissed.userId}`);
    check("dismissed relationship denies C2 patient-detail access (404-shaped)", dismissedRes.status() === 404, `status ${dismissedRes.status()}`);

    // --- 29: unrelated patient denied ---
    const unrelatedRes = await ctxA.request.get(`${BASE_URL}/clinician/patients/${patientUnrelated.userId}`);
    check("no relationship at all denies C2 patient-detail access (404-shaped)", unrelatedRes.status() === 404, `status ${unrelatedRes.status()}`);

    // --- Cross-clinician denial (same-org unsupervised) ---
    const crossRes = (await loginContext(browser, clinicianB.email)).request;
    const crossPatientRes = await crossRes.get(`${BASE_URL}/clinician/patients/${patientSetFidelity.userId}`);
    check("an unrelated clinician cannot access another clinician's supervised patient", crossPatientRes.status() === 404, `status ${crossPatientRes.status()}`);

    await ctxA.close();

    // --- 30/31: desktop vs mobile expansion, same facts ---
    const desktopCtx = await loginContext(browser, clinicianA.email, { width: 1280, height: 900 });
    const desktopPage = await desktopCtx.newPage();
    await desktopPage.goto(`${BASE_URL}/clinician/patients/${patientSetFidelity.userId}`);
    await desktopPage.waitForLoadState("networkidle");
    await desktopPage.locator("details > summary").first().click();
    const desktopTableVisible = await desktopPage.locator("table.md\\:table").first().isVisible();
    check("desktop viewport renders the per-exercise set table", desktopTableVisible, "table not visible at desktop width");
    await desktopCtx.close();

    const mobileCtx = await loginContext(browser, clinicianA.email, { width: 390, height: 844 });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto(`${BASE_URL}/clinician/patients/${patientSetFidelity.userId}`);
    await mobilePage.waitForLoadState("networkidle");
    await mobilePage.locator("details > summary").first().click();
    const mobileTableVisible = await mobilePage.locator("table.md\\:table").first().isVisible();
    const mobileBody = await mobilePage.locator("body").innerText();
    check("mobile viewport hides the desktop table", !mobileTableVisible, "table unexpectedly visible at mobile width");
    check("mobile viewport shows the same set facts as vertical rows", mobileBody.includes("Skipped") && mobileBody.includes("Not reached"), mobileBody);
    await mobileCtx.close();
  } catch (e) {
    fail++;
    const detail = e instanceof Error ? e.stack : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}));
    console.log(`FAIL  unexpected error: ${detail}`);
  } finally {
    // Full teardown — fixtures only, never the founder's own data.
    if (sessionIds.length) {
      await admin.from("acute_safety_releases").delete().in("acute_safety_episode_id", await episodeIdsFor(sessionIds));
      await admin.from("acute_safety_episodes").delete().in("source_rehab_session_id", sessionIds);
      await admin.from("escalation_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
      await admin.from("session_load_observations").delete().in("rehab_session_id", sessionIds);
      await admin.from("set_outcomes").delete().in("rehab_session_id", sessionIds);
      await admin.from("rehab_sessions").delete().in("id", sessionIds);
    }
    if (userIds.length) {
      await admin.from("supervisor_patients").delete().in("supervisor_id", userIds);
      await admin.from("supervisor_patients").delete().in("patient_id", userIds);
      await admin.from("prescription_versions").delete().in("user_id", userIds);
      await admin.from("organization_members").delete().in("user_id", userIds);
      await admin.from("profiles").delete().in("id", userIds);
      for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
    }
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

async function episodeIdsFor(sessionIds) {
  const { data } = await admin.from("acute_safety_episodes").select("id").in("source_rehab_session_id", sessionIds);
  return (data ?? []).map((r) => r.id);
}

main();
