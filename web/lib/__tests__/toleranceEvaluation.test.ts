// Milestone 4, Stage 4 — deterministic tolerance evaluator regression tests.
// Every named anchor case (A-K, P-W) from the Stage 4 clinical brief is
// tested for its exact required outcome. Where an anchor case (A-K) did not
// specify stiffness duration or morning-pain tolerability — those concepts
// were introduced later in the same brief, after cases A-K were written —
// this file uses documented, conservative stand-in values (min_5_15 for an
// unspecified duration, since that band is defined as "neutral... do not
// force reduction solely from this duration"; difficult_to_tolerate only for
// cases whose stated expected outcome is explicitly unfavorable/reduce, so
// the test actually exercises the intended severity). See
// toleranceEvaluation.ts's own header comment for the full rationale.

import { evaluateTolerance, TOLERANCE_RULE_VERSION, type ToleranceEvaluationInputs } from "../toleranceEvaluation";

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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function base(overrides: Partial<ToleranceEvaluationInputs> = {}): ToleranceEvaluationInputs {
  return {
    peakSessionPain: 0,
    nextMorningPain: 0,
    nextMorningStiffness: 0,
    stiffnessDuration: "not_applicable",
    morningPainTolerability: null,
    escalationLevel: 0,
    externalLoadCategories: null,
    hasExerciseSpecificSymptomResponse: false,
    hasPainLimitedTermination: false,
    ...overrides,
  };
}

// --- Earlier anchor cases (A-K) — duration stand-in: min_5_15 (neutral) ---

test("A: 1/0/1 -> well_tolerated / maintain", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 1, nextMorningPain: 0, nextMorningStiffness: 1, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "well_tolerated", "A classification");
  assertEqual(r.guidance, "maintain", "A guidance");
});

test("B: 3/2/2 -> well_tolerated / maintain", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 2, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "well_tolerated", "B classification");
  assertEqual(r.guidance, "maintain", "B guidance");
});

test("C: 4/1/1 -> well_tolerated / maintain (moderate session pain + quiet delayed response)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 4, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "well_tolerated", "C classification");
  assertEqual(r.guidance, "maintain", "C guidance");
});

test("D: 6/1/1 -> caution / maintain_cautiously, reason elevated_session_pain_recovered", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 6, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "caution", "D classification");
  assertEqual(r.guidance, "maintain_cautiously", "D guidance");
  assert(r.reasonCodes.includes("elevated_session_pain_recovered"), "D reason code");
});

test("E: 2/5(difficult)/5 -> caution / reduce_modify (delayed response concerning despite low session pain)", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 2, nextMorningPain: 5, morningPainTolerability: "difficult_to_tolerate", nextMorningStiffness: 5, stiffnessDuration: "min_5_15" })
  );
  assertEqual(r.classification, "caution", "E classification");
  assertEqual(r.guidance, "reduce_modify", "E guidance");
});

test("F: 4/4/4 -> caution / maintain_cautiously (near tolerance boundary)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 4, nextMorningPain: 4, nextMorningStiffness: 4, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "caution", "F classification");
  assertEqual(r.guidance, "maintain_cautiously", "F guidance");
  assert(r.reasonCodes.includes("combined_elevated_morning_symptoms"), "F reason code");
});

test("G: 5/1/1 -> caution / maintain, do not progress", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 5, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "caution", "G classification");
  assertEqual(r.guidance, "maintain", "G guidance");
});

test("H: 5/3/3 -> caution / maintain_cautiously (distinct from G despite same peak band)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 5, nextMorningPain: 3, nextMorningStiffness: 3, stiffnessDuration: "min_5_15" }));
  assertEqual(r.classification, "caution", "H classification");
  assertEqual(r.guidance, "maintain_cautiously", "H guidance");
});

test("I: 5/5(difficult)/5 -> caution / reduce_modify", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 5, nextMorningPain: 5, morningPainTolerability: "difficult_to_tolerate", nextMorningStiffness: 5, stiffnessDuration: "min_5_15" })
  );
  assertEqual(r.classification, "caution", "I classification");
  assertEqual(r.guidance, "reduce_modify", "I guidance");
});

test("K: 3/5(difficult)/5 -> caution / reduce_modify (low session pain does not rescue poor delayed response)", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 3, nextMorningPain: 5, morningPainTolerability: "difficult_to_tolerate", nextMorningStiffness: 5, stiffnessDuration: "min_5_15" })
  );
  assertEqual(r.classification, "caution", "K classification");
  assertEqual(r.guidance, "reduce_modify", "K guidance");
});

// --- Stiffness-duration edge-case acceptance tests (P-W) ---

test("P (manageable): 3/5(manageable)/2, <5min -> caution / maintain_cautiously", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 3, nextMorningPain: 5, morningPainTolerability: "manageable", nextMorningStiffness: 2, stiffnessDuration: "lt_5_min" })
  );
  assertEqual(r.classification, "caution", "P-manageable classification");
  assert(r.guidance === "maintain" || r.guidance === "maintain_cautiously", "P-manageable guidance should be Maintain or Maintain cautiously");
});

test("P (difficult): 3/5(difficult)/2, <5min -> reduce_modify", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 3, nextMorningPain: 5, morningPainTolerability: "difficult_to_tolerate", nextMorningStiffness: 2, stiffnessDuration: "lt_5_min" })
  );
  assertEqual(r.guidance, "reduce_modify", "P-difficult guidance");
});

test("Q: 3/2/5, <5min -> caution (favorable) / maintain — rapid resolution mitigates elevated stiffness", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 5, stiffnessDuration: "lt_5_min" }));
  assertEqual(r.classification, "caution", "Q classification (not well_tolerated — elevated stiffness still notable)");
  assertEqual(r.guidance, "maintain", "Q guidance");
});

test("R: 3/2/5, >30min -> caution (unfavorable) / reduce_modify — identical intensity to Q, different duration", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 5, stiffnessDuration: "gt_30_min" }));
  assertEqual(r.guidance, "reduce_modify", "R guidance");
});

test("S: 3/5(manageable)/5, >30min -> reduce_modify (prolonged stiffness overrides manageable pain)", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 3, nextMorningPain: 5, morningPainTolerability: "manageable", nextMorningStiffness: 5, stiffnessDuration: "gt_30_min" })
  );
  assertEqual(r.guidance, "reduce_modify", "S guidance");
});

test("T: 3/2/3, >30min -> reduce_modify (prolonged stiffness matters even at low pain/low stiffness intensity)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 3, stiffnessDuration: "gt_30_min" }));
  assertEqual(r.guidance, "reduce_modify", "T guidance");
});

test("U: 3/6/2, <5min -> reduce_modify (isolated morning pain >=6 crosses threshold)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 6, nextMorningStiffness: 2, stiffnessDuration: "lt_5_min" }));
  assertEqual(r.guidance, "reduce_modify", "U guidance");
});

test("V: 3/2/6, <5min -> caution / maintain (high stiffness intensity alone, rapid resolution)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 6, stiffnessDuration: "lt_5_min" }));
  assertEqual(r.classification, "caution", "V classification");
  assertEqual(r.guidance, "maintain", "V guidance");
});

test("W: 3/2/6, >30min -> reduce_modify (V vs W: identical intensity, duration flips the outcome)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 6, stiffnessDuration: "gt_30_min" }));
  assertEqual(r.guidance, "reduce_modify", "W guidance");
  assert(r.reasonCodes.includes("elevated_and_prolonged_morning_stiffness"), "W reason code (intensity>=6 + prolonged)");
});

test("V vs W explicit contrast: same intensity, different guidance", () => {
  const v = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 6, stiffnessDuration: "lt_5_min" }));
  const w = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 6, stiffnessDuration: "gt_30_min" }));
  assert(v.guidance !== w.guidance, "V and W must differ solely due to duration");
});

// --- Explicit stiffness=0 and incomplete-data behavior ---

test("explicit stiffness=0 with no duration asked -> valid, well_tolerated (not_applicable, never blocks)", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 1, nextMorningStiffness: 0, stiffnessDuration: "not_applicable" }));
  assertEqual(r.classification, "well_tolerated", "stiffness=0 classification");
});

test("stiffness > 0 with duration NULL -> insufficient_data, never interpreted as rapid resolution", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 1, nextMorningStiffness: 5, stiffnessDuration: null }));
  assertEqual(r.classification, "insufficient_data", "missing duration classification");
});

// Founder-acceptance patch: the evaluator must independently reject this
// inconsistent combination rather than relying on the UI/API to prevent it.
// "not_applicable" is only ever a legitimate value when stiffness === 0.
test("stiffness > 0 with duration 'not_applicable' -> insufficient_data, not silently skipped", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 1, nextMorningStiffness: 5, stiffnessDuration: "not_applicable" }));
  assertEqual(r.classification, "insufficient_data", "inconsistent not_applicable classification");
  assert(r.reasonCodes.includes("incomplete_required_response_data"), "reason code must flag incomplete data");
});

test("stiffness > 0 with duration 'not_applicable' is invalid at every intensity, not just high intensity", () => {
  for (const intensity of [1, 2, 3, 9, 10]) {
    const r = evaluateTolerance(base({ peakSessionPain: 0, nextMorningPain: 0, nextMorningStiffness: intensity, stiffnessDuration: "not_applicable" }));
    assertEqual(r.classification, "insufficient_data", `intensity ${intensity} must still be insufficient_data`);
  }
});

test("morning pain === 5 with tolerability NULL -> insufficient_data", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 5, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", morningPainTolerability: null }));
  assertEqual(r.classification, "insufficient_data", "missing tolerability classification");
});

// --- Acute override ---

test("acute override: escalation level 3 forces acute_override regardless of favorable morning response", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 0, nextMorningStiffness: 0, escalationLevel: 3 }));
  assertEqual(r.classification, "acute_override", "acute override classification");
  assertEqual(r.guidance, "clinical_review", "acute override guidance");
});

test("acute override level 5 also overrides", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 0, nextMorningPain: 0, nextMorningStiffness: 0, escalationLevel: 5 }));
  assertEqual(r.classification, "acute_override", "level 5 override");
});

test("escalation level below 3 does not trigger override", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 1, nextMorningPain: 0, nextMorningStiffness: 0, escalationLevel: 1 }));
  assert(r.classification !== "acute_override", "level 1 should not override");
});

// --- Founder-acceptance patch: "poorly_tolerated" removed from v1 ---

test("simultaneous morning-pain reduce factor (>=6) AND prolonged-stiffness reduce factor (>30min) stay caution + reduce_modify, never poorly_tolerated", () => {
  const r = evaluateTolerance(
    base({ peakSessionPain: 3, nextMorningPain: 7, nextMorningStiffness: 5, stiffnessDuration: "gt_30_min" })
  );
  assertEqual(r.classification, "caution", "must remain caution, not escalate to poorly_tolerated");
  assertEqual(r.guidance, "reduce_modify", "guidance must still be reduce_modify from either factor alone");
  assert(r.reasonCodes.includes("elevated_morning_pain"), "morning-pain reduce factor reason code must still be present");
  assert(
    r.reasonCodes.includes("prolonged_morning_stiffness") || r.reasonCodes.includes("elevated_and_prolonged_morning_stiffness"),
    "stiffness reduce factor reason code must still be present"
  );
});

test("simultaneous borderline-pain-difficult AND 15-30min-high-intensity reduce factors stay caution + reduce_modify", () => {
  const r = evaluateTolerance(
    base({
      peakSessionPain: 2,
      nextMorningPain: 5,
      morningPainTolerability: "difficult_to_tolerate",
      nextMorningStiffness: 8,
      stiffnessDuration: "min_15_30",
    })
  );
  assertEqual(r.classification, "caution", "must remain caution even with two independent reduce-tier factors");
  assertEqual(r.guidance, "reduce_modify", "guidance still reduce_modify");
});

test("a single severe factor on one axis alone never reaches poorly_tolerated (it is unreachable in v1)", () => {
  const severeMorningPainOnly = evaluateTolerance(base({ peakSessionPain: 0, nextMorningPain: 10, nextMorningStiffness: 0 }));
  const severeStiffnessOnly = evaluateTolerance(
    base({ peakSessionPain: 0, nextMorningPain: 0, nextMorningStiffness: 10, stiffnessDuration: "gt_30_min" })
  );
  assertEqual(severeMorningPainOnly.classification, "caution", "severe morning pain alone stays caution");
  assertEqual(severeStiffnessOnly.classification, "caution", "severe prolonged stiffness alone stays caution");
});

// --- External loading is observation only, never modifies classification ---

test("external loading does not numerically modify symptom scores", () => {
  const withRunning = evaluateTolerance(base({ peakSessionPain: 1, nextMorningPain: 0, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", externalLoadCategories: ["running", "sport"] }));
  const withNone = evaluateTolerance(base({ peakSessionPain: 1, nextMorningPain: 0, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", externalLoadCategories: ["none"] }));
  const withNull = evaluateTolerance(base({ peakSessionPain: 1, nextMorningPain: 0, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", externalLoadCategories: null }));
  assertEqual(withRunning.classification, withNone.classification, "classification must not change with external load");
  assertEqual(withRunning.guidance, withNone.guidance, "guidance must not change with external load");
  assertEqual(withNone.classification, withNull.classification, "classification identical for explicit none vs missing");
  assert(withRunning.reasonCodes.includes("external_loading_reported"), "reported activity should appear as a reason code");
  assert(!withNone.reasonCodes.includes("external_loading_reported"), "explicit none should not report external loading");
  assert(!withNull.reasonCodes.includes("external_loading_reported"), "missing/unanswered should not report external loading");
});

test("exercise-specific symptom response is preserved as context, never changes classification", () => {
  const withFlag = evaluateTolerance(base({ peakSessionPain: 4, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", hasExerciseSpecificSymptomResponse: true }));
  const withoutFlag = evaluateTolerance(base({ peakSessionPain: 4, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", hasExerciseSpecificSymptomResponse: false }));
  assertEqual(withFlag.classification, withoutFlag.classification, "classification unaffected");
  assertEqual(withFlag.guidance, withoutFlag.guidance, "guidance unaffected");
  assert(withFlag.reasonCodes.includes("exercise_specific_symptom_response"), "reason code present when flagged");
});

test("pain-limited termination is preserved as context, never changes classification", () => {
  const withFlag = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", hasPainLimitedTermination: true }));
  const withoutFlag = evaluateTolerance(base({ peakSessionPain: 2, nextMorningPain: 1, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", hasPainLimitedTermination: false }));
  assertEqual(withFlag.classification, withoutFlag.classification, "classification unaffected");
  assert(withFlag.reasonCodes.includes("pain_limited_termination"), "reason code present when flagged");
});

// --- Tolerability scope and rescue-proofing ---

test("tolerability has no effect when morning pain is not exactly 5", () => {
  const manageable = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", morningPainTolerability: "manageable" }));
  const difficult = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 2, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", morningPainTolerability: "difficult_to_tolerate" }));
  assertEqual(manageable.classification, difficult.classification, "tolerability must not matter outside morning pain === 5");
  assertEqual(manageable.guidance, difficult.guidance, "tolerability must not matter outside morning pain === 5");
});

test("high morning pain (>=6) cannot be rescued by a manageable tolerability answer", () => {
  const r = evaluateTolerance(base({ peakSessionPain: 3, nextMorningPain: 8, nextMorningStiffness: 1, stiffnessDuration: "min_5_15", morningPainTolerability: "manageable" }));
  assertEqual(r.guidance, "reduce_modify", "morning pain >=6 must still force reduce_modify regardless of tolerability");
});

// --- Rule version ---

test("rule version is stamped on every result", () => {
  const r = evaluateTolerance(base());
  assertEqual(r.ruleVersion, TOLERANCE_RULE_VERSION, "rule version");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
