import "server-only";

// Milestone 6, Stage 3B — the longitudinal-interpretation ENGINE: the write
// path longitudinalInterpretationServer.ts's own header note said didn't
// exist yet ("no inference engine exists yet (Stage 3B+)... this module is
// not the place that decision gets made"). This is that new module, kept
// separate from the read-only one rather than bolted onto it.
//
// Pipeline: fetch raw data (service-role client, same trust tier as every
// other module here) -> build response episodes (responseEpisode.ts, pure)
// -> select the 5+5 short window (responseEpisode.ts, pure) -> classify
// (symptomClassifier.ts, pure) -> build a coverage CONTEXT, not a coverage
// ratio (symptomCoverage.ts, pure — formal coverage is deferred by founder
// decision) -> persist into the Stage 3A tables (this file only).
//
// SCOPE: symptoms only (P/MP/MS/MSD short-window + overall Symptoms
// summary). Capacity and Training Response are NOT implemented here — see
// docs/m6-stage3b-symptom-engine.md.

import { createServiceRoleClient } from "./supabase/server";
import type { StiffnessDuration } from "./morningResponseTypes";
import { LONGITUDINAL_RULESET_VERSION, type InterpretationReasonCode } from "./longitudinalInterpretationTypes";
import { buildResponseEpisodes, selectShortWindows, type RawResponseEpisodeInput } from "./responseEpisode";
import type { ExternalLoadObservation, ResponseEpisode } from "./responseEpisodeTypes";
import { classifyCoreDomain, classifyMsd, classifyOverallSymptoms, type CoreDomainResult, type MsdResult, type OverallSymptomsState } from "./symptomClassifier";
import { buildCoverageContext, type CoverageContext } from "./symptomCoverage";
import { comparePrescriptionVersions } from "./progressCompare";
import { getHeuristicByKey } from "./heuristicsCatalogServer";
import {
  ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY,
  DIRECTIONAL_FREQUENCY_60PCT_HEURISTIC_KEY,
  ONE_POINT_DIRECTIONAL_BOUNDARY_HEURISTIC_KEY,
  OVERALL_SYMPTOMS_SUMMARY_HEURISTIC_KEY,
  CONSISTENCY_VARIABLE_VS_CONSISTENT_HEURISTIC_KEY,
  MSD_MIN_3_PER_WINDOW_HEURISTIC_KEY,
} from "./symptomHeuristics";

// Symptoms domain value — one of the exact illustrative values named by the
// Stage 3A migration header ('symptoms_short_window'), now actually used.
const SYMPTOMS_SHORT_WINDOW_DOMAIN = "symptoms_short_window";

// Generous — Stage 3B only ever needs the most recent ~10-20 eligible
// episodes, but a patient with a low completion rate may need a deeper
// lookback to find 10 eligible ones. Cheap query (id-shaped columns only).
const RAW_SESSION_FETCH_LIMIT = 400;

type SessionRow = {
  id: string;
  patient_local_date: string;
  prescription_version_id: string | null;
  prescription_instance_id: string;
  status: string;
  exercise_outcome: string | null;
  peak_session_pain: number | null;
};
type MorningRow = {
  id: string;
  rehab_session_id: string;
  next_morning_pain: number | null;
  next_morning_stiffness: number | null;
  stiffness_duration: StiffnessDuration | null;
  submitted_at: string | null;
};
type ToleranceRow = { id: string; rehab_session_id: string };
type SetOutcomeSessionIdRow = { rehab_session_id: string };
type LoadObsRow = { rehab_session_id: string; category: string; timing: string | null };
type BlockedOpportunityRow = { prescription_instance_id: string; blocked_at: string };
type AcuteEpisodeDateRow = { confirmed_at: string };

async function fetchRawEpisodeInputs(userId: string): Promise<{
  rawInputs: RawResponseEpisodeInput[];
  allAttemptedSessions: SessionRow[];
  blockedOpportunities: BlockedOpportunityRow[];
}> {
  const supabase = createServiceRoleClient();

  const { data: sessionRows } = await supabase
    .from("rehab_sessions")
    .select("id, patient_local_date, prescription_version_id, prescription_instance_id, status, exercise_outcome, peak_session_pain")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(RAW_SESSION_FETCH_LIMIT);
  const sessions = (sessionRows ?? []) as SessionRow[];
  const sessionIds = sessions.map((s) => s.id);

  const [morningRes, toleranceRes, setOutcomeRes, loadObsRes, blockedRes, acuteRes] = await Promise.all([
    sessionIds.length
      ? supabase
          .from("morning_responses")
          .select("id, rehab_session_id, next_morning_pain, next_morning_stiffness, stiffness_duration, submitted_at")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as MorningRow[] }),
    sessionIds.length
      ? supabase.from("tolerance_evaluations").select("id, rehab_session_id").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as ToleranceRow[] }),
    sessionIds.length
      ? supabase.from("set_outcomes").select("rehab_session_id").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as SetOutcomeSessionIdRow[] }),
    sessionIds.length
      ? supabase.from("session_load_observations").select("rehab_session_id, category, timing").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as LoadObsRow[] }),
    supabase.from("blocked_loading_opportunities").select("prescription_instance_id, blocked_at").eq("user_id", userId),
    supabase.from("acute_safety_episodes").select("confirmed_at").eq("user_id", userId),
  ]);

  // Only a finalized morning response is a known fact — same filter as
  // progressServer.ts's own "submitted_at IS NULL means not yet answered".
  const morningBySession = new Map<string, MorningRow>();
  for (const row of (morningRes.data ?? []) as MorningRow[]) {
    if (row.submitted_at != null) morningBySession.set(row.rehab_session_id, row);
  }
  const toleranceBySession = new Map<string, string>();
  for (const row of (toleranceRes.data ?? []) as ToleranceRow[]) {
    if (!toleranceBySession.has(row.rehab_session_id)) toleranceBySession.set(row.rehab_session_id, row.id);
  }
  const sessionsWithSetOutcomes = new Set<string>();
  for (const row of (setOutcomeRes.data ?? []) as SetOutcomeSessionIdRow[]) sessionsWithSetOutcomes.add(row.rehab_session_id);
  const loadObsBySession = new Map<string, ExternalLoadObservation[]>();
  for (const row of (loadObsRes.data ?? []) as LoadObsRow[]) {
    const list = loadObsBySession.get(row.rehab_session_id) ?? [];
    list.push({ category: row.category, timing: row.timing });
    loadObsBySession.set(row.rehab_session_id, list);
  }
  const acuteEventDates = new Set(((acuteRes.data ?? []) as AcuteEpisodeDateRow[]).map((r) => r.confirmed_at.slice(0, 10)));

  const rawInputs: RawResponseEpisodeInput[] = sessions.map((s) => {
    const morning = morningBySession.get(s.id) ?? null;
    return {
      rehabSessionId: s.id,
      userId,
      patientLocalDate: s.patient_local_date,
      prescriptionVersionId: s.prescription_version_id,
      prescriptionInstanceId: s.prescription_instance_id,
      sessionStatus: s.status,
      hasSetOutcomes: sessionsWithSetOutcomes.has(s.id),
      morningResponseId: morning?.id ?? null,
      morningResponseSubmittedAt: morning?.submitted_at ?? null,
      nextMorningPain: morning?.next_morning_pain ?? null,
      nextMorningStiffness: morning?.next_morning_stiffness ?? null,
      stiffnessDuration: morning?.stiffness_duration ?? null,
      toleranceEvaluationId: toleranceBySession.get(s.id) ?? null,
      peakSessionPain: s.peak_session_pain,
      externalLoadObservations: loadObsBySession.get(s.id) ?? [],
      hasAcuteSafetyContext: acuteEventDates.has(s.patient_local_date),
    };
  });

  return { rawInputs, allAttemptedSessions: sessions, blockedOpportunities: (blockedRes.data ?? []) as BlockedOpportunityRow[] };
}

export type GenerateShortWindowSymptomInterpretationResult =
  | {
      status: "insufficient_data";
      interpretationId: string;
      eligibleEpisodeCount: number;
    }
  | {
      status: "generated";
      interpretationId: string;
      overallState: OverallSymptomsState;
      core: { P: CoreDomainResult; MP: CoreDomainResult; MS: CoreDomainResult };
      msd: MsdResult;
      coverageContext: CoverageContext;
      reasonCodes: InterpretationReasonCode[];
    };

export async function generateShortWindowSymptomInterpretation(userId: string): Promise<GenerateShortWindowSymptomInterpretationResult> {
  const supabase = createServiceRoleClient();
  const { rawInputs, allAttemptedSessions, blockedOpportunities } = await fetchRawEpisodeInputs(userId);

  const allEpisodes = buildResponseEpisodes(rawInputs);
  // Newest-first, matching selectShortWindows' documented input contract.
  const eligibleNewestFirst = allEpisodes
    .filter((e) => e.eligibleForSymptomAnalysis)
    .sort((a, b) => b.patientLocalDate.localeCompare(a.patientLocalDate));

  const windows = selectShortWindows(eligibleNewestFirst);

  if (!windows) {
    const interpretationId = await persistInterpretation(supabase, {
      userId,
      resultState: "more_data_needed",
      windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions", sufficient: false },
      windowStartDate: null,
      windowEndDate: null,
      resultDetail: { eligibleEpisodeCount: eligibleNewestFirst.length },
      episodes: eligibleNewestFirst,
      reasonCodes: [],
      heuristicKeys: [ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY],
    });
    return { status: "insufficient_data", interpretationId, eligibleEpisodeCount: eligibleNewestFirst.length };
  }

  const { previous, recent } = windows;
  const allWindowEpisodes = [...previous, ...recent];

  const P = classifyCoreDomain(
    previous.map((e) => e.peakSessionPain as number),
    recent.map((e) => e.peakSessionPain as number)
  );
  const MP = classifyCoreDomain(
    previous.map((e) => e.nextMorningPain as number),
    recent.map((e) => e.nextMorningPain as number)
  );
  const MS = classifyCoreDomain(
    previous.map((e) => e.nextMorningStiffness as number),
    recent.map((e) => e.nextMorningStiffness as number)
  );
  const msd = classifyMsd(
    previous.map((e) => e.stiffnessDuration).filter((d): d is StiffnessDuration => d != null),
    recent.map((e) => e.stiffnessDuration).filter((d): d is StiffnessDuration => d != null)
  );
  const overallState = classifyOverallSymptoms({ P, MP, MS });

  const windowDates = allWindowEpisodes.map((e) => e.patientLocalDate).sort();
  const windowStartDate = windowDates[0];
  const windowEndDate = windowDates[windowDates.length - 1];

  const sessionsInSpan = allAttemptedSessions.filter((s) => s.patient_local_date >= windowStartDate && s.patient_local_date <= windowEndDate);
  const blockedInSpan = blockedOpportunities.filter((b) => {
    const d = b.blocked_at.slice(0, 10);
    return d >= windowStartDate && d <= windowEndDate;
  });
  const completeResponseEpisodeCountInSpan = allEpisodes.filter(
    (e) => e.eligibleForSymptomAnalysis && e.patientLocalDate >= windowStartDate && e.patientLocalDate <= windowEndDate
  ).length;

  const coverageContext = buildCoverageContext({
    attemptedPrescriptionInstanceIds: sessionsInSpan.map((s) => s.prescription_instance_id),
    completedPrescriptionInstanceIds: sessionsInSpan.filter((s) => s.exercise_outcome === "completed").map((s) => s.prescription_instance_id),
    blockedOnlyPrescriptionInstanceIds: blockedInSpan.map((b) => b.prescription_instance_id),
    completeResponseEpisodeCount: completeResponseEpisodeCountInSpan,
  });

  // --- Reason codes actually supported by this Stage 3B pass. Founder
  // decision: limited_coverage and high_response_variability are DEFERRED,
  // not merely unimplemented — limited_coverage depends on formal coverage
  // (not computed, see symptomCoverage.ts), and high_response_variability
  // would require inventing an IQR/distribution threshold the brief
  // explicitly forbids, on top of the domain-level Consistency output
  // already covering that need. See docs/m6-stage3b-symptom-engine.md. ---
  const reasonCodes: InterpretationReasonCode[] = [];
  if (overallState === "mixed_symptom_response") reasonCodes.push("mixed_symptom_directions");

  const distinctPrescriptionVersionIds = [...new Set(allWindowEpisodes.map((e) => e.prescriptionVersionId).filter((id): id is string => id != null))];
  let previousVersionId: string | null | undefined = undefined;
  let prescriptionChangedWithinWindow = false;
  for (const e of allWindowEpisodes) {
    if (previousVersionId !== undefined && comparePrescriptionVersions(previousVersionId, e.prescriptionVersionId) === "different") {
      prescriptionChangedWithinWindow = true;
    }
    previousVersionId = e.prescriptionVersionId;
  }
  if (prescriptionChangedWithinWindow) reasonCodes.push("recent_prescription_change");

  const hasExternalLoadContext = recent.some((e) => e.externalLoadObservations.some((o) => o.category !== "none"));
  if (hasExternalLoadContext) reasonCodes.push("external_loading_context_present");

  const interpretationId = await persistInterpretation(supabase, {
    userId,
    resultState: overallState,
    windowDefinition: {
      kind: "rolling_5_plus_5",
      unit: "sessions",
      sufficient: true,
      previousWindowRehabSessionIds: previous.map((e) => e.rehabSessionId),
      recentWindowRehabSessionIds: recent.map((e) => e.rehabSessionId),
    },
    windowStartDate,
    windowEndDate,
    resultDetail: {
      core: {
        P: serializeCoreDomainResult(P),
        MP: serializeCoreDomainResult(MP),
        MS: serializeCoreDomainResult(MS),
      },
      msd,
      coverageContext,
      distinctPrescriptionVersionIds,
    },
    episodes: allWindowEpisodes,
    reasonCodes,
    heuristicKeys: [
      ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY,
      DIRECTIONAL_FREQUENCY_60PCT_HEURISTIC_KEY,
      ONE_POINT_DIRECTIONAL_BOUNDARY_HEURISTIC_KEY,
      OVERALL_SYMPTOMS_SUMMARY_HEURISTIC_KEY,
      CONSISTENCY_VARIABLE_VS_CONSISTENT_HEURISTIC_KEY,
      MSD_MIN_3_PER_WINDOW_HEURISTIC_KEY,
    ],
  });

  return { status: "generated", interpretationId, overallState, core: { P, MP, MS }, msd, coverageContext, reasonCodes };
}

// Pure serialization of a CoreDomainResult into resultDetail's JSONB shape.
function serializeCoreDomainResult(r: CoreDomainResult) {
  return {
    direction: r.direction,
    consistency: r.consistency,
    recentMedian: r.recentMedian,
    previousMedian: r.previousMedian,
    recentIqr: r.recentIqr,
    previousIqr: r.previousIqr,
    frequencyPattern: r.frequencyPattern,
    medianDirection: r.medianDirection,
    recentValues: r.recentValues,
    previousValues: r.previousValues,
  };
}

async function persistInterpretation(
  supabase: ReturnType<typeof createServiceRoleClient>,
  params: {
    userId: string;
    resultState: string;
    windowDefinition: Record<string, unknown>;
    windowStartDate: string | null;
    windowEndDate: string | null;
    resultDetail: Record<string, unknown>;
    episodes: ResponseEpisode[];
    reasonCodes: InterpretationReasonCode[];
    heuristicKeys: string[];
  }
): Promise<string> {
  const { data: interpretation, error: interpretationError } = await supabase
    .from("m6_longitudinal_interpretations")
    .insert({
      user_id: params.userId,
      domain: SYMPTOMS_SHORT_WINDOW_DOMAIN,
      ruleset_version: LONGITUDINAL_RULESET_VERSION,
      window_definition: params.windowDefinition,
      window_start_date: params.windowStartDate,
      window_end_date: params.windowEndDate,
      result_state: params.resultState,
      result_detail: params.resultDetail,
    })
    .select("id")
    .single();
  if (interpretationError || !interpretation) {
    throw new Error(`generateShortWindowSymptomInterpretation: failed to insert interpretation: ${interpretationError?.message}`);
  }
  const interpretationId = interpretation.id as string;

  if (params.reasonCodes.length > 0) {
    const { error } = await supabase
      .from("m6_interpretation_reason_codes")
      .insert(params.reasonCodes.map((reason_code) => ({ interpretation_id: interpretationId, reason_code })));
    if (error) throw new Error(`generateShortWindowSymptomInterpretation: failed to insert reason codes: ${error.message}`);
  }

  const rehabSessionIds = [...new Set(params.episodes.map((e) => e.rehabSessionId))];
  const morningResponseIds = [...new Set(params.episodes.map((e) => e.morningResponseId))];
  const toleranceEvaluationIds = [...new Set(params.episodes.map((e) => e.toleranceEvaluationId).filter((id): id is string => id != null))];
  const prescriptionVersionIds = [...new Set(params.episodes.map((e) => e.prescriptionVersionId).filter((id): id is string => id != null))];

  const provenanceInserts: PromiseLike<{ error: { message: string } | null }>[] = [];
  if (rehabSessionIds.length > 0) {
    provenanceInserts.push(
      supabase.from("m6_interpretation_rehab_sessions").insert(rehabSessionIds.map((rehab_session_id) => ({ interpretation_id: interpretationId, rehab_session_id })))
    );
  }
  if (morningResponseIds.length > 0) {
    provenanceInserts.push(
      supabase
        .from("m6_interpretation_morning_responses")
        .insert(morningResponseIds.map((morning_response_id) => ({ interpretation_id: interpretationId, morning_response_id })))
    );
  }
  if (toleranceEvaluationIds.length > 0) {
    provenanceInserts.push(
      supabase
        .from("m6_interpretation_tolerance_evaluations")
        .insert(toleranceEvaluationIds.map((tolerance_evaluation_id) => ({ interpretation_id: interpretationId, tolerance_evaluation_id })))
    );
  }
  if (prescriptionVersionIds.length > 0) {
    provenanceInserts.push(
      supabase
        .from("m6_interpretation_prescription_versions")
        .insert(prescriptionVersionIds.map((prescription_version_id) => ({ interpretation_id: interpretationId, prescription_version_id })))
    );
  }
  const provenanceResults = await Promise.all(provenanceInserts);
  for (const r of provenanceResults) {
    if (r.error) throw new Error(`generateShortWindowSymptomInterpretation: failed to insert provenance: ${r.error.message}`);
  }

  if (params.heuristicKeys.length > 0) {
    const heuristics = await Promise.all(params.heuristicKeys.map((key) => getHeuristicByKey(key)));
    const heuristicIds = heuristics.filter((h): h is NonNullable<typeof h> => h != null).map((h) => h.id);
    if (heuristicIds.length !== params.heuristicKeys.length) {
      throw new Error(
        `generateShortWindowSymptomInterpretation: expected heuristic catalog rows for [${params.heuristicKeys.join(", ")}] but found [${heuristicIds.join(", ")}] — has the Stage 3B heuristic seed migration been applied?`
      );
    }
    if (heuristicIds.length > 0) {
      const { error } = await supabase
        .from("m6_interpretation_heuristics")
        .insert(heuristicIds.map((heuristic_id) => ({ interpretation_id: interpretationId, heuristic_id })));
      if (error) throw new Error(`generateShortWindowSymptomInterpretation: failed to insert heuristic links: ${error.message}`);
    }
  }

  return interpretationId;
}
