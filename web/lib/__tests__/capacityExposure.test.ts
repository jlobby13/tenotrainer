// Milestone 6, Stage 3C — Capacity exposure construction + qualification
// tests (round 3: real set-level performance vectors, never collapsed).
// Plain, dependency-free script (see morningEligibility.test.ts's header
// note). Run with `npx tsx <this file>`.
import { buildCapacityExposures, isSuccessfulCapacityExposure, type RawSetOutcomeRow, type RawCapacityExposureInput } from "../capacityExposure";
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

// --- successful exposure qualification (LOCKED, brief sections 8-9) ---

test("well_tolerated + maintain -> qualifies", () => {
  assert(isSuccessfulCapacityExposure("well_tolerated", "maintain"), "should qualify");
});

test("caution + maintain -> qualifies", () => {
  assert(isSuccessfulCapacityExposure("caution", "maintain"), "should qualify");
});

test("caution + maintain_cautiously -> does NOT qualify", () => {
  assert(!isSuccessfulCapacityExposure("caution", "maintain_cautiously"), "should not qualify");
});

test("caution + reduce_modify -> does NOT qualify", () => {
  assert(!isSuccessfulCapacityExposure("caution", "reduce_modify"), "should not qualify");
});

test("acute_override + clinical_review -> does NOT qualify", () => {
  assert(!isSuccessfulCapacityExposure("acute_override", "clinical_review"), "should not qualify");
});

test("insufficient_data (placeholder maintain) -> does NOT qualify", () => {
  assert(!isSuccessfulCapacityExposure("insufficient_data", "maintain"), "placeholder pairing must never count as success");
});

// --- exposure construction ---

const snapshot: PrescriptionSnapshotExercise[] = [
  { ex_id: "heavy_calf_raise", name: "Heavy calf raise", category: "strength", loading_profile: "heavy_slow_resistance", order_index: 0, dosage: { sets: 3, reps_or_hold_time: 10 } },
  { ex_id: "isometric_hold", name: "Isometric hold", category: "strength", loading_profile: "isometric", order_index: 1, dosage: { sets: 3, reps_or_hold_time: 45 } },
  { ex_id: "stretch", name: "Calf stretch", category: "mobility", order_index: 2, loading_profile: "stretching", dosage: { sets: 2, reps_or_hold_time: "30-45s hold" } },
];

function baseInput(overrides: Partial<RawCapacityExposureInput> = {}): RawCapacityExposureInput {
  return {
    rehabSessionId: "sess-1",
    userId: "user-1",
    patientLocalDate: "2026-09-01",
    prescriptionVersionId: "presc-1",
    toleranceEvaluationId: "tol-1",
    toleranceClassification: "well_tolerated",
    immediateGuidance: "maintain",
    prescriptionSnapshot: snapshot,
    setOutcomes: [],
    ...overrides,
  };
}

test("builds one exposure per exercise in the snapshot", () => {
  const exposures = buildCapacityExposures(baseInput());
  assertEqual(exposures.length, 3, "one exposure per snapshot exercise");
});

test("reps-based exercise: preserves the REAL ordered set vector, not a collapsed scalar", () => {
  const sets: RawSetOutcomeRow[] = [
    { exercise_id: "heavy_calf_raise", set_index: 0, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 12, actual_load: null },
    { exercise_id: "heavy_calf_raise", set_index: 1, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 12, actual_load: null },
    { exercise_id: "heavy_calf_raise", set_index: 2, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 8, actual_load: null },
  ];
  const exposures = buildCapacityExposures(baseInput({ setOutcomes: sets }));
  const e = exposures.find((x) => x.construct.exId === "heavy_calf_raise")!;
  assertEqual(e.construct.performanceUnit, "reps", "reps unit");
  assertEqual(
    e.actual,
    [
      { setIndex: 0, outcome: "completed", amount: 12, load: null },
      { setIndex: 1, outcome: "completed", amount: 12, load: null },
      { setIndex: 2, outcome: "completed", amount: 8, load: null },
    ],
    "exact real per-set vector preserved — [12,12,8], never collapsed to 8 (min) or 10.67 (avg)"
  );
});

test("isometric exercise: the SAME numeric column represents hold-seconds, discriminated only by loading_profile", () => {
  const sets: RawSetOutcomeRow[] = [
    { exercise_id: "isometric_hold", set_index: 0, outcome: "completed", prescribed_reps: 45, prescribed_load: null, actual_reps: 50, actual_load: null },
  ];
  const exposures = buildCapacityExposures(baseInput({ setOutcomes: sets }));
  const e = exposures.find((x) => x.construct.exId === "isometric_hold")!;
  assertEqual(e.construct.performanceUnit, "hold_seconds", "hold_seconds unit — same actual_reps column, different meaning");
  assertEqual(e.actual[0].amount, 50, "value is seconds, not reps, for this construct");
});

test("nonnumeric dosage exercise: still constructed (mechanical performance remains factual), but marked unrepresentable", () => {
  const exposures = buildCapacityExposures(baseInput());
  const e = exposures.find((x) => x.construct.exId === "stretch")!;
  assertEqual(e.construct.performanceUnit, "unrepresentable", "range/hold-string dosage never parsed into a number");
  assert(e !== undefined, "exposure still exists");
});

test("set vector preserves order by set_index, regardless of input array order", () => {
  const sets: RawSetOutcomeRow[] = [
    { exercise_id: "heavy_calf_raise", set_index: 2, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 8, actual_load: null },
    { exercise_id: "heavy_calf_raise", set_index: 0, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 12, actual_load: null },
    { exercise_id: "heavy_calf_raise", set_index: 1, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 10, actual_load: null },
  ];
  const exposures = buildCapacityExposures(baseInput({ setOutcomes: sets }));
  const e = exposures.find((x) => x.construct.exId === "heavy_calf_raise")!;
  assertEqual(e.actual.map((s) => s.amount), [12, 10, 8], "ordered by setIndex 0,1,2 regardless of row order");
});

test("skipped sets remain explicitly skipped: actual amount/load stay null, never become zero", () => {
  const sets: RawSetOutcomeRow[] = [
    { exercise_id: "heavy_calf_raise", set_index: 0, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 10, actual_load: null },
    { exercise_id: "heavy_calf_raise", set_index: 1, outcome: "skipped", prescribed_reps: 10, prescribed_load: null, actual_reps: null, actual_load: null },
    { exercise_id: "heavy_calf_raise", set_index: 2, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 10, actual_load: null },
  ];
  const exposures = buildCapacityExposures(baseInput({ setOutcomes: sets }));
  const e = exposures.find((x) => x.construct.exId === "heavy_calf_raise")!;
  assertEqual(e.actual[1].outcome, "skipped", "outcome preserved");
  assertEqual(e.actual[1].amount, null, "never coerced to 0");
  // Prescribed side still shows the set was prescribed (10), regardless of
  // whether it was actually performed.
  assertEqual(e.prescribed[1].amount, 10, "prescribed amount recorded even for a skipped set");
});

test("set-level reps/load pairing preserved exactly as recorded (never reordered across sets)", () => {
  const sets: RawSetOutcomeRow[] = [
    { exercise_id: "heavy_calf_raise", set_index: 0, outcome: "completed", prescribed_reps: 10, prescribed_load: 20, actual_reps: 10, actual_load: 20 },
    { exercise_id: "heavy_calf_raise", set_index: 1, outcome: "completed", prescribed_reps: 10, prescribed_load: 20, actual_reps: 10, actual_load: 22 },
    { exercise_id: "heavy_calf_raise", set_index: 2, outcome: "completed", prescribed_reps: 10, prescribed_load: 20, actual_reps: 8, actual_load: 22 },
  ];
  const exposures = buildCapacityExposures(baseInput({ setOutcomes: sets }));
  const e = exposures.find((x) => x.construct.exId === "heavy_calf_raise")!;
  assertEqual(
    e.actual,
    [
      { setIndex: 0, outcome: "completed", amount: 10, load: 20 },
      { setIndex: 1, outcome: "completed", amount: 10, load: 22 },
      { setIndex: 2, outcome: "completed", amount: 8, load: 22 },
    ],
    "each set's own reps paired with that SAME set's own load — never independently sorted"
  );
});

test("UNKNOWN != ZERO: no exercise records a load value -> load stays null per set, never coerced to 0", () => {
  const sets: RawSetOutcomeRow[] = [
    { exercise_id: "heavy_calf_raise", set_index: 0, outcome: "completed", prescribed_reps: 10, prescribed_load: null, actual_reps: 10, actual_load: null },
  ];
  const exposures = buildCapacityExposures(baseInput({ setOutcomes: sets }));
  const e = exposures.find((x) => x.construct.exId === "heavy_calf_raise")!;
  assertEqual(e.actual[0].load, null, "load stays null, never 0");
  assertEqual(e.prescribed[0].load, null, "prescribed load also stays null");
});

test("isSuccessfulExposure is applied uniformly to every exercise in the session (tolerance is session-level, not per-exercise)", () => {
  const exposures = buildCapacityExposures(baseInput({ toleranceClassification: "caution", immediateGuidance: "maintain" }));
  assert(exposures.every((e) => e.isSuccessfulExposure === true), "every exposure in this session shares the session-level qualification");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
