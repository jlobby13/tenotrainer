// Milestone 6, Stage 3B — statistical primitives tests. Plain,
// dependency-free script (see morningEligibility.test.ts's header note).
// Run with `npx tsx <this file>`.
import {
  classifyFrequencyPattern,
  interquartileRange,
  median,
  medianDirection,
  relativeDirection,
} from "../symptomStatistics";

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

// --- median ---

test("median correct for N=5 (odd)", () => {
  assertEqual(median([3, 1, 4, 1, 5]), 3, "sorted [1,1,3,4,5] -> middle is 3");
});

test("median correct for N=4 (even) — average of two middles", () => {
  assertEqual(median([1, 2, 3, 4]), 2.5, "avg of 2 and 3");
});

// --- IQR ---

test("IQR calculated correctly for an odd-length sample (median-of-halves)", () => {
  // sorted: 1,2,3,4,5,6,7 — lower half [1,2,3], upper half [5,6,7]
  const { q1, q3, iqr } = interquartileRange([7, 3, 1, 5, 6, 2, 4]);
  assertEqual(q1, 2, "q1");
  assertEqual(q3, 6, "q3");
  assertEqual(iqr, 4, "iqr");
});

test("IQR calculated correctly for an even-length sample", () => {
  // sorted: 1,2,3,4,5,6 — lower half [1,2,3], upper half [4,5,6]
  const { q1, q3, iqr } = interquartileRange([6, 2, 4, 1, 5, 3]);
  assertEqual(q1, 2, "q1");
  assertEqual(q3, 5, "q3");
  assertEqual(iqr, 3, "iqr");
});

test("IQR is context/descriptive only — this module exposes no threshold that classifies from it", () => {
  // Structural check: interquartileRange returns numbers, never a
  // 'variable'/'consistent' label. Any such label must come from
  // symptomClassifier.ts's frequency/median logic, never from IQR directly.
  const result = interquartileRange([1, 2, 3, 4, 5]);
  assertEqual(typeof result.iqr, "number", "iqr is a plain number, not a classification");
});

// --- relative direction (1-point operational boundary) ---

test("relativeDirection: value at least 1 below median -> lower", () => {
  assertEqual(relativeDirection(3, 4), "lower", "3 <= 4-1");
});

test("relativeDirection: value equal to median -> similar", () => {
  assertEqual(relativeDirection(4, 4), "similar", "exactly equal");
});

test("relativeDirection: value at least 1 above median -> higher", () => {
  assertEqual(relativeDirection(5, 4), "higher", "5 >= 4+1");
});

test("relativeDirection: zero values handled correctly (0 vs median 0 -> similar, not fabricated direction)", () => {
  assertEqual(relativeDirection(0, 0), "similar", "0 vs 0");
  assertEqual(relativeDirection(0, 1), "lower", "0 <= 1-1");
});

// --- frequency/proportion (>=60% rule; arithmetic mean never used) ---

test("3/5 lower -> favorable_lower (exactly at the 60% boundary)", () => {
  assertEqual(classifyFrequencyPattern(["lower", "lower", "lower", "similar", "higher"]), "favorable_lower", "3/5 = 60%");
});

test("4/5 lower -> favorable_lower", () => {
  assertEqual(classifyFrequencyPattern(["lower", "lower", "lower", "lower", "similar"]), "favorable_lower", "4/5");
});

test("5/5 lower -> favorable_lower", () => {
  assertEqual(classifyFrequencyPattern(["lower", "lower", "lower", "lower", "lower"]), "favorable_lower", "5/5");
});

test("3/5 higher -> unfavorable_higher", () => {
  assertEqual(classifyFrequencyPattern(["higher", "higher", "higher", "similar", "lower"]), "unfavorable_higher", "3/5 = 60%");
});

test("no 3/5 majority (2 lower, 2 higher, 1 similar) -> no_dominant_pattern", () => {
  assertEqual(classifyFrequencyPattern(["lower", "lower", "higher", "higher", "similar"]), "no_dominant_pattern", "no side reaches 60%");
});

test("stable distribution (all similar) -> no_dominant_pattern", () => {
  assertEqual(classifyFrequencyPattern(["similar", "similar", "similar", "similar", "similar"]), "no_dominant_pattern", "all similar");
});

test("classifyFrequencyPattern never uses arithmetic mean — only counts each direction", () => {
  // A sample designed so the mean of numeric-coded directions would suggest
  // something different from the count-based majority, to guard against an
  // accidental mean-based reimplementation. lower=0,similar=1,higher=2:
  // [0,0,0,2,2] has mean 0.8 (closer to "similar"=1 than to "lower"=0), but
  // the correct answer (3/5 lower) is favorable_lower.
  assertEqual(classifyFrequencyPattern(["lower", "lower", "lower", "higher", "higher"]), "favorable_lower", "count-based, not mean-based");
});

// --- median corroboration (directional only, no extra numeric threshold) ---

test("medianDirection: recent median lower than previous -> lower", () => {
  assertEqual(medianDirection(3, 4), "lower", "3 < 4");
});

test("medianDirection: recent median equal to previous -> same", () => {
  assertEqual(medianDirection(4, 4), "same", "4 === 4");
});

test("medianDirection: recent median higher than previous -> higher", () => {
  assertEqual(medianDirection(5, 4), "higher", "5 > 4");
});

test("medianDirection: even a 0.5 difference registers a direction (no invented dead-zone threshold)", () => {
  assertEqual(medianDirection(4.5, 4), "higher", "any positive difference is 'higher', no magnitude threshold");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
