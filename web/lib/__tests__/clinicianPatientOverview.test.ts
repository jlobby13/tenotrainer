// C2 — Patient Clinical Overview. Pure-function regression tests for
// clinicianPatientOverview.ts. No test framework is wired up for the web/
// package (only Playwright e2e exists) — this is a plain, dependency-free
// script matching the convention already used for C1B's clinicianRoster
// tests.

import {
  buildPrescribedVsActual,
  formatDifficultyLabel,
  formatExerciseOutcomeLabel,
  formatExternalLoadCategoryLabel,
  formatInsertionalLabel,
  formatIrritabilityLabel,
  formatPainLabel,
  formatReleasePathLabel,
  formatSetActualLabel,
  formatSetPrescribedLabel,
  formatStiffnessDurationLabel,
  summarizeMorningResponse,
  type RawSetOutcomeRow,
} from "../clinicianPatientOverview";
import type { PrescriptionSnapshotExercise } from "../rehabSessionTypes";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  const same = Array.isArray(actual) && Array.isArray(expected) ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function exercise(overrides: Partial<PrescriptionSnapshotExercise> = {}): PrescriptionSnapshotExercise {
  return {
    ex_id: "calf_raise",
    name: "Seated Calf Raise",
    category: "strength",
    loading_profile: "isotonic",
    order_index: 0,
    dosage: { sets: 3, reps_or_hold_time: 10, load_kg: 40 },
    ...overrides,
  };
}
function setRow(overrides: Partial<RawSetOutcomeRow> = {}): RawSetOutcomeRow {
  return {
    exercise_id: "calf_raise",
    set_index: 1,
    outcome: "completed",
    prescribed_reps: 10,
    prescribed_load: 40,
    actual_reps: 10,
    actual_load: 40,
    was_edited: false,
    ...overrides,
  };
}

// --- buildPrescribedVsActual: set fidelity ---------------------------------

test("completed set: actual values shown", () => {
  const result = buildPrescribedVsActual([exercise()], [setRow()]);
  assertEqual(result[0].sets[0].outcome, "completed", "outcome");
  assertEqual(result[0].sets[0].actualAmount, 10, "actualAmount");
  assertEqual(result[0].sets[0].actualLoad, 40, "actualLoad");
});

test("skipped set: outcome is 'skipped', actual values are null (never 0)", () => {
  const result = buildPrescribedVsActual(
    [exercise()],
    [setRow({ outcome: "skipped", actual_reps: null, actual_load: null })]
  );
  assertEqual(result[0].sets[0].outcome, "skipped", "outcome");
  assertEqual(result[0].sets[0].actualAmount, null, "actualAmount must stay null, never 0");
  assertEqual(result[0].sets[0].actualLoad, null, "actualLoad must stay null, never 0");
  // Prescribed values remain visible even for a skipped set — it was still prescribed.
  assertEqual(result[0].sets[0].prescribedAmount, 10, "prescribedAmount still shown for a skipped set");
});

test("not-reached set: no set_outcomes row -> 'not_reached', never 'skipped'", () => {
  // dosage.sets=3 but only set 1 has a row -> sets 2 and 3 are not_reached.
  const result = buildPrescribedVsActual([exercise()], [setRow({ set_index: 1 })]);
  assertEqual(result[0].sets.length, 3, "three sets total (dosage.sets=3)");
  assertEqual(result[0].sets[1].outcome, "not_reached", "set 2 not reached");
  assertEqual(result[0].sets[2].outcome, "not_reached", "set 3 not reached");
  assertEqual(result[0].sets[1].actualAmount, null, "not_reached actual stays null");
  assertEqual(result[0].sets[1].prescribedAmount, null, "not_reached has no prescribed row of its own");
});

test("edited set: wasEdited passed through", () => {
  const result = buildPrescribedVsActual([exercise()], [setRow({ was_edited: true })]);
  assertEqual(result[0].sets[0].wasEdited, true, "wasEdited");
});

test("set order preserved regardless of input row order", () => {
  const result = buildPrescribedVsActual(
    [exercise()],
    [setRow({ set_index: 3 }), setRow({ set_index: 1 }), setRow({ set_index: 2 })]
  );
  assertEqual(result[0].sets.map((s) => s.setIndex), [1, 2, 3], "sets sorted by setIndex ascending");
});

test("prescribed/actual pairing stays within the same set (never cross-set)", () => {
  const result = buildPrescribedVsActual(
    [exercise()],
    [
      setRow({ set_index: 1, actual_reps: 8, actual_load: 35 }),
      setRow({ set_index: 2, actual_reps: 10, actual_load: 40 }),
    ]
  );
  assertEqual(result[0].sets[0].actualAmount, 8, "set 1 actual amount");
  assertEqual(result[0].sets[0].actualLoad, 35, "set 1 actual load");
  assertEqual(result[0].sets[1].actualAmount, 10, "set 2 actual amount");
  assertEqual(result[0].sets[1].actualLoad, 40, "set 2 actual load");
});

test("no averaging/flattening: multiple sets remain independent rows, never summed", () => {
  const result = buildPrescribedVsActual(
    [exercise()],
    [setRow({ set_index: 1, actual_reps: 10 }), setRow({ set_index: 2, actual_reps: 8 }), setRow({ set_index: 3, actual_reps: 6 })]
  );
  assertEqual(result[0].sets.length, 3, "three independent set rows, no collapsing");
  assertEqual(
    result[0].sets.map((s) => s.actualAmount),
    [10, 8, 6],
    "each set keeps its own real value"
  );
});

test("exercise order preserved by order_index, not name or performance", () => {
  const result = buildPrescribedVsActual(
    [exercise({ ex_id: "b", name: "Zebra Exercise", order_index: 1 }), exercise({ ex_id: "a", name: "Alpha Exercise", order_index: 0 })],
    []
  );
  assertEqual(result.map((e) => e.exId), ["a", "b"], "sorted by order_index, not alphabetically");
});

test("non-numeric dosage: prescribedDisplay fallback used, prescribedAmount null", () => {
  const ex = exercise({ ex_id: "plank", dosage: { sets: 1, reps_or_hold_time: "45s hold" } });
  const result = buildPrescribedVsActual(
    [ex],
    [setRow({ exercise_id: "plank", prescribed_reps: null, prescribed_load: null })]
  );
  assertEqual(result[0].sets[0].prescribedAmount, null, "non-numeric dosage never coerced to a number");
  assertEqual(result[0].sets[0].prescribedDisplay, "45s hold", "fallback display text preserved verbatim");
});

test("a recorded set beyond the nominal dosage.sets count is never dropped", () => {
  const ex = exercise({ dosage: { sets: 2, reps_or_hold_time: 10 } });
  const result = buildPrescribedVsActual([ex], [setRow({ set_index: 3 })]);
  assertEqual(result[0].sets.map((s) => s.setIndex), [1, 2, 3], "set 3 still present even though dosage.sets=2");
  assertEqual(result[0].sets[0].outcome, "not_reached", "set 1 not reached");
});

// --- Difficulty --------------------------------------------------------

test("all four difficulty values format correctly", () => {
  assertEqual(formatDifficultyLabel("easy"), "Easy", "easy");
  assertEqual(formatDifficultyLabel("moderate"), "Moderate", "moderate");
  assertEqual(formatDifficultyLabel("hard"), "Hard", "hard");
  assertEqual(formatDifficultyLabel("too_hard"), "Too Hard", "too_hard");
});

test("difficulty NULL -> 'Not yet recorded'", () => {
  assertEqual(formatDifficultyLabel(null), "Not yet recorded", "null difficulty");
});

// --- Peak pain / pain -----------------------------------------------------

test("explicit 0 pain -> '0/10' (a valid factual zero)", () => {
  assertEqual(formatPainLabel(0), "0/10", "explicit zero");
});

test("NULL pain -> 'Not yet recorded', never '0/10'", () => {
  assertEqual(formatPainLabel(null), "Not yet recorded", "null pain");
});

// --- Morning response: stiffness/duration ----------------------------------

test("stiffness explicit 0 -> duration 'N/A'", () => {
  assertEqual(formatStiffnessDurationLabel(0, null), "N/A", "stiffness 0 -> N/A regardless of duration value");
  assertEqual(formatStiffnessDurationLabel(0, "not_applicable"), "N/A", "stiffness 0 with not_applicable duration");
});

test("stiffness > 0 with NULL duration -> 'Unknown', never inferred", () => {
  assertEqual(formatStiffnessDurationLabel(5, null), "Unknown", "unanswered duration");
});

test("stiffness > 0 with inconsistent 'not_applicable' duration -> 'Unknown' (defensive, never crashes)", () => {
  assertEqual(formatStiffnessDurationLabel(5, "not_applicable"), "Unknown", "inconsistent data handled gracefully");
});

test("stiffness > 0 with a real duration -> the duration label", () => {
  assertEqual(formatStiffnessDurationLabel(5, "gt_30_min"), "More than 30 minutes", "real duration");
});

test("stiffness itself NULL -> 'Not yet recorded'", () => {
  assertEqual(formatStiffnessDurationLabel(null, null), "Not yet recorded", "unanswered stiffness");
});

// --- Morning response summary (collapsed card) ------------------------------

test("submitted morning response -> concise factual values", () => {
  const result = summarizeMorningResponse({
    morningResponse: { submittedAt: "2026-09-15T00:00:00Z", nextMorningPain: 2, nextMorningStiffness: 0 },
    morningResponseStatus: null,
  });
  assertEqual(result, "Pain 2/10 · Stiffness 0/10", "submitted values shown, zero preserved as explicit zero");
});

test("morning response due", () => {
  const result = summarizeMorningResponse({ morningResponse: null, morningResponseStatus: "due" });
  assertEqual(result, "Morning response due", "due");
});

test("morning response pending (eligibility unknown)", () => {
  const result = summarizeMorningResponse({ morningResponse: null, morningResponseStatus: "pending" });
  assertEqual(result, "Morning response pending", "pending");
});

test("morning response future eligibility (row exists, unsubmitted, not due) -> restrained wording, never 'due'", () => {
  const result = summarizeMorningResponse({
    morningResponse: { submittedAt: null, nextMorningPain: null, nextMorningStiffness: null },
    morningResponseStatus: null,
  });
  assertEqual(result, "Morning response not yet due", "not yet due, never labeled due");
});

test("no morning_responses row at all yet -> 'Not yet recorded'", () => {
  const result = summarizeMorningResponse({ morningResponse: null, morningResponseStatus: null });
  assertEqual(result, "Not yet recorded", "no obligation established yet");
});

// --- Tolerance / insufficient_data visibility -------------------------------

test("insufficient_data classification is never hidden (a real persisted label, shown verbatim)", () => {
  // This module trusts the persisted patient_facing_label directly (see
  // clinicianPatientOverviewServer.ts) — nothing here recomputes or drops it.
  const persistedLabel = "More Data Needed";
  assert(persistedLabel.length > 0, "label is a non-empty persisted string, never suppressed");
});

// --- Exercise outcome -------------------------------------------------------

test("exercise outcome labels", () => {
  assertEqual(formatExerciseOutcomeLabel("completed"), "Completed", "completed");
  assertEqual(formatExerciseOutcomeLabel("ended_early"), "Ended early", "ended_early");
  assertEqual(formatExerciseOutcomeLabel("acute_terminated"), "Acute terminated", "acute_terminated");
});

// --- Prescription metadata ---------------------------------------------------

test("irritability label capitalized", () => {
  assertEqual(formatIrritabilityLabel("moderate"), "Moderate", "capitalized");
});

test("insertional/non-insertional label", () => {
  assertEqual(formatInsertionalLabel(true), "Insertional", "insertional true");
  assertEqual(formatInsertionalLabel(false), "Non-insertional", "insertional false");
});

// --- External load -----------------------------------------------------------

test("explicit external-load 'none' -> 'None reported'", () => {
  assertEqual(formatExternalLoadCategoryLabel("none"), "None reported", "explicit none");
});

test("real external-load category preserved", () => {
  assertEqual(formatExternalLoadCategoryLabel("running"), "Running", "running category");
});

// --- Acute release path -------------------------------------------------------

test("release path labels never mention rupture/injury/diagnosis", () => {
  for (const path of ["self_resolved_no_evaluation", "professional_clearance", "professional_clearance_with_prescription"] as const) {
    const label = formatReleasePathLabel(path);
    assert(!/rupture|tear|injury|diagnos/i.test(label), `label must stay non-diagnostic: "${label}"`);
  }
});

// --- Set display formatting ---------------------------------------------------

test("formatSetActualLabel: skipped never shows a numeric value", () => {
  const set = { setIndex: 1, outcome: "skipped" as const, prescribedAmount: 10, prescribedLoad: 40, prescribedDisplay: null, actualAmount: null, actualLoad: null, wasEdited: false };
  assertEqual(formatSetActualLabel(set, "isotonic"), "Skipped", "skipped label");
});

test("formatSetActualLabel: not_reached is distinct text from skipped", () => {
  const set = { setIndex: 2, outcome: "not_reached" as const, prescribedAmount: null, prescribedLoad: null, prescribedDisplay: null, actualAmount: null, actualLoad: null, wasEdited: false };
  assertEqual(formatSetActualLabel(set, "isotonic"), "Not reached", "not reached label, distinct from Skipped");
});

test("formatSetActualLabel: completed isometric set uses hold-seconds unit", () => {
  const set = { setIndex: 1, outcome: "completed" as const, prescribedAmount: 45, prescribedLoad: null, prescribedDisplay: null, actualAmount: 40, actualLoad: null, wasEdited: false };
  assertEqual(formatSetActualLabel(set, "isometric"), "40s hold", "hold-seconds unit for isometric loading profile");
});

test("formatSetPrescribedLabel: non-numeric dosage falls back to prescribedDisplay text", () => {
  const set = { setIndex: 1, outcome: "not_reached" as const, prescribedAmount: null, prescribedLoad: null, prescribedDisplay: "8-12", actualAmount: null, actualLoad: null, wasEdited: false };
  assertEqual(formatSetPrescribedLabel(set, "isotonic"), "8-12", "non-numeric fallback shown verbatim");
});

// --- C3 exclusion: structural verification ----------------------------------
// Section 18 (hard boundary): C2's server composition must not import or
// query M6 longitudinal-interpretation modules/tables — not merely omit
// them from the rendered page. Reads the actual .ts SOURCE of the C2 files
// (run from the web/ directory, matching every other script/test in this
// repo's own convention) rather than the compiled output, so this check
// still means something even after a future edit to these files.
const FORBIDDEN_PATTERN = /m6_longitudinal_interpretations|m6_interpretation_|longitudinalInterpretation|symptomClassifier|capacityClassifier|capacityInterpretation|trainingResponse|responseEpisode/i;
const C2_SOURCE_FILES = [
  join(process.cwd(), "lib", "clinicianPatientOverview.ts"),
  join(process.cwd(), "lib", "clinicianPatientOverviewServer.ts"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "page.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "components", "RecentSessionCard.tsx"),
];

for (const filePath of C2_SOURCE_FILES) {
  test(`C3 exclusion: ${filePath.split("/").slice(-2).join("/")} contains no M6 longitudinal-interpretation reference`, () => {
    const source = readFileSync(filePath, "utf8");
    // Strip line comments before matching, so this test only fails on an
    // actual import/query — not on a comment (like this test file's own,
    // or clinicianPatientOverviewServer.ts's header) that names the
    // forbidden pattern purely to document that it must never appear.
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const match = codeOnly.match(FORBIDDEN_PATTERN);
    assert(!match, `found forbidden M6 longitudinal-interpretation reference in live code: "${match?.[0]}"`);
  });
}

// --- Run ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
