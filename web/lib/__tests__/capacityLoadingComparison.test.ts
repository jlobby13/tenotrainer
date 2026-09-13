// Milestone 6, Stage 3C — structural/partial-order set-vector comparison
// tests (round 3: real set-level performance, never collapsed to a
// scalar). Plain, dependency-free script (see morningEligibility.test.ts's
// header note). Run with `npx tsx <this file>`.
import { compareSetVectors } from "../capacityLoadingComparison";
import type { ExposureSetVector, SetObservation } from "../capacityTypes";

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

// Builds a simple all-completed set vector from a plain amount array, e.g.
// vec([12,12,12,8]) — no load unless given.
function vec(amounts: number[], loads: (number | null)[] | null = null): ExposureSetVector {
  return amounts.map((amount, i): SetObservation => ({ setIndex: i, outcome: "completed", amount, load: loads ? loads[i] : null }));
}

// --- the four LOCKED worked examples, exactly as given ---

test("[12,12,12,12] vs [10,10,10,10] -> higher", () => {
  assertEqual(compareSetVectors(vec([12, 12, 12, 12]), vec([10, 10, 10, 10])), "higher", "");
});

test("[10,10,10,10] vs [10,10,10,10] -> equal", () => {
  assertEqual(compareSetVectors(vec([10, 10, 10, 10]), vec([10, 10, 10, 10])), "equal", "");
});

test("[8,8,8,8] vs [10,10,10,10] -> lower", () => {
  assertEqual(compareSetVectors(vec([8, 8, 8, 8]), vec([10, 10, 10, 10])), "lower", "");
});

test("[12,12,12,8] vs [10,10,10,10] -> non_dominating (NEVER higher by majority-of-sets)", () => {
  assertEqual(compareSetVectors(vec([12, 12, 12, 8]), vec([10, 10, 10, 10])), "non_dominating", "3 sets up, 1 down — never resolved by majority");
});

// --- unequal shape: never invent an exchange rate ---

test("3x12 vs 4x10 (unequal set count) -> non_dominating, never resolved by any exchange rate", () => {
  assertEqual(compareSetVectors(vec([12, 12, 12]), vec([10, 10, 10, 10])), "non_dominating", "fewer, higher sets vs more, lower sets — never equated");
});

test("unequal count in the OTHER direction is also non_dominating", () => {
  assertEqual(compareSetVectors(vec([10, 10, 10, 10, 10]), vec([10, 10, 10])), "non_dominating", "more sets at the same amount — still a shape mismatch, never assumed dominant");
});

// --- skipped sets: never become zero ---

test("a skipped set (amount=null) is excluded from the comparison entirely, never treated as 0", () => {
  const candidate: ExposureSetVector = [
    { setIndex: 0, outcome: "completed", amount: 12, load: null },
    { setIndex: 1, outcome: "skipped", amount: null, load: null },
    { setIndex: 2, outcome: "completed", amount: 12, load: null },
  ];
  const baseline = vec([10, 10, 10]);
  // set 1 excluded (unknown on candidate side); sets 0,2 both higher -> higher overall
  assertEqual(compareSetVectors(candidate, baseline), "higher", "skip excluded, not treated as a 0 (which would otherwise read as 'lower')");
});

test("both sides skipped at the same set position contributes no signal there", () => {
  const candidate: ExposureSetVector = [
    { setIndex: 0, outcome: "completed", amount: 12, load: null },
    { setIndex: 1, outcome: "skipped", amount: null, load: null },
  ];
  const baseline: ExposureSetVector = [
    { setIndex: 0, outcome: "completed", amount: 10, load: null },
    { setIndex: 1, outcome: "skipped", amount: null, load: null },
  ];
  assertEqual(compareSetVectors(candidate, baseline), "higher", "only set 0 contributes a signal");
});

test("all sets unknown on at least one side at every position -> insufficient", () => {
  const allSkipped: ExposureSetVector = [
    { setIndex: 0, outcome: "skipped", amount: null, load: null },
    { setIndex: 1, outcome: "skipped", amount: null, load: null },
  ];
  const baseline = vec([10, 10]);
  assertEqual(compareSetVectors(allSkipped, baseline), "insufficient", "nothing known to compare");
});

// --- load pairing: reps and load moving in different directions within one set ---

test("within one set, amount up and load down -> non_dominating (never weighting one dimension over the other)", () => {
  const candidate = vec([12], [18]);
  const baseline = vec([10], [20]);
  assertEqual(compareSetVectors(candidate, baseline), "non_dominating", "more reps but less load in the SAME set — no invented exchange rate");
});

test("amount and load both increase in the same set -> higher", () => {
  const candidate = vec([12], [22]);
  const baseline = vec([10], [20]);
  assertEqual(compareSetVectors(candidate, baseline), "higher", "");
});

test("load unknown on one side excludes load from that set's comparison, uses amount only", () => {
  const candidate: ExposureSetVector = [{ setIndex: 0, outcome: "completed", amount: 12, load: null }];
  const baseline: ExposureSetVector = [{ setIndex: 0, outcome: "completed", amount: 10, load: 20 }];
  assertEqual(compareSetVectors(candidate, baseline), "higher", "load excluded (unknown on candidate side), amount alone determines the result");
});

// --- real per-set pairing is preserved, never reordered across sets ---

test("per-set reps/load pairing is used as-recorded, never independently reordered across sets", () => {
  // Set1=10reps@20kg, Set2=10reps@22kg, Set3=8reps@22kg (candidate)
  // vs Set1=10reps@20kg, Set2=10reps@20kg, Set3=10reps@20kg (baseline)
  const candidate: ExposureSetVector = [
    { setIndex: 0, outcome: "completed", amount: 10, load: 20 },
    { setIndex: 1, outcome: "completed", amount: 10, load: 22 },
    { setIndex: 2, outcome: "completed", amount: 8, load: 22 },
  ];
  const baseline: ExposureSetVector = [
    { setIndex: 0, outcome: "completed", amount: 10, load: 20 },
    { setIndex: 1, outcome: "completed", amount: 10, load: 20 },
    { setIndex: 2, outcome: "completed", amount: 10, load: 20 },
  ];
  // set0: equal/equal -> equal. set1: amount equal, load higher -> higher.
  // set2: amount LOWER, load higher -> non_dominating within that set alone
  // -> whole comparison is non_dominating.
  assertEqual(compareSetVectors(candidate, baseline), "non_dominating", "set 3's own reps-down/load-up conflict is never resolved by an exchange rate");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
