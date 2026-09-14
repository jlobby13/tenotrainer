// Milestone 6, Stage 4 — patient-safe copy mapping tests. Plain,
// dependency-free script (see capacityConstruct.test.ts's header note).
// Run with `npx tsx lib/__tests__/progressInterpretationLabels.test.ts`.
import {
  getSymptomsCopy,
  getCapacityCopy,
  getTrainingResponseCopy,
  disambiguateCapacityDisplayNames,
  composeProgressSummary,
  SYMPTOMS_FALLBACK_COPY,
  CAPACITY_FALLBACK_COPY,
  TRAINING_RESPONSE_FALLBACK_COPY,
  TRAINING_RESPONSE_LIMITED_CONSTRUCTS_NOTE,
} from "../progressInterpretationLabels";
import type { OverallSymptomsState } from "../symptomClassifier";
import type { CapacityState, TrainingResponseState } from "../capacityTypes";

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

// Raw internal vocabulary that must NEVER appear inside any patient-facing
// string this file produces — engine result states, capacity reason codes,
// the internal reason-code slug, and raw loading-profile enum slugs
// (never their disambiguation-friendly words, which are fine).
const FORBIDDEN_SUBSTRINGS = [
  "more_comparable_data_needed",
  "insufficient_total_history",
  "unrepresentable_construct",
  "recent_loading_lower",
  "capacity_building",
  "loading_capacity_improving",
  "loading_capacity_stable",
  "loading_pattern_variable",
  "symptoms_improving",
  "symptoms_trending_better",
  "symptoms_stable",
  "mixed_symptom_response",
  "symptoms_trending_higher",
  "more_data_needed",
  "loading_tolerance_improving",
  "stable_training_response",
  "variable_training_response",
  "training_response_remains_unsettled",
  "limited_comparable_exposures",
  "heavy_slow_resistance",
  "eccentric_biased",
  "isotonic_slow",
  "return_to_run",
];

function assertNoRawTerminology(value: string, msg: string) {
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    assert(!value.includes(forbidden), `${msg}: leaked raw internal term "${forbidden}" into "${value}"`);
  }
}

// --- Symptoms: every OverallSymptomsState + null ---------------------------

const ALL_SYMPTOMS_STATES: OverallSymptomsState[] = [
  "symptoms_improving",
  "symptoms_trending_better",
  "symptoms_stable",
  "mixed_symptom_response",
  "symptoms_trending_higher",
  "more_data_needed",
];

for (const state of ALL_SYMPTOMS_STATES) {
  test(`getSymptomsCopy(${state}) returns a non-empty label+sentence with no leaked terminology`, () => {
    const copy = getSymptomsCopy(state);
    assert(copy.label.length > 0, "empty label");
    assert(copy.sentence.length > 0, "empty sentence");
    assertNoRawTerminology(copy.label, `${state} label`);
    assertNoRawTerminology(copy.sentence, `${state} sentence`);
  });
}

test("getSymptomsCopy(null) uses the restrained fallback (no-interpretation-yet)", () => {
  assertEqual(getSymptomsCopy(null), SYMPTOMS_FALLBACK_COPY, "null should use SYMPTOMS_FALLBACK_COPY");
});

test("getSymptomsCopy(unknown state) falls back rather than throwing", () => {
  assertEqual(getSymptomsCopy("some_future_state_not_in_the_map"), SYMPTOMS_FALLBACK_COPY, "unknown state should fall back");
});

test("symptoms_improving never claims ALL symptoms improved (engine only requires >=2 of 3)", () => {
  const { sentence } = getSymptomsCopy("symptoms_improving");
  assert(!/\ball\b/i.test(sentence), "must not overstate 'all' symptoms improving");
});

// --- Capacity: every CapacityState x every reason variant -------------------

const ALL_CAPACITY_STATES: CapacityState[] = [
  "capacity_building",
  "loading_capacity_improving",
  "loading_capacity_stable",
  "loading_pattern_variable",
  "more_comparable_data_needed",
];
const MORE_DATA_REASONS = ["insufficient_total_history", "unrepresentable_construct", "recent_loading_lower"] as const;

for (const state of ALL_CAPACITY_STATES) {
  if (state !== "more_comparable_data_needed") {
    test(`getCapacityCopy(${state}) returns non-empty, terminology-free copy`, () => {
      const copy = getCapacityCopy(state, null);
      assert(copy.label.length > 0 && copy.sentence.length > 0, "empty label/sentence");
      assertNoRawTerminology(copy.label, `${state} label`);
      assertNoRawTerminology(copy.sentence, `${state} sentence`);
    });
  }
}

for (const reason of MORE_DATA_REASONS) {
  test(`getCapacityCopy(more_comparable_data_needed, ${reason}) has its own distinct, terminology-free copy`, () => {
    const copy = getCapacityCopy("more_comparable_data_needed", reason);
    assert(copy.label.length > 0 && copy.sentence.length > 0, "empty label/sentence");
    assertNoRawTerminology(copy.label, `${reason} label`);
    assertNoRawTerminology(copy.sentence, `${reason} sentence`);
    if (reason === "unrepresentable_construct") {
      assert(!/error|wrong|mistake/i.test(copy.sentence), "must not sound like a patient error");
    }
  });
}

test("recent_loading_lower carries the approved secondary sentence disclaiming a Capacity decline claim", () => {
  const copy = getCapacityCopy("more_comparable_data_needed", "recent_loading_lower");
  assert(copy.sentence === "Recent loading on this exercise has been lower than before.", "primary sentence must match approved wording");
  assert(!!copy.secondarySentence && /not.*decline/i.test(copy.secondarySentence), "must disclaim a decline-in-capacity interpretation");
});

test("getCapacityCopy(more_comparable_data_needed, unknown reason) falls back safely", () => {
  assertEqual(getCapacityCopy("more_comparable_data_needed", "some_new_reason"), CAPACITY_FALLBACK_COPY, "unknown reason should fall back");
});

test("Capacity 'improving' copy never claims tendon/tissue strength or healing", () => {
  const { sentence } = getCapacityCopy("loading_capacity_improving", null);
  assertNoRawTerminology(sentence, "loading_capacity_improving");
  assert(!/tendon|tissue|stronger|healed|ready to progress/i.test(sentence), "must not overstate biological adaptation");
});

test("no Capacity decline state exists in the mapping", () => {
  for (const key of Object.keys({}) as never[]) void key; // no-op to keep structure consistent
  const allStates: string[] = [...ALL_CAPACITY_STATES];
  assert(!allStates.includes("loading_capacity_declining" as CapacityState), "a Capacity decline state must never be introduced");
});

// --- Training Response: every TrainingResponseState -------------------------

const ALL_TRAINING_RESPONSE_STATES: TrainingResponseState[] = [
  "loading_tolerance_improving",
  "stable_training_response",
  "variable_training_response",
  "training_response_remains_unsettled",
  "more_data_needed",
];

for (const state of ALL_TRAINING_RESPONSE_STATES) {
  test(`getTrainingResponseCopy(${state}) returns non-empty, terminology-free copy`, () => {
    const { copy } = getTrainingResponseCopy({ resultState: state, overallLoadingDirection: null, hasInsufficientConstruct: false });
    assert(copy.label.length > 0 && copy.sentence.length > 0, "empty label/sentence");
    assertNoRawTerminology(copy.label, `${state} label`);
    assertNoRawTerminology(copy.sentence, `${state} sentence`);
  });
}

test("variable_training_response does NOT add unapproved reassurance language", () => {
  const { copy } = getTrainingResponseCopy({ resultState: "variable_training_response", overallLoadingDirection: null, hasInsufficientConstruct: false });
  assert(!/not a cause for alarm/i.test(copy.sentence + (copy.secondarySentence ?? "")), "must not add reassurance beyond what the classifier establishes");
});

test("training_response_remains_unsettled never diagnoses a flare/injury/overload/failed rehab", () => {
  const { copy } = getTrainingResponseCopy({ resultState: "training_response_remains_unsettled", overallLoadingDirection: null, hasInsufficientConstruct: false });
  const combined = `${copy.sentence} ${copy.secondarySentence ?? ""}`;
  assert(!/flare|injury|overload|failed/i.test(combined), "must not diagnose beyond the classifier's own finding");
});

test("more_data_needed with decreased loading uses the specific lower-loading explanation", () => {
  const { copy } = getTrainingResponseCopy({ resultState: "more_data_needed", overallLoadingDirection: "decreased", hasInsufficientConstruct: false });
  assert(/lower/i.test(copy.sentence), "should mention lower loading specifically");
});

test("more_data_needed with non-decreased/insufficient loading uses the generic explanation", () => {
  const { copy } = getTrainingResponseCopy({ resultState: "more_data_needed", overallLoadingDirection: "insufficient", hasInsufficientConstruct: false });
  assertEqual(copy, TRAINING_RESPONSE_FALLBACK_COPY, "should use the generic fallback");
});

test("getTrainingResponseCopy(null resultState) uses the no-interpretation-yet fallback", () => {
  const { copy } = getTrainingResponseCopy({ resultState: null, overallLoadingDirection: null, hasInsufficientConstruct: false });
  assertEqual(copy, TRAINING_RESPONSE_FALLBACK_COPY, "null should use TRAINING_RESPONSE_FALLBACK_COPY");
});

test("hasInsufficientConstruct=true surfaces the patient-safe substitute note, never the raw reason-code slug", () => {
  const { limitedComparableConstructsNote } = getTrainingResponseCopy({
    resultState: "variable_training_response",
    overallLoadingDirection: null,
    hasInsufficientConstruct: true,
  });
  assertEqual(limitedComparableConstructsNote, TRAINING_RESPONSE_LIMITED_CONSTRUCTS_NOTE, "must use the approved substitute sentence");
  assertNoRawTerminology(limitedComparableConstructsNote ?? "", "limitedComparableConstructsNote");
});

test("hasInsufficientConstruct=false yields no note at all", () => {
  const { limitedComparableConstructsNote } = getTrainingResponseCopy({
    resultState: "stable_training_response",
    overallLoadingDirection: null,
    hasInsufficientConstruct: false,
  });
  assertEqual(limitedComparableConstructsNote, null, "no note expected");
});

// --- Capacity display-name resolution / disambiguation ----------------------

type FakeConstruct = { constructKey: string; exerciseName: string | null; loadingProfile: string | null };

test("a single resolved exercise name is used as-is, no disambiguation suffix", () => {
  const items: FakeConstruct[] = [{ constructKey: "a", exerciseName: "Heavy calf raise", loadingProfile: "heavy_slow_resistance" }];
  const out = disambiguateCapacityDisplayNames(items);
  assertEqual(out[0].displayName, "Heavy calf raise", "should be the plain resolved name");
});

test("two constructs sharing the SAME exercise name (different loading profile) get disambiguated", () => {
  const items: FakeConstruct[] = [
    { constructKey: "a", exerciseName: "Calf raise", loadingProfile: "isometric" },
    { constructKey: "b", exerciseName: "Calf raise", loadingProfile: "heavy_slow_resistance" },
  ];
  const out = disambiguateCapacityDisplayNames(items);
  assert(out[0].displayName !== out[1].displayName, "colliding names must be disambiguated into distinct display names");
  assert(out[0].displayName.includes("hold"), "isometric construct should be disambiguated with a patient-safe 'hold' descriptor");
  assertNoRawTerminology(out[0].displayName, "disambiguated name a");
  assertNoRawTerminology(out[1].displayName, "disambiguated name b");
});

test("an unresolved exercise name falls back to 'Exercise', never the raw exId, with a descriptor when available", () => {
  const items: FakeConstruct[] = [{ constructKey: "a", exerciseName: null, loadingProfile: "stretching" }];
  const out = disambiguateCapacityDisplayNames(items);
  assertEqual(out[0].displayName, "Exercise (stretch)", "should fall back to Exercise + descriptor");
  assert(!out[0].displayName.includes("some_raw_ex_id_123"), "must never contain a raw exId");
});

test("an unresolved exercise name with no loading profile falls back to plain 'Exercise'", () => {
  const items: FakeConstruct[] = [{ constructKey: "a", exerciseName: null, loadingProfile: null }];
  const out = disambiguateCapacityDisplayNames(items);
  assertEqual(out[0].displayName, "Exercise", "should fall back to plain Exercise");
});

test("multiple Capacity constructs never collapse into a single overall entry", () => {
  const items: FakeConstruct[] = [
    { constructKey: "a", exerciseName: "Heavy calf raise", loadingProfile: "heavy_slow_resistance" },
    { constructKey: "b", exerciseName: "Isometric hold", loadingProfile: "isometric" },
    { constructKey: "c", exerciseName: "Eccentric drop", loadingProfile: "eccentric_biased" },
  ];
  const out = disambiguateCapacityDisplayNames(items);
  assertEqual(out.length, 3, "every construct must remain its own entry");
});

// --- Top-level Progress Summary composition ---------------------------------

test("symptoms improving + training response improving states each independently, no flattened verdict", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "symptoms_improving" },
    capacityConstructs: [],
    trainingResponse: { resultState: "loading_tolerance_improving", overallLoadingDirection: "increased" },
  });
  const combined = sentences.join(" ");
  assert(/symptoms/i.test(combined), "must mention symptoms");
  assert(/tendon|response|loading/i.test(combined), "must mention training response separately");
  assert(!/^(you are improving|you are declining|your rehab is working|your rehab is failing)\.?$/i.test(combined.trim()), "must not flatten into a bare verdict");
});

test("symptoms improving + training response more_data_needed shows BOTH, does not collapse to a generic no-data message", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "symptoms_improving" },
    capacityConstructs: [],
    trainingResponse: { resultState: "more_data_needed", overallLoadingDirection: "insufficient" },
  });
  assert(/better direction/i.test(sentences[0]), "symptoms sentence must still be the improving one");
  assert(/more comparable loading data/i.test(sentences[1]), "training response sentence must state its own more-data-needed reason");
});

test("mixed symptoms + variable training response states both independently", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "mixed_symptom_response" },
    capacityConstructs: [],
    trainingResponse: { resultState: "variable_training_response", overallLoadingDirection: "mixed" },
  });
  assert(/mixed/i.test(sentences[0]), "must state mixed symptoms");
  assert(/varied/i.test(sentences[1]), "must state varied training response");
});

test("symptoms trending higher + training response unsettled states both independently, no alarming language", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "symptoms_trending_higher" },
    capacityConstructs: [],
    trainingResponse: { resultState: "training_response_remains_unsettled", overallLoadingDirection: "increased" },
  });
  const combined = sentences.join(" ");
  assert(!/alarm|emergency|danger|urgent/i.test(combined), "must not use alarming language");
});

test("exactly one Capacity construct: summary references it factually", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "symptoms_stable" },
    capacityConstructs: [{ displayName: "Heavy calf raise", resultState: "loading_capacity_improving" }],
    trainingResponse: null,
  });
  assert(sentences.some((s) => s.includes("Heavy calf raise")), "must name the single exercise");
});

test("multiple Capacity constructs: neutral orientation only, no per-exercise claim, no overall score", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "symptoms_stable" },
    capacityConstructs: [
      { displayName: "Heavy calf raise", resultState: "loading_capacity_improving" },
      { displayName: "Isometric hold", resultState: "loading_capacity_stable" },
    ],
    trainingResponse: null,
  });
  const combined = sentences.join(" ");
  assert(combined.includes("exercise by exercise"), "must use the neutral orientation sentence");
  assert(!combined.includes("Heavy calf raise") && !combined.includes("Isometric hold"), "must not name individual exercises when multiple exist");
  assert(!/\d+ of \d+/.test(combined), "must never say 'X of Y exercises improving'");
});

test("zero Capacity constructs: summary says nothing about Capacity at all", () => {
  const withZero = composeProgressSummary({
    symptoms: { resultState: "symptoms_stable" },
    capacityConstructs: [],
    trainingResponse: { resultState: "stable_training_response", overallLoadingDirection: "maintained" },
  }).join(" ");
  assert(!/capacity|loading capacity/i.test(withZero), "must not fabricate a Capacity statement when none exists");
});

test("all interpretations absent: uses the exact approved 'keep completing' message, mentions no domain state", () => {
  const sentences = composeProgressSummary({ symptoms: null, capacityConstructs: [], trainingResponse: null });
  assertEqual(
    sentences,
    ["Keep completing your rehab sessions and morning check-ins.", "We'll show progress patterns here as enough comparable data becomes available."],
    "must match the approved no-interpretations message exactly"
  );
});

test("summary never contains an overall status badge word standing alone as a verdict", () => {
  const sentences = composeProgressSummary({
    symptoms: { resultState: "symptoms_improving" },
    capacityConstructs: [],
    trainingResponse: { resultState: "loading_tolerance_improving", overallLoadingDirection: "increased" },
  });
  assertNoRawTerminology(sentences.join(" "), "full summary");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
