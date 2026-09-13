// Milestone 6, Stage 3C — Capacity classifier tests (round 3: fully
// deterministic — no pending-decision branch remains). Covers: 2-of-4
// confirmation, qualification gating, the Well-Tolerated-majority labeling
// rule, mechanical-only loading_pattern_variable, and the approved
// consistently-lower -> more_comparable_data_needed resolution. Plain,
// dependency-free script (see morningEligibility.test.ts's header note).
// Run with `npx tsx <this file>`.
import { classifyCapacity, RECENT_OPPORTUNITY_WINDOW_SIZE } from "../capacityClassifier";
import { isSuccessfulCapacityExposure } from "../capacityExposure";
import type { CapacityExposure, ComparableConstruct, ExposureSetVector } from "../capacityTypes";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const CONSTRUCT: ComparableConstruct = { exId: "heavy_calf_raise", loadingProfile: "heavy_slow_resistance", performanceUnit: "reps" };

function setVector(amounts: number[]): ExposureSetVector {
  return amounts.map((amount, i) => ({ setIndex: i, outcome: "completed" as const, amount, load: null }));
}

// isSuccessfulExposure is ALWAYS derived from toleranceClassification +
// immediateGuidance via the real capacityExposure.ts function — keeps
// fixtures internally consistent and doubles as an integration check.
function exposure(overrides: Partial<Omit<CapacityExposure, "isSuccessfulExposure">> = {}): CapacityExposure {
  const toleranceClassification = overrides.toleranceClassification ?? "well_tolerated";
  const immediateGuidance = overrides.immediateGuidance ?? "maintain";
  return {
    rehabSessionId: `sess-${Math.random()}`,
    userId: "user-1",
    patientLocalDate: "2026-09-01",
    prescriptionVersionId: "presc-1",
    toleranceEvaluationId: `tol-${Math.random()}`,
    toleranceClassification,
    immediateGuidance,
    construct: CONSTRUCT,
    prescribed: setVector([10, 10, 10]),
    actual: setVector([10, 10, 10]),
    ...overrides,
    isSuccessfulExposure: isSuccessfulCapacityExposure(toleranceClassification, immediateGuidance),
  };
}

// Newest-first array helper: index 0 = most recent. `amounts` maps
// index->actual set-vector amounts (defaults to [10,10,10] baseline level).
function series(count: number, fn: (i: number) => Partial<CapacityExposure>): CapacityExposure[] {
  return Array.from({ length: count }, (_, i) => exposure({ rehabSessionId: `sess-${i}`, patientLocalDate: `2026-09-${String(20 - i).padStart(2, "0")}`, ...fn(i) }));
}

// --- data sufficiency ---

test("fewer than window+1 total exposures -> more_comparable_data_needed (insufficient_total_history)", () => {
  const exposures = series(RECENT_OPPORTUNITY_WINDOW_SIZE, () => ({}));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "more_comparable_data_needed", "insufficient total history");
  assertEqual(result.facts.moreDataNeededReason, "insufficient_total_history", "correct reason recorded");
});

test("unrepresentable construct -> always more_comparable_data_needed (unrepresentable_construct), never classified quantitatively", () => {
  const unrepresentableConstruct: ComparableConstruct = { exId: "stretch", loadingProfile: "stretching", performanceUnit: "unrepresentable" };
  const exposures = series(10, () => ({ construct: unrepresentableConstruct }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "more_comparable_data_needed", "never quantitatively classified");
  assertEqual(result.facts.moreDataNeededReason, "unrepresentable_construct", "correct reason recorded");
});

// --- one higher exposure is factual evidence only, NOT confirmation ---

test("exactly 1 qualifying-higher demonstration among the recent 4 -> capacity_building, not confirmed", () => {
  const exposures = series(5, (i) => ({ actual: setVector(i === 0 ? [12, 12, 12] : [10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "capacity_building", "1 qualifying demonstration is 'under confirmation', not confirmed");
  assertEqual(result.facts.qualifyingDemonstrationCount, 1, "exactly 1 qualifying");
});

// --- 2-of-4 confirmation + APPROVED Well-Tolerated-majority labeling ---

test("2 WT / 0 Caution+Maintain -> loading_capacity_improving", () => {
  const exposures = series(5, (i) => ({ actual: setVector(i < 2 ? [12, 12, 12] : [10, 10, 10]), toleranceClassification: "well_tolerated", immediateGuidance: "maintain" }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "loading_capacity_improving", "2 WT, 0 CM -> improving");
});

test("1 WT / 1 Caution+Maintain -> capacity_building (tie does not justify the stronger label)", () => {
  const exposures = series(5, (i) => ({
    actual: setVector(i < 2 ? [12, 12, 12] : [10, 10, 10]),
    toleranceClassification: i === 0 ? "well_tolerated" : i === 1 ? "caution" : "well_tolerated",
    immediateGuidance: "maintain",
  }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "capacity_building", "tie (1 WT / 1 CM) -> capacity_building");
});

test("0 WT / 2 Caution+Maintain -> capacity_building", () => {
  const exposures = series(5, (i) => ({ actual: setVector(i < 2 ? [12, 12, 12] : [10, 10, 10]), toleranceClassification: "caution", immediateGuidance: "maintain" }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "capacity_building", "0 WT, 2 CM -> capacity_building (matches the brief's own example)");
});

test("2 WT / 1 Caution+Maintain (3-of-4) -> loading_capacity_improving", () => {
  const exposures = series(5, (i) => ({
    actual: setVector(i < 3 ? [12, 12, 12] : [10, 10, 10]),
    toleranceClassification: i < 2 ? "well_tolerated" : i === 2 ? "caution" : "well_tolerated",
    immediateGuidance: "maintain",
  }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "loading_capacity_improving", "2 WT beats 1 CM -> improving");
});

test("1 WT / 2 Caution+Maintain (3-of-4) -> capacity_building", () => {
  const exposures = series(5, (i) => ({
    actual: setVector(i < 3 ? [12, 12, 12] : [10, 10, 10]),
    toleranceClassification: i === 0 ? "well_tolerated" : "caution",
    immediateGuidance: "maintain",
  }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "capacity_building", "1 WT loses to 2 CM -> capacity_building");
});

// --- qualification gating (brief sections 8-9) feeds directly into the count ---

test("Reduce/Modify does NOT count toward confirmation", () => {
  const exposures = series(5, (i) => ({ actual: setVector(i < 3 ? [12, 12, 12] : [10, 10, 10]), toleranceClassification: "caution", immediateGuidance: "reduce_modify" }));
  const result = classifyCapacity(exposures);
  assertEqual(result.facts.qualifyingDemonstrationCount, 0, "reduce_modify never qualifies regardless of performance level");
});

test("acute_override/clinical_review does NOT count toward confirmation", () => {
  const exposures = series(5, (i) => ({ actual: setVector(i < 3 ? [12, 12, 12] : [10, 10, 10]), toleranceClassification: "acute_override", immediateGuidance: "clinical_review" }));
  const result = classifyCapacity(exposures);
  assertEqual(result.facts.qualifyingDemonstrationCount, 0, "acute_override never qualifies");
});

// --- structural comparison: mixed set-level movement never counts as a qualifying "higher" ---

test("non-dominating exposures (mixed set-level movement) never count as higher", () => {
  const exposures = series(5, (i) => ({ actual: i < 2 ? setVector([12, 12, 8]) : setVector([10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assertEqual(result.facts.qualifyingDemonstrationCount, 0, "non_dominating comparisons never count as higher");
});

// --- Mechanically stable, REGARDLESS of tolerance mix (brief section 9) ---

test("all recent 4 mechanically at-or-above baseline, ALL successful -> loading_capacity_stable", () => {
  const exposures = series(5, () => ({}));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "loading_capacity_stable", "consistent, successful, unchanged pattern");
});

test("mechanically stable (all equal to baseline) with MIXED/non-qualifying tolerance -> STILL loading_capacity_stable (tolerance variability belongs to Training Response, not Capacity)", () => {
  const exposures = series(5, (i) => ({
    actual: setVector([10, 10, 10]), // always exactly equal to baseline
    toleranceClassification: i % 2 === 0 ? "well_tolerated" : "caution",
    immediateGuidance: i % 2 === 0 ? "maintain" : "maintain_cautiously", // half non-qualifying
  }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "loading_capacity_stable", "mechanical stability alone determines this state now, never gated by tolerance");
});

// --- MECHANICAL-ONLY loading_pattern_variable ---

test("mechanically higher AND mechanically lower exposures present (regardless of tolerance) -> loading_pattern_variable", () => {
  // higher, higher, lower, baseline — the 2 "higher" ones given
  // NON-qualifying tolerance so they don't ALSO satisfy the separate,
  // higher-priority 2-of-4 mechanism, isolating this path.
  const amounts = [[12, 12, 12], [12, 12, 12], [8, 8, 8], [10, 10, 10]];
  const exposures = series(5, (i) => ({
    actual: i < 4 ? setVector(amounts[i]) : setVector([10, 10, 10]),
    toleranceClassification: "caution" as const,
    immediateGuidance: "reduce_modify" as const,
  }));
  const result = classifyCapacity(exposures);
  assertEqual(result.facts.qualifyingDemonstrationCount, 0, "sanity: nothing qualifies toward 2-of-4 (non-qualifying tolerance)");
  assertEqual(result.state, "loading_pattern_variable", "opposing mechanical evidence -> variable, driven by mechanics not tolerance");
  assert(result.facts.mechanicallyHigherRehabSessionIds.length >= 1 && result.facts.mechanicallyLowerRehabSessionIds.length >= 1, "facts capture both directions");
});

test("a single non-dominating exposure (mixed set-level movement) also triggers loading_pattern_variable", () => {
  const exposures = series(5, (i) => ({ actual: i === 0 ? setVector([12, 12, 8]) : setVector([10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "loading_pattern_variable", "a single non-dominating exposure is itself opposing mechanical evidence");
  assertEqual(result.facts.hasNonDominatingExposure, true, "fact recorded");
});

test("mixed tolerance qualification at a CONSTANT mechanical level -> NOT variable Capacity (tolerance must never drive mechanical variability)", () => {
  const exposures = series(5, (i) => ({
    actual: setVector([10, 10, 10]),
    toleranceClassification: i % 2 === 0 ? "well_tolerated" : "caution",
    immediateGuidance: i % 2 === 0 ? "maintain" : "maintain_cautiously",
  }));
  const result = classifyCapacity(exposures);
  assert(result.state !== "loading_pattern_variable", "mixed TOLERANCE alone must never produce variable Capacity");
});

// --- APPROVED: consistently lower -> more_comparable_data_needed, never variable/stable/declining ---

test("consistently LOWER (no opposing higher evidence) -> more_comparable_data_needed with recent_loading_lower descriptor", () => {
  const exposures = series(5, (i) => ({ actual: i < 4 ? setVector([8, 8, 8]) : setVector([10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "more_comparable_data_needed", "consistently lower resolves to more_comparable_data_needed, never variable/stable/declining");
  assertEqual(result.facts.moreDataNeededReason, "recent_loading_lower", "structured descriptor recorded");
  assert(!(["loading_pattern_variable", "loading_capacity_stable"] as string[]).includes(result.state), "must not be variable or stable");
});

test("even a single mechanically-lower exposure (with zero higher, zero opposing) routes to more_comparable_data_needed, not stable", () => {
  const exposures = series(5, (i) => ({ actual: i === 0 ? setVector([8, 8, 8]) : setVector([10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assertEqual(result.state, "more_comparable_data_needed", "any lower-only evidence, no invented majority threshold needed");
  assertEqual(result.facts.moreDataNeededReason, "recent_loading_lower", "");
});

test("no output ever uses 'declining' language, and no capacity_declining/loading_capacity_declining state exists", () => {
  const exposures = series(5, (i) => ({ actual: i < 4 ? setVector([8, 8, 8]) : setVector([10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assert(!result.state.toLowerCase().includes("declin"), "no state name ever uses 'declining' language");
});

// --- recentLoadingLowerThanPrior: single-most-recent-exposure fact, always preserved ---

test("recentLoadingLowerThanPrior fact reflects the single most recent exposure vs. baseline", () => {
  const exposures = series(5, (i) => ({ actual: i === 0 ? setVector([8, 8, 8]) : setVector([10, 10, 10]) }));
  const result = classifyCapacity(exposures);
  assertEqual(result.facts.recentLoadingLowerThanPrior, true, "factual flag set");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
