// C3 — Longitudinal Clinical Progress. Pure-function regression tests for
// clinicianPatientProgress.ts. No test framework is wired up for the web/
// package (only Playwright e2e exists) — this is a plain, dependency-free
// script matching the convention already used for C1B/C2's own tests.

import {
  buildCapacitySetRows,
  describeStateChange,
  formatCapacityMoreDataReasonLabel,
  formatCapacityQualifyingEvidence,
  formatCapacityStateLabel,
  formatCoreDomainDirectionLabel,
  formatCoverageEvidenceSentence,
  formatDimensionComparisonLabel,
  formatFrequencyPatternLabel,
  formatLoadingDirectionLabel,
  formatLoadingProfileLabel,
  formatMsdDefaultLabel,
  formatMsdExpandedNote,
  formatOverallSymptomsLabel,
  formatPerformanceUnitLabel,
  formatReasonCodeLabel,
  formatSymptomsInsufficientLabel,
  formatToleranceClassificationLabel,
  formatTrainingResponseInsufficientLabel,
  formatTrainingResponseStateLabel,
  formatUsablePairEvidence,
  formatValuesList,
  mechanicalComparisonLabelFor,
  parseCapacityResultDetail,
  parseSymptomsResultDetail,
  parseTrainingResponseResultDetail,
  ACTIVE_ACUTE_REVIEW_CAVEAT,
  type CapacityOpportunityDetail,
  type CapacityResultDetail,
  type CoreDomainResultDetail,
  type TrainingResponseConstructResultDetail,
} from "../clinicianPatientProgress";
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

// --- Symptoms: state labels ------------------------------------------------

test("every OverallSymptomsState has a distinct, non-empty label", () => {
  const states = ["symptoms_improving", "symptoms_trending_better", "symptoms_stable", "mixed_symptom_response", "symptoms_trending_higher", "more_data_needed"] as const;
  const labels = states.map((s) => formatOverallSymptomsLabel(s));
  assert(labels.every((l) => l.length > 0), "no empty labels");
  assert(new Set(labels).size === labels.length, "labels must be distinct");
});

test("every CoreDomainDirection has a distinct-ish label, insufficient maps to 'More data needed'", () => {
  assertEqual(formatCoreDomainDirectionLabel("insufficient_data"), "More data needed", "insufficient -> more data needed, never a favorable default");
  assertEqual(formatCoreDomainDirectionLabel("improving"), "Improving", "improving");
  assertEqual(formatCoreDomainDirectionLabel("trending_higher"), "Trending higher", "trending higher");
  assertEqual(formatCoreDomainDirectionLabel("stable"), "Stable", "stable");
});

// --- Symptoms: frequencyPattern TRANSLATION only (never a re-derived tally) --
// FOUNDER-LOCKED CORRECTION: C3 must never apply the 1-point directional
// boundary (or any threshold) to recentValues/previousMedian to reconstruct
// a "Lower/Higher in N of 5" count. It may only translate the already-
// persisted, already-classified `frequencyPattern` category to text, and
// display raw values/medians/IQR AS-IS (never compared against anything).

function coreDomain(overrides: Partial<CoreDomainResultDetail> = {}): CoreDomainResultDetail {
  return {
    direction: "improving",
    consistency: "consistent",
    recentMedian: 2,
    previousMedian: 5,
    recentIqr: { q1: 1, q3: 3, iqr: 2 },
    previousIqr: { q1: 4, q3: 6, iqr: 2 },
    frequencyPattern: "favorable_lower",
    medianDirection: "lower",
    recentValues: [1, 2, 2, 3, 8],
    previousValues: [5, 5, 5, 5, 5],
    ...overrides,
  };
}

// 1. Persisted direction is rendered.
test("persisted direction is rendered verbatim via the label map", () => {
  assertEqual(formatCoreDomainDirectionLabel(coreDomain({ direction: "improving" }).direction), "Improving", "direction rendered");
});

// 2. Persisted frequencyPattern is translated (not computed).
test("frequencyPattern translation: favorable_lower", () => {
  assertEqual(formatFrequencyPatternLabel("favorable_lower"), "Recent responses more often favored lower values.", "favorable_lower translated");
});
test("frequencyPattern translation: unfavorable_higher", () => {
  assertEqual(formatFrequencyPatternLabel("unfavorable_higher"), "Recent responses more often favored higher values.", "unfavorable_higher translated");
});
test("frequencyPattern translation: no_dominant_pattern", () => {
  assertEqual(formatFrequencyPatternLabel("no_dominant_pattern"), "No dominant recent directional pattern.", "no_dominant_pattern translated");
});
test("frequencyPattern translation: null (never fabricates a pattern)", () => {
  assertEqual(formatFrequencyPatternLabel(null), null, "null frequencyPattern translates to null, never a guessed sentence");
});
test("frequencyPattern translation never mentions a specific count, regardless of the underlying recentValues", () => {
  // Same frequencyPattern, wildly different recentValues -> IDENTICAL text.
  // Proves the translation depends only on the persisted category, never
  // on the raw values (which a re-derivation would have produced a
  // different-looking count for).
  const a = formatFrequencyPatternLabel(coreDomain({ recentValues: [1, 1, 1, 1, 1] }).frequencyPattern);
  const b = formatFrequencyPatternLabel(coreDomain({ recentValues: [4, 4, 4, 4, 9] }).frequencyPattern);
  assertEqual(a, b, "identical category must produce identical text regardless of underlying raw values");
  assert(!/\d+ of \d+/.test(a ?? ""), "translation must never contain an 'N of M' count");
});

// 3/4. recentValues/previousValues displayed without reclassification.
test("formatValuesList: raw values shown as-is, in persisted order, never sorted/compared/thresholded", () => {
  assertEqual(formatValuesList([8, 1, 2, 2, 3]), "8, 1, 2, 2, 3", "values shown verbatim, original order preserved");
});
test("formatValuesList: empty array renders an honest placeholder, never a fabricated value", () => {
  assertEqual(formatValuesList([]), "—", "empty list placeholder");
});

// 5/6. Medians remain corroborating; IQR remains explicitly context-only —
// this is purely a display-labeling assertion (the pure module attaches no
// numeric behavior to either, only formatting).
test("median and IQR are pure passthrough values, never used to compute a direction here", () => {
  const result = coreDomain({ recentMedian: 2, previousMedian: 5, recentIqr: { q1: 1, q3: 3, iqr: 2 }, previousIqr: { q1: 4, q3: 6, iqr: 2 } });
  assertEqual(result.recentMedian, 2, "median passthrough");
  assertEqual(result.recentIqr, { q1: 1, q3: 3, iqr: 2 }, "IQR passthrough");
});

// --- MSD: supporting-information-only behavior ------------------------------

test("MSD insufficient -> no default-view label (returns null, may still appear in expanded evidence)", () => {
  const msd = { direction: "insufficient_data" as const, recentMedianRank: null, previousMedianRank: null, recentSampleSize: 1, previousSampleSize: 2 };
  assertEqual(formatMsdDefaultLabel(msd), null, "insufficient MSD hidden from default view");
  assert(formatMsdExpandedNote(msd).includes("Not enough"), "expanded note still explains the insufficiency");
});

test("MSD sufficient -> shown in default view with its real direction label", () => {
  const msd = { direction: "shorter" as const, recentMedianRank: 1, previousMedianRank: 2, recentSampleSize: 4, previousSampleSize: 4 };
  assertEqual(formatMsdDefaultLabel(msd), "Shorter", "shorter label shown by default");
  assert(formatMsdExpandedNote(msd).includes("4 previous") && formatMsdExpandedNote(msd).includes("4 recent"), "expanded note cites real sample sizes");
});

// --- Symptoms insufficiency / coverage --------------------------------------

test("Symptoms insufficient copy matches locked founder wording", () => {
  assertEqual(formatSymptomsInsufficientLabel(), "Not enough completed rehab responses yet.", "locked copy");
});

test("parseSymptomsResultDetail: insufficient row (no core) parsed as insufficient with real episode count", () => {
  const parsed = parseSymptomsResultDetail("more_data_needed", { eligibleEpisodeCount: 4 });
  assertEqual(parsed, { status: "insufficient", eligibleEpisodeCount: 4 }, "insufficient parse");
});

test("parseSymptomsResultDetail: generated row parsed with core/msd/coverage intact", () => {
  const raw = {
    core: { P: coreDomain(), MP: coreDomain(), MS: coreDomain() },
    msd: { direction: "stable", recentMedianRank: 1, previousMedianRank: 1, recentSampleSize: 4, previousSampleSize: 4 },
    coverageContext: { rawCounts: { attemptedSessionCount: 10, completedSessionCount: 9, completeResponseEpisodeCount: 10, safetyBlockedOnlyCount: 1 } },
    distinctPrescriptionVersionIds: ["a", "b"],
  };
  const parsed = parseSymptomsResultDetail("symptoms_improving", raw);
  assert(parsed.status === "generated", "generated status");
  if (parsed.status === "generated") {
    assertEqual(parsed.coverageRawCounts.completedSessionCount, 9, "coverage counts preserved");
    assertEqual(parsed.distinctPrescriptionVersionIds, ["a", "b"], "prescription version ids preserved");
  }
});

test("coverage evidence sentence never fabricates a ratio, only shows raw counts", () => {
  const sentence = formatCoverageEvidenceSentence({ attemptedSessionCount: 10, completedSessionCount: 9, completeResponseEpisodeCount: 10, safetyBlockedOnlyCount: 2 });
  assert(sentence.includes("9 completed / 10 attempted"), "raw counts shown");
  assert(sentence.includes("2 blocked by an acute-safety hold"), "blocked count shown when > 0");
  assert(!sentence.includes("%"), "never a percentage/ratio");
});

// --- Previous-state comparison ------------------------------------------------

test("describeStateChange: no previous", () => {
  assertEqual(describeStateChange("symptoms_stable", null), "no_previous", "no previous");
});
test("describeStateChange: unchanged", () => {
  assertEqual(describeStateChange("symptoms_stable", "symptoms_stable"), "unchanged", "unchanged");
});
test("describeStateChange: changed", () => {
  assertEqual(describeStateChange("symptoms_improving", "symptoms_stable"), "changed", "changed");
});

// --- Capacity: state labels, no decline wording -----------------------------

test("every CapacityState has a label, none mention decline/decrease/losing", () => {
  const states = ["capacity_building", "loading_capacity_improving", "loading_capacity_stable", "loading_pattern_variable", "more_comparable_data_needed"] as const;
  for (const s of states) {
    const label = formatCapacityStateLabel(s);
    assert(label.length > 0, `label for ${s}`);
    assert(!/declin|decreas|losing/i.test(label), `label for ${s} must never suggest decline: "${label}"`);
  }
});

test("recent_loading_lower uses the exact locked phrasing, never 'declining'/'decreased'/'losing capacity'", () => {
  const label = formatCapacityMoreDataReasonLabel("recent_loading_lower");
  assertEqual(label, "Recent loading has been lower.", "exact locked phrasing");
});

test("insufficient_total_history and unrepresentable_construct have distinct, factual copy", () => {
  assertEqual(formatCapacityMoreDataReasonLabel("insufficient_total_history"), "Not enough comparable sessions yet for this exercise.", "insufficient history");
  assert(formatCapacityMoreDataReasonLabel("unrepresentable_construct").includes("can't be measured numerically"), "unrepresentable");
});

test("performance unit and loading profile labels are clinician-readable", () => {
  assertEqual(formatPerformanceUnitLabel("reps"), "Reps", "reps");
  assertEqual(formatPerformanceUnitLabel("hold_seconds"), "Hold (seconds)", "hold seconds");
  assertEqual(formatPerformanceUnitLabel("unrepresentable"), "Not numerically measurable", "unrepresentable");
  assertEqual(formatLoadingProfileLabel("isometric_eccentric"), "Isometric Eccentric", "profile title-cased");
  assertEqual(formatLoadingProfileLabel(null), "Not recorded", "null profile");
});

function capacityDetail(overrides: Partial<CapacityResultDetail> = {}): CapacityResultDetail {
  return {
    construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
    qualifyingDemonstrationCount: 2,
    qualifyingDemonstrationRehabSessionIds: ["s1", "s2"],
    wellToleratedQualifyingCount: 2,
    cautionMaintainQualifyingCount: 0,
    confirmedByTwoOfFourRule: true,
    recentLoadingLowerThanPrior: false,
    recentLoadingLowerThanPriorNote: null,
    moreDataNeededReason: null,
    mechanicallyHigherRehabSessionIds: ["s1", "s2"],
    mechanicallyLowerRehabSessionIds: [],
    hasNonDominatingExposure: false,
    recentOpportunities: [],
    ...overrides,
  };
}

test("parseCapacityResultDetail: round-trips the exact persisted shape", () => {
  const raw = {
    construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
    qualifyingDemonstrationCount: 2,
    qualifyingDemonstrationRehabSessionIds: ["s1"],
    wellToleratedQualifyingCount: 1,
    cautionMaintainQualifyingCount: 1,
    confirmedByTwoOfFourRule: true,
    recentLoadingLowerThanPrior: false,
    recentLoadingLowerThanPriorNote: null,
    moreDataNeededReason: null,
    mechanicallyHigherRehabSessionIds: ["s1"],
    mechanicallyLowerRehabSessionIds: [],
    hasNonDominatingExposure: false,
    recentOpportunities: [],
  };
  const parsed = parseCapacityResultDetail(raw);
  assertEqual(parsed.qualifyingDemonstrationCount, 2, "qualifying count");
  assertEqual(parsed.wellToleratedQualifyingCount, 1, "well tolerated count");
});

test("qualifying evidence sentence shows real counts, denominator is the locked window size (4)", () => {
  const sentence = formatCapacityQualifyingEvidence(capacityDetail());
  assertEqual(sentence, "2 of 4 qualifying demonstrations (2 well-tolerated, 0 caution+maintain)", "evidence sentence");
});

test("zero qualifying demonstrations omits the parenthetical breakdown", () => {
  const sentence = formatCapacityQualifyingEvidence(capacityDetail({ qualifyingDemonstrationCount: 0, wellToleratedQualifyingCount: 0, cautionMaintainQualifyingCount: 0 }));
  assertEqual(sentence, "0 of 4 qualifying demonstrations", "no parenthetical when zero");
});

test("mechanicalComparisonLabelFor: baseline, higher, lower, and unknown are all distinct", () => {
  const detail = capacityDetail({ mechanicallyHigherRehabSessionIds: ["higher1"], mechanicallyLowerRehabSessionIds: ["lower1"] });
  assertEqual(mechanicalComparisonLabelFor("baseline1", detail, "baseline1"), "Baseline", "baseline");
  assertEqual(mechanicalComparisonLabelFor("higher1", detail, "baseline1"), "Higher than baseline", "higher");
  assertEqual(mechanicalComparisonLabelFor("lower1", detail, "baseline1"), "Lower than baseline", "lower");
  assertEqual(mechanicalComparisonLabelFor("unknown1", detail, "baseline1"), null, "never guesses equal/non-dominating");
});

// --- Capacity: set-vector fidelity -------------------------------------------

function opportunity(overrides: Partial<CapacityOpportunityDetail> = {}): CapacityOpportunityDetail {
  return {
    rehabSessionId: "s1",
    patientLocalDate: "2026-09-01",
    performanceUnit: "reps",
    prescribedSets: [],
    actualSets: [],
    toleranceClassification: "well_tolerated",
    immediateGuidance: "maintain",
    isSuccessfulExposure: true,
    ...overrides,
  };
}

test("buildCapacitySetRows: completed set shows real amount/load, never averaged", () => {
  const opp = opportunity({
    prescribedSets: [{ setIndex: 1, outcome: "completed", amount: 10, load: 40 }],
    actualSets: [{ setIndex: 1, outcome: "completed", amount: 8, load: 35 }],
  });
  const rows = buildCapacitySetRows(opp);
  assertEqual(rows[0].prescribedLabel, "10 reps · 40 kg", "prescribed");
  assertEqual(rows[0].actualLabel, "8 reps · 35 kg", "actual");
});

test("buildCapacitySetRows: skipped set shows 'Skipped', never a zero or the prescribed value", () => {
  const opp = opportunity({
    prescribedSets: [{ setIndex: 1, outcome: "skipped", amount: 10, load: 40 }],
    actualSets: [{ setIndex: 1, outcome: "skipped", amount: null, load: null }],
  });
  const rows = buildCapacitySetRows(opp);
  assertEqual(rows[0].actualLabel, "Skipped", "skipped, never 0 or 10");
});

test("buildCapacitySetRows: isometric performance unit uses hold-seconds phrasing", () => {
  const opp = opportunity({
    performanceUnit: "hold_seconds",
    prescribedSets: [{ setIndex: 1, outcome: "completed", amount: 45, load: null }],
    actualSets: [{ setIndex: 1, outcome: "completed", amount: 40, load: null }],
  });
  const rows = buildCapacitySetRows(opp);
  assertEqual(rows[0].prescribedLabel, "45s hold", "hold seconds, no load shown when null");
  assertEqual(rows[0].actualLabel, "40s hold", "hold seconds actual");
});

test("buildCapacitySetRows: multiple sets preserved independently, never collapsed", () => {
  const opp = opportunity({
    prescribedSets: [
      { setIndex: 1, outcome: "completed", amount: 10, load: 40 },
      { setIndex: 2, outcome: "completed", amount: 10, load: 40 },
      { setIndex: 3, outcome: "completed", amount: 10, load: 40 },
    ],
    actualSets: [
      { setIndex: 1, outcome: "completed", amount: 10, load: 40 },
      { setIndex: 2, outcome: "completed", amount: 8, load: 35 },
      { setIndex: 3, outcome: "completed", amount: 6, load: 30 },
    ],
  });
  const rows = buildCapacitySetRows(opp);
  assertEqual(rows.length, 3, "three independent rows");
  assertEqual(
    rows.map((r) => r.actualLabel),
    ["10 reps · 40 kg", "8 reps · 35 kg", "6 reps · 30 kg"],
    "each set keeps its own real value, never averaged"
  );
});

test("formatToleranceClassificationLabel: poorly_tolerated and caution share the same v1 label (matches the evaluator's own v1 behavior)", () => {
  assertEqual(formatToleranceClassificationLabel("caution"), "Caution", "caution");
  assertEqual(formatToleranceClassificationLabel("poorly_tolerated"), "Caution", "poorly_tolerated maps to Caution, same as v1 evaluator");
  assertEqual(formatToleranceClassificationLabel("well_tolerated"), "Well tolerated", "well tolerated");
});

// --- Training Response: state labels, insufficiency, evidence --------------

test("every TrainingResponseState has a distinct, non-empty label", () => {
  const states = ["loading_tolerance_improving", "stable_training_response", "variable_training_response", "training_response_remains_unsettled", "more_data_needed"] as const;
  const labels = states.map((s) => formatTrainingResponseStateLabel(s));
  assert(labels.every((l) => l.length > 0), "no empty labels");
  assert(new Set(labels).size === labels.length, "labels must be distinct");
});

test("Training Response insufficient copy is the single restrained locked wording", () => {
  assertEqual(formatTrainingResponseInsufficientLabel(), "Not enough paired symptom and loading data yet.", "locked copy");
});

test("parseTrainingResponseResultDetail: insufficient-window row (no overallSymptomsState) parsed as insufficient", () => {
  const parsed = parseTrainingResponseResultDetail({ reason: "Stage 3B Symptoms is insufficient..." });
  assertEqual(parsed, { status: "insufficient" }, "insufficient parse never leaks the raw internal reason sentence");
});

test("parseTrainingResponseResultDetail: generated row preserves constructResults verbatim", () => {
  const constructResults: TrainingResponseConstructResultDetail[] = [
    {
      construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
      previousExposureCount: 5,
      recentExposureCount: 5,
      pairs: [{ previousRehabSessionId: "p1", recentRehabSessionId: "r1", comparison: "higher" }],
      usablePairCount: 1,
      unmatchedPreviousRehabSessionIds: [],
      unmatchedRecentRehabSessionIds: [],
      direction: "increased",
      insufficiencyReason: null,
    },
  ];
  const parsed = parseTrainingResponseResultDetail({
    overallSymptomsState: "symptoms_improving",
    overallLoadingDirection: "increased",
    hasInsufficientConstruct: false,
    constructResults,
  });
  assert(parsed.status === "generated", "generated status");
  if (parsed.status === "generated") {
    assertEqual(parsed.constructResults, constructResults, "construct results preserved verbatim, never re-paired");
  }
});

test("usable-pair evidence sentence shows real counts", () => {
  const result: TrainingResponseConstructResultDetail = {
    construct: { exId: "x", loadingProfile: null, performanceUnit: "reps" },
    previousExposureCount: 5,
    recentExposureCount: 4,
    pairs: [],
    usablePairCount: 3,
    unmatchedPreviousRehabSessionIds: ["u1"],
    unmatchedRecentRehabSessionIds: [],
    direction: "increased",
    insufficiencyReason: null,
  };
  assertEqual(formatUsablePairEvidence(result), "3 usable paired comparisons (5 previous / 4 recent exposures)", "evidence sentence");
});

test("dimension comparison labels are all distinct and never claim causation", () => {
  const comparisons = ["higher", "lower", "equal", "non_dominating", "insufficient"] as const;
  const labels = comparisons.map((c) => formatDimensionComparisonLabel(c));
  assert(new Set(labels).size === labels.length, "distinct labels");
  assert(labels.every((l) => !/caus/i.test(l)), "never claims causation");
});

test("loading direction labels cover every WindowLoadingComparison value", () => {
  assertEqual(formatLoadingDirectionLabel("increased"), "Increased", "increased");
  assertEqual(formatLoadingDirectionLabel("maintained"), "Maintained", "maintained");
  assertEqual(formatLoadingDirectionLabel("decreased"), "Decreased", "decreased");
  assertEqual(formatLoadingDirectionLabel("mixed"), "Mixed", "mixed");
  assertEqual(formatLoadingDirectionLabel("insufficient"), "Insufficient", "insufficient");
});

// --- Reason codes: translated, no raw enum leaked, external-load exact wording --

test("every InterpretationReasonCode translates to a non-empty, different-from-raw label", () => {
  const codes = [
    "limited_coverage",
    "mixed_symptom_directions",
    "high_response_variability",
    "recent_prescription_change",
    "limited_comparable_exposures",
    "external_loading_context_present",
    "capacity_response_mismatch",
  ] as const;
  for (const code of codes) {
    const label = formatReasonCodeLabel(code);
    assert(label.length > 0, `label for ${code}`);
    assert(label !== code, `label for ${code} must not be the raw enum string itself`);
  }
});

test("external_loading_context_present uses the exact locked wording, never a causal claim", () => {
  const label = formatReasonCodeLabel("external_loading_context_present");
  assertEqual(label, "One or more sessions in this interpretation window included reported external activity.", "exact locked wording");
  assert(!/caus|because|due to|explain/i.test(label), "never attributes causation");
});

// --- Acute caveat -------------------------------------------------------------

test("active-acute caveat uses the exact locked wording", () => {
  assertEqual(
    ACTIVE_ACUTE_REVIEW_CAVEAT,
    "Clinical review is currently active. Recent longitudinal data remain visible but should be interpreted in that context.",
    "exact locked caveat wording"
  );
});

// --- M6 protection: structural verification ---------------------------------
// Section 27 of the C3 brief: confirm C3 does not import classifier/
// generator functions — read functions only. Reads the actual .ts SOURCE
// (run from web/, matching every other script/test's own convention) so
// this stays meaningful after future edits, not just at the moment it was
// written. `import type` for locked-vocabulary string unions is exempted
// (zero runtime footprint, verified separately below) — only VALUE
// (function/runtime) references to the forbidden names are checked.
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
];
const C3_SOURCE_FILES = [
  join(process.cwd(), "lib", "clinicianPatientProgress.ts"),
  join(process.cwd(), "lib", "clinicianPatientProgressServer.ts"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "page.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "components", "SymptomsSectionCard.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "components", "CapacityConstructCard.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "components", "TrainingResponseSectionCard.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "components", "ProvenanceFooter.tsx"),
  join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "components", "StatePreviousChip.tsx"),
];

for (const filePath of C3_SOURCE_FILES) {
  test(`M6 protection: ${filePath.split("/").slice(-2).join("/")} imports no classifier/generator function`, () => {
    const source = readFileSync(filePath, "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const name of FORBIDDEN_FUNCTION_NAMES) {
      assert(!codeOnly.includes(name), `found forbidden classifier/generator reference: "${name}"`);
    }
  });
}

// 7/8. Directional-boundary / N-of-5-tally protection (FOUNDER-LOCKED
// CORRECTION). This protects the ARCHITECTURAL BEHAVIOR — "C3 never applies
// a threshold to raw observations to reconstruct a classification tally" —
// rather than banning a single literal token (the brief's own instruction:
// "do not create a brittle test that merely bans the literal number 1").
// Four independent, complementary signals, each catching a different way
// the removed logic could be reintroduced:
//   (a) no "boundary"-named constant/concept (the M6 classifier's own
//       DIRECTIONAL_BOUNDARY_POINTS concept has no legitimate reason to
//       exist anywhere in C3's display layer);
//   (b) no arithmetic offset applied to previousMedian/recentMedian
//       (previousMedian +/- N, recentMedian +/- N) — the exact shape of a
//       threshold-from-median computation, regardless of the offset's size;
//   (c) no transform (.map/.filter) over recentValues/previousValues — the
//       only legitimate operations on those arrays here are direct display
//       (e.g. .join), never a per-value comparison;
//   (d) no reconstructed "N of M [recent responses]" tally PHRASE anywhere
//       in rendered/formatted output text, in either the pure module or any
//       C3 component — this is the observable symptom of a reintroduced
//       re-derivation, independent of how it might be implemented.
for (const filePath of C3_SOURCE_FILES) {
  test(`directional-boundary protection: ${filePath.split("/").slice(-2).join("/")} never re-derives a tally from raw observations`, () => {
    const source = readFileSync(filePath, "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    assert(!/boundary/i.test(codeOnly), "must not (re)introduce any 'boundary'-named directional-threshold concept");
    assert(!/previousMedian\s*[+-]/.test(codeOnly), "must not apply an arithmetic offset to previousMedian");
    assert(!/recentMedian\s*[+-]/.test(codeOnly), "must not apply an arithmetic offset to recentMedian");
    assert(!/(recentValues|previousValues)\.(map|filter|reduce)\(/.test(codeOnly), "must not transform raw values arrays — display them as-is only");
    assert(!/\d+\s+of\s+\d+\s+recent\s+responses/i.test(codeOnly), "must not contain a reconstructed 'N of M recent responses' tally phrase");
  });
}

// Same C3-exclusion structural check established for C2 — this route must
// never reach M6 longitudinal-interpretation CLASSIFICATION/trend modules
// beyond reading the already-persisted m6_longitudinal_interpretations rows.
const FORBIDDEN_C4_PATTERN = /increase load|decrease load|progress this patient|regress this patient|change frequency|change exercise|advance stage|hold stage|patient needs|recommended prescription|automated priority|clinical action score/i;
for (const filePath of C3_SOURCE_FILES) {
  test(`C4 exclusion: ${filePath.split("/").slice(-2).join("/")} contains no generated action/recommendation language`, () => {
    const source = readFileSync(filePath, "utf8");
    const match = source.match(FORBIDDEN_C4_PATTERN);
    assert(!match, `found forbidden C4-style action language: "${match?.[0]}"`);
  });
}

// --- Heuristic-prose exclusion: structural verification ----------------------
// Section 17 of the C3 brief: heuristic description/rationale/
// known_limitations must never be rendered — only a heuristic's short name
// (already fetched via getHeuristicsByIds, which returns the FULL
// HeuristicRecord) may ever reach the page.
for (const filePath of [join(process.cwd(), "lib", "clinicianPatientProgressServer.ts"), join(process.cwd(), "app", "clinician", "patients", "[id]", "progress", "components", "ProvenanceFooter.tsx")]) {
  test(`heuristic-prose exclusion: ${filePath.split("/").slice(-2).join("/")} never reads .description/.rationale/.knownLimitations`, () => {
    const source = readFileSync(filePath, "utf8");
    assert(!/\.\s*(description|rationale|knownLimitations)\b/.test(source), "found a forbidden heuristic-prose field access");
  });
}

// --- Run ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
