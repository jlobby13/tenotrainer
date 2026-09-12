// Milestone 6, Stage 3B — 5+5 rolling-window longitudinal SYMPTOM
// classifier. Pure, deterministic, human-authored rules only — no LLM, no
// weighted opaque score (mirrors toleranceEvaluation.ts's design note).
//
// Scope: P (peak session pain), MP (next-morning pain), MS (next-morning
// stiffness intensity) as the three CORE domains, MSD (next-morning
// stiffness duration) as an ordinal, conditional/enriching domain, and the
// overall Symptoms summary. Capacity and Training Response are explicitly
// OUT OF SCOPE for Stage 3B — see docs/m6-stage3b-symptom-engine.md.
//
// CONSISTENCY (`classifyConsistency`) — APPROVED for M6 v1 by founder
// decision. Catalogued as heuristic `m6_consistency_variable_vs_consistent`
// (see symptomHeuristics.ts and
// supabase/migrations/20260912000002_m6_stage3b_consistency_and_msd_heuristics.sql).
// A TenoTrainer operational definition, not a validated Achilles threshold.

import type { StiffnessDuration } from "./morningResponseTypes";
import { STIFFNESS_DURATION_ORDER } from "./progressCompare";
import {
  classifyFrequencyPattern,
  interquartileRange,
  median,
  medianDirection,
  relativeDirection,
  type FrequencyPattern,
  type MedianDirection,
  type RelativeDirection,
} from "./symptomStatistics";

export type CoreDomainDirection = "improving" | "stable" | "trending_higher" | "insufficient_data";
export type CoreDomainConsistency = "consistent" | "variable" | "insufficient_data";

export type CoreDomainResult = {
  direction: CoreDomainDirection;
  consistency: CoreDomainConsistency;
  recentMedian: number | null;
  previousMedian: number | null;
  recentIqr: { q1: number; q3: number; iqr: number } | null;
  previousIqr: { q1: number; q3: number; iqr: number } | null;
  frequencyPattern: FrequencyPattern | null;
  medianDirection: MedianDirection | null;
  recentDirections: RelativeDirection[];
  recentValues: number[];
  previousValues: number[];
};

const INSUFFICIENT_CORE_DOMAIN_RESULT: CoreDomainResult = {
  direction: "insufficient_data",
  consistency: "insufficient_data",
  recentMedian: null,
  previousMedian: null,
  recentIqr: null,
  previousIqr: null,
  frequencyPattern: null,
  medianDirection: null,
  recentDirections: [],
  recentValues: [],
  previousValues: [],
};

// APPROVED (M6 v1). "Variable" whenever the 5 recent relative-direction
// observations contain BOTH at least one "lower" and at least one "higher"
// (genuinely opposing evidence). "Consistent" otherwise — a one-sided mix of
// a single direction plus "similar" observations is NOT automatically
// variable, since "similar" is neutral, not opposing (explicitly confirmed:
// lower+similar with no higher, or higher+similar with no lower, is
// "consistent"). IQR plays no role in this decision and never will — no IQR
// threshold is introduced here or anywhere in this module.
export function classifyConsistency(recentDirections: RelativeDirection[]): CoreDomainConsistency {
  if (recentDirections.length === 0) return "insufficient_data";
  const hasLower = recentDirections.includes("lower");
  const hasHigher = recentDirections.includes("higher");
  return hasLower && hasHigher ? "variable" : "consistent";
}

// previousValues/recentValues must each be exactly 5 integers (0-10) for a
// real result; otherwise "insufficient_data" is returned for both direction
// and consistency, per the locked "ten eligible complete episodes required"
// rule (Stage 3B brief section 2).
export function classifyCoreDomain(previousValues: number[], recentValues: number[]): CoreDomainResult {
  if (previousValues.length !== 5 || recentValues.length !== 5) return INSUFFICIENT_CORE_DOMAIN_RESULT;

  const previousWindowMedian = median(previousValues);
  const recentWindowMedian = median(recentValues);
  const recentDirections = recentValues.map((v) => relativeDirection(v, previousWindowMedian));
  const frequencyPattern = classifyFrequencyPattern(recentDirections);
  const medianDir = medianDirection(recentWindowMedian, previousWindowMedian);

  // Frequency is PRIMARY; median is CORROBORATING only (Stage 3B brief
  // section 5). A favorable/unfavorable frequency pattern NOT corroborated
  // by the median is treated as discordant -> "stable", never forced into
  // improving/trending_higher.
  let direction: CoreDomainDirection;
  if (frequencyPattern === "favorable_lower") {
    direction = medianDir === "lower" ? "improving" : "stable";
  } else if (frequencyPattern === "unfavorable_higher") {
    direction = medianDir === "higher" ? "trending_higher" : "stable";
  } else {
    direction = "stable";
  }

  return {
    direction,
    consistency: classifyConsistency(recentDirections),
    recentMedian: recentWindowMedian,
    previousMedian: previousWindowMedian,
    recentIqr: interquartileRange(recentValues),
    previousIqr: interquartileRange(previousValues),
    frequencyPattern,
    medianDirection: medianDir,
    recentDirections,
    recentValues,
    previousValues,
  };
}

// ---------------------------------------------------------------------------
// MSD — ordinal only. Never converted to fake minutes, never averaged (see
// STIFFNESS_DURATION_ORDER's own header note in progressCompare.ts — reused
// here, not redefined, so the TS ordering can never disagree with itself).
// Reapplies the SAME already-locked frequency-primary/median-corroborating
// hierarchy to ordinal ranks instead of a new invented rule.
// ---------------------------------------------------------------------------

export type MsdDirection = "shorter" | "stable" | "longer" | "variable" | "insufficient_data";

export type MsdResult = {
  direction: MsdDirection;
  recentMedianRank: number | null;
  previousMedianRank: number | null;
  recentSampleSize: number;
  previousSampleSize: number;
};

function stiffnessDurationRank(duration: StiffnessDuration): number {
  return STIFFNESS_DURATION_ORDER.indexOf(duration);
}

// Inputs are each window's stiffness_duration values for episodes where
// next_morning_stiffness > 0 ONLY (MSD is not applicable/not ranked when
// MS = 0 — see responseEpisode.ts; MS=0 does NOT make the response episode
// incomplete, it just contributes no ordinal duration observation here).
// Defensively excludes 'not_applicable' even if present, since it isn't a
// real duration to rank.
//
// FOUNDER DECISION (M6 v1): a formal MSD direction requires at least
// MSD_MIN_APPLICABLE_OBSERVATIONS_PER_WINDOW (3) applicable, known duration
// observations in EACH window — not merely "at least one". Below that floor
// in either window, direction is "insufficient_data": raw MSD history
// remains available to the caller (via resultDetail), but no formal
// shorter/stable/longer/variable call is made. This is a TenoTrainer
// operational heuristic for v1 (catalogued as
// `m6_msd_min_3_applicable_per_window`), not a validated biological
// threshold. Core P/MP/MS classification and the overall Symptoms summary
// are entirely unaffected by MSD insufficiency — see classifyOverallSymptoms,
// which never reads MsdResult at all.
export const MSD_MIN_APPLICABLE_OBSERVATIONS_PER_WINDOW = 3;

export function classifyMsd(previousDurations: StiffnessDuration[], recentDurations: StiffnessDuration[]): MsdResult {
  const previousRanks = previousDurations.filter((d) => d !== "not_applicable").map(stiffnessDurationRank);
  const recentRanks = recentDurations.filter((d) => d !== "not_applicable").map(stiffnessDurationRank);

  if (previousRanks.length < MSD_MIN_APPLICABLE_OBSERVATIONS_PER_WINDOW || recentRanks.length < MSD_MIN_APPLICABLE_OBSERVATIONS_PER_WINDOW) {
    return { direction: "insufficient_data", recentMedianRank: null, previousMedianRank: null, recentSampleSize: recentRanks.length, previousSampleSize: previousRanks.length };
  }

  const previousMedianRank = median(previousRanks);
  const recentMedianRank = median(recentRanks);
  const recentDirections = recentRanks.map((rank) => relativeDirection(rank, previousMedianRank));
  const frequencyPattern = classifyFrequencyPattern(recentDirections);
  const medianDir = medianDirection(recentMedianRank, previousMedianRank);

  let direction: MsdDirection;
  if (frequencyPattern === "favorable_lower") {
    direction = medianDir === "lower" ? "shorter" : "variable";
  } else if (frequencyPattern === "unfavorable_higher") {
    direction = medianDir === "higher" ? "longer" : "variable";
  } else {
    direction = "stable";
  }

  return { direction, recentMedianRank, previousMedianRank, recentSampleSize: recentRanks.length, previousSampleSize: previousRanks.length };
}

// ---------------------------------------------------------------------------
// Overall Symptoms summary — a navigation aid, NOT a validated composite.
// No numerical weighting among P/MP/MS/MSD (Stage 3B brief section 9). Only
// the three CORE domains' directions feed this; MSD never does.
// ---------------------------------------------------------------------------

export type OverallSymptomsState =
  | "symptoms_improving"
  | "symptoms_trending_better"
  | "symptoms_stable"
  | "mixed_symptom_response"
  | "symptoms_trending_higher"
  | "more_data_needed";

export function classifyOverallSymptoms(core: { P: CoreDomainResult; MP: CoreDomainResult; MS: CoreDomainResult }): OverallSymptomsState {
  const directions = [core.P.direction, core.MP.direction, core.MS.direction];
  if (directions.some((d) => d === "insufficient_data")) return "more_data_needed";

  const improvingCount = directions.filter((d) => d === "improving").length;
  const higherCount = directions.filter((d) => d === "trending_higher").length;

  if (higherCount === 0 && improvingCount >= 2) return "symptoms_improving";
  if (higherCount === 0 && improvingCount === 1) return "symptoms_trending_better";
  if (improvingCount >= 1 && higherCount >= 1) return "mixed_symptom_response";
  if (higherCount >= 2 && improvingCount === 0) return "symptoms_trending_higher";
  return "symptoms_stable";
}
