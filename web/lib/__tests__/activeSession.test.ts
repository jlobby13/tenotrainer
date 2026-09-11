// Milestone 6, Stage 2 founder-acceptance patch — regression coverage for
// getPrescribedSet()'s prescribed-dosage semantic fix. Previously ran
// parseFloat() on reps_or_hold_time, silently turning a hold duration or a
// rep range's lower bound into a fabricated "prescribed reps" number that
// could be recorded as real actual performance via the one-tap "Complete
// Set" button. Now: non-null reps ONLY for a genuine plain numeric rep
// count; every other dosage shape returns null, never a guessed number.
import { getPrescribedSet } from "../activeSession";
import type { SessionExercise } from "../fastapi";

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

function exerciseWith(dosage: Record<string, unknown>): SessionExercise {
  return {
    exercise: {
      ex_id: "ex_test",
      name: "Test Exercise",
      category: "test",
      loading_profile: "test",
      setup_instructions: null,
      execution_cues: [],
      patient_facing_explanation: null,
    },
    reason: "test fixture",
    dosage,
  };
}

test("A. plain numeric rep count -> reps mirrored exactly, never re-parsed", () => {
  const result = getPrescribedSet(exerciseWith({ reps_or_hold_time: 12 }));
  assertEqual(result.reps, 12, "reps");
});

test("B. rep-range string ('8-12') -> null, never collapsed to the lower bound (8)", () => {
  const result = getPrescribedSet(exerciseWith({ reps_or_hold_time: "8-12" }));
  assertEqual(result.reps, null, "reps");
});

test("C. hold-duration string ('45s hold') -> null, never treated as 45 reps", () => {
  const result = getPrescribedSet(exerciseWith({ reps_or_hold_time: "45s hold" }));
  assertEqual(result.reps, null, "reps");
});

test("D. duration-range string ('30-45s hold') -> null, never collapsed to 30", () => {
  const result = getPrescribedSet(exerciseWith({ reps_or_hold_time: "30-45s hold" }));
  assertEqual(result.reps, null, "reps");
});

test("E. free-form duration string ('20 min total (1 min jog : 2 min walk)') -> null, never an unrelated leading number", () => {
  const result = getPrescribedSet(exerciseWith({ reps_or_hold_time: "20 min total (1 min jog : 2 min walk)" }));
  assertEqual(result.reps, null, "reps");
});

test("F. missing dosage entirely -> reps null, no crash", () => {
  const result = getPrescribedSet(exerciseWith({}));
  assertEqual(result.reps, null, "reps");
});

test("G. missing dosage object on the exercise itself -> reps null, no crash", () => {
  const ex = exerciseWith({});
  // @ts-expect-error — simulating a genuinely absent dosage at runtime
  ex.dosage = undefined;
  const result = getPrescribedSet(ex);
  assertEqual(result.reps, null, "reps");
});

test("H. load_kg numeric -> mirrored; load_kg absent (every current exercise) -> undefined, never guessed", () => {
  assertEqual(getPrescribedSet(exerciseWith({ reps_or_hold_time: 12, load_kg: 5 })).load, 5, "load present");
  assertEqual(getPrescribedSet(exerciseWith({ reps_or_hold_time: 12 })).load, undefined, "load absent");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
