// Milestone 5, Stage 2 — Today's Rehab feedback view-model regression
// tests. Pure-function tests only (no DB) — mirrors the existing
// guidance.test.ts / toleranceEvaluation.test.ts style.

import { computeTodaysRehabFeedback, type ComputeTodaysRehabFeedbackInput } from "../todaysRehabFeedback";
import type { RelevantGuidance } from "../guidance";
import type { ImmediateGuidance, ToleranceClassification } from "../morningResponseTypes";
import type { PrescriptionVersionSource } from "../prescriptionVersionTypes";

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

function guidance(overrides: Partial<RelevantGuidance> = {}): RelevantGuidance {
  return {
    evaluation: {
      id: "eval-1",
      rehabSessionId: "session-1",
      toleranceClassification: "well_tolerated" as ToleranceClassification,
      immediateGuidance: "maintain" as ImmediateGuidance,
      reasonCodes: ["normal_response"],
      evaluatedAt: "2026-09-10T08:00:00.000Z",
      ruleVersion: "v1",
    },
    sourcePrescriptionVersion: { known: true, prescriptionVersionId: "version-A" },
    supersededByNewerEvaluation: false,
    newerPrescriptionVersion: { exists: false },
    subsequentSession: {
      anotherSessionStarted: false,
      anotherSessionCompleted: false,
      subsequentSessionId: null,
      subsequentSessionPrescriptionVersionId: null,
      versionComparison: null,
    },
    ...overrides,
  };
}

function input(overrides: Partial<ComputeTodaysRehabFeedbackInput> = {}): ComputeTodaysRehabFeedbackInput {
  return {
    guidance: guidance(),
    escalationLevel: null,
    hasOutstandingMorningResponse: false,
    ...overrides,
  };
}

// --- 1. Well Tolerated + Maintain ---
test("1. Well Tolerated + Maintain -> compact positive state, no CTA override", () => {
  const result = computeTodaysRehabFeedback(input());
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.tone, "positive", "positive tone");
    assertEqual(result.title, "Last session: Well Tolerated", "title");
    assertEqual(result.ctaLabelOverride, null, "no CTA override for well_tolerated");
    assertEqual(result.demoted, false, "not demoted");
    assertEqual(result.reasonExplanations, [], "no reason explanations for well_tolerated");
    // Wording principles: no implied progression/adaptation/guaranteed safety.
    assert(!result.body.toLowerCase().includes("increase"), "never suggests increasing load");
    assert(!result.body.toLowerCase().includes("healing"), "never implies tissue healing");
  }
});

// --- 2. Caution + Maintain ---
test("2. Caution + Maintain -> normal session available, no CTA override", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "caution",
          immediateGuidance: "maintain",
          reasonCodes: ["elevated_session_pain"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
      }),
    })
  );
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.tone, "caution", "caution tone");
    assertEqual(result.title, "Last session: Caution", "title");
    assertEqual(result.ctaLabelOverride, null, "session stays normally available");
    assert(!result.title.toLowerCase().includes("bad"), "never labeled 'bad'");
  }
});

// --- 3. Caution + Maintain Cautiously ---
test("3. Caution + Maintain Cautiously -> monitoring state, session still available", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "caution",
          immediateGuidance: "maintain_cautiously",
          reasonCodes: ["borderline_morning_pain_manageable"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
      }),
    })
  );
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.tone, "attention", "attention tone (more weight than plain caution)");
    assertEqual(result.title, "Monitor today's response", "title");
    assertEqual(result.ctaLabelOverride, null, "session start is not blocked");
  }
});

// --- 4. Caution + Reduce/Modify ---
test("4. Caution + Reduce/Modify -> prominent review state, session still available via softened CTA", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "caution",
          immediateGuidance: "reduce_modify",
          reasonCodes: ["prolonged_morning_stiffness"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
      }),
    })
  );
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.tone, "reduce", "reduce tone");
    assertEqual(result.title, "Your last response suggests the current loading plan may need adjustment.", "title");
    // Founder-acceptance wording patch: exact approved copy — no exposed
    // internal decision-boundary disclaimer, no assumed clinician
    // relationship, no claim about which variable should change.
    assertEqual(
      result.body,
      "Your response indicates that some part of your current loading plan may need to be modified. Today's prescribed rehab is still available, but this response deserves extra attention.",
      "approved reduce_modify body copy"
    );
    assertEqual(result.ctaLabelOverride, "Continue to Today's Rehab", "CTA softened, not blocked");
    // Locked prohibited phrases — none of these must ever appear.
    const combined = (result.title + " " + result.body).toLowerCase();
    for (const forbidden of [
      "reduce your weight",
      "fewer sets",
      "skip today",
      "regress to stage",
      "cannot tolerate",
      "continue anyway",
      "clinician",
      "tenotrainer doesn't choose",
      "tenotrainer does not choose",
    ]) {
      assert(!combined.includes(forbidden), `must never say "${forbidden}"`);
    }
  }
});

// --- 5. Reduce/Modify + newer prescription version ---
test("5. Reduce/Modify + newer prescription version -> demoted, plan-updated note shown, CTA reverts to default", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "caution",
          immediateGuidance: "reduce_modify",
          reasonCodes: ["prolonged_morning_stiffness"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
        newerPrescriptionVersion: { exists: true, prescriptionVersionId: "version-B", createdAt: "2026-09-11T00:00:00.000Z", source: "clinician_change" },
      }),
    })
  );
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.demoted, true, "demoted once plan has changed");
    assertEqual(result.prescriptionUpdatedNote, "Your rehab plan has been updated since your last response.", "plan-updated note");
    assertEqual(result.ctaLabelOverride, null, "no longer 'continue anyway' framing — plan changed");
  }
});

// --- 6. newer version source described only factually ---
test("6. newer-version note is identical regardless of source, including legacy_bootstrap, and never mentions clinician review", () => {
  const sources: PrescriptionVersionSource[] = ["onboarding", "legacy_bootstrap", "clinician_change", "system_progression"];
  const notes = new Set<string>();
  for (const source of sources) {
    const result = computeTodaysRehabFeedback(
      input({
        guidance: guidance({
          newerPrescriptionVersion: { exists: true, prescriptionVersionId: "version-B", createdAt: "2026-09-11T00:00:00.000Z", source },
        }),
      })
    );
    assert(result.kind === "response", `kind is response for source=${source}`);
    if (result.kind === "response") {
      notes.add(result.prescriptionUpdatedNote ?? "");
      const lower = (result.prescriptionUpdatedNote ?? "").toLowerCase();
      assert(!lower.includes("clinician"), `source=${source}: never mentions clinician`);
      assert(!lower.includes("review"), `source=${source}: never claims review`);
      assert(!lower.includes("resolved"), `source=${source}: never claims resolved`);
      assert(!lower.includes("address"), `source=${source}: never claims addressed`);
    }
  }
  assertEqual(notes.size, 1, "exactly one distinct note text across all four source values — purely factual, source-independent");
});

// --- 7. same prescription version fact is threaded through ---
test("7. subsequentSessionVersionComparison 'same' is passed through unrendered but present for Stage 3", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "caution",
          immediateGuidance: "reduce_modify",
          reasonCodes: ["prolonged_morning_stiffness"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
        subsequentSession: {
          anotherSessionStarted: true,
          anotherSessionCompleted: true,
          subsequentSessionId: "session-2",
          subsequentSessionPrescriptionVersionId: "version-A",
          versionComparison: "same",
        },
      }),
    })
  );
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.subsequentSessionVersionComparison, "same", "same-version fact preserved for Stage 3 consumption");
  }
});

test("7b. subsequentSessionVersionComparison 'different' is likewise passed through", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        subsequentSession: {
          anotherSessionStarted: true,
          anotherSessionCompleted: false,
          subsequentSessionId: "session-2",
          subsequentSessionPrescriptionVersionId: "version-B",
          versionComparison: "different",
        },
      }),
    })
  );
  assert(result.kind === "response" && result.subsequentSessionVersionComparison === "different", "different-version fact preserved");
});

// --- 8. newer evaluation supersedes older evaluation ---
test("8. a superseded evaluation is never shown as current/primary feedback (defensive)", () => {
  const result = computeTodaysRehabFeedback(input({ guidance: guidance({ supersededByNewerEvaluation: true }) }));
  assertEqual(result.kind, "none", "superseded evaluation never rendered as primary feedback");
});

// --- 9. no evaluation ---
test("9. no evaluation at all -> no fabricated positive feedback", () => {
  const result = computeTodaysRehabFeedback(input({ guidance: null }));
  assertEqual(result, { kind: "none" }, "absence of evaluation is not a favorable evaluation");
});

// --- 10. unresolved source prescription identity ---
test("10. unresolved source prescription identity never produces a false same/different claim", () => {
  const result = computeTodaysRehabFeedback(
    input({
      guidance: guidance({
        sourcePrescriptionVersion: { known: false },
        subsequentSession: {
          anotherSessionStarted: true,
          anotherSessionCompleted: true,
          subsequentSessionId: "session-2",
          subsequentSessionPrescriptionVersionId: "version-A",
          versionComparison: "unknown",
        },
      }),
    })
  );
  assert(result.kind === "response", "kind is response");
  if (result.kind === "response") {
    assertEqual(result.subsequentSessionVersionComparison, "unknown", "unknown is preserved as unknown, never guessed as same/different");
  }
});

// --- 11. outstanding morning response ---
test("11. outstanding morning response -> M4 gate remains primary, no Stage 2 feedback rendered", () => {
  const result = computeTodaysRehabFeedback(input({ hasOutstandingMorningResponse: true }));
  assertEqual(result, { kind: "none" }, "Stage 2 feedback never bypasses or competes with the gate");
});

test("11b. outstanding morning response suppresses feedback even when guidance would otherwise show reduce_modify", () => {
  const result = computeTodaysRehabFeedback(
    input({
      hasOutstandingMorningResponse: true,
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "caution",
          immediateGuidance: "reduce_modify",
          reasonCodes: [],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
      }),
    })
  );
  assertEqual(result.kind, "none", "gate wins even over a prominent guidance state");
});

// --- 12. acute safety state ---
test("12. acute_override always supersedes ordinary Stage 2 states, even with a newer prescription version present", () => {
  const result = computeTodaysRehabFeedback(
    input({
      escalationLevel: 5,
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "acute_override",
          immediateGuidance: "clinical_review",
          reasonCodes: ["acute_safety_override"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
        newerPrescriptionVersion: { exists: true, prescriptionVersionId: "version-B", createdAt: "2026-09-11T00:00:00.000Z", source: "onboarding" },
      }),
    })
  );
  assertEqual(result.kind, "acute", "acute state wins, no demotion logic applied");
  if (result.kind === "acute") {
    assertEqual(result.title, "Stop Loading", "level 5 exact M3 copy reused verbatim");
  }
});

test("12b. acute_override at escalation level 3 uses the 'symptoms warrant review' copy, not 'Stop Loading'", () => {
  const result = computeTodaysRehabFeedback(
    input({
      escalationLevel: 3,
      guidance: guidance({
        evaluation: {
          id: "eval-1",
          rehabSessionId: "session-1",
          toleranceClassification: "acute_override",
          immediateGuidance: "clinical_review",
          reasonCodes: ["acute_safety_override"],
          evaluatedAt: "2026-09-10T08:00:00.000Z",
          ruleVersion: "v1",
        },
      }),
    })
  );
  assertEqual(result.kind, "acute", "kind is acute");
  if (result.kind === "acute") {
    assertEqual(result.title, "Your symptoms warrant review.", "level 3-4 exact M3 copy reused verbatim");
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
