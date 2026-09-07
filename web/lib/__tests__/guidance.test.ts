// Milestone 5, Stage 1 — derived-guidance domain logic regression tests.
// Pure-function tests only (no DB) — mirrors the existing
// toleranceEvaluation.test.ts style. See guidance.ts for the semantics
// under test.
//
// Founder-acceptance patch: chronology != intent. A newer
// prescription_versions row is reported as a fact (existence + id +
// createdAt + source), never interpreted as "addressed"/"resolved"/
// "reviewed" — see the tests below asserting no such field exists on the
// result at all, for every source value including legacy_bootstrap.

import {
  deriveGuidance,
  pickLatestEvaluation,
  type DeriveGuidanceInput,
  type PrescriptionVersionRef,
  type SourceEvaluation,
} from "../guidance";

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

function evaluation(overrides: Partial<SourceEvaluation> = {}): SourceEvaluation {
  return {
    id: "eval-1",
    rehabSessionId: "session-1",
    toleranceClassification: "caution",
    immediateGuidance: "maintain_cautiously",
    reasonCodes: [],
    evaluatedAt: "2026-09-10T08:00:00.000Z",
    ruleVersion: "v1",
    ...overrides,
  };
}

function baseInput(overrides: Partial<DeriveGuidanceInput> = {}): DeriveGuidanceInput {
  return {
    evaluation: evaluation(),
    sourceSession: { id: "session-1", startedAt: "2026-09-10T07:00:00.000Z", prescriptionVersionId: "version-A" },
    allPatientEvaluations: [{ id: "eval-1", evaluatedAt: "2026-09-10T08:00:00.000Z" }],
    patientPrescriptionVersions: [{ id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" }],
    candidateSubsequentSessions: [],
    ...overrides,
  };
}

function versionRef(overrides: Partial<PrescriptionVersionRef>): PrescriptionVersionRef {
  return { id: "version-new", createdAt: "2026-09-11T00:00:00.000Z", source: "clinician_change", ...overrides };
}

// Fields that must NEVER appear anywhere on a RelevantGuidance result — this
// is the locked "chronology != intent" boundary itself, checked structurally
// rather than trusting each test to remember to check it.
const FORBIDDEN_FIELD_NAMES = ["addressedByPrescriptionChange", "guidanceResolved", "clinicianAddressedGuidance", "addressed", "resolved", "reviewed"];
function assertNoInterpretiveFields(result: unknown, msg: string) {
  const json = JSON.stringify(result);
  for (const name of FORBIDDEN_FIELD_NAMES) {
    assert(!json.includes(`"${name}"`), `${msg}: must not contain forbidden interpretive field "${name}"`);
  }
}

// --- baseline: no subsequent events at all ---
test("latest evaluation with no subsequent events -> not superseded, no newer version, no subsequent session", () => {
  const result = deriveGuidance(baseInput());
  assertEqual(result.supersededByNewerEvaluation, false, "not superseded");
  assertEqual(result.newerPrescriptionVersion, { exists: false }, "no newer prescription version");
  assertEqual(result.subsequentSession.anotherSessionStarted, false, "no subsequent session started");
  assertEqual(result.subsequentSession.versionComparison, null, "no comparison when nothing subsequent");
});

// --- 1. evaluation -> no later prescription version ---
test("1. no prescription version created after the evaluation -> newerPrescriptionVersion.exists=false", () => {
  const input = baseInput({
    patientPrescriptionVersions: [{ id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" }],
  });
  const result = deriveGuidance(input);
  assertEqual(result.newerPrescriptionVersion, { exists: false }, "only a version from before the evaluation exists");
});

// --- 2. evaluation -> later clinician_change version ---
test("2. later clinician_change version -> reported factually with source='clinician_change'", () => {
  const input = baseInput({
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-B", createdAt: "2026-09-11T00:00:00.000Z", source: "clinician_change" }),
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(
    result.newerPrescriptionVersion,
    { exists: true, prescriptionVersionId: "version-B", createdAt: "2026-09-11T00:00:00.000Z", source: "clinician_change" },
    "clinician_change version reported with its real source"
  );
  assertNoInterpretiveFields(result, "clinician_change case");
});

// --- 3. evaluation -> later system_progression version ---
test("3. later system_progression version -> reported factually with source='system_progression'", () => {
  const input = baseInput({
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-C", createdAt: "2026-09-12T00:00:00.000Z", source: "system_progression" }),
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.newerPrescriptionVersion.exists, true, "exists");
  assert(result.newerPrescriptionVersion.exists && result.newerPrescriptionVersion.source === "system_progression", "source is system_progression");
  assertNoInterpretiveFields(result, "system_progression case");
});

// --- 4. evaluation -> later legacy_bootstrap version (the important bootstrap case) ---
test("4. later legacy_bootstrap version -> reported factually, NEVER implies clinical review/resolution", () => {
  const input = baseInput({
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-D", createdAt: "2026-09-13T00:00:00.000Z", source: "legacy_bootstrap" }),
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(
    result.newerPrescriptionVersion,
    { exists: true, prescriptionVersionId: "version-D", createdAt: "2026-09-13T00:00:00.000Z", source: "legacy_bootstrap" },
    "legacy_bootstrap version reported as-is — a migration/provenance event, not clinical action"
  );
  assertNoInterpretiveFields(result, "legacy_bootstrap case — this is the case most likely to be misread as 'addressed'");
});

// --- 5. evaluation -> later onboarding version (representable: a second onboarding event) ---
test("5. a second later onboarding-sourced version -> reported factually with source='onboarding'", () => {
  const input = baseInput({
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-E", createdAt: "2026-09-14T00:00:00.000Z", source: "onboarding" }),
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.newerPrescriptionVersion.exists, true, "exists");
  assert(result.newerPrescriptionVersion.exists && result.newerPrescriptionVersion.source === "onboarding", "source is onboarding");
  assertNoInterpretiveFields(result, "second-onboarding case");
});

// --- 6. newer version chronology is reported factually (id + createdAt + source all present) ---
test("6. newerPrescriptionVersion carries id, createdAt, and source together — full chronology, not just a boolean", () => {
  const input = baseInput({
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-F", createdAt: "2026-09-15T12:34:56.000Z", source: "clinician_change" }),
    ],
  });
  const result = deriveGuidance(input);
  assert(result.newerPrescriptionVersion.exists === true, "exists");
  if (result.newerPrescriptionVersion.exists) {
    assertEqual(result.newerPrescriptionVersion.prescriptionVersionId, "version-F", "id present");
    assertEqual(result.newerPrescriptionVersion.createdAt, "2026-09-15T12:34:56.000Z", "createdAt present");
    assertEqual(result.newerPrescriptionVersion.source, "clinician_change", "source present");
  }
});

// --- 7. none of the above alone are labeled clinician-reviewed/addressed/resolved ---
test("7. no source value, alone, ever produces an interpretive addressed/resolved/reviewed field", () => {
  const sources: Array<"onboarding" | "legacy_bootstrap" | "clinician_change" | "system_progression"> = [
    "onboarding",
    "legacy_bootstrap",
    "clinician_change",
    "system_progression",
  ];
  for (const source of sources) {
    const result = deriveGuidance(
      baseInput({
        patientPrescriptionVersions: [
          { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
          versionRef({ id: `version-${source}`, createdAt: "2026-09-20T00:00:00.000Z", source }),
        ],
      })
    );
    assertNoInterpretiveFields(result, `source=${source}`);
  }
});

// --- earliest-wins when multiple newer versions exist ---
test("multiple newer versions: the EARLIEST one (by createdAt) is reported, regardless of source ordering", () => {
  const input = baseInput({
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-later", createdAt: "2026-09-20T00:00:00.000Z", source: "system_progression" }),
      versionRef({ id: "version-earliest", createdAt: "2026-09-11T00:00:00.000Z", source: "legacy_bootstrap" }),
    ],
  });
  const result = deriveGuidance(input);
  assert(result.newerPrescriptionVersion.exists === true, "exists");
  if (result.newerPrescriptionVersion.exists) {
    assertEqual(result.newerPrescriptionVersion.prescriptionVersionId, "version-earliest", "earliest newer version wins");
  }
});

// --- 8. subsequent session same version remains 'same' ---
test("8. subsequent session under the SAME prescription version -> versionComparison 'same'", () => {
  const input = baseInput({
    candidateSubsequentSessions: [
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "response_complete", prescriptionVersionId: "version-A" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.subsequentSession.anotherSessionStarted, true, "started");
  assertEqual(result.subsequentSession.anotherSessionCompleted, true, "completed");
  assertEqual(result.subsequentSession.subsequentSessionId, "session-2", "subsequent session id");
  assertEqual(result.subsequentSession.versionComparison, "same", "same version");
});

// --- 9. subsequent session different version remains 'different' ---
test("9. subsequent session under a DIFFERENT prescription version -> versionComparison 'different'", () => {
  const input = baseInput({
    candidateSubsequentSessions: [
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "in_progress", prescriptionVersionId: "version-B" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.subsequentSession.anotherSessionStarted, true, "started");
  assertEqual(result.subsequentSession.anotherSessionCompleted, false, "not yet completed (still in_progress)");
  assertEqual(result.subsequentSession.versionComparison, "different", "different version");
});

// --- 10. unresolved/null version remains 'unknown' ---
test("10a. unresolved SOURCE prescription identity -> sourcePrescriptionVersion.known=false and comparison 'unknown'", () => {
  const input = baseInput({
    sourceSession: { id: "session-1", startedAt: "2026-09-10T07:00:00.000Z", prescriptionVersionId: null },
    candidateSubsequentSessions: [
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "response_complete", prescriptionVersionId: "version-A" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.sourcePrescriptionVersion, { known: false }, "source version unresolved");
  assertEqual(result.subsequentSession.versionComparison, "unknown", "never guessed as same/different");
});

test("10b. unresolved SUBSEQUENT session prescription identity -> comparison 'unknown', not 'same'", () => {
  const input = baseInput({
    candidateSubsequentSessions: [
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "in_progress", prescriptionVersionId: null },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.subsequentSession.versionComparison, "unknown", "unresolved subsequent identity is never collapsed into same");
});

test("10c. both source and subsequent unresolved -> still 'unknown', never 'same' merely because both are null", () => {
  const input = baseInput({
    sourceSession: { id: "session-1", startedAt: "2026-09-10T07:00:00.000Z", prescriptionVersionId: null },
    candidateSubsequentSessions: [
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "in_progress", prescriptionVersionId: null },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.subsequentSession.versionComparison, "unknown", "two unresolved identities are not provably the same");
});

// --- older/newer evaluation supersession (retained from Stage 1) ---
test("older evaluation is superseded when a newer one exists for the same patient", () => {
  const input = baseInput({
    allPatientEvaluations: [
      { id: "eval-1", evaluatedAt: "2026-09-10T08:00:00.000Z" },
      { id: "eval-2", evaluatedAt: "2026-09-12T08:00:00.000Z" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.supersededByNewerEvaluation, true, "superseded by the later evaluation");
});

test("the latest evaluation itself is never superseded by an OLDER one", () => {
  const input = baseInput({
    allPatientEvaluations: [
      { id: "eval-0", evaluatedAt: "2026-09-05T08:00:00.000Z" },
      { id: "eval-1", evaluatedAt: "2026-09-10T08:00:00.000Z" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.supersededByNewerEvaluation, false, "not superseded by an older evaluation");
});

// --- reduce_modify does not trigger autonomous escalation, with either fact present ---
test("reduce_modify + subsequent same-version session preserves the fact without changing the evaluation itself", () => {
  const input = baseInput({
    evaluation: evaluation({ toleranceClassification: "caution", immediateGuidance: "reduce_modify" }),
    candidateSubsequentSessions: [
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "response_complete", prescriptionVersionId: "version-A" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.evaluation.immediateGuidance, "reduce_modify", "guidance echoed unchanged");
  assertEqual(result.subsequentSession.versionComparison, "same", "same-prescription fact preserved");
  assertNoInterpretiveFields(result, "reduce_modify + same version");
});

test("reduce_modify + a newer prescription version -> reported as a fact, never as 'addressed'", () => {
  const input = baseInput({
    evaluation: evaluation({ toleranceClassification: "caution", immediateGuidance: "reduce_modify" }),
    patientPrescriptionVersions: [
      { id: "version-A", createdAt: "2026-09-01T00:00:00.000Z", source: "onboarding" },
      versionRef({ id: "version-G", createdAt: "2026-09-11T00:00:00.000Z", source: "clinician_change" }),
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.newerPrescriptionVersion.exists, true, "a newer version exists as a fact");
  assertNoInterpretiveFields(result, "reduce_modify + newer version");
});

// --- multiple subsequent sessions: only the earliest ("Session N+1") drives the comparison ---
test("multiple subsequent sessions: the EARLIEST one drives subsequentSessionId/versionComparison", () => {
  const input = baseInput({
    candidateSubsequentSessions: [
      { id: "session-3", startedAt: "2026-09-13T07:00:00.000Z", status: "response_complete", prescriptionVersionId: "version-B" },
      { id: "session-2", startedAt: "2026-09-11T07:00:00.000Z", status: "in_progress", prescriptionVersionId: "version-A" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.subsequentSession.subsequentSessionId, "session-2", "earliest subsequent session wins");
  assertEqual(result.subsequentSession.versionComparison, "same", "comparison against the earliest session's version");
  assertEqual(result.subsequentSession.anotherSessionCompleted, true, "completed=true because SOME subsequent session (session-3) completed");
});

test("a session that started before evaluatedAt is never treated as subsequent", () => {
  const input = baseInput({
    candidateSubsequentSessions: [
      { id: "session-1", startedAt: "2026-09-10T07:00:00.000Z", status: "response_complete", prescriptionVersionId: "version-A" },
    ],
  });
  const result = deriveGuidance(input);
  assertEqual(result.subsequentSession.anotherSessionStarted, false, "source/earlier sessions are not subsequent");
});

// --- latest-evaluation selection never relies on lexicographic rule_version ordering ---
test("pickLatestEvaluation selects by evaluatedAt, not lexicographic rule_version", () => {
  const evaluations = [
    { id: "e-v10", evaluatedAt: "2026-09-01T00:00:00.000Z", ruleVersion: "v10" },
    { id: "e-v9", evaluatedAt: "2026-09-15T00:00:00.000Z", ruleVersion: "v9" },
    { id: "e-v2", evaluatedAt: "2026-09-05T00:00:00.000Z", ruleVersion: "v2" },
  ];
  const latest = pickLatestEvaluation(evaluations);
  assertEqual(latest?.id, "e-v9", "the actually-latest-by-time evaluation wins regardless of rule_version text");
});

test("pickLatestEvaluation returns null for an empty list", () => {
  assertEqual(pickLatestEvaluation([]), null, "empty list -> null");
});

test("multiple evaluations across different sessions: the globally latest one wins", () => {
  const evaluations = [
    { id: "e-1", evaluatedAt: "2026-09-01T00:00:00.000Z" },
    { id: "e-2", evaluatedAt: "2026-09-20T00:00:00.000Z" },
    { id: "e-3", evaluatedAt: "2026-09-10T00:00:00.000Z" },
  ];
  const latest = pickLatestEvaluation(evaluations);
  assertEqual(latest?.id, "e-2", "correct latest across sessions");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
