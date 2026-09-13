// Milestone 6, Stage 3C — structural/partial-order comparison of REAL,
// ordered set-vectors. Pure.
//
// FOUNDER DECISION (round 3): Capacity must preserve and compare actual
// demonstrated set-level performance — never collapse an exposure into a
// single scalar (no min/median/sum/mean across sets) before comparing.
// `compareSetVectors` operates directly on two ExposureSetVector arrays.
//
// LOCKED examples this function must reproduce exactly:
//   [12,12,12,12] vs [10,10,10,10] -> higher
//   [10,10,10,10] vs [10,10,10,10] -> equal
//   [8,8,8,8]     vs [10,10,10,10] -> lower
//   [12,12,12,8]  vs [10,10,10,10] -> non_dominating (NEVER "higher" by
//     majority-of-sets, never averaged/summed)
//
// Unequal set count (e.g. 3x12 vs 4x10): never invent an exchange rate
// between set count and per-set amount — conservatively non_dominating,
// full stop. No partial "extra sets are free" logic is attempted, since
// that would itself require inventing when extra volume counts as
// dominance — exactly the kind of threshold the brief forbids guessing.
//
// Within one set, reps/hold-duration and external load moving in different
// directions is ALSO non-dominating — never resolved by weighting one
// dimension over the other. A dimension unknown on either side of a given
// set (skipped, or never recorded) is excluded from that set's comparison,
// never coerced to 0.

import type { ExposureSetVector } from "./capacityTypes";

export type DimensionComparison = "higher" | "lower" | "equal" | "non_dominating" | "insufficient";

function compareValue(a: number, b: number): "higher" | "lower" | "equal" {
  if (a > b) return "higher";
  if (a < b) return "lower";
  return "equal";
}

export function compareSetVectors(candidate: ExposureSetVector, baseline: ExposureSetVector): DimensionComparison {
  // Different set counts: never invent an exchange rate between set count
  // and per-set amount (e.g. "3x12 vs 4x10") — conservatively non_dominating.
  if (candidate.length !== baseline.length) return "non_dominating";

  const signs: Array<"higher" | "lower" | "equal"> = [];
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    const b = baseline[i];
    const amountSign = c.amount != null && b.amount != null ? compareValue(c.amount, b.amount) : null;
    const loadSign = c.load != null && b.load != null ? compareValue(c.load, b.load) : null;
    const knownSigns = [amountSign, loadSign].filter((s): s is "higher" | "lower" | "equal" => s != null);
    if (knownSigns.length === 0) continue; // nothing known at this set position (e.g. both skipped) — excluded, not a signal
    if (knownSigns.includes("higher") && knownSigns.includes("lower")) return "non_dominating"; // amount up, load down (or vice versa) within one set
    signs.push(knownSigns.includes("higher") ? "higher" : knownSigns.includes("lower") ? "lower" : "equal");
  }

  if (signs.length === 0) return "insufficient";
  const hasHigher = signs.includes("higher");
  const hasLower = signs.includes("lower");
  if (hasHigher && hasLower) return "non_dominating"; // never resolved by majority-of-sets
  if (hasHigher) return "higher";
  if (hasLower) return "lower";
  return "equal";
}
