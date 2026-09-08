// Milestone 5, Stage 3 — session-guidance-context row mapper test.
//
// Note on Stage 3 test coverage: unlike guidance.ts/toleranceEvaluation.ts,
// Stage 3's actual derivation logic (most-recent-evaluation selection,
// same/different/unknown comparison, idempotent capture) lives entirely in
// the capture_session_guidance_context() Postgres function — it is not
// duplicated in TypeScript, to avoid two implementations drifting apart at
// a transaction-safety-critical boundary. That logic was verified via 36
// live scenario/idempotency checks against the linked development database
// (see the M5 Stage 3 completion report) — matching this repo's existing
// precedent for RPC-level behavior (M5 Stage 1's session-creation RPC was
// verified the same way, not via a committed TypeScript test). This file
// covers the one piece of Stage 3's TS layer that IS a pure function: the
// row mapper.

import { mapSessionGuidanceContextRow } from "../sessionGuidanceContextTypes";

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

test("mapSessionGuidanceContextRow maps every snake_case column to its camelCase field", () => {
  const row = {
    id: "ctx-1",
    rehab_session_id: "session-2",
    source_tolerance_evaluation_id: "eval-1",
    source_rehab_session_id: "session-1",
    source_tolerance_classification: "caution",
    source_immediate_guidance: "reduce_modify",
    source_prescription_version_id: "version-A",
    session_prescription_version_id: "version-A",
    prescription_version_comparison: "same",
    created_at: "2026-09-10T08:00:00.000Z",
  };
  assertEqual(
    mapSessionGuidanceContextRow(row),
    {
      id: "ctx-1",
      rehabSessionId: "session-2",
      sourceToleranceEvaluationId: "eval-1",
      sourceRehabSessionId: "session-1",
      sourceToleranceClassification: "caution",
      sourceImmediateGuidance: "reduce_modify",
      sourcePrescriptionVersionId: "version-A",
      sessionPrescriptionVersionId: "version-A",
      prescriptionVersionComparison: "same",
      createdAt: "2026-09-10T08:00:00.000Z",
    },
    "full row mapping"
  );
});

test("mapSessionGuidanceContextRow preserves NULL source/session prescription version ids (never fabricated)", () => {
  const row = {
    id: "ctx-2",
    rehab_session_id: "session-4",
    source_tolerance_evaluation_id: "eval-3",
    source_rehab_session_id: "session-3",
    source_tolerance_classification: "well_tolerated",
    source_immediate_guidance: "maintain",
    source_prescription_version_id: null,
    session_prescription_version_id: null,
    prescription_version_comparison: "unknown",
    created_at: "2026-09-10T09:00:00.000Z",
  };
  const mapped = mapSessionGuidanceContextRow(row);
  assertEqual(mapped.sourcePrescriptionVersionId, null, "source version id null preserved");
  assertEqual(mapped.sessionPrescriptionVersionId, null, "session version id null preserved");
  assertEqual(mapped.prescriptionVersionComparison, "unknown", "comparison preserved");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
