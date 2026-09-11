// Milestone 6, Stage 2 — regression coverage for the pure Layer-1
// comparison logic feeding /patient/progress.
import {
  buildNumericComparison,
  numericComparisonDirection,
  numericComparisonDelta,
  buildStiffnessDurationComparison,
  stiffnessDurationDirection,
  comparePrescriptionVersions,
  ruleVersionChanged,
} from "../progressCompare";

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
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const numeric = (previous: number | null, current: number | null) =>
  buildNumericComparison({ label: "x", previous, previousDate: previous == null ? null : "2026-09-01", current, currentDate: current == null ? null : "2026-09-02" });

test("A. increasing value -> direction 'up', positive delta", () => {
  const c = numeric(2, 4);
  assertEqual(numericComparisonDirection(c), "up", "direction");
  assertEqual(numericComparisonDelta(c), 2, "delta");
});

test("B. decreasing value -> direction 'down', negative delta", () => {
  const c = numeric(4, 2);
  assertEqual(numericComparisonDirection(c), "down", "direction");
  assertEqual(numericComparisonDelta(c), -2, "delta");
});

test("C. unchanged value -> direction 'same', zero delta", () => {
  const c = numeric(3, 3);
  assertEqual(numericComparisonDirection(c), "same", "direction");
  assertEqual(numericComparisonDelta(c), 0, "delta");
});

test("D. explicit zero on both sides is a real comparison, not 'unavailable'", () => {
  const c = numeric(0, 0);
  assertEqual(numericComparisonDirection(c), "same", "direction");
  assertEqual(numericComparisonDelta(c), 0, "delta");
});

test("E. explicit zero current vs. a real prior value -> real 'down', never treated as missing", () => {
  const c = numeric(5, 0);
  assertEqual(numericComparisonDirection(c), "down", "direction");
  assertEqual(numericComparisonDelta(c), -5, "delta");
});

test("F. missing current (null) -> direction and delta both null, never coerced to 0", () => {
  const c = numeric(4, null);
  assertEqual(numericComparisonDirection(c), null, "direction");
  assertEqual(numericComparisonDelta(c), null, "delta");
});

test("G. missing previous (null) -> direction and delta both null (first-ever observation)", () => {
  const c = numeric(null, 4);
  assertEqual(numericComparisonDirection(c), null, "direction");
  assertEqual(numericComparisonDelta(c), null, "delta");
});

test("H. no history at all (both null) -> direction and delta both null", () => {
  const c = numeric(null, null);
  assertEqual(numericComparisonDirection(c), null, "direction");
  assertEqual(numericComparisonDelta(c), null, "delta");
});

// --- Stiffness duration (ordinal, never converted to fake minutes) ---

test("I. stiffness-duration bucket increased (lt_5_min -> gt_30_min) -> direction 'up'", () => {
  const c = buildStiffnessDurationComparison({ previous: "lt_5_min", previousDate: "2026-09-01", current: "gt_30_min", currentDate: "2026-09-02" });
  assertEqual(stiffnessDurationDirection(c), "up", "direction");
});

test("J. stiffness-duration bucket decreased (gt_30_min -> min_5_15) -> direction 'down'", () => {
  const c = buildStiffnessDurationComparison({ previous: "gt_30_min", previousDate: "2026-09-01", current: "min_5_15", currentDate: "2026-09-02" });
  assertEqual(stiffnessDurationDirection(c), "down", "direction");
});

test("K. stiffness-duration bucket unchanged -> direction 'same'", () => {
  const c = buildStiffnessDurationComparison({ previous: "min_15_30", previousDate: "2026-09-01", current: "min_15_30", currentDate: "2026-09-02" });
  assertEqual(stiffnessDurationDirection(c), "same", "direction");
});

test("L. stiffness-duration missing current -> direction null, never guessed", () => {
  const c = buildStiffnessDurationComparison({ previous: "min_5_15", previousDate: "2026-09-01", current: null, currentDate: null });
  assertEqual(stiffnessDurationDirection(c), null, "direction");
});

test("M. not_applicable (stiffness=0) ranks lowest, correctly registers as 'up' from there", () => {
  const c = buildStiffnessDurationComparison({ previous: "not_applicable", previousDate: "2026-09-01", current: "lt_5_min", currentDate: "2026-09-02" });
  assertEqual(stiffnessDurationDirection(c), "up", "direction");
});

// --- Prescription-version boundary ---

test("N. same prescription_version_id on both sessions -> 'same'", () => {
  assertEqual(comparePrescriptionVersions("v1", "v1"), "same", "comparison");
});

test("O. different prescription_version_id -> 'different' (drives 'Rehab plan updated')", () => {
  assertEqual(comparePrescriptionVersions("v1", "v2"), "different", "comparison");
});

test("P. either side null (legacy/unresolved session) -> 'unknown', never guessed as 'same'", () => {
  assertEqual(comparePrescriptionVersions(null, "v2"), "unknown", "previous null");
  assertEqual(comparePrescriptionVersions("v1", null), "unknown", "current null");
  assertEqual(comparePrescriptionVersions(null, null), "unknown", "both null");
});

// --- Tolerance rule-version boundary ---

test("Q. same rule_version -> no change flagged", () => {
  assertEqual(ruleVersionChanged("v1", "v1"), false, "changed");
});

test("R. different rule_version -> change flagged", () => {
  assertEqual(ruleVersionChanged("v1", "v2"), true, "changed");
});

test("S. no previous rule_version (first evaluation ever) -> never flagged as a change", () => {
  assertEqual(ruleVersionChanged(null, "v1"), false, "changed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
