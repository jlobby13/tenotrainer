// Milestone 6, Stage 3B — pure statistical primitives for the 5+5
// longitudinal symptom classifier. No I/O, no clinical judgment calls
// beyond the LOCKED rules cited inline. See docs/m6-stage3b-symptom-engine.md
// for the full design rationale.
//
// STATISTICAL HIERARCHY (Stage 3B brief section 3) — LOCKED:
//   PRIMARY:      frequency/proportion of recent observations relative to
//                 the previous window's median (the main directional signal).
//   CORROBORATING: median (does the typical recent value support or
//                 contradict what frequency says?). Median never
//                 independently determines direction.
//   CONTEXT ONLY:  IQR (dispersion/context; never drives classification).
// Arithmetic mean is never used for classification anywhere in this module.

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Standard median-of-halves method. Context/descriptive only — see header.
export function interquartileRange(values: number[]): { q1: number; q3: number; iqr: number } {
  if (values.length === 0) throw new Error("interquartileRange: empty input");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lowerHalf = sorted.slice(0, mid);
  const upperHalf = sorted.length % 2 === 0 ? sorted.slice(mid) : sorted.slice(mid + 1);
  const q1 = median(lowerHalf);
  const q3 = median(upperHalf);
  return { q1, q3, iqr: q3 - q1 };
}

export type RelativeDirection = "lower" | "similar" | "higher";

// The 1-point operational directional boundary (Stage 3B brief section 3) —
// a TenoTrainer operational choice, NOT a validated MCID. Catalogued as
// heuristic `m6_1pt_directional_boundary` (see symptomHeuristics.ts).
export const DIRECTIONAL_BOUNDARY_POINTS = 1;

export function relativeDirection(recentValue: number, previousWindowMedian: number): RelativeDirection {
  if (recentValue <= previousWindowMedian - DIRECTIONAL_BOUNDARY_POINTS) return "lower";
  if (recentValue >= previousWindowMedian + DIRECTIONAL_BOUNDARY_POINTS) return "higher";
  return "similar";
}

export type FrequencyPattern = "favorable_lower" | "unfavorable_higher" | "no_dominant_pattern";

// >= 60% of the 5 recent observations — a TenoTrainer operational
// heuristic, NOT a validated biological threshold. Catalogued as heuristic
// `m6_directional_frequency_60pct` (see symptomHeuristics.ts).
export const DIRECTIONAL_FREQUENCY_THRESHOLD = 0.6;
const FREQUENCY_EPSILON = 1e-9; // guards float comparison (e.g. 3/5 vs 0.6)

export function classifyFrequencyPattern(directions: RelativeDirection[]): FrequencyPattern {
  if (directions.length === 0) throw new Error("classifyFrequencyPattern: empty input");
  const n = directions.length;
  const lowerCount = directions.filter((d) => d === "lower").length;
  const higherCount = directions.filter((d) => d === "higher").length;
  if (lowerCount / n >= DIRECTIONAL_FREQUENCY_THRESHOLD - FREQUENCY_EPSILON) return "favorable_lower";
  if (higherCount / n >= DIRECTIONAL_FREQUENCY_THRESHOLD - FREQUENCY_EPSILON) return "unfavorable_higher";
  return "no_dominant_pattern";
}

export type MedianDirection = "lower" | "same" | "higher";

// Directional only, per Stage 3B brief section 5 — no additional invented
// numeric median-difference threshold.
export function medianDirection(recentWindowMedian: number, previousWindowMedian: number): MedianDirection {
  if (recentWindowMedian < previousWindowMedian) return "lower";
  if (recentWindowMedian > previousWindowMedian) return "higher";
  return "same";
}
