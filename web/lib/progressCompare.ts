// Milestone 6, Stage 2 — pure comparison/derivation logic for the Progress
// page. No server-only import, no I/O: every function here takes already-
// fetched facts and returns a factual comparison. This is the Layer-1
// "4 → 2, decreased by 2 points" arithmetic the founder brief explicitly
// allows — nothing here classifies improvement, computes a score, or infers
// causation. See lib/progressTypes.ts for the shapes these produce.

import type { StiffnessDuration } from "./morningResponseTypes";
import type { NumericComparison, StiffnessDurationComparison, PrescriptionVersionComparison } from "./progressTypes";

export function buildNumericComparison(params: {
  label: string;
  previous: number | null;
  previousDate: string | null;
  current: number | null;
  currentDate: string | null;
}): NumericComparison {
  return { ...params };
}

// Arrow direction for a numeric comparison — 'up' | 'down' | 'same' | null.
// null whenever either side is unavailable: an arrow implies a real prior
// and current value both exist, never an implied zero baseline.
export function numericComparisonDirection(c: NumericComparison): "up" | "down" | "same" | null {
  if (c.previous == null || c.current == null) return null;
  if (c.current > c.previous) return "up";
  if (c.current < c.previous) return "down";
  return "same";
}

export function numericComparisonDelta(c: NumericComparison): number | null {
  if (c.previous == null || c.current == null) return null;
  return c.current - c.previous;
}

// Ordinal rank only — used to decide a direction arrow, NEVER surfaced as a
// number of minutes. "not_applicable" (stiffness=0, i.e. no stiffness at
// all) ranks lowest; "gt_30_min" ranks highest. This ordering is a fact
// about the fixed vocabulary (supabase/migrations/...m4_stage4_tolerance_
// interpretation.sql), not an invented clinical scale.
const STIFFNESS_DURATION_ORDER: StiffnessDuration[] = ["not_applicable", "lt_5_min", "min_5_15", "min_15_30", "gt_30_min"];

export function buildStiffnessDurationComparison(params: {
  previous: StiffnessDuration | null;
  previousDate: string | null;
  current: StiffnessDuration | null;
  currentDate: string | null;
}): StiffnessDurationComparison {
  return { ...params };
}

export function stiffnessDurationDirection(c: StiffnessDurationComparison): "up" | "down" | "same" | null {
  if (c.previous == null || c.current == null) return null;
  const prevRank = STIFFNESS_DURATION_ORDER.indexOf(c.previous);
  const currRank = STIFFNESS_DURATION_ORDER.indexOf(c.current);
  if (prevRank < 0 || currRank < 0) return null;
  if (currRank > prevRank) return "up";
  if (currRank < prevRank) return "down";
  return "same";
}

// 'unknown' whenever either side has no resolved prescription_version_id —
// never guessed as "same". Mirrors the exact locked derivation rule already
// used by session_guidance_contexts.prescription_version_comparison
// (supabase/migrations/20260910000001_m5_stage3_session_guidance_contexts.sql),
// applied here to consecutive sessions in a displayed list instead of to a
// tolerance-evaluation handoff.
export function comparePrescriptionVersions(
  previous: string | null,
  current: string | null
): PrescriptionVersionComparison {
  if (previous == null || current == null) return "unknown";
  return previous === current ? "same" : "different";
}

// True only when both rule versions are known and differ. Inert today (only
// "v1" exists anywhere in tolerance_evaluations) — this exists so a future
// real rule-version change can render a subtle "Interpretation method
// updated" note without any further logic change, per the founder brief.
export function ruleVersionChanged(previous: string | null, current: string): boolean {
  return previous != null && previous !== current;
}
