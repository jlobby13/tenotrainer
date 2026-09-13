// Milestone 6, Stage 3C — live DB/RLS + real-engine verification for the
// Capacity and Training Response interpretation engines (round 3: set-level
// structural comparison, deterministic Capacity, episode-scoped generation,
// Training Response window aggregation left as an explicit pending gate).
// Mirrors verifyM6Stage3bSymptomEngine.mjs's conventions (throwaway users,
// service-role + anon-signed-in clients, real engine execution via a
// TEMPORARY dev-only route, full teardown in `finally`).
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Stage 3A/3B migrations and the Stage 3C heuristic seed migration
// (20260913000001) already applied.
//
// Run from the web/ directory:
//   node scripts/verifyM6Stage3cCapacityTrainingResponse.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";
const DEV_ROUTE = "http://localhost:3000/api/internal/dev-verify-symptom-engine";

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

async function makeUser(label, role = "member") {
  const email = `m6-stage3c-verify-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  return { userId, email };
}

async function anonClientSignedInAs(email) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function makePrescriptionVersion(userId) {
  const { data, error } = await admin
    .from("prescription_versions")
    .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

const HEAVY_CALF_RAISE = { ex_id: "heavy_calf_raise", name: "Heavy calf raise", category: "strength", loading_profile: "heavy_slow_resistance", order_index: 0, dosage: { sets: 3, reps_or_hold_time: 10 } };
const ISOMETRIC_HOLD = { ex_id: "isometric_hold", name: "Isometric hold", category: "strength", loading_profile: "isometric", order_index: 0, dosage: { sets: 3, reps_or_hold_time: 30 } };

// Builds one full session: rehab_session (with prescription_snapshot) +
// set_outcomes for ONE exercise + finalized morning_response +
// tolerance_evaluation. `amounts` is the ordered per-set actual amount
// array (real set-level performance, never collapsed).
async function createSession(userId, { date, prescriptionVersionId, exercise, amounts, morningPain = 3, morningStiffness = 0, stiffnessDuration = "not_applicable", toleranceClassification = "well_tolerated", immediateGuidance = "maintain", peakPain = 3 }) {
  const sessionId = genUuid();
  await admin.from("rehab_sessions").insert({
    id: sessionId,
    user_id: userId,
    prescription_instance_id: `${sessionId}:i`,
    patient_local_date: date,
    started_at: `${date}T14:00:00Z`,
    status: "response_complete",
    exercise_outcome: "completed",
    prescription_snapshot: [exercise],
    peak_session_pain: peakPain,
    prescription_version_id: prescriptionVersionId,
  });
  for (let i = 0; i < amounts.length; i++) {
    await admin.from("set_outcomes").insert({
      rehab_session_id: sessionId,
      exercise_id: exercise.ex_id,
      exercise_order_index: 0,
      set_index: i,
      outcome: "completed",
      prescribed_reps: 10,
      prescribed_load: null,
      actual_reps: amounts[i],
      actual_load: null,
      occurred_at: `${date}T14:05:00Z`,
    });
  }
  const { data: morning } = await admin
    .from("morning_responses")
    .insert({ rehab_session_id: sessionId, user_id: userId, next_morning_pain: morningPain, next_morning_stiffness: morningStiffness, stiffness_duration: stiffnessDuration, submitted_at: `${date}T20:00:00Z` })
    .select()
    .single();
  const { data: tolerance } = await admin
    .from("tolerance_evaluations")
    .insert({
      rehab_session_id: sessionId,
      morning_response_id: morning.id,
      tolerance_classification: toleranceClassification,
      immediate_guidance: immediateGuidance,
      patient_facing_label: "fixture",
      reason: "fixture",
      rule_version: "v1",
      inputs_snapshot: {},
    })
    .select()
    .single();
  return { sessionId, morningResponseId: morning.id, toleranceEvaluationId: tolerance.id };
}

function dateFor(dayIndex) {
  const d = new Date("2026-02-01T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dayIndex);
  return d.toISOString().slice(0, 10);
}

async function runEngine(userId, kind, extra = {}) {
  const res = await fetch(DEV_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, kind, ...extra }) });
  if (!res.ok) throw new Error(`dev-verify-symptom-engine route failed (${kind}): ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const sessionIds = [];
  const userIds = [];
  const interpretationIds = [];

  try {
    const userA = await makeUser("a"); // loading_capacity_improving (2-of-4, all well_tolerated)
    const userA2 = await makeUser("a2"); // capacity_building (2-of-4 confirmed, but 0 WT / 2 Caution+Maintain)
    const userB = await makeUser("b"); // capacity_building (1 qualifying)
    const userC = await makeUser("c"); // loading_capacity_stable, with MIXED tolerance (round-3 rule: stable is mechanical-only)
    const userD = await makeUser("d"); // more_comparable_data_needed (insufficient_total_history)
    const userE = await makeUser("e"); // loading_pattern_variable (mechanical opposing evidence)
    const userI = await makeUser("i"); // consistently lower -> more_comparable_data_needed (recent_loading_lower), NOW persisted
    const userJ = await makeUser("j"); // episode-scoping: A/B rotation
    const userF = await makeUser("f"); // training response: improving symptoms + maintained loading -> loading_tolerance_improving (FINAL mechanism)
    const userG = await makeUser("g"); // training response: stable symptoms + maintained loading -> stable_training_response
    const userH = await makeUser("h"); // training response: insufficient symptom data
    const userK = await makeUser("k"); // training response: one usable construct + one insufficient construct
    const clinicianAssigned = await makeUser("clinician-assigned", "clinician_admin");
    const clinicianUnrelated = await makeUser("clinician-unrelated", "clinician_admin");
    userIds.push(userA.userId, userA2.userId, userB.userId, userC.userId, userD.userId, userE.userId, userI.userId, userJ.userId, userF.userId, userG.userId, userH.userId, userK.userId, clinicianAssigned.userId, clinicianUnrelated.userId);
    await admin.from("supervisor_patients").insert({ supervisor_id: clinicianAssigned.userId, patient_id: userB.userId, status: "active" });

    // ------------------------------------------------------------------
    // Scenario A: 2-of-4 confirmed, 2 WT / 0 Caution+Maintain -> loading_capacity_improving.
    // ------------------------------------------------------------------
    const versionA = await makePrescriptionVersion(userA.userId);
    for (let i = 0; i < 5; i++) {
      const amt = i < 2 ? [12, 12, 12] : [10, 10, 10];
      const ep = await createSession(userA.userId, { date: dateFor(4 - i), prescriptionVersionId: versionA, exercise: HEAVY_CALF_RAISE, amounts: amt, toleranceClassification: "well_tolerated", immediateGuidance: "maintain" });
      sessionIds.push(ep.sessionId);
    }
    const resultA = await runEngine(userA.userId, "capacity");
    check("scenario A: loading_capacity_improving persisted for 2 WT / 0 Caution+Maintain", resultA.generated[0]?.state === "loading_capacity_improving", JSON.stringify(resultA.generated));
    if (resultA.generated[0]) interpretationIds.push(resultA.generated[0].interpretationId);
    const { data: interpRowA } = await admin.from("m6_longitudinal_interpretations").select("result_detail").eq("id", resultA.generated[0]?.interpretationId).single();
    check("scenario A: persisted result_detail shows wellToleratedQualifyingCount=2, cautionMaintainQualifyingCount=0", interpRowA?.result_detail?.wellToleratedQualifyingCount === 2 && interpRowA?.result_detail?.cautionMaintainQualifyingCount === 0, JSON.stringify(interpRowA?.result_detail));
    check(
      "scenario A: persisted result_detail preserves the REAL per-set vectors (not a collapsed scalar)",
      Array.isArray(interpRowA?.result_detail?.recentOpportunities?.[0]?.actualSets) && interpRowA.result_detail.recentOpportunities[0].actualSets.length === 3,
      JSON.stringify(interpRowA?.result_detail?.recentOpportunities?.[0])
    );

    // ------------------------------------------------------------------
    // Scenario A2: 0 WT / 2 Caution+Maintain -> capacity_building.
    // ------------------------------------------------------------------
    const versionA2 = await makePrescriptionVersion(userA2.userId);
    for (let i = 0; i < 5; i++) {
      const amt = i < 2 ? [12, 12, 12] : [10, 10, 10];
      const ep = await createSession(userA2.userId, { date: dateFor(4 - i), prescriptionVersionId: versionA2, exercise: HEAVY_CALF_RAISE, amounts: amt, toleranceClassification: "caution", immediateGuidance: "maintain" });
      sessionIds.push(ep.sessionId);
    }
    const resultA2 = await runEngine(userA2.userId, "capacity");
    check("scenario A2: capacity_building persisted for 0 WT / 2 Caution+Maintain", resultA2.generated[0]?.state === "capacity_building", JSON.stringify(resultA2.generated));
    if (resultA2.generated[0]) interpretationIds.push(resultA2.generated[0].interpretationId);

    // ------------------------------------------------------------------
    // Scenario B: exactly 1 qualifying -> capacity_building.
    // ------------------------------------------------------------------
    const versionB = await makePrescriptionVersion(userB.userId);
    for (let i = 0; i < 5; i++) {
      const amt = i === 0 ? [12, 12, 12] : [10, 10, 10];
      const ep = await createSession(userB.userId, { date: dateFor(4 - i), prescriptionVersionId: versionB, exercise: HEAVY_CALF_RAISE, amounts: amt });
      sessionIds.push(ep.sessionId);
    }
    const resultB = await runEngine(userB.userId, "capacity");
    check("scenario B: capacity_building persisted for exactly 1 qualifying demonstration", resultB.generated[0]?.state === "capacity_building", JSON.stringify(resultB.generated));
    if (resultB.generated[0]) interpretationIds.push(resultB.generated[0].interpretationId);
    const { data: interpRowB } = await admin.from("m6_longitudinal_interpretations").select().eq("id", resultB.generated[0]?.interpretationId).single();
    check("scenario B: domain = capacity_series", interpRowB?.domain === "capacity_series", interpRowB?.domain);
    check("scenario B: ruleset_version persisted correctly", interpRowB?.ruleset_version === "m6_longitudinal_v1", interpRowB?.ruleset_version);
    const { data: linkedHeuristicsB } = await admin.from("m6_interpretation_heuristics").select("heuristic_id").eq("interpretation_id", resultB.generated[0]?.interpretationId);
    check("scenario B: all 5 capacity heuristics linked", (linkedHeuristicsB ?? []).length === 5, (linkedHeuristicsB ?? []).length);

    // ------------------------------------------------------------------
    // Scenario C: mechanically stable (all equal) WITH MIXED tolerance -> loading_capacity_stable (round-3 rule: Capacity is mechanical-only, tolerance mix lives in Training Response).
    // ------------------------------------------------------------------
    const versionC = await makePrescriptionVersion(userC.userId);
    for (let i = 0; i < 5; i++) {
      const isEven = i % 2 === 0;
      const ep = await createSession(userC.userId, {
        date: dateFor(4 - i),
        prescriptionVersionId: versionC,
        exercise: HEAVY_CALF_RAISE,
        amounts: [10, 10, 10],
        toleranceClassification: isEven ? "well_tolerated" : "caution",
        immediateGuidance: isEven ? "maintain" : "maintain_cautiously",
      });
      sessionIds.push(ep.sessionId);
    }
    const resultC = await runEngine(userC.userId, "capacity");
    check("scenario C: loading_capacity_stable persisted DESPITE mixed/non-qualifying tolerance (mechanics-only rule)", resultC.generated[0]?.state === "loading_capacity_stable", JSON.stringify(resultC.generated));
    if (resultC.generated[0]) interpretationIds.push(resultC.generated[0].interpretationId);

    // ------------------------------------------------------------------
    // Scenario D: only 3 sessions total -> more_comparable_data_needed (insufficient_total_history).
    // ------------------------------------------------------------------
    const versionD = await makePrescriptionVersion(userD.userId);
    for (let i = 0; i < 3; i++) {
      const ep = await createSession(userD.userId, { date: dateFor(2 - i), prescriptionVersionId: versionD, exercise: HEAVY_CALF_RAISE, amounts: [10, 10, 10] });
      sessionIds.push(ep.sessionId);
    }
    const resultD = await runEngine(userD.userId, "capacity");
    check("scenario D: more_comparable_data_needed persisted for insufficient total history", resultD.generated[0]?.state === "more_comparable_data_needed", JSON.stringify(resultD.generated));
    if (resultD.generated[0]) interpretationIds.push(resultD.generated[0].interpretationId);
    const { data: interpRowD } = await admin.from("m6_longitudinal_interpretations").select("result_detail").eq("id", resultD.generated[0]?.interpretationId).single();
    check("scenario D: moreDataNeededReason = insufficient_total_history", interpRowD?.result_detail?.moreDataNeededReason === "insufficient_total_history", interpRowD?.result_detail?.moreDataNeededReason);

    // ------------------------------------------------------------------
    // Scenario E: mechanically higher AND lower exposures present (non-qualifying tolerance on the higher ones so 2-of-4 never fires) -> loading_pattern_variable.
    // ------------------------------------------------------------------
    const versionE = await makePrescriptionVersion(userE.userId);
    const eAmounts = [[12, 12, 12], [12, 12, 12], [8, 8, 8], [10, 10, 10]];
    for (let i = 0; i < 5; i++) {
      const amt = i < 4 ? eAmounts[i] : [10, 10, 10];
      const isHigherOne = i < 2;
      const ep = await createSession(userE.userId, {
        date: dateFor(4 - i),
        prescriptionVersionId: versionE,
        exercise: HEAVY_CALF_RAISE,
        amounts: amt,
        toleranceClassification: isHigherOne ? "caution" : "well_tolerated",
        immediateGuidance: isHigherOne ? "reduce_modify" : "maintain",
      });
      sessionIds.push(ep.sessionId);
    }
    const resultE = await runEngine(userE.userId, "capacity");
    check("scenario E: loading_pattern_variable persisted for genuinely opposing mechanical evidence, driven by mechanics not tolerance", resultE.generated[0]?.state === "loading_pattern_variable", JSON.stringify(resultE.generated));
    if (resultE.generated[0]) interpretationIds.push(resultE.generated[0].interpretationId);
    const { data: interpRowE } = await admin.from("m6_longitudinal_interpretations").select("result_detail").eq("id", resultE.generated[0]?.interpretationId).single();
    check(
      "scenario E: persisted result_detail records both mechanically-higher and mechanically-lower session ids",
      (interpRowE?.result_detail?.mechanicallyHigherRehabSessionIds ?? []).length === 2 && (interpRowE?.result_detail?.mechanicallyLowerRehabSessionIds ?? []).length === 1,
      JSON.stringify(interpRowE?.result_detail)
    );

    // ------------------------------------------------------------------
    // Scenario I: consistently LOWER (no opposing higher evidence) -> NOW persisted as more_comparable_data_needed (recent_loading_lower) — round 3 approval.
    // ------------------------------------------------------------------
    const versionI = await makePrescriptionVersion(userI.userId);
    for (let i = 0; i < 5; i++) {
      const amt = i < 4 ? [8, 8, 8] : [10, 10, 10];
      const ep = await createSession(userI.userId, { date: dateFor(4 - i), prescriptionVersionId: versionI, exercise: HEAVY_CALF_RAISE, amounts: amt });
      sessionIds.push(ep.sessionId);
    }
    const resultI = await runEngine(userI.userId, "capacity");
    check("scenario I: more_comparable_data_needed persisted for a consistently-lower, non-opposing pattern (NOT variable, NOT stable, NOT declining)", resultI.generated[0]?.state === "more_comparable_data_needed", JSON.stringify(resultI.generated));
    if (resultI.generated[0]) interpretationIds.push(resultI.generated[0].interpretationId);
    const { data: interpRowI } = await admin.from("m6_longitudinal_interpretations").select("result_detail, result_state").eq("id", resultI.generated[0]?.interpretationId).single();
    check("scenario I: moreDataNeededReason = recent_loading_lower and factual note uses approved phrasing", interpRowI?.result_detail?.moreDataNeededReason === "recent_loading_lower" && interpRowI?.result_detail?.recentLoadingLowerThanPriorNote === "Recent loading has been lower.", JSON.stringify(interpRowI?.result_detail));
    check("scenario I: no 'declining' state ever persisted", !String(interpRowI?.result_state ?? "").toLowerCase().includes("declin"), interpRowI?.result_state);

    // ------------------------------------------------------------------
    // Scenario J: EPISODE-SCOPED generation — an A/B rotation. Generating
    // for construct B's episode must NOT regenerate/touch construct A's
    // already-persisted interpretation, and both remain independently
    // retrievable (brief section 7).
    // ------------------------------------------------------------------
    const versionJ = await makePrescriptionVersion(userJ.userId);
    // Build 5 sessions of construct A to get it to a classifiable state, then one construct B session.
    let aTargetSessionId = null;
    for (let i = 0; i < 5; i++) {
      const ep = await createSession(userJ.userId, { date: dateFor(4 - i), prescriptionVersionId: versionJ, exercise: HEAVY_CALF_RAISE, amounts: [10, 10, 10] });
      sessionIds.push(ep.sessionId);
      if (i === 0) aTargetSessionId = ep.sessionId; // most recent A session
    }
    const resultJ_Agen = await runEngine(userJ.userId, "capacity", { rehabSessionId: aTargetSessionId });
    check("scenario J: generating construct A's episode persists an A interpretation", resultJ_Agen.generated[0]?.construct?.exId === "heavy_calf_raise", JSON.stringify(resultJ_Agen.generated));
    const aInterpretationId = resultJ_Agen.generated[0]?.interpretationId;
    if (aInterpretationId) interpretationIds.push(aInterpretationId);

    // Now a single construct B session — a rotating A/B program.
    const bEp = await createSession(userJ.userId, { date: dateFor(5), prescriptionVersionId: versionJ, exercise: ISOMETRIC_HOLD, amounts: [20, 20, 20] });
    sessionIds.push(bEp.sessionId);
    const resultJ_Bgen = await runEngine(userJ.userId, "capacity", { rehabSessionId: bEp.sessionId });
    check("scenario J: generating construct B's episode persists a B interpretation (more_comparable_data_needed — only 1 B exposure)", resultJ_Bgen.generated[0]?.construct?.exId === "isometric_hold", JSON.stringify(resultJ_Bgen.generated));
    check("scenario J: generating B's episode does NOT also regenerate A (only B is in the result)", resultJ_Bgen.generated.length === 1, JSON.stringify(resultJ_Bgen.generated));
    if (resultJ_Bgen.generated[0]) interpretationIds.push(resultJ_Bgen.generated[0].interpretationId);

    const { data: aRowsAfterB } = await admin.from("m6_longitudinal_interpretations").select("id").eq("user_id", userJ.userId).eq("domain", "capacity_series");
    check("scenario J: exactly 2 capacity_series rows exist total (1 A, 1 B) — B's episode did not create a duplicate/second A row", (aRowsAfterB ?? []).length === 2, (aRowsAfterB ?? []).length);

    const { data: rereadA } = await admin.from("m6_longitudinal_interpretations").select("result_state").eq("id", aInterpretationId).single();
    check("scenario J: construct A's interpretation is UNCHANGED after B's episode was processed (historical immutability across constructs)", rereadA?.result_state === resultJ_Agen.generated[0]?.state, JSON.stringify({ before: resultJ_Agen.generated[0]?.state, after: rereadA?.result_state }));

    // ------------------------------------------------------------------
    // Scenario F: Training Response — FINAL mechanism: improving symptoms +
    // maintained loading (constant reps across all 10 sessions, boundary-
    // adjacent pairing yields 4 usable "equal" pairs) -> loading_tolerance_improving.
    // ------------------------------------------------------------------
    const versionF = await makePrescriptionVersion(userF.userId);
    const fPreviousP = [5, 5, 5, 5, 5];
    const fRecentP = [2, 2, 2, 2, 5]; // improving
    for (let i = 0; i < 5; i++) {
      const ep = await createSession(userF.userId, { date: dateFor(i), prescriptionVersionId: versionF, exercise: HEAVY_CALF_RAISE, amounts: [10, 10, 10], peakPain: fPreviousP[i], morningPain: fPreviousP[i], morningStiffness: 3, stiffnessDuration: "gt_30_min" });
      sessionIds.push(ep.sessionId);
    }
    for (let i = 5; i < 10; i++) {
      const ep = await createSession(userF.userId, { date: dateFor(i), prescriptionVersionId: versionF, exercise: HEAVY_CALF_RAISE, amounts: [10, 10, 10], peakPain: fRecentP[i - 5], morningPain: fRecentP[i - 5], morningStiffness: 3, stiffnessDuration: "gt_30_min" });
      sessionIds.push(ep.sessionId);
    }
    const resultF = await runEngine(userF.userId, "trainingResponse");
    check("scenario F: Training Response = loading_tolerance_improving (favorable symptoms + maintained loading, FINAL mechanism)", resultF.state === "loading_tolerance_improving", JSON.stringify(resultF));
    check("scenario F: overall loading direction = maintained (5 boundary-adjacent pairs, all equal)", resultF.windowLoadingComparison?.overall === "maintained", resultF.windowLoadingComparison?.overall);
    check("scenario F: construct usablePairCount = 5 (min(5,5) boundary-adjacent pairs)", resultF.windowLoadingComparison?.constructResults?.[0]?.usablePairCount === 5, JSON.stringify(resultF.windowLoadingComparison?.constructResults));
    interpretationIds.push(resultF.interpretationId, resultF.symptomInterpretationId);
    const { data: symptomRowF } = await admin.from("m6_longitudinal_interpretations").select("window_definition, result_state").eq("id", resultF.symptomInterpretationId).single();
    check("scenario F: the underlying Stage 3B Symptoms interpretation itself is UNCHANGED and still correctly favorable (symptoms_improving)", symptomRowF?.result_state === "symptoms_improving", symptomRowF?.result_state);
    const { data: trResultRowF } = await admin.from("m6_longitudinal_interpretations").select("window_definition, domain, result_detail").eq("id", resultF.interpretationId).single();
    check("scenario F: Training Response domain = training_response_series", trResultRowF?.domain === "training_response_series", trResultRowF?.domain);
    check(
      "scenario F: Training Response analyzed the EXACT SAME 10 episodes as the Stage 3B Symptoms interpretation (window alignment)",
      JSON.stringify(trResultRowF?.window_definition?.previousWindowRehabSessionIds?.sort()) === JSON.stringify(symptomRowF?.window_definition?.previousWindowRehabSessionIds?.sort()) &&
        JSON.stringify(trResultRowF?.window_definition?.recentWindowRehabSessionIds?.sort()) === JSON.stringify(symptomRowF?.window_definition?.recentWindowRehabSessionIds?.sort()),
      JSON.stringify({ tr: trResultRowF?.window_definition, symptom: symptomRowF?.window_definition })
    );
    check(
      "scenario F: persisted result_detail preserves full per-construct pairing provenance (pairs, unmatched ids, direction)",
      Array.isArray(trResultRowF?.result_detail?.constructResults?.[0]?.pairs) && trResultRowF.result_detail.constructResults[0].pairs.length === 5,
      JSON.stringify(trResultRowF?.result_detail?.constructResults)
    );

    // ------------------------------------------------------------------
    // Scenario G: Training Response — stable symptoms + maintained loading -> stable_training_response.
    // ------------------------------------------------------------------
    const versionG = await makePrescriptionVersion(userG.userId);
    for (let i = 0; i < 10; i++) {
      const ep = await createSession(userG.userId, { date: dateFor(i), prescriptionVersionId: versionG, exercise: HEAVY_CALF_RAISE, amounts: [10, 10, 10], peakPain: 4, morningPain: 3, morningStiffness: 0, stiffnessDuration: "not_applicable" });
      sessionIds.push(ep.sessionId);
    }
    const resultG = await runEngine(userG.userId, "trainingResponse");
    check("scenario G: Training Response = stable_training_response (stable symptoms + maintained loading)", resultG.state === "stable_training_response", JSON.stringify(resultG));
    interpretationIds.push(resultG.interpretationId, resultG.symptomInterpretationId);

    // ------------------------------------------------------------------
    // Scenario H: Training Response — insufficient Stage 3B symptom data -> more_data_needed.
    // ------------------------------------------------------------------
    const versionH = await makePrescriptionVersion(userH.userId);
    for (let i = 0; i < 4; i++) {
      const ep = await createSession(userH.userId, { date: dateFor(i), prescriptionVersionId: versionH, exercise: HEAVY_CALF_RAISE, amounts: [10, 10, 10] });
      sessionIds.push(ep.sessionId);
    }
    const resultH = await runEngine(userH.userId, "trainingResponse");
    check("scenario H: Training Response = more_data_needed when Stage 3B Symptoms is insufficient", resultH.state === "more_data_needed", JSON.stringify(resultH));
    check("scenario H: symptomInterpretationId still recorded even when insufficient", typeof resultH.symptomInterpretationId === "string" && resultH.symptomInterpretationId.length > 0, resultH.symptomInterpretationId);
    interpretationIds.push(resultH.interpretationId, resultH.symptomInterpretationId);

    // ------------------------------------------------------------------
    // Scenario K: one usable construct (HEAVY_CALF_RAISE, 4 sessions each
    // half, maintained) + one insufficient construct (ISOMETRIC_HOLD, only
    // 1 session in each half -> 1 pair -> insufficient) within the SAME
    // 10-episode window -> overall driven by the usable construct alone,
    // limited_comparable_exposures attached, insufficient construct
    // remains fully visible in provenance (never silently dropped).
    // ------------------------------------------------------------------
    const versionK = await makePrescriptionVersion(userK.userId);
    for (let i = 0; i < 10; i++) {
      const useIsometric = i === 0 || i === 5; // exactly 1 per half
      const ep = await createSession(userK.userId, {
        date: dateFor(i),
        prescriptionVersionId: versionK,
        exercise: useIsometric ? ISOMETRIC_HOLD : HEAVY_CALF_RAISE,
        amounts: useIsometric ? [20, 20, 20] : [10, 10, 10],
        peakPain: 4,
        morningPain: 3,
        morningStiffness: 0,
        stiffnessDuration: "not_applicable",
      });
      sessionIds.push(ep.sessionId);
    }
    const resultK = await runEngine(userK.userId, "trainingResponse");
    check("scenario K: overall loading = maintained (driven by the usable HEAVY_CALF_RAISE construct alone)", resultK.windowLoadingComparison?.overall === "maintained", JSON.stringify(resultK.windowLoadingComparison));
    check("scenario K: Training Response = stable_training_response (stable symptoms + maintained usable loading)", resultK.state === "stable_training_response", JSON.stringify(resultK));
    check("scenario K: hasInsufficientConstruct = true", resultK.windowLoadingComparison?.hasInsufficientConstruct === true, JSON.stringify(resultK.windowLoadingComparison));
    const isometricResultK = resultK.windowLoadingComparison?.constructResults?.find((c) => c.construct?.exId === "isometric_hold");
    check("scenario K: the insufficient construct (isometric_hold, 1 pair) remains VISIBLE in the result, never silently dropped", isometricResultK?.direction === "insufficient", JSON.stringify(isometricResultK));
    interpretationIds.push(resultK.interpretationId, resultK.symptomInterpretationId);
    const { data: trResultRowK } = await admin.from("m6_longitudinal_interpretations").select("result_detail").eq("id", resultK.interpretationId).single();
    check(
      "scenario K: limited_comparable_exposures reason code persisted (usable + insufficient constructs coexist)",
      (await admin.from("m6_interpretation_reason_codes").select("reason_code").eq("interpretation_id", resultK.interpretationId)).data?.some((r) => r.reason_code === "limited_comparable_exposures"),
      ""
    );
    check(
      "scenario K: persisted result_detail includes BOTH constructs (usable and insufficient), never silently excluding one",
      trResultRowK?.result_detail?.constructResults?.length === 2,
      JSON.stringify(trResultRowK?.result_detail?.constructResults)
    );

    // ------------------------------------------------------------------
    // Coexistence / historical immutability: a later ruleset version for
    // userB's capacity_series row must not touch the real v1 row.
    // ------------------------------------------------------------------
    const { data: laterCapacityRow } = await admin
      .from("m6_longitudinal_interpretations")
      .insert({ user_id: userB.userId, domain: "capacity_series", ruleset_version: "m6_longitudinal_v2_fixture", result_state: "loading_capacity_stable" })
      .select()
      .single();
    if (laterCapacityRow) interpretationIds.push(laterCapacityRow.id);
    const { data: allCapacityForB } = await admin.from("m6_longitudinal_interpretations").select("id, ruleset_version, result_state").eq("user_id", userB.userId).eq("domain", "capacity_series");
    check("coexistence: userB's real v1 capacity row and a later ruleset version coexist as 2 rows", (allCapacityForB ?? []).length === 2, (allCapacityForB ?? []).length);
    const { data: rereadB } = await admin.from("m6_longitudinal_interpretations").select("ruleset_version, result_state").eq("id", resultB.generated[0]?.interpretationId).single();
    check("historical integrity: userB's real v1 capacity_building interpretation is unchanged", rereadB?.ruleset_version === "m6_longitudinal_v1" && rereadB?.result_state === "capacity_building");

    // ------------------------------------------------------------------
    // RLS: patient reads own; unrelated patient cannot; clinician tenancy.
    // ------------------------------------------------------------------
    const clientB = await anonClientSignedInAs(userB.email);
    const { data: ownReadB } = await clientB.from("m6_longitudinal_interpretations").select("id").eq("id", resultB.generated[0]?.interpretationId);
    check("RLS: patient B can read their own capacity interpretation", (ownReadB ?? []).length === 1);

    const clientC = await anonClientSignedInAs(userC.email);
    const { data: crossRead } = await clientC.from("m6_longitudinal_interpretations").select("id").eq("id", resultB.generated[0]?.interpretationId);
    check("RLS: an unrelated patient cannot read patient B's capacity interpretation", (crossRead ?? []).length === 0);

    const clinicianClient = await anonClientSignedInAs(clinicianAssigned.email);
    const { data: clinicianRead } = await clinicianClient.from("m6_longitudinal_interpretations").select("id").eq("id", resultB.generated[0]?.interpretationId);
    check("RLS: the assigned clinician can read patient B's capacity interpretation", (clinicianRead ?? []).length === 1);

    const unrelatedClinicianClient = await anonClientSignedInAs(clinicianUnrelated.email);
    const { data: unrelatedClinicianRead } = await unrelatedClinicianClient.from("m6_longitudinal_interpretations").select("id").eq("id", resultB.generated[0]?.interpretationId);
    check("RLS: a clinician with no supervisor_patients link cannot read patient B's capacity interpretation", (unrelatedClinicianRead ?? []).length === 0);

    check("RLS: patient cannot INSERT a forged capacity interpretation", Boolean((await clientB.from("m6_longitudinal_interpretations").insert({ user_id: userB.userId, domain: "capacity_series", ruleset_version: "forged", result_state: "loading_capacity_improving" })).error));
  } finally {
    // ------------------------------------------------------------------
    // Cleanup — leaves no throwaway records/users.
    // ------------------------------------------------------------------
    if (interpretationIds.length > 0) {
      await admin.from("m6_interpretation_reason_codes").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_rehab_sessions").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_morning_responses").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_tolerance_evaluations").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_prescription_versions").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_heuristics").delete().in("interpretation_id", interpretationIds);
    }
    await admin.from("m6_longitudinal_interpretations").delete().in("id", interpretationIds);
    if (sessionIds.length > 0) {
      await admin.from("set_outcomes").delete().in("rehab_session_id", sessionIds);
      await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
    }
    await admin.from("rehab_sessions").delete().in("id", sessionIds);
    for (const userId of userIds) {
      await admin.from("supervisor_patients").delete().or(`supervisor_id.eq.${userId},patient_id.eq.${userId}`);
      await admin.from("prescription_versions").delete().eq("user_id", userId);
      await admin.from("organization_members").delete().eq("user_id", userId);
      await admin.from("profiles").delete().eq("id", userId);
      await admin.auth.admin.deleteUser(userId).catch(() => {});
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
