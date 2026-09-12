// Milestone 6, Stage 3B — live DB/RLS + real-engine verification for the
// 5+5 longitudinal symptom engine. Mirrors verifyM6Stage3aSchema.mjs's
// conventions (throwaway users, service-role + anon-signed-in clients,
// full teardown in `finally`).
//
// UNLIKE the Stage 3A schema script, this one also exercises the REAL
// TypeScript engine (web/lib/longitudinalInterpretationEngine.ts) end to
// end — not just the DB contract — via a TEMPORARY dev-only route
// (app/api/internal/dev-verify-symptom-engine/route.ts, deleted before
// Stage 3B is finalized) POSTed to a running `next dev` server. That route
// exists ONLY for this verification pass; nothing else in this stage's
// deliverables depends on it.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// the Stage 3A migrations (20260911000006-8) AND the Stage 3B heuristic
// seed migration (20260912000001) already applied.
//
// Run from the web/ directory:
//   node scripts/verifyM6Stage3bSymptomEngine.mjs
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
  const email = `m6-stage3b-verify-${label}-${Date.now()}@example.invalid`.toLowerCase();
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

// Builds one full "response episode" fixture chain: rehab_session +
// set_outcomes (actual performance) + finalized morning_response +
// tolerance_evaluation. Mirrors the LOCKED atomic-unit definition exactly.
async function createEpisode(userId, { date, prescriptionVersionId, peakPain, morningPain, morningStiffness, stiffnessDuration, externalLoad }) {
  const sessionId = genUuid();
  await admin.from("rehab_sessions").insert({
    id: sessionId,
    user_id: userId,
    prescription_instance_id: `${sessionId}:i`,
    patient_local_date: date,
    started_at: `${date}T14:00:00Z`,
    status: "response_complete",
    exercise_outcome: "completed",
    prescription_snapshot: [],
    peak_session_pain: peakPain,
    prescription_version_id: prescriptionVersionId,
  });
  await admin.from("set_outcomes").insert({
    rehab_session_id: sessionId,
    exercise_id: "ex1",
    exercise_order_index: 0,
    set_index: 0,
    outcome: "completed",
    occurred_at: `${date}T14:05:00Z`,
  });
  const { data: morning } = await admin
    .from("morning_responses")
    .insert({
      rehab_session_id: sessionId,
      user_id: userId,
      next_morning_pain: morningPain,
      next_morning_stiffness: morningStiffness,
      stiffness_duration: stiffnessDuration,
      submitted_at: `${date}T20:00:00Z`,
    })
    .select()
    .single();
  const { data: tolerance } = await admin
    .from("tolerance_evaluations")
    .insert({
      rehab_session_id: sessionId,
      morning_response_id: morning.id,
      tolerance_classification: "well_tolerated",
      immediate_guidance: "maintain",
      patient_facing_label: "Well Tolerated",
      reason: "fixture",
      rule_version: "v1",
      inputs_snapshot: {},
    })
    .select()
    .single();
  if (externalLoad) {
    await admin.from("session_load_observations").insert({
      rehab_session_id: sessionId,
      user_id: userId,
      category: externalLoad.category,
      timing: externalLoad.timing,
      captured_during: externalLoad.capturedDuring,
    });
  }
  return { sessionId, morningResponseId: morning.id, toleranceEvaluationId: tolerance.id };
}

function dateFor(dayIndex) {
  const d = new Date("2026-01-01T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dayIndex);
  return d.toISOString().slice(0, 10);
}

async function runEngine(userId) {
  const res = await fetch(DEV_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error(`dev-verify-symptom-engine route failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const sessionIds = [];
  const userIds = [];
  const interpretationIds = [];

  try {
    const userA = await makeUser("a"); // scenario: clean improving case
    const userB = await makeUser("b"); // scenario: insufficient data
    const userC = await makeUser("c"); // scenario: mixed + rx change + external load
    const clinicianAssigned = await makeUser("clinician-assigned", "clinician_admin");
    const clinicianUnrelated = await makeUser("clinician-unrelated", "clinician_admin");
    userIds.push(userA.userId, userB.userId, userC.userId, clinicianAssigned.userId, clinicianUnrelated.userId);
    await admin.from("supervisor_patients").insert({ supervisor_id: clinicianAssigned.userId, patient_id: userA.userId, status: "active" });

    // ------------------------------------------------------------------
    // Scenario A: 10 eligible episodes, single prescription version, no
    // external load. P improving, MP improving, MS stable, MSD shorter ->
    // expect overall = symptoms_improving, no reason codes.
    // ------------------------------------------------------------------
    const versionA = await makePrescriptionVersion(userA.userId);
    const aPreviousP = [5, 5, 5, 5, 5];
    const aRecentP = [2, 2, 2, 2, 5]; // 4/5 lower, median 2 < 5 -> improving
    const aPreviousMP = [5, 5, 5, 5, 5];
    const aRecentMP = [2, 2, 2, 2, 5]; // improving
    const aMS = 3; // stable both windows
    const aPreviousDuration = "gt_30_min";
    const aRecentDuration = "lt_5_min"; // MSD: shorter
    for (let i = 0; i < 5; i++) {
      const ep = await createEpisode(userA.userId, {
        date: dateFor(i),
        prescriptionVersionId: versionA,
        peakPain: aPreviousP[i],
        morningPain: aPreviousMP[i],
        morningStiffness: aMS,
        stiffnessDuration: aPreviousDuration,
      });
      sessionIds.push(ep.sessionId);
    }
    for (let i = 5; i < 10; i++) {
      const ep = await createEpisode(userA.userId, {
        date: dateFor(i),
        prescriptionVersionId: versionA,
        peakPain: aRecentP[i - 5],
        morningPain: aRecentMP[i - 5],
        morningStiffness: aMS,
        stiffnessDuration: aRecentDuration,
      });
      sessionIds.push(ep.sessionId);
    }

    const resultA = await runEngine(userA.userId);
    check("scenario A: engine returns status=generated (10 eligible episodes)", resultA.status === "generated", JSON.stringify(resultA));
    check("scenario A: overall Symptoms = symptoms_improving (2 improving core domains, 0 higher)", resultA.overallState === "symptoms_improving", resultA.overallState);
    check("scenario A: P direction = improving", resultA.core?.P?.direction === "improving", JSON.stringify(resultA.core?.P));
    check("scenario A: MP direction = improving", resultA.core?.MP?.direction === "improving", JSON.stringify(resultA.core?.MP));
    check("scenario A: MS direction = stable (identical values both windows)", resultA.core?.MS?.direction === "stable", JSON.stringify(resultA.core?.MS));
    check("scenario A: MSD direction = shorter", resultA.msd?.direction === "shorter", JSON.stringify(resultA.msd));
    check("scenario A: no reason codes fired (no mixed/rx-change/external-load present)", (resultA.reasonCodes ?? []).length === 0, JSON.stringify(resultA.reasonCodes));
    check(
      "scenario A: formal coverage is not_computable (founder decision — no ratio persisted)",
      resultA.coverageContext?.sessionCompletionCoverage === "not_computable" && resultA.coverageContext?.completeResponseCoverage === "not_computable",
      JSON.stringify(resultA.coverageContext)
    );
    check(
      "scenario A: raw coverage counts preserved for future authoritative reconstruction (10 attempted, 10 completed, 10 complete-response episodes)",
      resultA.coverageContext?.rawCounts?.attemptedSessionCount === 10 &&
        resultA.coverageContext?.rawCounts?.completedSessionCount === 10 &&
        resultA.coverageContext?.rawCounts?.completeResponseEpisodeCount === 10,
      JSON.stringify(resultA.coverageContext?.rawCounts)
    );
    if (resultA.interpretationId) interpretationIds.push(resultA.interpretationId);

    // --- Provenance: exact episode ids, window definition, ruleset version, heuristic links, reason codes ---
    const { data: interpRow } = await admin.from("m6_longitudinal_interpretations").select().eq("id", resultA.interpretationId).single();
    check("provenance: ruleset_version persisted correctly", interpRow?.ruleset_version === "m6_longitudinal_v1", interpRow?.ruleset_version);
    check("provenance: window_definition carries explicit previous/recent episode ids (reproducible membership)", Array.isArray(interpRow?.window_definition?.previousWindowRehabSessionIds) && interpRow.window_definition.previousWindowRehabSessionIds.length === 5, JSON.stringify(interpRow?.window_definition));
    check(
      "provenance: persisted result_detail.coverageContext is not_computable (proves the DEFERRAL, not just the in-memory response, was actually persisted)",
      interpRow?.result_detail?.coverageContext?.sessionCompletionCoverage === "not_computable",
      JSON.stringify(interpRow?.result_detail?.coverageContext)
    );
    const { data: linkedSessions } = await admin.from("m6_interpretation_rehab_sessions").select("rehab_session_id").eq("interpretation_id", resultA.interpretationId);
    check("provenance: exactly the 10 window rehab_session ids are linked", (linkedSessions ?? []).length === 10, (linkedSessions ?? []).length);
    const { data: linkedHeuristics } = await admin.from("m6_interpretation_heuristics").select("heuristic_id").eq("interpretation_id", resultA.interpretationId);
    check("provenance: all 6 Stage 3B heuristics linked for a fully-computed interpretation (incl. the 2 added post-review)", (linkedHeuristics ?? []).length === 6, (linkedHeuristics ?? []).length);

    // ------------------------------------------------------------------
    // Scenario B: only 6 eligible episodes -> insufficient data.
    // ------------------------------------------------------------------
    const versionB = await makePrescriptionVersion(userB.userId);
    for (let i = 0; i < 6; i++) {
      const ep = await createEpisode(userB.userId, {
        date: dateFor(i),
        prescriptionVersionId: versionB,
        peakPain: 3,
        morningPain: 3,
        morningStiffness: 0,
        stiffnessDuration: "not_applicable",
      });
      sessionIds.push(ep.sessionId);
    }
    const resultB = await runEngine(userB.userId);
    check("scenario B: fewer than 10 eligible episodes -> insufficient_data status", resultB.status === "insufficient_data", JSON.stringify(resultB));
    check("scenario B: eligibleEpisodeCount reported accurately (6)", resultB.eligibleEpisodeCount === 6, resultB.eligibleEpisodeCount);
    if (resultB.interpretationId) interpretationIds.push(resultB.interpretationId);
    const { data: insufficientRow } = await admin.from("m6_longitudinal_interpretations").select("result_state, window_start_date").eq("id", resultB.interpretationId).single();
    check("scenario B: persisted result_state = more_data_needed", insufficientRow?.result_state === "more_data_needed", insufficientRow?.result_state);
    check("scenario B: no fabricated window dates when insufficient", insufficientRow?.window_start_date === null, insufficientRow?.window_start_date);

    // ------------------------------------------------------------------
    // Scenario C: mixed core domains + a mid-window prescription change +
    // an external-load observation on a recent episode.
    // ------------------------------------------------------------------
    const versionC1 = await makePrescriptionVersion(userC.userId);
    const versionC2 = await makePrescriptionVersion(userC.userId);
    const cPreviousP = [5, 5, 5, 5, 5];
    const cRecentP = [2, 2, 2, 2, 5]; // improving
    const cPreviousMP = [3, 3, 3, 3, 3];
    const cRecentMP = [5, 5, 5, 5, 5]; // trending_higher
    for (let i = 0; i < 5; i++) {
      const ep = await createEpisode(userC.userId, {
        date: dateFor(i),
        prescriptionVersionId: versionC1,
        peakPain: cPreviousP[i],
        morningPain: cPreviousMP[i],
        morningStiffness: 0,
        stiffnessDuration: "not_applicable",
      });
      sessionIds.push(ep.sessionId);
    }
    for (let i = 5; i < 10; i++) {
      const ep = await createEpisode(userC.userId, {
        date: dateFor(i),
        prescriptionVersionId: versionC2, // version change within the window
        peakPain: cRecentP[i - 5],
        morningPain: cRecentMP[i - 5],
        morningStiffness: 0,
        stiffnessDuration: "not_applicable",
        externalLoad: i === 9 ? { category: "running", timing: "same_day_after_rehab", capturedDuring: "m4_morning_response" } : undefined,
      });
      sessionIds.push(ep.sessionId);
    }
    const resultC = await runEngine(userC.userId);
    check("scenario C: overall Symptoms = mixed_symptom_response (P improving + MP trending_higher)", resultC.overallState === "mixed_symptom_response", resultC.overallState);
    check("scenario C: mixed_symptom_directions reason code attached", (resultC.reasonCodes ?? []).includes("mixed_symptom_directions"), JSON.stringify(resultC.reasonCodes));
    check("scenario C: recent_prescription_change reason code attached (version changed mid-window)", (resultC.reasonCodes ?? []).includes("recent_prescription_change"), JSON.stringify(resultC.reasonCodes));
    check("scenario C: external_loading_context_present reason code attached (context only, never changes the classifier)", (resultC.reasonCodes ?? []).includes("external_loading_context_present"), JSON.stringify(resultC.reasonCodes));
    check("scenario C: high_response_variability NEVER auto-generated (no founder-approved trigger exists yet)", !(resultC.reasonCodes ?? []).includes("high_response_variability"), JSON.stringify(resultC.reasonCodes));
    check("scenario C: limited_coverage NEVER auto-generated (no founder-approved numeric threshold exists yet)", !(resultC.reasonCodes ?? []).includes("limited_coverage"), JSON.stringify(resultC.reasonCodes));
    // Decision 7: scenario C has MS=0 (stiffness_duration='not_applicable')
    // for all 10 episodes, so MSD has 0 applicable observations in BOTH
    // windows — well below the approved 3-per-window floor. This proves
    // MSD insufficiency does NOT force the overall Symptoms summary to
    // more_data_needed when P/MP/MS are complete: it stays a real,
    // fully-computed mixed_symptom_response (asserted above).
    check("scenario C: MSD direction = insufficient_data (0 applicable observations per window, below the 3-floor)", resultC.msd?.direction === "insufficient_data", JSON.stringify(resultC.msd));
    check(
      "scenario C: MSD insufficiency does NOT force overall Symptoms to more_data_needed — P/MP/MS alone still drive a real state",
      resultC.overallState !== "more_data_needed" && resultC.overallState === "mixed_symptom_response",
      resultC.overallState
    );
    if (resultC.interpretationId) interpretationIds.push(resultC.interpretationId);
    const { data: reasonRowsC } = await admin.from("m6_interpretation_reason_codes").select("reason_code").eq("interpretation_id", resultC.interpretationId);
    check("scenario C: all 3 reason codes actually persisted (not just returned in-memory)", (reasonRowsC ?? []).length === 3, (reasonRowsC ?? []).length);

    // ------------------------------------------------------------------
    // Coexistence + historical immutability: simulate a future ruleset
    // version for user A's domain and confirm the real v1 row is untouched.
    // ------------------------------------------------------------------
    await admin.from("m6_longitudinal_interpretations").insert({
      user_id: userA.userId,
      domain: "symptoms_short_window",
      ruleset_version: "m6_longitudinal_v2_fixture",
      result_state: "symptoms_stable",
      window_start_date: dateFor(10),
      window_end_date: dateFor(19),
    }).select().single().then(({ data }) => data && interpretationIds.push(data.id));
    const { data: allForDomainA } = await admin
      .from("m6_longitudinal_interpretations")
      .select("id, ruleset_version, result_state")
      .eq("user_id", userA.userId)
      .eq("domain", "symptoms_short_window")
      .order("generated_at", { ascending: false });
    check("coexistence: v1 (real engine output) and a later ruleset version coexist as 2 rows", (allForDomainA ?? []).length === 2, (allForDomainA ?? []).length);
    const { data: rereadV1 } = await admin.from("m6_longitudinal_interpretations").select("ruleset_version, result_state").eq("id", resultA.interpretationId).single();
    check(
      "historical integrity: userA's real v1 interpretation is unchanged after a later ruleset version was introduced",
      rereadV1?.ruleset_version === "m6_longitudinal_v1" && rereadV1?.result_state === "symptoms_improving"
    );

    // ------------------------------------------------------------------
    // RLS: patient reads own; unrelated patient cannot; clinician tenancy.
    // ------------------------------------------------------------------
    const clientA = await anonClientSignedInAs(userA.email);
    const { data: ownRead } = await clientA.from("m6_longitudinal_interpretations").select("id").eq("id", resultA.interpretationId);
    check("RLS: patient A can read their own generated interpretation", (ownRead ?? []).length === 1);

    const clientB = await anonClientSignedInAs(userB.email);
    const { data: crossRead } = await clientB.from("m6_longitudinal_interpretations").select("id").eq("id", resultA.interpretationId);
    check("RLS: an unrelated patient cannot read patient A's interpretation", (crossRead ?? []).length === 0);

    const clinicianClient = await anonClientSignedInAs(clinicianAssigned.email);
    const { data: clinicianRead } = await clinicianClient.from("m6_longitudinal_interpretations").select("id").eq("id", resultA.interpretationId);
    check("RLS: the assigned clinician can read patient A's interpretation", (clinicianRead ?? []).length === 1);
    const { data: clinicianReasonRead } = await clinicianClient.from("m6_interpretation_reason_codes").select("reason_code").eq("interpretation_id", resultC.interpretationId);
    // clinicianAssigned is only linked to userA, not userC, so this must be empty.
    check("RLS: the clinician cannot read reason codes for a patient they are not assigned to", (clinicianReasonRead ?? []).length === 0);

    const unrelatedClinicianClient = await anonClientSignedInAs(clinicianUnrelated.email);
    const { data: unrelatedClinicianRead } = await unrelatedClinicianClient.from("m6_longitudinal_interpretations").select("id").eq("id", resultA.interpretationId);
    check("RLS: a clinician with no supervisor_patients link cannot read patient A's interpretation", (unrelatedClinicianRead ?? []).length === 0);

    check("RLS: patient cannot INSERT a forged interpretation", Boolean((await clientA.from("m6_longitudinal_interpretations").insert({ user_id: userA.userId, domain: "symptoms_short_window", ruleset_version: "forged", result_state: "symptoms_improving" })).error));
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
      await admin.from("session_load_observations").delete().in("rehab_session_id", sessionIds);
      await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
      await admin.from("set_outcomes").delete().in("rehab_session_id", sessionIds);
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
