// Milestone 6, Stage 3C — Capacity classifier. Pure, deterministic.
//
// LOCKED (brief sections 6-9):
//  - "Comparable recorded prescribed opportunity" = a legitimately created
//    rehab session whose immutable prescription snapshot contains the
//    comparable construct. NOT a schedule-derived denominator; never reused
//    for adherence or formal coverage (Stage 3B coverage stays not_computable).
//  - A higher demonstrated level requires >=2 successful demonstrations
//    within the most recent 4 comparable recorded prescribed opportunities
//    for that construct. Unrelated constructs never enter the four.
//  - Successful exposure = well_tolerated+maintain or caution+maintain
//    (see capacityExposure.ts's isSuccessfulCapacityExposure).
//  - One higher exposure is factual evidence only, never confirmation.
//
// APPROVED (round 2/3 founder review — every branch below is now fully
// determined; no pending-decision branch remains for Capacity):
//  - loading_capacity_improving vs. capacity_building (once 2-of-4 is
//    mechanically confirmed): use loading_capacity_improving only when
//    wellToleratedQualifyingCount > cautionMaintainQualifyingCount among the
//    qualifying demonstrations; otherwise capacity_building. Caution+Maintain
//    still counts fully toward the 2-of-4 mechanical confirmation — this
//    rule affects the LABEL only. A TenoTrainer operational LABELING
//    heuristic, not evidence of biological tendon adaptation.
//  - loading_pattern_variable is MECHANICAL-ONLY — tolerance qualification
//    never itself makes Capacity "variable". Fires on genuine opposing
//    mechanical evidence relative to the baseline: at least one exposure
//    mechanically HIGHER and at least one mechanically LOWER, OR a single
//    exposure whose own set-vector comparison is "non_dominating".
//  - Consistently LOWER mechanical loading (no opposing higher evidence) is
//    NEVER loading_pattern_variable, loading_capacity_stable, or any
//    "declining" state — it resolves to more_comparable_data_needed with a
//    structured descriptor (moreDataNeededReason: "recent_loading_lower")
//    and the approved factual phrasing "Recent loading has been lower."
//    No inference about WHY, about physiological capacity, or about
//    regression is made.
//  - Mechanically stable loading with variable/mixed TOLERANCE responses is
//    still loading_capacity_stable — Capacity is mechanical-only throughout;
//    the tolerance/symptom-response variability belongs to Training
//    Response, never to Capacity.

import type { CapacityExposure, CapacityState, ComparableConstruct } from "./capacityTypes";
import { compareSetVectors } from "./capacityLoadingComparison";

// LOCKED constants (brief section 7).
export const RECENT_OPPORTUNITY_WINDOW_SIZE = 4;
export const MIN_SUCCESSFUL_DEMONSTRATIONS_TO_CONFIRM = 2;
// A baseline-plus-window shape, structurally mirroring Stage 3B's own
// "N+comparison" design (5 recent vs. 5 previous) — the smallest baseline
// that lets a 4-opportunity confirmation window mean anything at all is one
// exposure immediately preceding it. Not a founder-review-gated decision:
// this is the minimum data needed for the ALREADY-LOCKED 2-of-4 rule to be
// evaluable at all, not a new clinical threshold.
const MIN_TOTAL_EXPOSURES_FOR_CLASSIFICATION = RECENT_OPPORTUNITY_WINDOW_SIZE + 1;

export type MoreDataNeededReason = "insufficient_total_history" | "unrepresentable_construct" | "recent_loading_lower";

export type CapacityClassificationFacts = {
  construct: ComparableConstruct;
  totalExposureCount: number;
  baselineRehabSessionId: string | null;
  // Most-recent-first, up to RECENT_OPPORTUNITY_WINDOW_SIZE.
  recentOpportunityRehabSessionIds: string[];
  qualifyingDemonstrationRehabSessionIds: string[];
  qualifyingDemonstrationCount: number;
  wellToleratedQualifyingCount: number;
  cautionMaintainQualifyingCount: number;
  confirmedByTwoOfFourRule: boolean;
  // Factual only — brief: "Lower recent loading alone NEVER produces
  // 'Capacity declining'." The single most recent exposure's relation to
  // baseline, stored as fact, never as inference.
  recentLoadingLowerThanPrior: boolean;
  // Mechanical-only (tolerance-INDEPENDENT) evidence among the recent 4 —
  // the sole basis for loading_pattern_variable and for the
  // consistently-lower resolution. Never gated by tolerance.
  mechanicallyHigherRehabSessionIds: string[];
  mechanicallyLowerRehabSessionIds: string[];
  hasNonDominatingExposure: boolean;
  // Set when state === more_comparable_data_needed, to distinguish "not
  // enough history yet" from "consistently lower loading" — both resolve to
  // the same state, but the reason is materially different and preserved.
  moreDataNeededReason: MoreDataNeededReason | null;
};

export type CapacityClassificationResult = { state: CapacityState; facts: CapacityClassificationFacts };

const EMPTY_FACTS = (construct: ComparableConstruct, exposures: CapacityExposure[], reason: MoreDataNeededReason): CapacityClassificationFacts => ({
  construct,
  totalExposureCount: exposures.length,
  baselineRehabSessionId: null,
  recentOpportunityRehabSessionIds: exposures.map((e) => e.rehabSessionId),
  qualifyingDemonstrationRehabSessionIds: [],
  qualifyingDemonstrationCount: 0,
  wellToleratedQualifyingCount: 0,
  cautionMaintainQualifyingCount: 0,
  confirmedByTwoOfFourRule: false,
  recentLoadingLowerThanPrior: false,
  mechanicallyHigherRehabSessionIds: [],
  mechanicallyLowerRehabSessionIds: [],
  hasNonDominatingExposure: false,
  moreDataNeededReason: reason,
});

// `exposuresNewestFirst` must already be filtered to ONE construct and
// sorted newest-first by the caller (see capacityInterpretationEngine.ts) —
// this function does no grouping or sorting of its own.
export function classifyCapacity(exposuresNewestFirst: CapacityExposure[]): CapacityClassificationResult {
  const construct = exposuresNewestFirst[0]?.construct ?? { exId: "", loadingProfile: null, performanceUnit: "unrepresentable" as const };

  // Brief section 4: nonnumeric/unrepresentable constructs are never given
  // a formal quantitative Capacity trend classification.
  if (construct.performanceUnit === "unrepresentable") {
    return { state: "more_comparable_data_needed", facts: EMPTY_FACTS(construct, exposuresNewestFirst, "unrepresentable_construct") };
  }

  if (exposuresNewestFirst.length < MIN_TOTAL_EXPOSURES_FOR_CLASSIFICATION) {
    return { state: "more_comparable_data_needed", facts: EMPTY_FACTS(construct, exposuresNewestFirst, "insufficient_total_history") };
  }

  const recentOpportunities = exposuresNewestFirst.slice(0, RECENT_OPPORTUNITY_WINDOW_SIZE);
  const baseline = exposuresNewestFirst[RECENT_OPPORTUNITY_WINDOW_SIZE];

  const comparisons = recentOpportunities.map((exposure) => ({
    exposure,
    vsBaseline: compareSetVectors(exposure.actual, baseline.actual),
  }));

  // "Higher" = strict structural dominance over the baseline (brief section
  // 5) — never a single-exposure "one higher exposure is factual evidence
  // only" (section 7) treated as confirmation by itself.
  const qualifying = comparisons.filter((c) => c.vsBaseline === "higher" && c.exposure.isSuccessfulExposure);
  const wellToleratedQualifying = qualifying.filter((c) => c.exposure.toleranceClassification === "well_tolerated");
  const cautionMaintainQualifying = qualifying.filter((c) => c.exposure.toleranceClassification === "caution");

  // Mechanical-only (tolerance-INDEPENDENT) evidence.
  const mechanicallyHigher = comparisons.filter((c) => c.vsBaseline === "higher");
  const mechanicallyLower = comparisons.filter((c) => c.vsBaseline === "lower");
  const hasNonDominatingExposure = comparisons.some((c) => c.vsBaseline === "non_dominating");

  const baseFacts = {
    construct,
    totalExposureCount: exposuresNewestFirst.length,
    baselineRehabSessionId: baseline.rehabSessionId,
    recentOpportunityRehabSessionIds: recentOpportunities.map((e) => e.rehabSessionId),
    qualifyingDemonstrationRehabSessionIds: qualifying.map((c) => c.exposure.rehabSessionId),
    qualifyingDemonstrationCount: qualifying.length,
    wellToleratedQualifyingCount: wellToleratedQualifying.length,
    cautionMaintainQualifyingCount: cautionMaintainQualifying.length,
    confirmedByTwoOfFourRule: qualifying.length >= MIN_SUCCESSFUL_DEMONSTRATIONS_TO_CONFIRM,
    recentLoadingLowerThanPrior: comparisons[0]?.vsBaseline === "lower",
    mechanicallyHigherRehabSessionIds: mechanicallyHigher.map((c) => c.exposure.rehabSessionId),
    mechanicallyLowerRehabSessionIds: mechanicallyLower.map((c) => c.exposure.rehabSessionId),
    hasNonDominatingExposure,
  };

  if (baseFacts.confirmedByTwoOfFourRule) {
    // APPROVED labeling rule: majority of the QUALIFYING demonstrations
    // must be Well-Tolerated (not merely Caution+Maintain) to justify the
    // stronger interpretation. A tie does NOT justify it -> capacity_building.
    const state: CapacityState = baseFacts.wellToleratedQualifyingCount > baseFacts.cautionMaintainQualifyingCount ? "loading_capacity_improving" : "capacity_building";
    return { state, facts: { ...baseFacts, moreDataNeededReason: null } };
  }

  if (qualifying.length === 1) {
    // A candidate higher level has one piece of factual evidence but is not
    // yet under a confirmed pattern — unambiguously "under confirmation".
    return { state: "capacity_building", facts: { ...baseFacts, moreDataNeededReason: null } };
  }

  // Zero qualifying-higher demonstrations. From here, Capacity's
  // determination is MECHANICAL-ONLY — tolerance plays no further role.
  const hasOpposingMechanicalEvidence = (mechanicallyHigher.length > 0 && mechanicallyLower.length > 0) || hasNonDominatingExposure;
  if (hasOpposingMechanicalEvidence) {
    return { state: "loading_pattern_variable", facts: { ...baseFacts, moreDataNeededReason: null } };
  }

  // Not opposing. Any mechanically LOWER exposure present (with no
  // compensating higher one, by exclusion above) means recent loading has
  // been consistently lower — APPROVED resolution: more_comparable_data_needed,
  // never variable/stable/declining, with the structured descriptor.
  if (mechanicallyLower.length > 0) {
    return { state: "more_comparable_data_needed", facts: { ...baseFacts, moreDataNeededReason: "recent_loading_lower" } };
  }

  // No lower, no opposing evidence: mechanically at-or-above baseline
  // throughout. loading_capacity_stable REGARDLESS of tolerance mix — a
  // mechanically stable pattern with variable tolerance responses is still
  // mechanically stable; the tolerance variability belongs to Training
  // Response, not Capacity.
  return { state: "loading_capacity_stable", facts: { ...baseFacts, moreDataNeededReason: null } };
}
