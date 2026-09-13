// Milestone 6, Stage 3C — Training Response classifier tests (round 4,
// FINAL LOCKED mechanism): boundary-adjacent one-to-one real-exposure
// pairing, >=2-usable-pairs-per-construct sufficiency, construct-level
// direction mapping, insufficient-construct handling, multi-construct
// aggregation, and the final state mapping. Plain, dependency-free script
// (see morningEligibility.test.ts's header note). Run with
// `npx tsx <this file>`.
import { compareWindowLoading, classifyTrainingResponse } from "../trainingResponseClassifier";
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
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const CONSTRUCT_A: ComparableConstruct = { exId: "heavy_calf_raise", loadingProfile: "heavy_slow_resistance", performanceUnit: "reps" };
const CONSTRUCT_B: ComparableConstruct = { exId: "isometric_hold", loadingProfile: "isometric", performanceUnit: "hold_seconds" };

function setVector(amounts: number[]): ExposureSetVector {
  return amounts.map((amount, i) => ({ setIndex: i, outcome: "completed" as const, amount, load: null }));
}

function exposure(sessionId: string, date: string, construct: ComparableConstruct, amounts: number[]): CapacityExposure {
  return {
    rehabSessionId: sessionId,
    userId: "user-1",
    patientLocalDate: date,
    prescriptionVersionId: "presc-1",
    toleranceEvaluationId: `tol-${sessionId}`,
    toleranceClassification: "well_tolerated",
    immediateGuidance: "maintain",
    construct,
    prescribed: setVector(amounts),
    actual: setVector(amounts),
    isSuccessfulExposure: true,
  };
}

// --- boundary-adjacent pairing (LOCKED, section 1/15) ---

test("3 previous vs 3 recent: P3<->R1, P2<->R2, P1<->R3 (pairing outward from the boundary)", () => {
  const exposures = [
    exposure("P1", "2026-09-01", CONSTRUCT_A, [10]),
    exposure("P2", "2026-09-02", CONSTRUCT_A, [10]),
    exposure("P3", "2026-09-03", CONSTRUCT_A, [10]), // closest to boundary
    exposure("R1", "2026-09-10", CONSTRUCT_A, [10]), // closest to boundary
    exposure("R2", "2026-09-11", CONSTRUCT_A, [10]),
    exposure("R3", "2026-09-12", CONSTRUCT_A, [10]),
  ];
  const result = compareWindowLoading({ previousRehabSessionIds: ["P1", "P2", "P3"], recentRehabSessionIds: ["R1", "R2", "R3"], exposures });
  const pairs = result.constructResults[0].pairs;
  assertEqual(pairs.length, 3, "3 pairs formed");
  assertEqual([pairs[0].previousRehabSessionId, pairs[0].recentRehabSessionId], ["P3", "R1"], "P3<->R1");
  assertEqual([pairs[1].previousRehabSessionId, pairs[1].recentRehabSessionId], ["P2", "R2"], "P2<->R2");
  assertEqual([pairs[2].previousRehabSessionId, pairs[2].recentRehabSessionId], ["P1", "R3"], "P1<->R3");
});

test("no exposure ID appears in more than one pair", () => {
  const exposures = [
    exposure("P1", "2026-09-01", CONSTRUCT_A, [10]),
    exposure("P2", "2026-09-02", CONSTRUCT_A, [10]),
    exposure("P3", "2026-09-03", CONSTRUCT_A, [10]),
    exposure("R1", "2026-09-10", CONSTRUCT_A, [10]),
    exposure("R2", "2026-09-11", CONSTRUCT_A, [10]),
    exposure("R3", "2026-09-12", CONSTRUCT_A, [10]),
  ];
  const result = compareWindowLoading({ previousRehabSessionIds: ["P1", "P2", "P3"], recentRehabSessionIds: ["R1", "R2", "R3"], exposures });
  const usedIds = result.constructResults[0].pairs.flatMap((p) => [p.previousRehabSessionId, p.recentRehabSessionId]);
  assertEqual(new Set(usedIds).size, usedIds.length, "every id used exactly once");
});

test("3 previous vs 2 recent: P3<->R1, P2<->R2, P1 unmatched (never reused, never synthesized)", () => {
  const exposures = [
    exposure("P1", "2026-09-01", CONSTRUCT_A, [10]),
    exposure("P2", "2026-09-02", CONSTRUCT_A, [10]),
    exposure("P3", "2026-09-03", CONSTRUCT_A, [10]),
    exposure("R1", "2026-09-10", CONSTRUCT_A, [10]),
    exposure("R2", "2026-09-11", CONSTRUCT_A, [10]),
  ];
  const result = compareWindowLoading({ previousRehabSessionIds: ["P1", "P2", "P3"], recentRehabSessionIds: ["R1", "R2"], exposures });
  const c = result.constructResults[0];
  assertEqual(c.pairs.length, 2, "only 2 pairs — the shorter side sets the count");
  assertEqual([c.pairs[0].previousRehabSessionId, c.pairs[0].recentRehabSessionId], ["P3", "R1"], "");
  assertEqual([c.pairs[1].previousRehabSessionId, c.pairs[1].recentRehabSessionId], ["P2", "R2"], "");
  assertEqual(c.unmatchedPreviousRehabSessionIds, ["P1"], "P1 unmatched, preserved in provenance, not synthesized into anything");
  assertEqual(c.unmatchedRecentRehabSessionIds, [], "recent side fully used");
  assertEqual(c.previousExposureCount, 3, "raw count preserved");
  assertEqual(c.recentExposureCount, 2, "raw count preserved");
});

// --- minimum evidence: >=2 usable pairs (LOCKED, section 3/15) ---

function pairedConstruct(amountsPrevious: number[][], amountsRecent: number[][]): CapacityExposure[] {
  const exposures: CapacityExposure[] = [];
  amountsPrevious.forEach((amt, i) => exposures.push(exposure(`P${i}`, `2026-09-0${i + 1}`, CONSTRUCT_A, amt)));
  amountsRecent.forEach((amt, i) => exposures.push(exposure(`R${i}`, `2026-09-1${i}`, CONSTRUCT_A, amt)));
  return exposures;
}
function ids(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

test("1 usable pair -> construct result = insufficient", () => {
  const exposures = pairedConstruct([[10]], [[12]]);
  const result = compareWindowLoading({ previousRehabSessionIds: ids(1, "P"), recentRehabSessionIds: ids(1, "R"), exposures });
  assertEqual(result.constructResults[0].direction, "insufficient", "only 1 pair — below the 2-pair floor");
  assertEqual(result.constructResults[0].insufficiencyReason, "fewer_than_two_usable_pairs", "");
  assertEqual(result.constructResults[0].pairs.length, 1, "the underlying pair remains visible in provenance");
});

test("2 equal pairs -> maintained", () => {
  const exposures = pairedConstruct([[10], [10]], [[10], [10]]);
  const result = compareWindowLoading({ previousRehabSessionIds: ids(2, "P"), recentRehabSessionIds: ids(2, "R"), exposures });
  assertEqual(result.constructResults[0].direction, "maintained", "");
});

test("2 higher/equal pairs -> increased", () => {
  const exposures = pairedConstruct([[10], [10]], [[12], [10]]);
  const result = compareWindowLoading({ previousRehabSessionIds: ids(2, "P"), recentRehabSessionIds: ids(2, "R"), exposures });
  assertEqual(result.constructResults[0].direction, "increased", "[higher, equal] -> increased");
});

test("2 lower/equal pairs -> decreased", () => {
  const exposures = pairedConstruct([[10], [10]], [[8], [10]]);
  const result = compareWindowLoading({ previousRehabSessionIds: ids(2, "P"), recentRehabSessionIds: ids(2, "R"), exposures });
  assertEqual(result.constructResults[0].direction, "decreased", "[lower, equal] -> decreased");
});

test("higher + lower -> mixed", () => {
  const exposures = pairedConstruct([[10], [10]], [[12], [8]]);
  const result = compareWindowLoading({ previousRehabSessionIds: ids(2, "P"), recentRehabSessionIds: ids(2, "R"), exposures });
  assertEqual(result.constructResults[0].direction, "mixed", "[higher, lower] -> mixed");
});

test("higher + non_dominating -> mixed", () => {
  const exposures = pairedConstruct(
    [[10, 10], [10, 10]],
    [[12, 12], [12, 8]] // second pair: sets [12,8] vs baseline [10,10] -> non_dominating
  );
  const result = compareWindowLoading({ previousRehabSessionIds: ids(2, "P"), recentRehabSessionIds: ids(2, "R"), exposures });
  assertEqual(result.constructResults[0].direction, "mixed", "[higher, non_dominating] -> mixed");
});

// --- insufficient constructs alongside usable ones (LOCKED, section 6/15) ---

test("construct A increased (>=2 pairs) + construct B insufficient -> overall increased, hasInsufficientConstruct=true", () => {
  const exposures = [
    ...pairedConstruct([[10], [10]], [[12], [12]]), // A: 2 pairs, both higher
    exposure("BP0", "2026-09-01", CONSTRUCT_B, [30]), // B: only 1 previous exposure, 0 recent -> insufficient
  ];
  const result = compareWindowLoading({ previousRehabSessionIds: [...ids(2, "P"), "BP0"], recentRehabSessionIds: ids(2, "R"), exposures });
  assertEqual(result.overall, "increased", "the usable construct (A) alone drives the overall result");
  assertEqual(result.hasInsufficientConstruct, true, "B's insufficiency is visible");
  const bResult = result.constructResults.find((c) => c.construct.exId === "isometric_hold");
  assertEqual(bResult?.direction, "insufficient", "B remains represented in provenance, not silently dropped");
});

test("both constructs insufficient -> overall insufficient", () => {
  const exposures = [exposure("AP0", "2026-09-01", CONSTRUCT_A, [10]), exposure("BP0", "2026-09-01", CONSTRUCT_B, [30])];
  const result = compareWindowLoading({ previousRehabSessionIds: ["AP0", "BP0"], recentRehabSessionIds: [], exposures });
  assertEqual(result.overall, "insufficient", "no construct has >=2 usable pairs");
});

// --- multi-construct aggregation (LOCKED, section 7/15) ---

test("A increased + B increased -> overall increased", () => {
  const exposures = [...pairedConstruct([[10], [10]], [[12], [12]])];
  const bExposures = [exposure("BP0", "2026-09-01", CONSTRUCT_B, [30]), exposure("BP1", "2026-09-02", CONSTRUCT_B, [30]), exposure("BR0", "2026-09-10", CONSTRUCT_B, [35]), exposure("BR1", "2026-09-11", CONSTRUCT_B, [35])];
  const result = compareWindowLoading({ previousRehabSessionIds: [...ids(2, "P"), "BP0", "BP1"], recentRehabSessionIds: [...ids(2, "R"), "BR0", "BR1"], exposures: [...exposures, ...bExposures] });
  assertEqual(result.overall, "increased", "both agree");
});

test("A increased + B maintained -> overall mixed", () => {
  const exposures = [...pairedConstruct([[10], [10]], [[12], [12]])];
  const bExposures = [exposure("BP0", "2026-09-01", CONSTRUCT_B, [30]), exposure("BP1", "2026-09-02", CONSTRUCT_B, [30]), exposure("BR0", "2026-09-10", CONSTRUCT_B, [30]), exposure("BR1", "2026-09-11", CONSTRUCT_B, [30])];
  const result = compareWindowLoading({ previousRehabSessionIds: [...ids(2, "P"), "BP0", "BP1"], recentRehabSessionIds: [...ids(2, "R"), "BR0", "BR1"], exposures: [...exposures, ...bExposures] });
  assertEqual(result.overall, "mixed", "disagreement between constructs -> mixed");
});

test("A maintained + B decreased -> overall mixed", () => {
  const exposures = [...pairedConstruct([[10], [10]], [[10], [10]])];
  const bExposures = [exposure("BP0", "2026-09-01", CONSTRUCT_B, [30]), exposure("BP1", "2026-09-02", CONSTRUCT_B, [30]), exposure("BR0", "2026-09-10", CONSTRUCT_B, [25]), exposure("BR1", "2026-09-11", CONSTRUCT_B, [25])];
  const result = compareWindowLoading({ previousRehabSessionIds: [...ids(2, "P"), "BP0", "BP1"], recentRehabSessionIds: [...ids(2, "R"), "BR0", "BR1"], exposures: [...exposures, ...bExposures] });
  assertEqual(result.overall, "mixed", "");
});

test("A mixed + B maintained -> overall mixed (any usable construct internally mixed forces overall mixed)", () => {
  const exposures = [...pairedConstruct([[10], [10]], [[12], [8]])]; // A: mixed
  const bExposures = [exposure("BP0", "2026-09-01", CONSTRUCT_B, [30]), exposure("BP1", "2026-09-02", CONSTRUCT_B, [30]), exposure("BR0", "2026-09-10", CONSTRUCT_B, [30]), exposure("BR1", "2026-09-11", CONSTRUCT_B, [30])];
  const result = compareWindowLoading({ previousRehabSessionIds: [...ids(2, "P"), "BP0", "BP1"], recentRehabSessionIds: [...ids(2, "R"), "BR0", "BR1"], exposures: [...exposures, ...bExposures] });
  assertEqual(result.overall, "mixed", "");
});

test("no comparable exposures at all -> insufficient", () => {
  const result = compareWindowLoading({ previousRehabSessionIds: [], recentRehabSessionIds: [], exposures: [] });
  assertEqual(result.overall, "insufficient", "");
  assertEqual(result.constructResults.length, 0, "");
});

test("unrepresentable constructs are excluded from window loading entirely", () => {
  const unrepresentable: ComparableConstruct = { exId: "stretch", loadingProfile: "stretching", performanceUnit: "unrepresentable" };
  const exposures = [exposure("P0", "2026-09-01", unrepresentable, [10]), exposure("R0", "2026-09-10", unrepresentable, [10])];
  const result = compareWindowLoading({ previousRehabSessionIds: ["P0"], recentRehabSessionIds: ["R0"], exposures });
  assertEqual(result.constructResults.length, 0, "never quantitatively compared");
});

// --- Training Response state mapping (LOCKED, brief section 8) ---

test("improving symptoms + maintained loading -> loading_tolerance_improving", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_improving", windowLoadingComparison: "maintained" }), "loading_tolerance_improving", "");
});

test("improving symptoms + increased loading -> loading_tolerance_improving", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_improving", windowLoadingComparison: "increased" }), "loading_tolerance_improving", "");
});

test("trending-better symptoms + maintained loading -> loading_tolerance_improving", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_trending_better", windowLoadingComparison: "maintained" }), "loading_tolerance_improving", "");
});

test("improving symptoms + DECREASED loading (meaningful deload) -> NOT loading_tolerance_improving; favorable Symptoms result is not claimed to be caused by the deload", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_improving", windowLoadingComparison: "decreased" }), "more_data_needed", "");
});

test("stable symptoms + maintained loading -> stable_training_response", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_stable", windowLoadingComparison: "maintained" }), "stable_training_response", "");
});

test("trending-higher symptoms + maintained loading -> training_response_remains_unsettled", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_trending_higher", windowLoadingComparison: "maintained" }), "training_response_remains_unsettled", "");
});

// --- FINAL LOCKED mixed-symptom mapping (founder decision) ---
// Mixed Symptom Response already represents observed symptom variability,
// not missing information — it qualifies variable_training_response
// against increased/maintained/mixed loading. Decreased and insufficient
// loading do NOT qualify (a material deload, or no evidence, means a
// formal longitudinal loading-tolerance interpretation isn't justified).

test("mixed symptoms + increased loading -> variable_training_response", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "mixed_symptom_response", windowLoadingComparison: "increased" }), "variable_training_response", "");
});

test("mixed symptoms + maintained loading -> variable_training_response", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "mixed_symptom_response", windowLoadingComparison: "maintained" }), "variable_training_response", "");
});

test("mixed symptoms + mixed loading -> variable_training_response (mechanical loading variability does not erase already-observed symptom variability)", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "mixed_symptom_response", windowLoadingComparison: "mixed" }), "variable_training_response", "");
});

test("mixed symptoms + decreased loading -> more_data_needed (material deload means no formal loading-tolerance interpretation is justified; Mixed Symptom Response remains independently visible)", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "mixed_symptom_response", windowLoadingComparison: "decreased" }), "more_data_needed", "");
});

test("mixed symptoms + insufficient loading -> more_data_needed", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "mixed_symptom_response", windowLoadingComparison: "insufficient" }), "more_data_needed", "");
});

// --- IMPORTANT SEPARATION: loading being mechanically "mixed" never
// promotes any OTHER symptom state into variable_training_response — only
// Stage 3B's own mixed_symptom_response determination does. ---

test("stable symptoms + mixed loading -> NOT variable_training_response -> more_data_needed", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_stable", windowLoadingComparison: "mixed" }), "more_data_needed", "loading mixed alone never qualifies stable_training_response either");
});

test("improving symptoms + mixed loading -> NOT automatically variable_training_response -> more_data_needed, while Symptoms Improving remains independently visible", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_improving", windowLoadingComparison: "mixed" }), "more_data_needed", "");
});

test("trending-higher symptoms + mixed loading -> NOT training_response_remains_unsettled (that state requires maintained/increased loading) -> more_data_needed", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_trending_higher", windowLoadingComparison: "mixed" }), "more_data_needed", "");
});

test("Stage 3B Symptoms insufficient -> more_data_needed regardless of loading", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "more_data_needed", windowLoadingComparison: "increased" }), "more_data_needed", "");
});

test("insufficient loading information -> more_data_needed regardless of symptom state", () => {
  assertEqual(classifyTrainingResponse({ overallSymptomsState: "symptoms_improving", windowLoadingComparison: "insufficient" }), "more_data_needed", "");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
