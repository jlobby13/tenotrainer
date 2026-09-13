import "server-only";

// Milestone 6, Stage 3C — the Training Response interpretation ENGINE.
//
// LOCKED (brief section 12 — WINDOW ALIGNMENT): Training Response analyzes
// comparable loading over the EXACT SAME 10 response episodes used by the
// relevant Stage 3B 5+5 Symptoms interpretation. This engine therefore
// calls generateShortWindowSymptomInterpretation() FIRST (regenerating —
// and re-persisting — that Symptoms interpretation as part of this run,
// exactly as Stage 3B already does standalone) and takes its exact
// previous/recent rehab_session_id sets as the ONLY window it will ever
// compare loading over. It never re-derives a "conveniently different"
// window of its own.
//
// Pipeline: generate/persist the Stage 3B Symptoms interpretation -> build
// every CapacityExposure for the patient (capacityInterpretationEngine.ts's
// shared builder) -> restrict to exactly the symptom window's session ids
// -> compare loading across the window using the FINAL LOCKED mechanism
// (trainingResponseClassifier.ts: boundary-adjacent real-exposure pairing,
// >=2-usable-pairs-per-construct sufficiency, per-construct direction, then
// multi-construct aggregation) -> combine with Overall Symptoms -> persist.

import { createServiceRoleClient } from "./supabase/server";
import { generateShortWindowSymptomInterpretation } from "./longitudinalInterpretationEngine";
import { persistInterpretation } from "./longitudinalInterpretationEngine";
import { buildAllCapacityExposuresForUser } from "./capacityInterpretationEngine";
import { compareWindowLoading, classifyTrainingResponse, type WindowLoadingComparisonDetail } from "./trainingResponseClassifier";
import type { InterpretationReasonCode } from "./longitudinalInterpretationTypes";
import {
  TRAINING_RESPONSE_STATE_MAPPING_HEURISTIC_KEY,
  PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY,
  TRAINING_RESPONSE_WINDOW_PAIRING_HEURISTIC_KEY,
  TRAINING_RESPONSE_MINIMUM_PAIRED_EXPOSURES_HEURISTIC_KEY,
  TRAINING_RESPONSE_LOADING_DIRECTION_MAPPING_HEURISTIC_KEY,
} from "./capacityHeuristics";
import {
  ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY,
  DIRECTIONAL_FREQUENCY_60PCT_HEURISTIC_KEY,
  ONE_POINT_DIRECTIONAL_BOUNDARY_HEURISTIC_KEY,
  OVERALL_SYMPTOMS_SUMMARY_HEURISTIC_KEY,
} from "./symptomHeuristics";

const TRAINING_RESPONSE_SERIES_DOMAIN = "training_response_series";

export type TrainingResponseEngineResult = {
  interpretationId: string;
  state: string;
  symptomInterpretationId: string;
  windowLoadingComparison: WindowLoadingComparisonDetail;
};

export async function generateTrainingResponseInterpretation(userId: string): Promise<TrainingResponseEngineResult> {
  const supabase = createServiceRoleClient();

  const symptomResult = await generateShortWindowSymptomInterpretation(userId);

  if (symptomResult.status === "insufficient_data") {
    const interpretationId = await persistInterpretation(supabase, {
      userId,
      domain: TRAINING_RESPONSE_SERIES_DOMAIN,
      resultState: "more_data_needed",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: false, symptomInterpretationId: symptomResult.interpretationId },
      windowStartDate: null,
      windowEndDate: null,
      resultDetail: { reason: "Stage 3B Symptoms is insufficient for this patient — no aligned window exists yet to compare loading over." },
      rehabSessionIds: [],
      morningResponseIds: [],
      toleranceEvaluationIds: [],
      prescriptionVersionIds: [],
      reasonCodes: [],
      heuristicKeys: [TRAINING_RESPONSE_STATE_MAPPING_HEURISTIC_KEY],
    });
    return {
      interpretationId,
      state: "more_data_needed",
      symptomInterpretationId: symptomResult.interpretationId,
      windowLoadingComparison: { overall: "insufficient", constructResults: [], hasInsufficientConstruct: false },
    };
  }

  const { previousWindowRehabSessionIds, recentWindowRehabSessionIds } = symptomResult;
  const windowRehabSessionIds = new Set([...previousWindowRehabSessionIds, ...recentWindowRehabSessionIds]);

  const { allExposuresNewestFirst, sessionsWithExternalLoad } = await buildAllCapacityExposuresForUser(userId);
  const exposuresInWindow = allExposuresNewestFirst.filter((e) => windowRehabSessionIds.has(e.rehabSessionId));

  const windowLoadingComparison = compareWindowLoading({
    previousRehabSessionIds: previousWindowRehabSessionIds,
    recentRehabSessionIds: recentWindowRehabSessionIds,
    exposures: exposuresInWindow,
  });

  const state = classifyTrainingResponse({
    overallSymptomsState: symptomResult.overallState,
    windowLoadingComparison: windowLoadingComparison.overall,
  });

  const reasonCodes: InterpretationReasonCode[] = [];
  if ([...windowRehabSessionIds].some((id) => sessionsWithExternalLoad.has(id))) reasonCodes.push("external_loading_context_present");
  // LOCKED (brief section 6): at least one usable construct AND at least
  // one insufficient construct -> attach a structured limitation. The
  // brief names this "limited_comparable_constructs"; this codebase's
  // existing, already-approved Stage 3A reason-code vocabulary has no such
  // value, but DOES have the near-identical "limited_comparable_exposures"
  // (Stage 3A migration 20260911000007) — reused here deliberately rather
  // than extending the CHECK-constrained enum for a schema change this
  // pass wasn't asked to make. Flagged explicitly in the Stage 3C report,
  // not a silent substitution.
  const usableConstructCount = windowLoadingComparison.constructResults.filter((c) => c.direction !== "insufficient").length;
  if (usableConstructCount > 0 && windowLoadingComparison.hasInsufficientConstruct) reasonCodes.push("limited_comparable_exposures");

  const toleranceEvaluationIds = [...new Set(exposuresInWindow.map((e) => e.toleranceEvaluationId))];
  const prescriptionVersionIds = [...new Set(exposuresInWindow.map((e) => e.prescriptionVersionId).filter((id): id is string => id != null))];
  const windowDates = [...new Set(exposuresInWindow.map((e) => e.patientLocalDate))].sort();

  const interpretationId = await persistInterpretation(supabase, {
    userId,
    domain: TRAINING_RESPONSE_SERIES_DOMAIN,
    resultState: state,
    windowDefinition: {
      kind: "aligned_with_symptom_window",
      sufficient: true,
      symptomInterpretationId: symptomResult.interpretationId,
      previousWindowRehabSessionIds,
      recentWindowRehabSessionIds,
    },
    windowStartDate: windowDates[0] ?? null,
    windowEndDate: windowDates[windowDates.length - 1] ?? null,
    resultDetail: {
      overallSymptomsState: symptomResult.overallState,
      overallLoadingDirection: windowLoadingComparison.overall,
      hasInsufficientConstruct: windowLoadingComparison.hasInsufficientConstruct,
      // Full per-construct provenance — every pairing, every unmatched real
      // exposure, every construct's own direction — never silently excluded
      // (brief section 14).
      constructResults: windowLoadingComparison.constructResults.map((c) => ({
        construct: c.construct,
        previousExposureCount: c.previousExposureCount,
        recentExposureCount: c.recentExposureCount,
        pairs: c.pairs,
        usablePairCount: c.usablePairCount,
        unmatchedPreviousRehabSessionIds: c.unmatchedPreviousRehabSessionIds,
        unmatchedRecentRehabSessionIds: c.unmatchedRecentRehabSessionIds,
        direction: c.direction,
        insufficiencyReason: c.insufficiencyReason,
      })),
    },
    rehabSessionIds: [...windowRehabSessionIds],
    morningResponseIds: [],
    toleranceEvaluationIds,
    prescriptionVersionIds,
    reasonCodes,
    heuristicKeys: [
      TRAINING_RESPONSE_STATE_MAPPING_HEURISTIC_KEY,
      PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY,
      TRAINING_RESPONSE_WINDOW_PAIRING_HEURISTIC_KEY,
      TRAINING_RESPONSE_MINIMUM_PAIRED_EXPOSURES_HEURISTIC_KEY,
      TRAINING_RESPONSE_LOADING_DIRECTION_MAPPING_HEURISTIC_KEY,
      ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY,
      DIRECTIONAL_FREQUENCY_60PCT_HEURISTIC_KEY,
      ONE_POINT_DIRECTIONAL_BOUNDARY_HEURISTIC_KEY,
      OVERALL_SYMPTOMS_SUMMARY_HEURISTIC_KEY,
    ],
  });

  return { interpretationId, state, symptomInterpretationId: symptomResult.interpretationId, windowLoadingComparison };
}
