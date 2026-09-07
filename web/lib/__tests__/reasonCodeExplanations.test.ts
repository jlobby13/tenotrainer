// Milestone 5, Stage 2 — reason-code explanation mapper regression tests.

import { explainReasonCode, selectPrimaryReasonExplanations, EXTERNAL_LOAD_EXPLANATION } from "../reasonCodeExplanations";

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

// --- 13. known reason codes map to approved patient-facing language ---
test("13a. elevated_session_pain_recovered maps to the given example wording", () => {
  assertEqual(
    explainReasonCode("elevated_session_pain_recovered"),
    "Pain was higher during the session but settled by the next morning.",
    "matches the Stage 2 brief's example verbatim"
  );
});

test("13b. prolonged_morning_stiffness maps to the given example wording", () => {
  assertEqual(
    explainReasonCode("prolonged_morning_stiffness"),
    "Morning stiffness lasted longer than the preferred range.",
    "matches the Stage 2 brief's example verbatim"
  );
});

test("13c. elevated_morning_pain maps to the given example wording", () => {
  assertEqual(
    explainReasonCode("elevated_morning_pain"),
    "Morning pain remained elevated after the session.",
    "matches the Stage 2 brief's example verbatim"
  );
});

test("13d. every reason code the v1 evaluator can emit (from toleranceEvaluation.ts) has a mapped explanation", () => {
  const evaluatorCodes = [
    "elevated_session_pain",
    "elevated_session_pain_with_mild_response",
    "elevated_session_pain_recovered",
    "combined_elevated_morning_symptoms",
    "borderline_morning_pain_manageable",
    "borderline_morning_pain_difficult",
    "elevated_morning_pain",
    "elevated_stiffness_rapid_resolution",
    "elevated_stiffness_neutral_duration",
    "elevated_stiffness_moderate_duration",
    "prolonged_morning_stiffness",
    "elevated_and_prolonged_morning_stiffness",
  ];
  for (const code of evaluatorCodes) {
    const text = explainReasonCode(code);
    assert(typeof text === "string" && text.length > 0, `${code} must have a non-empty mapped explanation`);
    assert(!text!.includes("_"), `${code}'s explanation must not leak the raw code name (contains underscore)`);
  }
});

test("13e. explanations never invent causation language", () => {
  const evaluatorCodes = [
    "elevated_session_pain",
    "elevated_session_pain_with_mild_response",
    "elevated_session_pain_recovered",
    "combined_elevated_morning_symptoms",
    "borderline_morning_pain_manageable",
    "borderline_morning_pain_difficult",
    "elevated_morning_pain",
    "elevated_stiffness_rapid_resolution",
    "elevated_stiffness_neutral_duration",
    "elevated_stiffness_moderate_duration",
    "prolonged_morning_stiffness",
    "elevated_and_prolonged_morning_stiffness",
  ];
  for (const code of evaluatorCodes) {
    const text = explainReasonCode(code)!.toLowerCase();
    assert(!text.includes("cause"), `${code}: must not claim causation`);
    assert(!text.includes("damage"), `${code}: must not say damage`);
    assert(!text.includes("unsafe"), `${code}: must not say unsafe`);
  }
});

// --- 14. unknown reason code fails safely ---
test("14a. an unrecognized reason code returns null rather than invented text", () => {
  assertEqual(explainReasonCode("some_future_rule_version_code_v99"), null, "unknown code -> null, never fabricated");
});

test("14b. selectPrimaryReasonExplanations omits an unknown code entirely rather than inventing a placeholder", () => {
  const result = selectPrimaryReasonExplanations(["elevated_morning_pain", "totally_unknown_code"]);
  assertEqual(result, ["Morning pain remained elevated after the session."], "unknown code silently omitted, known one still shown");
});

test("14c. selectPrimaryReasonExplanations returns an empty array (not an error) when nothing is recognized", () => {
  assertEqual(selectPrimaryReasonExplanations(["totally_unknown_a", "totally_unknown_b"]), [], "no explanations, no crash, no invented text");
});

test("14d. selectPrimaryReasonExplanations caps at maxCount even with many known codes present", () => {
  const result = selectPrimaryReasonExplanations(
    ["prolonged_morning_stiffness", "elevated_morning_pain", "elevated_session_pain_recovered", "combined_elevated_morning_symptoms"],
    2
  );
  assertEqual(result.length, 2, "capped at the requested max, prioritizing the most clinically useful");
  assertEqual(
    result,
    ["Morning stiffness lasted longer than the preferred range.", "Morning pain remained elevated after the session."],
    "the two highest-priority explanations are chosen, not an arbitrary pair"
  );
});

test("14e. selectPrimaryReasonExplanations never duplicates identical explanation text", () => {
  // prolonged_morning_stiffness and elevated_stiffness_moderate_duration
  // happen to share wording in this map — dedupe must still apply.
  const result = selectPrimaryReasonExplanations(["prolonged_morning_stiffness", "elevated_stiffness_moderate_duration"], 2);
  assertEqual(result.length, 1, "identical text is not shown twice");
});

// --- 15. external-load explanation remains contextual/non-causal ---
test("15. external-load explanation says 'may have contributed', never 'caused'", () => {
  const lower = EXTERNAL_LOAD_EXPLANATION.toLowerCase();
  assert(lower.includes("may have contributed"), "uses the required non-causal framing");
  assert(!lower.includes("caused"), "never states causation");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
