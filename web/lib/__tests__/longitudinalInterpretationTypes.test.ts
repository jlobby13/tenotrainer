// Milestone 6, Stage 3A — longitudinal-interpretation row mapper test.
//
// Note on Stage 3A test coverage: there is no inference/derivation logic to
// test yet (Stage 3A is architecture only — see the migration header in
// supabase/migrations/20260911000007_m6_stage3a_longitudinal_interpretations.sql).
// This covers the one pure function that exists: the row mapper. Live
// schema/RLS/provenance behavior is covered by
// scripts/verifyM6Stage3aSchema.mjs, matching this repo's existing
// precedent (see sessionGuidanceContextTypes.test.ts's own note) of
// verifying RPC/DB-level behavior against the linked development database
// rather than duplicating it in a committed pure-function test — that
// script could not be run in this pass because the migration is not yet
// applied to the live database (see the Stage 3A report).
import { mapLongitudinalInterpretationRow } from "../longitudinalInterpretationTypes";

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

test("mapLongitudinalInterpretationRow maps every snake_case column to its camelCase field", () => {
  const row = {
    id: "interp-1",
    user_id: "user-1",
    domain: "symptoms_short_window",
    ruleset_version: "m6_longitudinal_v1",
    window_definition: { kind: "rolling_5_plus_5", unit: "sessions" },
    window_start_date: "2026-08-01",
    window_end_date: "2026-08-15",
    result_state: "insufficient_data",
    result_detail: { observedCount: 3 },
    generated_at: "2026-09-11T08:00:00.000Z",
  };
  assertEqual(
    mapLongitudinalInterpretationRow(row),
    {
      id: "interp-1",
      userId: "user-1",
      domain: "symptoms_short_window",
      rulesetVersion: "m6_longitudinal_v1",
      windowDefinition: { kind: "rolling_5_plus_5", unit: "sessions" },
      windowStartDate: "2026-08-01",
      windowEndDate: "2026-08-15",
      resultState: "insufficient_data",
      resultDetail: { observedCount: 3 },
      generatedAt: "2026-09-11T08:00:00.000Z",
    },
    "full row mapping"
  );
});

test("mapLongitudinalInterpretationRow preserves NULL window dates (never guessed) and defaults missing JSON to {}", () => {
  const row = {
    id: "interp-2",
    user_id: "user-2",
    domain: "capacity_series",
    ruleset_version: "m6_longitudinal_v1",
    window_definition: null,
    window_start_date: null,
    window_end_date: null,
    result_state: "insufficient_data",
    result_detail: null,
    generated_at: "2026-09-11T09:00:00.000Z",
  };
  const mapped = mapLongitudinalInterpretationRow(row);
  assertEqual(mapped.windowStartDate, null, "window start date null preserved");
  assertEqual(mapped.windowEndDate, null, "window end date null preserved");
  assertEqual(mapped.windowDefinition, {}, "null window_definition defaults to {}, never fabricated content");
  assertEqual(mapped.resultDetail, {}, "null result_detail defaults to {}, never fabricated content");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
