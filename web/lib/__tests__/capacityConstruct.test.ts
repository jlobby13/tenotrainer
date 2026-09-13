// Milestone 6, Stage 3C — comparable construct identity tests. Plain,
// dependency-free script (see morningEligibility.test.ts's header note).
// Run with `npx tsx <this file>`.
import { derivePerformanceUnit, deriveComparableConstruct, constructsMatch, constructKey } from "../capacityConstruct";
import type { PrescriptionSnapshotExercise } from "../rehabSessionTypes";

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

function makeExercise(overrides: Partial<PrescriptionSnapshotExercise> = {}): PrescriptionSnapshotExercise {
  return {
    ex_id: "heavy_calf_raise",
    name: "Heavy calf raise",
    category: "strength",
    loading_profile: "heavy_slow_resistance",
    order_index: 0,
    dosage: { sets: 3, reps_or_hold_time: 10 },
    ...overrides,
  };
}

// --- performance unit derivation ---

test("isometric numeric dosage -> hold_seconds", () => {
  assertEqual(derivePerformanceUnit("isometric", true), "hold_seconds", "isometric + numeric");
});

test("non-isometric numeric dosage -> reps", () => {
  assertEqual(derivePerformanceUnit("heavy_slow_resistance", true), "reps", "non-isometric + numeric");
  assertEqual(derivePerformanceUnit("eccentric_biased", true), "reps", "eccentric + numeric");
});

test("nonnumeric dosage -> unrepresentable regardless of loading profile", () => {
  assertEqual(derivePerformanceUnit("isometric", false), "unrepresentable", "isometric + nonnumeric");
  assertEqual(derivePerformanceUnit("heavy_slow_resistance", false), "unrepresentable", "reps-style + nonnumeric");
});

// --- construct derivation from a real snapshot exercise ---

test("deriveComparableConstruct: numeric reps dosage -> reps construct", () => {
  const c = deriveComparableConstruct(makeExercise({ dosage: { sets: 3, reps_or_hold_time: 10 } }));
  assertEqual(c, { exId: "heavy_calf_raise", loadingProfile: "heavy_slow_resistance", performanceUnit: "reps" }, "reps construct");
});

test("deriveComparableConstruct: isometric numeric dosage -> hold_seconds construct", () => {
  const c = deriveComparableConstruct(makeExercise({ loading_profile: "isometric", dosage: { sets: 3, reps_or_hold_time: 45 } }));
  assertEqual(c.performanceUnit, "hold_seconds", "hold_seconds construct");
});

test("deriveComparableConstruct: never parses range/free-text dosage into an invented number ('8-12' -> unrepresentable)", () => {
  const c = deriveComparableConstruct(makeExercise({ dosage: { sets: 3, reps_or_hold_time: "8-12" } }));
  assertEqual(c.performanceUnit, "unrepresentable", "range string never parsed");
});

test("deriveComparableConstruct: never parses a hold-string dosage ('45s hold') into an invented number", () => {
  const c = deriveComparableConstruct(makeExercise({ loading_profile: "isometric", dosage: { sets: 3, reps_or_hold_time: "45s hold" } }));
  assertEqual(c.performanceUnit, "unrepresentable", "hold string never parsed");
});

test("deriveComparableConstruct: never parses free-text duration dosage into an invented number", () => {
  const c = deriveComparableConstruct(makeExercise({ loading_profile: "return_to_run", dosage: { reps_or_hold_time: "20 min total (1 min jog : 2 min walk)" } }));
  assertEqual(c.performanceUnit, "unrepresentable", "free-text duration never parsed");
});

// --- exact-match identity (brief section 2) ---

test("constructsMatch: same ex_id + loading_profile + unit -> match", () => {
  const a = deriveComparableConstruct(makeExercise());
  const b = deriveComparableConstruct(makeExercise());
  assert(constructsMatch(a, b), "identical constructs should match");
});

test("constructsMatch: different ex_id -> no match (heavy dynamic vs reactive pogo example)", () => {
  const a = deriveComparableConstruct(makeExercise({ ex_id: "heavy_calf_raise" }));
  const b = deriveComparableConstruct(makeExercise({ ex_id: "reactive_pogo" }));
  assert(!constructsMatch(a, b), "different exercise identity must not match");
});

test("constructsMatch: different loading_profile on the same ex_id -> no match", () => {
  const a = deriveComparableConstruct(makeExercise({ loading_profile: "heavy_slow_resistance" }));
  const b = deriveComparableConstruct(makeExercise({ loading_profile: "eccentric_biased" }));
  assert(!constructsMatch(a, b), "different loading profile must not match even with same ex_id");
});

test("constructsMatch: different performance unit (rep-based vs hold-time-based) -> no match", () => {
  const a = deriveComparableConstruct(makeExercise({ loading_profile: "isotonic_slow", dosage: { reps_or_hold_time: 10 } }));
  const b = deriveComparableConstruct(makeExercise({ loading_profile: "isometric", dosage: { reps_or_hold_time: 10 } }));
  assert(a.performanceUnit !== b.performanceUnit, "sanity: units actually differ");
  assert(!constructsMatch(a, b), "rep-based vs hold-time-based must not match");
});

test("constructsMatch: dosage AMOUNT differing (3x10 -> 3x12) does not itself break comparability", () => {
  const a = deriveComparableConstruct(makeExercise({ dosage: { sets: 3, reps_or_hold_time: 10 } }));
  const b = deriveComparableConstruct(makeExercise({ dosage: { sets: 3, reps_or_hold_time: 12 } }));
  assert(constructsMatch(a, b), "same exercise/profile/unit despite a higher prescribed amount stays comparable");
});

// --- prescription-version change alone never breaks comparability ---

test("comparability is defined with NO reference to prescription_version_id at all (type-level guarantee)", () => {
  // ComparableConstruct has exactly 3 fields: exId, loadingProfile,
  // performanceUnit. There is no prescriptionVersionId field to even
  // compare — a version change literally cannot participate in this check.
  const c = deriveComparableConstruct(makeExercise());
  assertEqual(Object.keys(c).sort(), ["exId", "loadingProfile", "performanceUnit"].sort(), "construct has no version field");
});

// --- construct key stability for grouping ---

test("constructKey: distinct constructs produce distinct keys", () => {
  const a = deriveComparableConstruct(makeExercise({ ex_id: "a" }));
  const b = deriveComparableConstruct(makeExercise({ ex_id: "b" }));
  assert(constructKey(a) !== constructKey(b), "distinct keys");
});

test("constructKey: null loading_profile handled without crashing or colliding with an empty string", () => {
  const withNull = deriveComparableConstruct(makeExercise({ loading_profile: null }));
  const withEmpty = deriveComparableConstruct(makeExercise({ loading_profile: "" }));
  assert(constructKey(withNull) !== constructKey(withEmpty), "null and empty-string loading_profile must not collide");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
