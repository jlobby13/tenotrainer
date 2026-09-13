// Milestone 6, Stage 3C — Training Response classifier. Pure, deterministic.
// No new symptom hierarchy: consumes Stage 3B's Overall Symptoms directly
// (brief section 11) — P/MP/MS remain the core symptom domains, MSD remains
// conditional/enriching, exactly as Stage 3B locked them. This module only
// adds the loading-comparison half and the combination rule.
//
// LOCKED (brief section 12 — WINDOW ALIGNMENT): Training Response must
// analyze loading over the EXACT SAME 10 response episodes used by the
// relevant Stage 3B 5+5 Symptoms interpretation — never a conveniently
// different window.
//
// FINAL LOCKED MECHANISM (round 4 founder decision):
//  - Real-exposure pairing: BOUNDARY-ADJACENT one-to-one chronological
//    pairing per construct. Previous-half exposures ordered chronologically
//    (oldest->newest); recent-half exposures ordered chronologically
//    (oldest->newest). Pair from the window boundary outward: the most-
//    recent previous exposure pairs with the earliest recent exposure, the
//    second-most-recent previous pairs with the second-earliest recent,
//    etc., until the shorter side is exhausted. Each real exposure appears
//    in AT MOST ONE pair — never reused, never synthesized, never averaged.
//    Unmatched real exposures on the longer side are preserved in
//    provenance but do not enter this run's paired directional comparison.
//  - Minimum evidence: a construct needs >=2 USABLE paired comparisons
//    (comparison result != "insufficient") before it may contribute a
//    formal direction; 0 or 1 usable pair -> that construct's result is
//    "insufficient" (the underlying pair(s), if any, remain visible in
//    provenance — a TenoTrainer operational SUFFICIENCY heuristic, not a
//    validated biological threshold, MCID, or statistical confidence
//    threshold: m6_training_response_minimum_paired_exposures).
//  - Construct-level direction (from usable pairs' higher/equal/lower/
//    non_dominating results only): increased = >=1 higher, 0 lower, 0
//    non_dominating (equal may coexist); decreased = >=1 lower, 0 higher, 0
//    non_dominating (equal may coexist); maintained = all equal; mixed =
//    (>=1 higher AND >=1 lower) OR any non_dominating. No 60%, no majority
//    voting, no 2-of-4, no mean/median/weighted scoring anywhere in this
//    step (m6_training_response_loading_direction_mapping).
//  - Multi-construct aggregation: usable constructs (direction !=
//    "insufficient") vote; all agree -> that value; disagreement, or any
//    usable construct itself "mixed" -> overall "mixed". Insufficient
//    constructs never vote but are ALWAYS visible in provenance and trigger
//    a "limited_comparable_exposures" reason code when at least one usable
//    construct also exists (see the engine). If NO construct has >=2
//    usable pairs, overall = "insufficient".
//
// Capacity and Training Response remain fully distinct: this module never
// interprets a loading pattern as Capacity confirmation — Capacity is
// governed entirely and only by capacityClassifier.ts's own 2-of-4/
// qualification/labeling mechanism.

import type { CapacityExposure, ComparableConstruct, TrainingResponseState } from "./capacityTypes";
import { compareSetVectors, type DimensionComparison } from "./capacityLoadingComparison";
import { constructKey } from "./capacityConstruct";
import type { OverallSymptomsState } from "./symptomClassifier";

// LOCKED constant (round 4 founder decision) — a TenoTrainer operational
// sufficiency heuristic, not a validated threshold.
export const MIN_USABLE_PAIRS_PER_CONSTRUCT = 2;

export type WindowLoadingComparison = "increased" | "maintained" | "decreased" | "mixed" | "insufficient";
export type ConstructDirection = WindowLoadingComparison; // same vocabulary at the construct level

export type ConstructPairComparison = {
  previousRehabSessionId: string;
  recentRehabSessionId: string;
  comparison: DimensionComparison;
};

export type ConstructWindowResult = {
  construct: ComparableConstruct;
  previousExposureCount: number;
  recentExposureCount: number;
  // Every attempted pair (min(previousCount, recentCount) of them),
  // including ones whose comparison came back "insufficient" — never
  // discarded, always visible.
  pairs: ConstructPairComparison[];
  usablePairCount: number;
  unmatchedPreviousRehabSessionIds: string[];
  unmatchedRecentRehabSessionIds: string[];
  direction: ConstructDirection;
  insufficiencyReason: "no_data_in_one_half" | "fewer_than_two_usable_pairs" | null;
};

export type WindowLoadingComparisonDetail = {
  overall: WindowLoadingComparison;
  constructResults: ConstructWindowResult[];
  hasInsufficientConstruct: boolean;
};

// Boundary-adjacent one-to-one pairing (LOCKED, round 4). Given previous and
// recent exposures for ONE construct (any input order), returns exactly
// min(previousCount, recentCount) pairs plus whichever real exposures on
// the longer side go unmatched. No exposure ever appears in more than one
// pair.
function pairBoundaryAdjacent(
  previousExposures: CapacityExposure[],
  recentExposures: CapacityExposure[]
): { pairs: Array<{ previous: CapacityExposure; recent: CapacityExposure }>; unmatchedPrevious: CapacityExposure[]; unmatchedRecent: CapacityExposure[] } {
  // Previous ordered chronologically then reversed -> newest-previous first
  // (closest to the window boundary first). Recent ordered chronologically
  // oldest-first (also closest to the boundary first). Pairing index-wise
  // therefore pairs outward from the boundary, exactly as locked.
  const previousNewestFirst = [...previousExposures].sort((a, b) => a.patientLocalDate.localeCompare(b.patientLocalDate)).reverse();
  const recentOldestFirst = [...recentExposures].sort((a, b) => a.patientLocalDate.localeCompare(b.patientLocalDate));

  const pairCount = Math.min(previousNewestFirst.length, recentOldestFirst.length);
  const pairs = Array.from({ length: pairCount }, (_, i) => ({ previous: previousNewestFirst[i], recent: recentOldestFirst[i] }));
  return {
    pairs,
    unmatchedPrevious: previousNewestFirst.slice(pairCount),
    unmatchedRecent: recentOldestFirst.slice(pairCount),
  };
}

function classifyConstructWindow(construct: ComparableConstruct, previous: CapacityExposure[], recent: CapacityExposure[]): ConstructWindowResult {
  const { pairs, unmatchedPrevious, unmatchedRecent } = pairBoundaryAdjacent(previous, recent);
  const pairComparisons: ConstructPairComparison[] = pairs.map((p) => ({
    previousRehabSessionId: p.previous.rehabSessionId,
    recentRehabSessionId: p.recent.rehabSessionId,
    comparison: compareSetVectors(p.recent.actual, p.previous.actual),
  }));
  // A pair whose comparison is itself "insufficient" (nothing comparable at
  // any set position) contributes no directional evidence — excluded from
  // the usable count, though still fully visible in `pairs`.
  const usable = pairComparisons.filter((p) => p.comparison !== "insufficient");

  let direction: ConstructDirection;
  let insufficiencyReason: ConstructWindowResult["insufficiencyReason"] = null;

  if (usable.length < MIN_USABLE_PAIRS_PER_CONSTRUCT) {
    direction = "insufficient";
    insufficiencyReason = previous.length === 0 || recent.length === 0 ? "no_data_in_one_half" : "fewer_than_two_usable_pairs";
  } else {
    const hasHigher = usable.some((p) => p.comparison === "higher");
    const hasLower = usable.some((p) => p.comparison === "lower");
    const hasNonDominating = usable.some((p) => p.comparison === "non_dominating");
    if ((hasHigher && hasLower) || hasNonDominating) direction = "mixed";
    else if (hasHigher) direction = "increased";
    else if (hasLower) direction = "decreased";
    else direction = "maintained"; // all usable pairs are 'equal'
  }

  return {
    construct,
    previousExposureCount: previous.length,
    recentExposureCount: recent.length,
    pairs: pairComparisons,
    usablePairCount: usable.length,
    unmatchedPreviousRehabSessionIds: unmatchedPrevious.map((e) => e.rehabSessionId),
    unmatchedRecentRehabSessionIds: unmatchedRecent.map((e) => e.rehabSessionId),
    direction,
    insufficiencyReason,
  };
}

export function compareWindowLoading(params: {
  previousRehabSessionIds: string[];
  recentRehabSessionIds: string[];
  // Every CapacityExposure across every construct for sessions in this
  // exact window (both halves) — the caller is responsible for exact
  // window alignment (brief section 12).
  exposures: CapacityExposure[];
}): WindowLoadingComparisonDetail {
  const byConstruct = new Map<string, CapacityExposure[]>();
  for (const e of params.exposures) {
    if (e.construct.performanceUnit === "unrepresentable") continue; // never quantitatively compared (brief section 4)
    const key = constructKey(e.construct);
    const list = byConstruct.get(key) ?? [];
    list.push(e);
    byConstruct.set(key, list);
  }

  const constructResults: ConstructWindowResult[] = [];
  for (const exposuresForConstruct of byConstruct.values()) {
    const previous = exposuresForConstruct.filter((e) => params.previousRehabSessionIds.includes(e.rehabSessionId));
    const recent = exposuresForConstruct.filter((e) => params.recentRehabSessionIds.includes(e.rehabSessionId));
    if (previous.length === 0 && recent.length === 0) continue; // not actually present in this window at all
    constructResults.push(classifyConstructWindow(exposuresForConstruct[0].construct, previous, recent));
  }

  const usableResults = constructResults.filter((c) => c.direction !== "insufficient");
  const hasInsufficientConstruct = constructResults.some((c) => c.direction === "insufficient");

  let overall: WindowLoadingComparison;
  if (usableResults.length === 0) {
    overall = "insufficient";
  } else {
    const anyMixed = usableResults.some((c) => c.direction === "mixed");
    const distinctDirections = new Set(usableResults.map((c) => c.direction));
    overall = anyMixed || distinctDirections.size > 1 ? "mixed" : (usableResults[0].direction as WindowLoadingComparison);
  }

  return { overall, constructResults, hasInsufficientConstruct };
}

// LOCKED (brief section 8, FINAL v1 mapping). Checked as a fixed priority
// chain; anything matching none of the four positive conditions falls to
// more_data_needed by construction. Mixed Symptom Response is the one
// state whose qualifying loading set includes "mixed" (increased/
// maintained/mixed all qualify; decreased and insufficient do not) — see
// the dedicated comment on that branch below for the founder's rationale.
export function classifyTrainingResponse(params: {
  overallSymptomsState: OverallSymptomsState;
  windowLoadingComparison: WindowLoadingComparison;
}): TrainingResponseState {
  const { overallSymptomsState, windowLoadingComparison } = params;

  if (overallSymptomsState === "more_data_needed") return "more_data_needed";
  if (windowLoadingComparison === "insufficient") return "more_data_needed";

  const loadingMaintainedOrIncreased = windowLoadingComparison === "maintained" || windowLoadingComparison === "increased";

  if ((overallSymptomsState === "symptoms_improving" || overallSymptomsState === "symptoms_trending_better") && loadingMaintainedOrIncreased) {
    // Brief section 8: if symptoms improved after a MEANINGFUL DELOAD
    // (windowLoadingComparison === "decreased"), this branch is
    // deliberately NOT reached — the favorable Symptoms interpretation
    // stays available separately, but it is never relabeled
    // loading_tolerance_improving, and no deload-caused-the-improvement
    // claim is made anywhere in this module.
    return "loading_tolerance_improving";
  }
  if (overallSymptomsState === "symptoms_stable" && windowLoadingComparison === "maintained") {
    return "stable_training_response";
  }
  // FOUNDER DECISION (final): Mixed Symptom Response already represents
  // observed symptom variability, not missing information — it qualifies
  // variable_training_response against increased/maintained/mixed loading.
  // "mixed" loading is included here on purpose: mechanical loading
  // variability does not erase the already-observed symptom variability
  // (no claim is made that loading caused it). "decreased" is deliberately
  // EXCLUDED: a material deload means a formal longitudinal loading-
  // tolerance interpretation isn't justified, so that combination falls to
  // more_data_needed below instead, with Mixed Symptom Response remaining
  // independently visible. This branch only ever fires when Stage 3B
  // itself already determined mixed_symptom_response — loading being
  // mechanically "mixed" never promotes any OTHER symptom state (stable,
  // improving, trending_higher) into this state; those keep their own
  // stricter loading requirements below/above and fall through to
  // more_data_needed when loading is "mixed".
  if (
    overallSymptomsState === "mixed_symptom_response" &&
    (windowLoadingComparison === "increased" || windowLoadingComparison === "maintained" || windowLoadingComparison === "mixed")
  ) {
    return "variable_training_response";
  }
  if (overallSymptomsState === "symptoms_trending_higher" && loadingMaintainedOrIncreased) {
    return "training_response_remains_unsettled";
  }
  return "more_data_needed";
}
