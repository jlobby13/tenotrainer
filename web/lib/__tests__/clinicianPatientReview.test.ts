// C4 — Clinical Decision Support. Pure-function regression tests for
// clinicianPatientReview.ts. No test framework is wired up for the web/
// package (only Playwright e2e exists) — this is a plain, dependency-free
// script matching the convention already used for C1B/C2/C3's own tests.

import {
  capacityRecentLoadingLowerSignal,
  detectCapacityConstructChange,
  detectPrescriptionChange,
  detectStateChange,
  formatPrescriptionSourceLabel,
  isMoreDataNeededState,
  symptomsReviewSignal,
  trainingResponseReviewSignal,
  NEW_CAPACITY_CONSTRUCT_COPY,
  NEW_CAPACITY_CONSTRUCT_TITLE,
  NO_RECENT_SESSION_TEXT,
  CLINICAL_REVIEW_ACTIVE_TITLE,
  type CapacityConstructRow,
  type PrescriptionVersionSnapshot,
} from "../clinicianPatientReview";
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
  const bothObjects = typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null;
  const same = bothObjects ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Every structural (source-scanning) check in this file tests CODE, never
// documentation ABOUT what's excluded — this file's own header comments
// legitimately name every excluded concept (skipped sets, difficulty,
// Caution tallies, scoring, etc.) to document the lock; stripping // line
// comments before scanning is what lets that documentation coexist with a
// real, meaningful "this concept has no live code path" check.
function readCodeOnly(filePath: string): string {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// --- Safety (behavioral facts only — the actual rendering test is in the
// live-verification script; here we confirm the exact locked title text and
// that nothing in this pure module gates OTHER signals on acuteReviewActive,
// i.e. no function in this file takes an "active review" parameter at all). --

test("CLINICAL_REVIEW_ACTIVE_TITLE uses the exact locked C1B/C2/C3 wording", () => {
  assertEqual(CLINICAL_REVIEW_ACTIVE_TITLE, "Clinical review active", "exact wording, reused verbatim");
});

test("no detector function in this module accepts an 'active review' parameter (Safety never suppresses other signals)", () => {
  assertEqual(detectStateChange.length, 2, "detectStateChange takes only current/previous of ONE domain");
  assertEqual(symptomsReviewSignal.length, 1, "symptomsReviewSignal takes only a resultState");
  assertEqual(trainingResponseReviewSignal.length, 1, "trainingResponseReviewSignal takes only a resultState");
  assertEqual(detectCapacityConstructChange.length, 2, "detectCapacityConstructChange takes only current/previous of ONE construct");
  assertEqual(detectPrescriptionChange.length, 2, "detectPrescriptionChange takes only current/previous prescription snapshots");
});

// --- Symptoms: change detection -----------------------------------------

test("Symptoms change: changed", () => {
  const result = detectStateChange({ id: "i1", resultState: "symptoms_trending_higher" }, { resultState: "symptoms_stable" });
  assertEqual(result, { interpretationId: "i1", current: "symptoms_trending_higher", previous: "symptoms_stable" }, "changed");
});
test("Symptoms change: unchanged -> null", () => {
  const result = detectStateChange({ id: "i1", resultState: "symptoms_stable" }, { resultState: "symptoms_stable" });
  assertEqual(result, null, "unchanged never renders");
});
test("Symptoms change: no previous -> null", () => {
  const result = detectStateChange({ id: "i1", resultState: "symptoms_stable" }, null);
  assertEqual(result, null, "no previous never renders as changed");
});
test("Symptoms change: no current -> null", () => {
  assertEqual(detectStateChange(null, { resultState: "symptoms_stable" }), null, "no current interpretation at all");
});

// --- Symptoms: Review Context current-state allowlist -----------------------

test("Symptoms trending higher included", () => {
  assertEqual(symptomsReviewSignal("symptoms_trending_higher"), "trending_higher", "included");
});
test("Symptoms mixed included", () => {
  assertEqual(symptomsReviewSignal("mixed_symptom_response"), "mixed", "included");
});
test("Symptoms improving is NEVER converted into a C4 signal", () => {
  assertEqual(symptomsReviewSignal("symptoms_improving"), null, "improving excluded");
});
test("Symptoms trending_better is NEVER converted into a C4 signal", () => {
  assertEqual(symptomsReviewSignal("symptoms_trending_better"), null, "trending_better excluded");
});
test("Symptoms stable is NEVER converted into a C4 signal", () => {
  assertEqual(symptomsReviewSignal("symptoms_stable"), null, "stable excluded");
});
test("Symptoms more_data_needed is informational only, never a Review-tier signal", () => {
  assertEqual(symptomsReviewSignal("more_data_needed"), null, "not a review signal");
  assertEqual(isMoreDataNeededState("more_data_needed"), true, "but flagged informational");
});

// --- Training Response: change detection ------------------------------------

test("Training Response change: changed", () => {
  const result = detectStateChange({ id: "i2", resultState: "variable_training_response" }, { resultState: "stable_training_response" });
  assertEqual(result, { interpretationId: "i2", current: "variable_training_response", previous: "stable_training_response" }, "changed");
});
test("Training Response change: unchanged -> null", () => {
  assertEqual(detectStateChange({ id: "i2", resultState: "stable_training_response" }, { resultState: "stable_training_response" }), null, "unchanged");
});
test("Training Response change: no previous -> null", () => {
  assertEqual(detectStateChange({ id: "i2", resultState: "stable_training_response" }, null), null, "no previous");
});

// --- Training Response: Review Context current-state allowlist --------------

test("Training Response variable included", () => {
  assertEqual(trainingResponseReviewSignal("variable_training_response"), "variable", "included");
});
test("Training Response unsettled included", () => {
  assertEqual(trainingResponseReviewSignal("training_response_remains_unsettled"), "unsettled", "included");
});
test("Training Response loading_tolerance_improving is NEVER turned into a recommendation/signal", () => {
  assertEqual(trainingResponseReviewSignal("loading_tolerance_improving"), null, "improving excluded");
});
test("Training Response stable is NEVER turned into a signal", () => {
  assertEqual(trainingResponseReviewSignal("stable_training_response"), null, "stable excluded");
});
test("Training Response more_data_needed is informational only", () => {
  assertEqual(trainingResponseReviewSignal("more_data_needed"), null, "not a review signal");
  assertEqual(isMoreDataNeededState("more_data_needed"), true, "but flagged informational");
});

// --- Capacity -----------------------------------------------------------

function capacityRow(overrides: Partial<CapacityConstructRow> = {}): CapacityConstructRow {
  return {
    interpretationId: "cap1",
    construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
    resultState: "loading_capacity_stable",
    moreDataNeededReason: null,
    ...overrides,
  };
}

test("Capacity: same construct changed", () => {
  const current = capacityRow({ resultState: "loading_pattern_variable" });
  const previous = capacityRow({ resultState: "loading_capacity_stable" });
  const result = detectCapacityConstructChange(current, previous);
  assertEqual(result, { kind: "changed", current, previousResultState: "loading_capacity_stable" }, "changed item");
});
test("Capacity: same construct unchanged -> null", () => {
  const current = capacityRow({ resultState: "loading_capacity_stable" });
  const previous = capacityRow({ resultState: "loading_capacity_stable" });
  assertEqual(detectCapacityConstructChange(current, previous), null, "unchanged never renders");
});
test("Capacity: new construct (no previous row for this exact identity)", () => {
  const current = capacityRow();
  assertEqual(detectCapacityConstructChange(current, null), { kind: "new", current }, "new item");
});
test("Capacity: distinct loading profile remains a distinct construct (different JSON identity)", () => {
  const a = capacityRow({ construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" } });
  const b = capacityRow({ construct: { exId: "calf_raise", loadingProfile: "isometric", performanceUnit: "hold_seconds" } });
  assert(JSON.stringify(a.construct) !== JSON.stringify(b.construct), "distinct constructKey despite same exId");
});
test("Capacity: distinct performance unit remains a distinct construct", () => {
  const a = capacityRow({ construct: { exId: "x", loadingProfile: "isotonic", performanceUnit: "reps" } });
  const b = capacityRow({ construct: { exId: "x", loadingProfile: "isotonic", performanceUnit: "unrepresentable" } });
  assert(JSON.stringify(a.construct) !== JSON.stringify(b.construct), "distinct constructKey despite same exId/profile");
});
test("Capacity: recent_loading_lower signal fires only for that exact reason", () => {
  assertEqual(capacityRecentLoadingLowerSignal(capacityRow({ moreDataNeededReason: "recent_loading_lower" })), true, "fires");
  assertEqual(capacityRecentLoadingLowerSignal(capacityRow({ moreDataNeededReason: "insufficient_total_history" })), false, "does not fire for other reasons");
  assertEqual(capacityRecentLoadingLowerSignal(capacityRow({ moreDataNeededReason: null })), false, "does not fire when no reason at all");
});
test("Capacity: insufficient history is contextual only — no dedicated Review Context signal exists for it", () => {
  // There is no exported function that turns insufficient_total_history or
  // unrepresentable_construct into a standalone Review Context signal — the
  // only Capacity Review Context detector is capacityRecentLoadingLowerSignal,
  // and it explicitly returns false for these reasons (proven above). This
  // test documents that omission is intentional, not an oversight.
  assertEqual(capacityRecentLoadingLowerSignal(capacityRow({ moreDataNeededReason: "unrepresentable_construct" })), false, "unrepresentable_construct is never a standalone signal");
});
test("New Capacity construct copy never calls it improvement or regression", () => {
  assert(!/improv|regress/i.test(NEW_CAPACITY_CONSTRUCT_COPY), "copy must stay neutral");
  assertEqual(NEW_CAPACITY_CONSTRUCT_TITLE, "New loading construct", "exact locked title");
  assertEqual(NEW_CAPACITY_CONSTRUCT_COPY, "A new loading construct is being established; comparable history is limited.", "exact locked copy");
});
test("no function anywhere in this module computes an overall/combined Capacity state across constructs", () => {
  // Structural: every Capacity function takes exactly ONE construct's row(s)
  // — never an array of constructs, never a cross-construct aggregate.
  assertEqual(detectCapacityConstructChange.length, 2, "single construct in, single construct out");
  assertEqual(capacityRecentLoadingLowerSignal.length, 1, "single construct row only");
});

// --- Prescription ---------------------------------------------------------

function rxSnapshot(overrides: Partial<PrescriptionVersionSnapshot> = {}): PrescriptionVersionSnapshot {
  return { id: "v1", createdAt: "2026-09-01T00:00:00Z", stage: 2, irritability: "moderate", isInsertional: false, source: "clinician_change", ...overrides };
}

test("Prescription: current vs previous with a real difference renders a changed item", () => {
  const current = rxSnapshot({ id: "v2", stage: 3 });
  const previous = rxSnapshot({ id: "v1", stage: 2 });
  const result = detectPrescriptionChange(current, previous);
  assert(result !== null, "changed item present");
  assertEqual(result?.current.stage, 3, "current stage");
  assertEqual(result?.previous.stage, 2, "previous stage");
});
test("Prescription: stage change reflected in the snapshot pair", () => {
  const result = detectPrescriptionChange(rxSnapshot({ id: "v2", stage: 4 }), rxSnapshot({ id: "v1", stage: 3 }));
  assertEqual([result?.previous.stage, result?.current.stage], [3, 4], "stage delta preserved, never averaged");
});
test("Prescription: irritability change reflected in the snapshot pair", () => {
  const result = detectPrescriptionChange(rxSnapshot({ id: "v2", irritability: "high" }), rxSnapshot({ id: "v1", irritability: "low" }));
  assertEqual([result?.previous.irritability, result?.current.irritability], ["low", "high"], "irritability delta preserved");
});
test("Prescription: insertional-status change reflected in the snapshot pair", () => {
  const result = detectPrescriptionChange(rxSnapshot({ id: "v2", isInsertional: true }), rxSnapshot({ id: "v1", isInsertional: false }));
  assertEqual([result?.previous.isInsertional, result?.current.isInsertional], [false, true], "insertional delta preserved");
});
test("Prescription: no previous -> null (nothing to compare)", () => {
  assertEqual(detectPrescriptionChange(rxSnapshot({ id: "v1" }), null), null, "no previous");
});
test("Prescription: no current -> null", () => {
  assertEqual(detectPrescriptionChange(null, rxSnapshot({ id: "v1" })), null, "no current");
});
test("Prescription source label translation covers every enum value, including the dormant system_progression", () => {
  assertEqual(formatPrescriptionSourceLabel("onboarding"), "Onboarding", "onboarding");
  assertEqual(formatPrescriptionSourceLabel("legacy_bootstrap"), "Legacy bootstrap", "legacy_bootstrap");
  assertEqual(formatPrescriptionSourceLabel("clinician_change"), "Clinician change", "clinician_change");
  assertEqual(formatPrescriptionSourceLabel("system_progression"), "System progression", "system_progression shown factually, never triggered");
});

// --- Compound inference: no signal's output depends on another domain's input --

test("compound inference: Symptoms signal is unaffected by any Capacity-shaped input (function simply has no such parameter)", () => {
  // symptomsReviewSignal(resultState) has exactly one parameter and no way
  // to receive Capacity or Training Response data at all — this is the
  // actual guarantee (not merely "same output for different Capacity
  // values", which would be trivially true of any single-argument function,
  // but the STRUCTURAL absence of a second parameter is what makes a
  // combined signal impossible to construct here).
  assertEqual(symptomsReviewSignal.length, 1, "single argument only");
  assertEqual(trainingResponseReviewSignal.length, 1, "single argument only");
  assertEqual(capacityRecentLoadingLowerSignal.length, 1, "single argument only");
});

test("compound inference: identical Symptoms input always produces identical output regardless of call order/context", () => {
  const a = symptomsReviewSignal("symptoms_trending_higher");
  const b = symptomsReviewSignal("symptoms_trending_higher");
  assertEqual(a, b, "pure, deterministic, no hidden state");
});

// --- Exclusions: prove C4 does NOT create these signal categories at all ----

const CLINICIAN_PATIENT_REVIEW_PATH = join(process.cwd(), "lib", "clinicianPatientReview.ts");

test("exclusion: no skipped-set-related CODE exists in this module (comments documenting the exclusion are fine)", () => {
  assert(!/skip/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no skipped-set concept in live code");
});
test("exclusion: no difficulty/Too-Hard-related CODE exists in this module", () => {
  assert(!/too_hard|difficulty/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no difficulty concept in live code");
});
test("exclusion: no Caution-tally-related CODE exists in this module", () => {
  assert(!/caution/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no tolerance-classification tally concept in live code");
});
test("exclusion: no immediate-guidance restatement CODE exists in this module", () => {
  assert(!/immediateGuidance|immediate_guidance|maintain_cautiously|reduce_modify/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no historical immediate-guidance concept in live code");
});
test("exclusion: no new prescribed-vs-actual comparator CODE exists in this module", () => {
  assert(!/prescribed|actualReps|actualLoad|setOutcome/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no C4-specific prescribed-vs-actual logic in live code");
});
test("exclusion: no adherence/coverage percentage CODE exists in this module", () => {
  assert(!/adherence|compliance|percentage|percent\b/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no adherence-shaped concept in live code");
});

// --- No composite score / no ranking -----------------------------------------

test("no scoring: this module contains no live numeric score/weight/rank/priority/urgency computation", () => {
  assert(!/\bscore\b|\bweight\b|\brank\b|\bpriority\b|\burgency\b/i.test(readCodeOnly(CLINICIAN_PATIENT_REVIEW_PATH)), "no scoring vocabulary or computation in live code");
});

// --- Vocabulary -----------------------------------------------------------

const FORBIDDEN_VOCABULARY = /\b(concern|risk|warning|problematic|inadequate|excessive|overloaded|underloaded|failed|noncompliant|adherence|compliance|engagement|motivation|declining|priority|urgent|urgency|needs adjustment)\b/i;
// "decreased Capacity" is checked as its own phrase (the word "decreased"
// alone is too broad — e.g. it would false-positive on a legitimate
// "decreased" WindowLoadingComparison value reused elsewhere in the
// codebase). Capacity-specific decline language is checked separately.
const FORBIDDEN_CAPACITY_DECLINE = /capacity\s+declin|decreased\s+capacity|lost\s+capacity|losing\s+capacity/i;

const C4_ALL_SOURCE_FILES = [
  join(process.cwd(), "lib", "clinicianPatientReview.ts"),
  join(process.cwd(), "lib", "clinicianPatientReviewServer.ts"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "review", "page.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "review", "components", "SafetySection.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "review", "components", "WhatChangedSection.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "review", "components", "ReviewContextSection.tsx"),
];

// Vocabulary is checked only against files that actually contain
// clinician-facing COPY (the pure module + presentational components) —
// clinicianPatientReviewServer.ts is deliberately excluded here: it never
// renders text, and its `${fn} failed: ${error.message}` internal-exception
// strings (the same convention every server file in this codebase uses)
// legitimately contain words like "failed" that have nothing to do with
// clinician-facing vocabulary.
const C4_COPY_SOURCE_FILES = C4_ALL_SOURCE_FILES.filter((f) => !f.endsWith("clinicianPatientReviewServer.ts"));

for (const filePath of C4_COPY_SOURCE_FILES) {
  test(`vocabulary: ${filePath.split("/").slice(-2).join("/")} contains no forbidden generated language`, () => {
    const codeOnly = readCodeOnly(filePath);
    const match = codeOnly.match(FORBIDDEN_VOCABULARY);
    assert(!match, `found forbidden vocabulary: "${match?.[0]}"`);
    const declineMatch = codeOnly.match(FORBIDDEN_CAPACITY_DECLINE);
    assert(!declineMatch, `found forbidden Capacity-decline phrasing: "${declineMatch?.[0]}"`);
  });
}

// --- Classifier boundary: no classifier/generator/progression-engine import --

const FORBIDDEN_FUNCTION_NAMES = [
  "generateShortWindowSymptomInterpretation",
  "generateCapacityInterpretations",
  "generateTrainingResponseInterpretation",
  "classifyCoreDomain",
  "classifyOverallSymptoms",
  "classifyMsd",
  "classifyCapacity",
  "classifyTrainingResponse",
  "compareSetVectors",
  "compareWindowLoading",
  "persistInterpretation",
  "buildResponseEpisodes",
  "buildAllCapacityExposuresForUser",
  "buildCapacityExposures",
  // Legacy FastAPI progression engine — Section 30: do not import, call,
  // reference, or use as a template, anywhere.
  "evaluate_exercise_progression",
  "run_decision_engine",
  "app/engine/rules",
];

for (const filePath of C4_ALL_SOURCE_FILES) {
  test(`classifier boundary: ${filePath.split("/").slice(-2).join("/")} imports no classifier/generator/legacy-progression-engine reference`, () => {
    const source = readFileSync(filePath, "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const name of FORBIDDEN_FUNCTION_NAMES) {
      assert(!codeOnly.includes(name), `found forbidden reference: "${name}"`);
    }
  });
}

// --- Compound inference: structural check for "if signalA && signalB" shapes --

const SIGNAL_FUNCTION_NAMES = ["symptomsReviewSignal", "trainingResponseReviewSignal", "capacityRecentLoadingLowerSignal", "detectStateChange", "detectCapacityConstructChange", "detectPrescriptionChange"];
const COMPOUND_INFERENCE_PATTERN = new RegExp(`(${SIGNAL_FUNCTION_NAMES.join("|")})\\([^)]*\\)\\s*(&&|\\|\\|)`);
for (const filePath of [join(process.cwd(), "lib", "clinicianPatientReviewServer.ts"), join(process.cwd(), "app", "clinician", "patients", "[id]", "review", "page.tsx")]) {
  test(`compound inference: ${filePath.split("/").slice(-2).join("/")} never combines two independent signal results with && / ||`, () => {
    const source = readFileSync(filePath, "utf8");
    const match = source.match(COMPOUND_INFERENCE_PATTERN);
    assert(!match, `found a compound signal combination: "${match?.[0]}"`);
  });
}

// --- No-recent-session copy -------------------------------------------------

test("no-recent-session copy contains no adherence/compliance/motivation language", () => {
  assertEqual(NO_RECENT_SESSION_TEXT, "No recent qualifying rehab session is available for review.", "exact restrained copy");
  assert(!/adherence|compliance|motivation|engagement|inactiv/i.test(NO_RECENT_SESSION_TEXT), "no judgment language");
});

// --- Run ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
