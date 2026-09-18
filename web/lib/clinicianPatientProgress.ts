// C3 — Longitudinal Clinical Progress. Pure, deterministic domain logic
// only (no server-only import, no DB access, NO classifier/generator
// functions imported or called) — mirrors the clinicianPatientOverview.ts /
// clinicianPatientOverviewServer.ts split.
//
// LOCKED founder decisions this module encodes:
//   - C3 exposes the EXISTING M6 persisted interpretation. Every function
//     here FORMATS an already-decided, already-persisted value; NONE of
//     them decide, recompute, reclassify, or apply any M6 threshold —
//     including symptomStatistics.ts's 1-point directional boundary. A
//     prior version of this module re-derived a "Lower/Higher in N of 5"
//     tally from raw recentValues/previousMedian by re-applying that
//     boundary; this was a FOUNDER-REJECTED architecture violation (a
//     second, partial implementation of the classifier inside the display
//     layer) and has been removed. The locked flow is:
//       Persisted interpretation -> persisted evidence -> clinician display
//     never:
//       Persisted observations -> clinician UI partially re-runs classifier logic
//     `frequencyPattern` (already a persisted, classified fact — favorable_
//     lower/unfavorable_higher/no_dominant_pattern) is TRANSLATED to
//     clinician-readable text (formatFrequencyPatternLabel) — this is
//     formatting an existing categorical value, not computing one. Raw
//     recentValues/previousValues/medians/IQR remain available in expanded
//     evidence, displayed as-is, never fed through a threshold.
//   - Capacity has no decline state and never will — "recent_loading_lower"
//     always renders as the exact locked sentence "Recent loading has been
//     lower.", never "declining"/"decreased"/"losing capacity".
//   - MSD (stiffness duration) is supporting information only — never
//     described as feeding the overall Symptoms state.
//   - `result_detail` is untyped JSONB at the DB layer (see
//     longitudinalInterpretationTypes.ts's own header). The types below are
//     THIS MODULE's frozen read-side contract for what the engines are
//     verified (as of this pass) to persist — never the engines' own
//     internal types — so a future internal M6 refactor can't silently
//     change C3's shape assumptions without a visible type error here.
//   - `symptomCoverage.ts`'s own `reason` field is explicitly documented as
//     "never surfaced to a patient or clinician as-is" — this module never
//     renders it; only the raw, honest `rawCounts` are used.
//   - Heuristic PROSE (description/rationale/known_limitations) is never
//     rendered — the audit found the Training Response heuristic catalog
//     text stale relative to the actual locked implementation. Only a
//     heuristic's short `name` may be shown, as provenance identifying that
//     a defined TenoTrainer rule was applied — never as explanatory prose.

import type { OverallSymptomsState, CoreDomainDirection, CoreDomainConsistency, MsdDirection } from "./symptomClassifier";
import type { CapacityState, PerformanceUnit, ComparableConstruct, TrainingResponseState } from "./capacityTypes";
import type { MoreDataNeededReason } from "./capacityClassifier";
import type { WindowLoadingComparison, ConstructDirection } from "./trainingResponseClassifier";
import type { DimensionComparison } from "./capacityLoadingComparison";
import type { InterpretationReasonCode } from "./longitudinalInterpretationTypes";
import type { ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";

// ---------------------------------------------------------------------------
// Local mirrors of persisted result_detail JSON shapes (read-side contract —
// see header). Parsers below are defensive: a missing/reshaped field never
// throws, it falls back to an honest empty/insufficient shape.
// ---------------------------------------------------------------------------

export type CoreDomainResultDetail = {
  direction: CoreDomainDirection;
  consistency: CoreDomainConsistency;
  recentMedian: number | null;
  previousMedian: number | null;
  recentIqr: { q1: number; q3: number; iqr: number } | null;
  previousIqr: { q1: number; q3: number; iqr: number } | null;
  frequencyPattern: "favorable_lower" | "unfavorable_higher" | "no_dominant_pattern" | null;
  medianDirection: "lower" | "same" | "higher" | null;
  recentValues: number[];
  previousValues: number[];
};

export type MsdResultDetail = {
  direction: MsdDirection;
  recentMedianRank: number | null;
  previousMedianRank: number | null;
  recentSampleSize: number;
  previousSampleSize: number;
};

export type CoverageRawCounts = {
  attemptedSessionCount: number;
  completedSessionCount: number;
  completeResponseEpisodeCount: number;
  safetyBlockedOnlyCount: number;
};

export type SymptomsResultDetail =
  | { status: "insufficient"; eligibleEpisodeCount: number }
  | {
      status: "generated";
      core: { P: CoreDomainResultDetail; MP: CoreDomainResultDetail; MS: CoreDomainResultDetail };
      msd: MsdResultDetail;
      coverageRawCounts: CoverageRawCounts;
      distinctPrescriptionVersionIds: string[];
    };

export type CapacitySetObservationDetail = { setIndex: number; outcome: "completed" | "skipped"; amount: number | null; load: number | null };

export type CapacityOpportunityDetail = {
  rehabSessionId: string;
  patientLocalDate: string;
  performanceUnit: PerformanceUnit;
  prescribedSets: CapacitySetObservationDetail[];
  actualSets: CapacitySetObservationDetail[];
  toleranceClassification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance | null;
  isSuccessfulExposure: boolean;
};

export type CapacityResultDetail = {
  construct: ComparableConstruct;
  qualifyingDemonstrationCount: number;
  qualifyingDemonstrationRehabSessionIds: string[];
  wellToleratedQualifyingCount: number;
  cautionMaintainQualifyingCount: number;
  confirmedByTwoOfFourRule: boolean;
  recentLoadingLowerThanPrior: boolean;
  recentLoadingLowerThanPriorNote: string | null;
  moreDataNeededReason: MoreDataNeededReason | null;
  mechanicallyHigherRehabSessionIds: string[];
  mechanicallyLowerRehabSessionIds: string[];
  hasNonDominatingExposure: boolean;
  recentOpportunities: CapacityOpportunityDetail[];
};

export type TrainingResponsePairDetail = { previousRehabSessionId: string; recentRehabSessionId: string; comparison: DimensionComparison };

export type TrainingResponseConstructResultDetail = {
  construct: ComparableConstruct;
  previousExposureCount: number;
  recentExposureCount: number;
  pairs: TrainingResponsePairDetail[];
  usablePairCount: number;
  unmatchedPreviousRehabSessionIds: string[];
  unmatchedRecentRehabSessionIds: string[];
  direction: ConstructDirection;
  insufficiencyReason: "no_data_in_one_half" | "fewer_than_two_usable_pairs" | null;
};

export type TrainingResponseResultDetail =
  | { status: "insufficient" }
  | {
      status: "generated";
      overallSymptomsState: OverallSymptomsState;
      overallLoadingDirection: WindowLoadingComparison;
      hasInsufficientConstruct: boolean;
      constructResults: TrainingResponseConstructResultDetail[];
    };

export function parseSymptomsResultDetail(resultState: string, raw: Record<string, unknown>): SymptomsResultDetail {
  if (resultState === "more_data_needed" && !("core" in raw)) {
    return { status: "insufficient", eligibleEpisodeCount: typeof raw.eligibleEpisodeCount === "number" ? raw.eligibleEpisodeCount : 0 };
  }
  const core = (raw.core as Record<string, unknown>) ?? {};
  const coverageContext = raw.coverageContext as { rawCounts?: CoverageRawCounts } | undefined;
  return {
    status: "generated",
    core: {
      P: core.P as CoreDomainResultDetail,
      MP: core.MP as CoreDomainResultDetail,
      MS: core.MS as CoreDomainResultDetail,
    },
    msd: raw.msd as MsdResultDetail,
    coverageRawCounts: coverageContext?.rawCounts ?? { attemptedSessionCount: 0, completedSessionCount: 0, completeResponseEpisodeCount: 0, safetyBlockedOnlyCount: 0 },
    distinctPrescriptionVersionIds: (raw.distinctPrescriptionVersionIds as string[] | undefined) ?? [],
  };
}

export function parseCapacityResultDetail(raw: Record<string, unknown>): CapacityResultDetail {
  return {
    construct: raw.construct as ComparableConstruct,
    qualifyingDemonstrationCount: (raw.qualifyingDemonstrationCount as number) ?? 0,
    qualifyingDemonstrationRehabSessionIds: (raw.qualifyingDemonstrationRehabSessionIds as string[]) ?? [],
    wellToleratedQualifyingCount: (raw.wellToleratedQualifyingCount as number) ?? 0,
    cautionMaintainQualifyingCount: (raw.cautionMaintainQualifyingCount as number) ?? 0,
    confirmedByTwoOfFourRule: Boolean(raw.confirmedByTwoOfFourRule),
    recentLoadingLowerThanPrior: Boolean(raw.recentLoadingLowerThanPrior),
    recentLoadingLowerThanPriorNote: (raw.recentLoadingLowerThanPriorNote as string | null) ?? null,
    moreDataNeededReason: (raw.moreDataNeededReason as MoreDataNeededReason | null) ?? null,
    mechanicallyHigherRehabSessionIds: (raw.mechanicallyHigherRehabSessionIds as string[]) ?? [],
    mechanicallyLowerRehabSessionIds: (raw.mechanicallyLowerRehabSessionIds as string[]) ?? [],
    hasNonDominatingExposure: Boolean(raw.hasNonDominatingExposure),
    recentOpportunities: (raw.recentOpportunities as CapacityOpportunityDetail[]) ?? [],
  };
}

export function parseTrainingResponseResultDetail(raw: Record<string, unknown>): TrainingResponseResultDetail {
  if (!("overallSymptomsState" in raw)) return { status: "insufficient" };
  return {
    status: "generated",
    overallSymptomsState: raw.overallSymptomsState as OverallSymptomsState,
    overallLoadingDirection: raw.overallLoadingDirection as WindowLoadingComparison,
    hasInsufficientConstruct: Boolean(raw.hasInsufficientConstruct),
    constructResults: (raw.constructResults as TrainingResponseConstructResultDetail[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Previous-state comparison — "did this just change, and from what" only.
// ---------------------------------------------------------------------------

export type StateChange = "no_previous" | "unchanged" | "changed";

export function describeStateChange(currentResultState: string, previousResultState: string | null): StateChange {
  if (previousResultState === null) return "no_previous";
  return currentResultState === previousResultState ? "unchanged" : "changed";
}

// ---------------------------------------------------------------------------
// Symptoms formatting
// ---------------------------------------------------------------------------

const OVERALL_SYMPTOMS_LABELS: Record<OverallSymptomsState, string> = {
  symptoms_improving: "Improving",
  symptoms_trending_better: "Trending better",
  symptoms_stable: "Stable",
  mixed_symptom_response: "Mixed",
  symptoms_trending_higher: "Trending higher",
  more_data_needed: "More data needed",
};
export function formatOverallSymptomsLabel(state: OverallSymptomsState): string {
  return OVERALL_SYMPTOMS_LABELS[state];
}

const CORE_DOMAIN_DIRECTION_LABELS: Record<CoreDomainDirection, string> = {
  improving: "Improving",
  stable: "Stable",
  trending_higher: "Trending higher",
  insufficient_data: "More data needed",
};
export function formatCoreDomainDirectionLabel(direction: CoreDomainDirection): string {
  return CORE_DOMAIN_DIRECTION_LABELS[direction];
}

export const CORE_DOMAIN_NAMES: Record<"P" | "MP" | "MS", string> = {
  P: "Peak session pain",
  MP: "Next-morning pain",
  MS: "Next-morning stiffness intensity",
};

// Pure TRANSLATION of the already-persisted, already-classified
// `frequencyPattern` categorical fact — never a computation over raw
// recentValues/previousMedian, never a threshold, never a tally. C3 does
// not know (and must never re-derive) how many of the recent responses
// were "lower"/"higher" — only M6's own classifier decides that, and it
// does not persist the count, only the resulting category. If a future M6
// stage persists that count directly, this function may be extended to
// show it verbatim; until then, only the category is shown.
const FREQUENCY_PATTERN_LABELS: Record<"favorable_lower" | "unfavorable_higher" | "no_dominant_pattern", string> = {
  favorable_lower: "Recent responses more often favored lower values.",
  unfavorable_higher: "Recent responses more often favored higher values.",
  no_dominant_pattern: "No dominant recent directional pattern.",
};

export function formatFrequencyPatternLabel(frequencyPattern: CoreDomainResultDetail["frequencyPattern"]): string | null {
  return frequencyPattern === null ? null : FREQUENCY_PATTERN_LABELS[frequencyPattern];
}

// Raw persisted values, displayed exactly as stored — a plain join, never a
// comparison against each other or against a median/threshold.
export function formatValuesList(values: number[]): string {
  return values.length > 0 ? values.join(", ") : "—";
}

const MSD_DIRECTION_LABELS: Record<Exclude<MsdDirection, "insufficient_data">, string> = {
  shorter: "Shorter",
  stable: "Stable",
  longer: "Longer",
  variable: "Variable",
};

// Returns null when insufficient — the founder's locked instruction is to
// show MSD in the DEFAULT view only when it "contains meaningful
// information"; an insufficient MSD result may still appear inside expanded
// evidence via formatMsdExpandedNote below, never cluttering the default view.
export function formatMsdDefaultLabel(msd: MsdResultDetail): string | null {
  return msd.direction === "insufficient_data" ? null : MSD_DIRECTION_LABELS[msd.direction];
}

export function formatMsdExpandedNote(msd: MsdResultDetail): string {
  if (msd.direction === "insufficient_data") {
    return `Not enough stiffness-duration observations yet (need at least 3 per window; have ${msd.previousSampleSize} previous, ${msd.recentSampleSize} recent).`;
  }
  return `${MSD_DIRECTION_LABELS[msd.direction]} (based on ${msd.previousSampleSize} previous and ${msd.recentSampleSize} recent applicable observations).`;
}

export function formatSymptomsInsufficientLabel(): string {
  return "Not enough completed rehab responses yet.";
}

export function formatCoverageEvidenceSentence(counts: CoverageRawCounts): string {
  return `${counts.completedSessionCount} completed / ${counts.attemptedSessionCount} attempted sessions in this window (${counts.completeResponseEpisodeCount} complete responses${counts.safetyBlockedOnlyCount > 0 ? `, ${counts.safetyBlockedOnlyCount} blocked by an acute-safety hold` : ""}).`;
}

// ---------------------------------------------------------------------------
// Capacity formatting
// ---------------------------------------------------------------------------

const CAPACITY_STATE_LABELS: Record<CapacityState, string> = {
  capacity_building: "Building",
  loading_capacity_improving: "Improving",
  loading_capacity_stable: "Stable",
  loading_pattern_variable: "Variable mechanical loading",
  more_comparable_data_needed: "More data needed",
};
export function formatCapacityStateLabel(state: CapacityState): string {
  return CAPACITY_STATE_LABELS[state];
}

const CAPACITY_MORE_DATA_REASON_LABELS: Record<MoreDataNeededReason, string> = {
  insufficient_total_history: "Not enough comparable sessions yet for this exercise.",
  unrepresentable_construct: "This exercise's prescribed amount can't be measured numerically, so loading comparisons aren't available.",
  // LOCKED phrasing — never "declining"/"decreased"/"losing capacity".
  recent_loading_lower: "Recent loading has been lower.",
};
export function formatCapacityMoreDataReasonLabel(reason: MoreDataNeededReason): string {
  return CAPACITY_MORE_DATA_REASON_LABELS[reason];
}

export function formatPerformanceUnitLabel(unit: PerformanceUnit): string {
  if (unit === "reps") return "Reps";
  if (unit === "hold_seconds") return "Hold (seconds)";
  return "Not numerically measurable";
}

export function formatLoadingProfileLabel(profile: string | null): string {
  if (profile === null || profile.length === 0) return "Not recorded";
  return profile
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// Same RECENT_OPPORTUNITY_WINDOW_SIZE=4 published, locked constant as
// capacityClassifier.ts — kept as a local literal (display text only,
// never imported from the classifier) so this module never depends on an
// M6 engine/classifier file at runtime, only on the already-persisted
// resultDetail values it formats.
const CAPACITY_RECENT_WINDOW_SIZE = 4;

export function formatCapacityQualifyingEvidence(detail: CapacityResultDetail): string {
  const base = `${detail.qualifyingDemonstrationCount} of ${CAPACITY_RECENT_WINDOW_SIZE} qualifying demonstrations`;
  return detail.qualifyingDemonstrationCount > 0
    ? `${base} (${detail.wellToleratedQualifyingCount} well-tolerated, ${detail.cautionMaintainQualifyingCount} caution+maintain)`
    : base;
}

function formatCapacityAmount(obs: CapacitySetObservationDetail | undefined, unit: PerformanceUnit): string {
  if (!obs || obs.outcome === "skipped" || obs.amount === null) return obs?.outcome === "skipped" ? "Skipped" : "—";
  const amountText = unit === "hold_seconds" ? `${obs.amount}s hold` : `${obs.amount} reps`;
  return obs.load !== null ? `${amountText} · ${obs.load} kg` : amountText;
}

export type CapacitySetRow = { setIndex: number; prescribedLabel: string; actualLabel: string };

// prescribedSets/actualSets are always the same length/order (both built
// from the same set_outcomes rows — see capacityExposure.ts's
// buildSetVector) — zipped by array position, never by re-sorting.
export function buildCapacitySetRows(opportunity: CapacityOpportunityDetail): CapacitySetRow[] {
  return opportunity.prescribedSets.map((p, i) => ({
    setIndex: p.setIndex,
    prescribedLabel: formatCapacityAmount(p, opportunity.performanceUnit),
    actualLabel: formatCapacityAmount(opportunity.actualSets[i], opportunity.performanceUnit),
  }));
}

// Capacity's own resultDetail persists only the raw ToleranceClassification
// enum per opportunity (not the persisted tolerance_evaluations row's own
// patient_facing_label text) — a small enum-to-string map, same idiom as
// clinicianPatientOverview.ts's formatImmediateGuidanceLabel (which C3
// reuses directly for ImmediateGuidance rather than duplicating it).
const TOLERANCE_CLASSIFICATION_LABELS: Record<ToleranceClassification, string> = {
  well_tolerated: "Well tolerated",
  caution: "Caution",
  poorly_tolerated: "Caution",
  acute_override: "Safety review",
  insufficient_data: "More data needed",
};
export function formatToleranceClassificationLabel(classification: ToleranceClassification): string {
  return TOLERANCE_CLASSIFICATION_LABELS[classification];
}

export type MechanicalComparisonLabel = "Baseline" | "Higher than baseline" | "Lower than baseline" | null;

// Only derived from what's directly PERSISTED (the higher/lower session-id
// lists) — never recomputed via compareSetVectors. A session in neither
// list (and not the baseline) simply gets no mechanical-comparison tag,
// rather than guessing whether it was "equal" or "non-dominating".
export function mechanicalComparisonLabelFor(
  rehabSessionId: string,
  detail: Pick<CapacityResultDetail, "mechanicallyHigherRehabSessionIds" | "mechanicallyLowerRehabSessionIds">,
  baselineRehabSessionId: string | null
): MechanicalComparisonLabel {
  if (baselineRehabSessionId === rehabSessionId) return "Baseline";
  if (detail.mechanicallyHigherRehabSessionIds.includes(rehabSessionId)) return "Higher than baseline";
  if (detail.mechanicallyLowerRehabSessionIds.includes(rehabSessionId)) return "Lower than baseline";
  return null;
}

// ---------------------------------------------------------------------------
// Training Response formatting
// ---------------------------------------------------------------------------

const TRAINING_RESPONSE_STATE_LABELS: Record<TrainingResponseState, string> = {
  loading_tolerance_improving: "Loading tolerance improving",
  stable_training_response: "Stable",
  variable_training_response: "Variable",
  training_response_remains_unsettled: "Remains unsettled",
  more_data_needed: "More data needed",
};
export function formatTrainingResponseStateLabel(state: TrainingResponseState): string {
  return TRAINING_RESPONSE_STATE_LABELS[state];
}

const LOADING_DIRECTION_LABELS: Record<WindowLoadingComparison, string> = {
  increased: "Increased",
  maintained: "Maintained",
  decreased: "Decreased",
  mixed: "Mixed",
  insufficient: "Insufficient",
};
export function formatLoadingDirectionLabel(direction: WindowLoadingComparison): string {
  return LOADING_DIRECTION_LABELS[direction];
}

const DIMENSION_COMPARISON_LABELS: Record<DimensionComparison, string> = {
  higher: "Higher",
  lower: "Lower",
  equal: "Equal",
  non_dominating: "Not clearly comparable",
  insufficient: "Not comparable",
};
export function formatDimensionComparisonLabel(comparison: DimensionComparison): string {
  return DIMENSION_COMPARISON_LABELS[comparison];
}

// LOCKED: the founder's own instruction — do not distinguish "genuinely
// insufficient" from "no locked positive state for this real-evidence
// combination"; both use this single restrained copy.
export function formatTrainingResponseInsufficientLabel(): string {
  return "Not enough paired symptom and loading data yet.";
}

export function formatUsablePairEvidence(constructResult: TrainingResponseConstructResultDetail): string {
  return `${constructResult.usablePairCount} usable paired comparison${constructResult.usablePairCount === 1 ? "" : "s"} (${constructResult.previousExposureCount} previous / ${constructResult.recentExposureCount} recent exposures)`;
}

// ---------------------------------------------------------------------------
// Shared: reason codes, external load, acute caveat
// ---------------------------------------------------------------------------

const REASON_CODE_LABELS: Record<InterpretationReasonCode, string> = {
  limited_coverage: "Session-coverage data for this window is limited.",
  mixed_symptom_directions: "Symptom measures moved in different directions across this window.",
  high_response_variability: "Session responses showed high variability.",
  recent_prescription_change: "The prescription changed during this window.",
  limited_comparable_exposures: "Some exercises had limited comparable loading history in this window.",
  // LOCKED exact wording (founder brief section 18).
  external_loading_context_present: "One or more sessions in this interpretation window included reported external activity.",
  capacity_response_mismatch: "Capacity and tolerance responses showed a mismatch.",
};
export function formatReasonCodeLabel(code: InterpretationReasonCode): string {
  return REASON_CODE_LABELS[code];
}

export const ACTIVE_ACUTE_REVIEW_CAVEAT =
  "Clinical review is currently active. Recent longitudinal data remain visible but should be interpreted in that context.";
