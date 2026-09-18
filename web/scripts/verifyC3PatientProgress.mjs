// C3 — Longitudinal Clinical Progress. Live verification. Drives the REAL
// Next.js /clinician/patients/[id]/progress route over authenticated HTTP
// via Playwright, using entirely throwaway fixture users — never the
// founder's own real clinical history. Mirrors verifyC1AClinicianFoundation.mjs
// / verifyC1BClinicianRoster.mjs / verifyC2PatientOverview.mjs's conventions
// exactly (loadEnv, admin client, makeUser, loginContext, full teardown).
//
// m6_longitudinal_interpretations rows are inserted DIRECTLY via the admin
// client (never through the real generation engine, which needs a full
// realistic session history to run) — same fixture philosophy as C2's
// script inserting acute_safety_episodes/set_outcomes directly. This tests
// the READ/DISPLAY path only, exactly what C3 itself is.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated.
// Point at a dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyC3PatientProgress.mjs
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
  const email = `c3-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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

async function insertRehabSession({ id, userId, startedAt }) {
  const { error } = await admin.from("rehab_sessions").insert({
    id,
    user_id: userId,
    prescription_instance_id: `c3-verify:${id}`,
    patient_local_date: startedAt.slice(0, 10),
    status: "response_complete",
    exercise_outcome: "completed",
    started_at: startedAt,
    prescription_snapshot: [],
  });
  if (error) throw error;
}

async function insertInterpretation({ userId, domain, resultState, windowDefinition, resultDetail, reasonCodes = [], rehabSessionIds = [], generatedAt }) {
  const { data, error } = await admin
    .from("m6_longitudinal_interpretations")
    .insert({
      user_id: userId,
      domain,
      ruleset_version: "c3-verify",
      window_definition: windowDefinition,
      window_start_date: null,
      window_end_date: null,
      result_state: resultState,
      result_detail: resultDetail,
      ...(generatedAt ? { generated_at: generatedAt } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("no interpretation row returned");
  const interpretationId = data.id;

  if (reasonCodes.length > 0) {
    const { error: rcError } = await admin.from("m6_interpretation_reason_codes").insert(reasonCodes.map((reason_code) => ({ interpretation_id: interpretationId, reason_code })));
    if (rcError) throw rcError;
  }
  if (rehabSessionIds.length > 0) {
    const { error: rsError } = await admin
      .from("m6_interpretation_rehab_sessions")
      .insert(rehabSessionIds.map((rehab_session_id) => ({ interpretation_id: interpretationId, rehab_session_id })));
    if (rsError) throw rsError;
  }
  return interpretationId;
}

function coreDomain(overrides = {}) {
  return {
    direction: "improving",
    consistency: "consistent",
    recentMedian: 2,
    previousMedian: 5,
    recentIqr: { q1: 1, q3: 3, iqr: 2 },
    previousIqr: { q1: 4, q3: 6, iqr: 2 },
    frequencyPattern: "favorable_lower",
    medianDirection: "lower",
    recentValues: [1, 2, 2, 3, 8],
    previousValues: [5, 5, 5, 5, 5],
    ...overrides,
  };
}
function msdSufficient(direction) {
  return { direction, recentMedianRank: 1, previousMedianRank: 2, recentSampleSize: 4, previousSampleSize: 4 };
}
const MSD_INSUFFICIENT = { direction: "insufficient_data", recentMedianRank: null, previousMedianRank: null, recentSampleSize: 1, previousSampleSize: 1 };

function symptomsGeneratedDetail({ P = coreDomain(), MP = coreDomain(), MS = coreDomain(), msd = MSD_INSUFFICIENT } = {}) {
  return {
    core: { P, MP, MS },
    msd,
    coverageContext: { rawCounts: { attemptedSessionCount: 10, completedSessionCount: 10, completeResponseEpisodeCount: 10, safetyBlockedOnlyCount: 0 } },
    distinctPrescriptionVersionIds: ["v1"],
  };
}

function capacityDetail(overrides = {}) {
  return {
    construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
    qualifyingDemonstrationCount: 0,
    qualifyingDemonstrationRehabSessionIds: [],
    wellToleratedQualifyingCount: 0,
    cautionMaintainQualifyingCount: 0,
    confirmedByTwoOfFourRule: false,
    recentLoadingLowerThanPrior: false,
    recentLoadingLowerThanPriorNote: null,
    moreDataNeededReason: null,
    mechanicallyHigherRehabSessionIds: [],
    mechanicallyLowerRehabSessionIds: [],
    hasNonDominatingExposure: false,
    recentOpportunities: [],
    ...overrides,
  };
}

async function main() {
  const browser = await chromium.launch();
  const userIds = [];
  const sessionIds = [];

  try {
    const clinicianA = await makeUser("clinician-a", "Throwaway C3 Clinician A");
    const clinicianB = await makeUser("clinician-b", "Throwaway C3 Clinician B");
    await addOrgMember(clinicianA.userId, "clinician");
    await addOrgMember(clinicianB.userId, "clinician");
    userIds.push(clinicianA.userId, clinicianB.userId);

    const patientEmpty = await makeUser("empty", "Throwaway Empty Progress Patient");
    const patientSymptomsImproving = await makeUser("symptoms-improving", "Throwaway Symptoms Improving Patient");
    const patientSymptomsStableSame = await makeUser("symptoms-stable-same", "Throwaway Symptoms Stable Same Patient");
    const patientSymptomsMixed = await makeUser("symptoms-mixed", "Throwaway Symptoms Mixed Patient");
    const patientSymptomsTrendingHigher = await makeUser("symptoms-trending-higher", "Throwaway Symptoms Trending Higher Patient");
    const patientSymptomsInsufficient = await makeUser("symptoms-insufficient", "Throwaway Symptoms Insufficient Patient");
    const patientCapacityAllStates = await makeUser("capacity-all-states", "Throwaway Capacity All States Patient");
    const patientTRImproving = await makeUser("tr-improving", "Throwaway TR Improving Patient");
    const patientTRStable = await makeUser("tr-stable", "Throwaway TR Stable Patient");
    const patientTRVariable = await makeUser("tr-variable", "Throwaway TR Variable Patient");
    const patientTRUnsettled = await makeUser("tr-unsettled", "Throwaway TR Unsettled Patient");
    const patientTRMoreDataGenerated = await makeUser("tr-more-data", "Throwaway TR More Data Patient");
    const patientTRInsufficientWindow = await makeUser("tr-insufficient-window", "Throwaway TR Insufficient Window Patient");
    const patientActiveAcute = await makeUser("active-acute", "Throwaway Active Acute Progress Patient");
    const patientDismissed = await makeUser("dismissed", "Throwaway Dismissed Progress Patient");
    const patientUnrelated = await makeUser("unrelated", "Throwaway Unrelated Progress Patient");

    const allPatients = [
      patientEmpty,
      patientSymptomsImproving,
      patientSymptomsStableSame,
      patientSymptomsMixed,
      patientSymptomsTrendingHigher,
      patientSymptomsInsufficient,
      patientCapacityAllStates,
      patientTRImproving,
      patientTRStable,
      patientTRVariable,
      patientTRUnsettled,
      patientTRMoreDataGenerated,
      patientTRInsufficientWindow,
      patientActiveAcute,
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
    ]);
    if (relError) throw relError;

    // --- Symptoms: improving, with a previous (changed) row ---
    {
      const sIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(() => crypto.randomUUID());
      sessionIds.push(...sIds);
      await Promise.all(sIds.map((id, i) => insertRehabSession({ id, userId: patientSymptomsImproving.userId, startedAt: isoDaysAgo(10 - i) })));
      await insertInterpretation({
        userId: patientSymptomsImproving.userId,
        domain: "symptoms_short_window",
        resultState: "symptoms_stable",
        windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
        resultDetail: symptomsGeneratedDetail(),
        generatedAt: isoDaysAgo(5),
      });
      await insertInterpretation({
        userId: patientSymptomsImproving.userId,
        domain: "symptoms_short_window",
        resultState: "symptoms_improving",
        windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
        resultDetail: symptomsGeneratedDetail({ msd: msdSufficient("shorter") }),
        rehabSessionIds: sIds,
        generatedAt: isoDaysAgo(0),
      });
    }

    // --- Symptoms: stable, previous also stable (unchanged) ---
    {
      await insertInterpretation({
        userId: patientSymptomsStableSame.userId,
        domain: "symptoms_short_window",
        resultState: "symptoms_stable",
        windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
        resultDetail: symptomsGeneratedDetail({ P: coreDomain({ direction: "stable", frequencyPattern: "no_dominant_pattern" }) }),
        generatedAt: isoDaysAgo(5),
      });
      await insertInterpretation({
        userId: patientSymptomsStableSame.userId,
        domain: "symptoms_short_window",
        resultState: "symptoms_stable",
        windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
        resultDetail: symptomsGeneratedDetail({ P: coreDomain({ direction: "stable", frequencyPattern: "no_dominant_pattern" }) }),
        generatedAt: isoDaysAgo(0),
      });
    }

    // --- Symptoms: mixed, with reason codes (incl. external load) ---
    {
      const mixedSessionId = crypto.randomUUID();
      sessionIds.push(mixedSessionId);
      await insertRehabSession({ id: mixedSessionId, userId: patientSymptomsMixed.userId, startedAt: isoDaysAgo(1) });
      await insertInterpretation({
        userId: patientSymptomsMixed.userId,
        domain: "symptoms_short_window",
        resultState: "mixed_symptom_response",
        windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
        resultDetail: symptomsGeneratedDetail({
          P: coreDomain({ direction: "improving" }),
          MS: coreDomain({ direction: "trending_higher", frequencyPattern: "unfavorable_higher", medianDirection: "higher", previousMedian: 2, recentValues: [5, 5, 5, 1, 1] }),
        }),
        reasonCodes: ["mixed_symptom_directions", "external_loading_context_present"],
        rehabSessionIds: [mixedSessionId],
      });
    }

    // --- Symptoms: trending higher, no previous ---
    await insertInterpretation({
      userId: patientSymptomsTrendingHigher.userId,
      domain: "symptoms_short_window",
      resultState: "symptoms_trending_higher",
      windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
      resultDetail: symptomsGeneratedDetail({
        P: coreDomain({ direction: "trending_higher", frequencyPattern: "unfavorable_higher", medianDirection: "higher", previousMedian: 2, recentValues: [5, 5, 5, 5, 1] }),
        MP: coreDomain({ direction: "trending_higher", frequencyPattern: "unfavorable_higher", medianDirection: "higher", previousMedian: 2, recentValues: [5, 5, 5, 5, 1] }),
      }),
    });

    // --- Symptoms: insufficient ---
    await insertInterpretation({
      userId: patientSymptomsInsufficient.userId,
      domain: "symptoms_short_window",
      resultState: "more_data_needed",
      windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: false },
      resultDetail: { eligibleEpisodeCount: 6 },
    });

    // --- Capacity: 7 constructs on one patient, covering every state ---
    {
      const setVectorSession1 = crypto.randomUUID();
      const setVectorSession2 = crypto.randomUUID();
      sessionIds.push(setVectorSession1, setVectorSession2);
      await insertRehabSession({ id: setVectorSession1, userId: patientCapacityAllStates.userId, startedAt: isoDaysAgo(1) });
      await insertRehabSession({ id: setVectorSession2, userId: patientCapacityAllStates.userId, startedAt: isoDaysAgo(3) });

      const buildingOpportunities = [
        {
          rehabSessionId: setVectorSession1,
          patientLocalDate: isoDaysAgo(1).slice(0, 10),
          performanceUnit: "reps",
          prescribedSets: [
            { setIndex: 1, outcome: "completed", amount: 10, load: 40 },
            { setIndex: 2, outcome: "completed", amount: 10, load: 40 },
          ],
          actualSets: [
            { setIndex: 1, outcome: "completed", amount: 10, load: 40 },
            { setIndex: 2, outcome: "skipped", amount: null, load: null },
          ],
          toleranceClassification: "well_tolerated",
          immediateGuidance: "maintain",
          isSuccessfulExposure: true,
        },
        {
          rehabSessionId: setVectorSession2,
          patientLocalDate: isoDaysAgo(3).slice(0, 10),
          performanceUnit: "reps",
          prescribedSets: [{ setIndex: 1, outcome: "completed", amount: 10, load: 35 }],
          actualSets: [{ setIndex: 1, outcome: "completed", amount: 10, load: 35 }],
          toleranceClassification: "caution",
          immediateGuidance: "maintain",
          isSuccessfulExposure: true,
        },
      ];

      const constructs = [
        {
          state: "capacity_building",
          detail: capacityDetail({
            construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
            qualifyingDemonstrationCount: 1,
            qualifyingDemonstrationRehabSessionIds: [setVectorSession1],
            wellToleratedQualifyingCount: 1,
            mechanicallyHigherRehabSessionIds: [setVectorSession1],
            recentOpportunities: buildingOpportunities,
          }),
          previousState: "more_comparable_data_needed",
        },
        {
          state: "loading_capacity_improving",
          detail: capacityDetail({
            construct: { exId: "calf_raise", loadingProfile: "isometric", performanceUnit: "hold_seconds" },
            qualifyingDemonstrationCount: 2,
            wellToleratedQualifyingCount: 2,
            confirmedByTwoOfFourRule: true,
            mechanicallyHigherRehabSessionIds: [setVectorSession1, setVectorSession2],
          }),
        },
        { state: "loading_capacity_stable", detail: capacityDetail({ construct: { exId: "heel_drop", loadingProfile: "isotonic", performanceUnit: "reps" } }) },
        {
          state: "loading_pattern_variable",
          detail: capacityDetail({
            construct: { exId: "bridge", loadingProfile: "isotonic", performanceUnit: "reps" },
            hasNonDominatingExposure: true,
            mechanicallyHigherRehabSessionIds: [setVectorSession1],
            mechanicallyLowerRehabSessionIds: [setVectorSession2],
          }),
        },
        {
          state: "more_comparable_data_needed",
          detail: capacityDetail({ construct: { exId: "plank", loadingProfile: "isometric", performanceUnit: "hold_seconds" }, moreDataNeededReason: "insufficient_total_history" }),
        },
        {
          state: "more_comparable_data_needed",
          detail: capacityDetail({ construct: { exId: "wall_sit", loadingProfile: "cardio", performanceUnit: "unrepresentable" }, moreDataNeededReason: "unrepresentable_construct" }),
        },
        {
          state: "more_comparable_data_needed",
          detail: capacityDetail({
            construct: { exId: "single_leg_hop", loadingProfile: "isotonic", performanceUnit: "reps" },
            moreDataNeededReason: "recent_loading_lower",
            recentLoadingLowerThanPrior: true,
            recentLoadingLowerThanPriorNote: "Recent loading has been lower.",
            mechanicallyLowerRehabSessionIds: [setVectorSession1],
          }),
        },
      ];

      for (const c of constructs) {
        if (c.previousState) {
          await insertInterpretation({
            userId: patientCapacityAllStates.userId,
            domain: "capacity_series",
            resultState: c.previousState,
            windowDefinition: { kind: "comparable_construct_2_of_4", construct: c.detail.construct },
            resultDetail: capacityDetail({ construct: c.detail.construct }),
            generatedAt: isoDaysAgo(5),
          });
        }
        await insertInterpretation({
          userId: patientCapacityAllStates.userId,
          domain: "capacity_series",
          resultState: c.state,
          windowDefinition: { kind: "comparable_construct_2_of_4", construct: c.detail.construct },
          resultDetail: c.detail,
          rehabSessionIds: c.detail.recentOpportunities.map((o) => o.rehabSessionId),
          generatedAt: isoDaysAgo(0),
        });
      }
    }

    // --- Training Response: improving, previous stable (changed), with pairs ---
    {
      const prevId = crypto.randomUUID();
      const recId = crypto.randomUUID();
      sessionIds.push(prevId, recId);
      await insertRehabSession({ id: prevId, userId: patientTRImproving.userId, startedAt: isoDaysAgo(8) });
      await insertRehabSession({ id: recId, userId: patientTRImproving.userId, startedAt: isoDaysAgo(1) });
      const constructResults = [
        {
          construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
          previousExposureCount: 5,
          recentExposureCount: 5,
          pairs: [{ previousRehabSessionId: prevId, recentRehabSessionId: recId, comparison: "higher" }],
          usablePairCount: 1,
          unmatchedPreviousRehabSessionIds: [],
          unmatchedRecentRehabSessionIds: [],
          direction: "increased",
          insufficiencyReason: null,
        },
      ];
      await insertInterpretation({
        userId: patientTRImproving.userId,
        domain: "training_response_series",
        resultState: "stable_training_response",
        windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
        resultDetail: { overallSymptomsState: "symptoms_stable", overallLoadingDirection: "maintained", hasInsufficientConstruct: false, constructResults: [] },
        generatedAt: isoDaysAgo(5),
      });
      await insertInterpretation({
        userId: patientTRImproving.userId,
        domain: "training_response_series",
        resultState: "loading_tolerance_improving",
        windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
        resultDetail: { overallSymptomsState: "symptoms_improving", overallLoadingDirection: "increased", hasInsufficientConstruct: false, constructResults },
        rehabSessionIds: [prevId, recId],
        generatedAt: isoDaysAgo(0),
      });
    }

    // --- Training Response: stable, previous also stable (unchanged) ---
    for (const generatedAt of [isoDaysAgo(5), isoDaysAgo(0)]) {
      await insertInterpretation({
        userId: patientTRStable.userId,
        domain: "training_response_series",
        resultState: "stable_training_response",
        windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
        resultDetail: { overallSymptomsState: "symptoms_stable", overallLoadingDirection: "maintained", hasInsufficientConstruct: false, constructResults: [] },
        generatedAt,
      });
    }

    // --- Training Response: variable ---
    await insertInterpretation({
      userId: patientTRVariable.userId,
      domain: "training_response_series",
      resultState: "variable_training_response",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
      resultDetail: { overallSymptomsState: "mixed_symptom_response", overallLoadingDirection: "mixed", hasInsufficientConstruct: false, constructResults: [] },
    });

    // --- Training Response: unsettled ---
    await insertInterpretation({
      userId: patientTRUnsettled.userId,
      domain: "training_response_series",
      resultState: "training_response_remains_unsettled",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
      resultDetail: { overallSymptomsState: "symptoms_trending_higher", overallLoadingDirection: "maintained", hasInsufficientConstruct: false, constructResults: [] },
    });

    // --- Training Response: more_data_needed but GENERATED (real evidence, no locked state) ---
    await insertInterpretation({
      userId: patientTRMoreDataGenerated.userId,
      domain: "training_response_series",
      resultState: "more_data_needed",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
      resultDetail: {
        overallSymptomsState: "symptoms_stable",
        overallLoadingDirection: "insufficient",
        hasInsufficientConstruct: true,
        constructResults: [
          {
            construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
            previousExposureCount: 1,
            recentExposureCount: 0,
            pairs: [],
            usablePairCount: 0,
            unmatchedPreviousRehabSessionIds: ["orphan1"],
            unmatchedRecentRehabSessionIds: [],
            direction: "insufficient",
            insufficiencyReason: "no_data_in_one_half",
          },
        ],
      },
    });

    // --- Training Response: the special early-insufficient-window case ---
    await insertInterpretation({
      userId: patientTRInsufficientWindow.userId,
      domain: "training_response_series",
      resultState: "more_data_needed",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: false },
      resultDetail: { reason: "Stage 3B Symptoms is insufficient for this patient — no aligned window exists yet to compare loading over." },
    });

    // --- Active acute review caveat ---
    {
      const acuteSessionId = crypto.randomUUID();
      sessionIds.push(acuteSessionId);
      await insertRehabSession({ id: acuteSessionId, userId: patientActiveAcute.userId, startedAt: isoDaysAgo(0) });
      const { data: evalRow, error: evalError } = await admin
        .from("escalation_evaluations")
        .insert({ rehab_session_id: acuteSessionId, escalation_level: 3, escalation_reason: "c3_verify_fixture", rule_version: "c3-verify", inputs_snapshot: {} })
        .select()
        .maybeSingle();
      if (evalError || !evalRow) throw evalError ?? new Error("no escalation_evaluations row");
      const { error: episodeError } = await admin.from("acute_safety_episodes").insert({
        user_id: patientActiveAcute.userId,
        source_rehab_session_id: acuteSessionId,
        source_escalation_evaluation_id: evalRow.id,
        initial_level: 3,
        initial_sudden_or_sharp_pain: true,
        initial_new_functional_difficulty: false,
        initial_pop_felt_or_heard: false,
        recurrence_window_anchor_id: null,
        recurrence_sequence_in_window: 1,
        level4_recurrent: false,
        confirmed_at: isoDaysAgo(0),
      });
      if (episodeError) throw episodeError;

      await insertInterpretation({
        userId: patientActiveAcute.userId,
        domain: "symptoms_short_window",
        resultState: "symptoms_stable",
        windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: true },
        resultDetail: symptomsGeneratedDetail({ P: coreDomain({ direction: "stable", frequencyPattern: "no_dominant_pattern" }) }),
      });
    }

    // ==================== Drive the real routes ====================
    const ctxA = await loginContext(browser, clinicianA.email);
    const pageA = await ctxA.newPage();

    async function openProgress(patientId) {
      await pageA.goto(`${BASE_URL}/clinician/patients/${patientId}/progress`);
      await pageA.waitForLoadState("networkidle");
    }
    async function expandAll() {
      const summaries = pageA.locator("details > summary");
      const count = await summaries.count();
      for (let i = 0; i < count; i++) await summaries.nth(i).click();
    }

    // --- 1/2: route authorized + Overview <-> Progress navigation ---
    await openProgress(patientEmpty.userId);
    check("Progress route authorized for active supervised patient", pageA.url().endsWith("/progress"), pageA.url());
    {
      const overviewUrl = `${BASE_URL}/clinician/patients/${patientEmpty.userId}`;
      const progressUrl = `${overviewUrl}/progress`;
      await Promise.all([pageA.waitForURL(overviewUrl), pageA.getByRole("link", { name: "Overview", exact: true }).click()]);
      check("Progress -> Overview navigation works", pageA.url() === overviewUrl, pageA.url());
      await Promise.all([pageA.waitForURL(progressUrl), pageA.getByRole("link", { name: "Progress", exact: true }).click()]);
      check("Overview -> Progress navigation works", pageA.url() === progressUrl, pageA.url());
    }

    // --- Empty patient: no data anywhere, no caveat, no composite score ---
    await openProgress(patientEmpty.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("empty patient shows 'No longitudinal interpretation yet.' for Symptoms/Training Response", (body.match(/No longitudinal interpretation yet\./g) ?? []).length >= 2, body);
      check("empty patient shows no Capacity interpretation message", body.includes("No Capacity interpretation yet."), body);
      check("no active-review caveat for a patient with no acute episode", !body.includes("Clinical review is currently active"), body);
      check("no charts anywhere (no canvas/svg chart element)", (await pageA.locator("canvas, svg[class*='chart']").count()) === 0, "chart element found");
      check("no composite/recovery/readiness score language anywhere", !/recovery score|readiness score|overall progress score|combined clinical state/i.test(body), body);
    }

    // --- Symptoms: improving + previous changed ---
    await openProgress(patientSymptomsImproving.userId);
    await expandAll();
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms improving state shown", /IMPROVING/i.test(body), body);
      check("previous state shows 'Changed from'", body.includes("Changed from"), body);
      check(
        "P/MP/MS evidence shows the translated frequencyPattern, never a re-derived 'N of 5' tally",
        body.includes("Recent responses more often favored lower values.") && !/\d+\s+of\s+\d+\s+recent\s+responses/i.test(body),
        body
      );
      check("expanded evidence shows raw recent/previous values as persisted, never recomputed", body.includes("Recent values:") && body.includes("Previous values:"), body);
      check("MSD shown in default view when sufficient ('Shorter')", body.includes("supporting information") && body.includes("Shorter"), body);
    }

    // --- Symptoms: stable, unchanged ---
    await openProgress(patientSymptomsStableSame.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms stable state shown", /STABLE/i.test(body), body);
      check("previous state shows 'Unchanged from previous'", body.includes("Unchanged from previous"), body);
    }

    // --- Symptoms: mixed + reason codes + external load ---
    await openProgress(patientSymptomsMixed.userId);
    await expandAll();
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms mixed state shown", /MIXED/i.test(body), body);
      check("reason code translated (symptom directions)", body.includes("moved in different directions"), body);
      check("external-load provenance note shown with exact locked wording", body.includes("One or more sessions in this interpretation window included reported external activity."), body);
      check("no causal external-load language", !/caused by|due to the external|because of the activity/i.test(body), body);
      check("provenance shows real session date, not raw id", body.includes("Yesterday") || /[A-Z][a-z]{2} \d{1,2}/.test(body), body);
    }

    // --- Symptoms: trending higher ---
    await openProgress(patientSymptomsTrendingHigher.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms trending higher state shown", /TRENDING HIGHER/i.test(body), body);
      check("no previous interpretation chip shown", body.includes("No previous interpretation"), body);
    }

    // --- Symptoms: insufficient ---
    await openProgress(patientSymptomsInsufficient.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms insufficient shows locked copy", body.includes("Not enough completed rehab responses yet."), body);
      check("insufficient shows real eligible-episode count (6)", body.includes("6 of the 10"), body);
    }

    // --- Capacity: all 7 states across constructs on one patient ---
    await openProgress(patientCapacityAllStates.userId);
    await expandAll();
    {
      const body = await pageA.locator("body").innerText();
      check("Capacity building state shown", /BUILDING/i.test(body), body);
      check("Capacity improving state shown", /IMPROVING/i.test(body), body);
      check("Capacity stable state shown", /\bSTABLE\b/i.test(body), body);
      check("Capacity variable mechanical loading state shown", /VARIABLE MECHANICAL LOADING/i.test(body), body);
      check("Capacity insufficient-history reason shown", body.includes("Not enough comparable sessions yet for this exercise."), body);
      check("Capacity unrepresentable-construct reason shown", body.includes("can't be measured numerically"), body);
      check("Capacity recent-loading-lower uses exact locked phrasing", body.includes("Recent loading has been lower."), body);
      check("no 'declining'/'decreased'/'losing capacity' language anywhere", !/capacity declin|capacity decreas|losing capacity/i.test(body), body);
      check("multiple constructs render as separate cards (7 'Why this interpretation?' panels)", (body.match(/Why this interpretation\?/g) ?? []).length >= 7, body);
      check("same exercise (calf_raise) with different loading profile stays separate (Reps and Hold both shown)", body.includes("Reps") && body.includes("Hold (seconds)"), body);
      check("set-vector provenance: skipped set shown, never coerced to zero", body.includes("Skipped"), body);
      check("previous-state chip present for the building construct (Changed from)", body.includes("Changed from"), body);
    }

    // --- Training Response: improving + changed + pairs ---
    await openProgress(patientTRImproving.userId);
    await expandAll();
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response improving state shown", body.includes("Loading tolerance improving"), body);
      check("previous state shows 'Changed from'", body.includes("Changed from"), body);
      check("Symptoms input visible", body.includes("Symptoms input: Improving"), body);
      check("Loading comparison direction visible", body.includes("Loading comparison: Increased"), body);
      check("usable-pair evidence shown", body.includes("usable paired comparison"), body);
      check("pair-level provenance shows resolved dates and comparison label, not raw uuids", body.includes("Higher") && !body.includes(patientTRImproving.userId), body);
      check("Training Response never described as Capacity or adherence", !/adherence/i.test(body), body);
    }

    // --- Training Response: stable, unchanged ---
    await openProgress(patientTRStable.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response stable state shown", body.includes("Stable"), body);
      check("previous state shows 'Unchanged from previous'", body.includes("Unchanged from previous"), body);
    }

    // --- Training Response: variable ---
    await openProgress(patientTRVariable.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response variable state shown", body.includes("Variable") && !body.includes("Variable mechanical loading"), body);
    }

    // --- Training Response: unsettled ---
    await openProgress(patientTRUnsettled.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response unsettled state shown", body.includes("Remains unsettled"), body);
    }

    // --- Training Response: more_data_needed (generated, real evidence) ---
    await openProgress(patientTRMoreDataGenerated.userId);
    await expandAll();
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response more-data-needed uses the single restrained locked copy", body.includes("Not enough paired symptom and loading data yet."), body);
      check("unmatched-session provenance fact shown", body.includes("not paired"), body);
    }

    // --- Training Response: early insufficient-window case ---
    await openProgress(patientTRInsufficientWindow.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("insufficient-window case also uses the restrained locked copy, never the raw internal reason sentence", body.includes("Not enough paired symptom and loading data yet.") && !body.includes("Stage 3B Symptoms is insufficient"), body);
    }

    // --- Active acute review caveat ---
    await openProgress(patientActiveAcute.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("active clinical-review caveat shown", body.includes("Clinical review is currently active. Recent longitudinal data remain visible but should be interpreted in that context."), body);
      check("interpretation remains visible during active review (Symptoms state still shown)", /STABLE/i.test(body), body);
      check("no 'series boundary'/'reset'/recalculation language introduced", !/series boundary|capacity reset|recalculat/i.test(body), body);
    }

    // --- Authorization: dismissed / unrelated ---
    const dismissedRes = await ctxA.request.get(`${BASE_URL}/clinician/patients/${patientDismissed.userId}/progress`);
    check("dismissed relationship denies Progress access (404-shaped)", dismissedRes.status() === 404, `status ${dismissedRes.status()}`);
    const unrelatedRes = await ctxA.request.get(`${BASE_URL}/clinician/patients/${patientUnrelated.userId}/progress`);
    check("unrelated patient denies Progress access (404-shaped)", unrelatedRes.status() === 404, `status ${unrelatedRes.status()}`);

    await ctxA.close();

    // --- Desktop / mobile ---
    // Target the SPECIFIC construct card that has real set-vector data
    // (the "building" construct's opportunities include a skipped set) —
    // never `.first()` on all <details>, since Capacity construct rows all
    // share nearly the same generated_at and their DESC-ordered "latest per
    // construct" grouping is not guaranteed to put "building" first.
    const desktopCtx = await loginContext(browser, clinicianA.email, { width: 1280, height: 900 });
    const desktopPage = await desktopCtx.newPage();
    await desktopPage.goto(`${BASE_URL}/clinician/patients/${patientCapacityAllStates.userId}/progress`);
    await desktopPage.waitForLoadState("networkidle");
    const desktopBuildingDetails = desktopPage.locator("details", { hasText: "Skipped" }).first();
    await desktopBuildingDetails.locator("summary").click();
    check("desktop viewport renders the per-opportunity set table", await desktopBuildingDetails.locator("table.md\\:table").first().isVisible(), "table not visible at desktop width");
    await desktopCtx.close();

    const mobileCtx = await loginContext(browser, clinicianA.email, { width: 390, height: 844 });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto(`${BASE_URL}/clinician/patients/${patientCapacityAllStates.userId}/progress`);
    await mobilePage.waitForLoadState("networkidle");
    const mobileBuildingDetails = mobilePage.locator("details", { hasText: "Skipped" }).first();
    await mobileBuildingDetails.locator("summary").click();
    const mobileTableVisible = await mobileBuildingDetails.locator("table.md\\:table").first().isVisible();
    check("mobile viewport hides the desktop set table", !mobileTableVisible, "table unexpectedly visible at mobile width");
    await mobileCtx.close();
  } catch (e) {
    fail++;
    const detail = e instanceof Error ? e.stack : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}));
    console.log(`FAIL  unexpected error: ${detail}`);
  } finally {
    // ORDER MATTERS: m6_interpretation_rehab_sessions has a foreign key to
    // rehab_sessions(id) with no ON DELETE CASCADE on that side — it must be
    // deleted BEFORE rehab_sessions itself, or the rehab_sessions delete
    // fails on the FK constraint (silently, since supabase-js delete()
    // returns an error object rather than throwing — checked explicitly
    // below specifically so a silent teardown failure is never mistaken for
    // a clean one).
    if (userIds.length) {
      const { data: interpretations } = await admin.from("m6_longitudinal_interpretations").select("id").in("user_id", userIds);
      const interpretationIds = (interpretations ?? []).map((r) => r.id);
      if (interpretationIds.length) {
        await admin.from("m6_interpretation_reason_codes").delete().in("interpretation_id", interpretationIds);
        await admin.from("m6_interpretation_rehab_sessions").delete().in("interpretation_id", interpretationIds);
        await admin.from("m6_longitudinal_interpretations").delete().in("id", interpretationIds);
      }
    }
    if (sessionIds.length) {
      await admin.from("acute_safety_episodes").delete().in("source_rehab_session_id", sessionIds);
      await admin.from("escalation_evaluations").delete().in("rehab_session_id", sessionIds);
      const { error: sessionDeleteError, count } = await admin.from("rehab_sessions").delete({ count: "exact" }).in("id", sessionIds);
      if (sessionDeleteError) console.error(`FIXTURE CLEANUP FAILED for rehab_sessions: ${sessionDeleteError.message}`);
      else if (count !== sessionIds.length) console.error(`FIXTURE CLEANUP WARNING: deleted ${count} of ${sessionIds.length} fixture rehab_sessions rows`);
    }
    if (userIds.length) {
      await admin.from("supervisor_patients").delete().in("supervisor_id", userIds);
      await admin.from("supervisor_patients").delete().in("patient_id", userIds);
      await admin.from("organization_members").delete().in("user_id", userIds);
      await admin.from("profiles").delete().in("id", userIds);
      for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
    }
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
