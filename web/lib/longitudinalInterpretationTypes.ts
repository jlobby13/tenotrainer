// Milestone 6, Stage 3A — durable longitudinal-interpretation types. Mirrors
// the Postgres schema in
// supabase/migrations/20260911000007_m6_stage3a_longitudinal_interpretations.sql
// exactly. Client-safe (no server-only import).
//
// ARCHITECTURE ONLY: no inference engine writes these rows yet (Stage 3B+).
// A row here, once it exists, is an immutable FACT: "this ruleset version,
// evaluating this domain over this window, produced this coded result, from
// exactly these source observations." It is derived from — and must never
// be confused with — the raw layers it references (rehab_sessions,
// morning_responses, tolerance_evaluations, prescription_versions) or the
// clinician-review layer above it (not built yet).
//
// `domain` and `resultState` are intentionally untyped (plain string, not a
// union) — the classifier vocabulary is not locked yet. See the migration's
// header comment for the tolerance_evaluations Stage 1 precedent this
// mirrors. Do not add a union type here until Stage 3B locks the vocabulary.

// Milestone 6, Stage 3A: the explicit ruleset/model version identifier for
// M6 longitudinal interpretation, mirroring ESCALATION_RULE_VERSION (M3,
// lib/escalation.ts) and TOLERANCE_RULE_VERSION (M4, lib/toleranceEvaluation.ts)
// exactly — a plain exported constant, not a database-backed versions
// registry (see the migration header for why that alternative was
// considered and rejected). NOT YET WRITTEN ANYWHERE: no inference engine
// exists yet (Stage 3B+ builds it), so this constant is reserved, not in
// use. It does NOT represent a validated clinical instrument — it identifies
// which iteration of the (not-yet-built) ruleset would have produced a
// given row, nothing more.
export const LONGITUDINAL_RULESET_VERSION = "m6_longitudinal_v1";

export type InterpretationReasonCode =
  | "limited_coverage"
  | "mixed_symptom_directions"
  | "high_response_variability"
  | "recent_prescription_change"
  | "limited_comparable_exposures"
  | "external_loading_context_present"
  | "capacity_response_mismatch";

export const INTERPRETATION_REASON_CODES: InterpretationReasonCode[] = [
  "limited_coverage",
  "mixed_symptom_directions",
  "high_response_variability",
  "recent_prescription_change",
  "limited_comparable_exposures",
  "external_loading_context_present",
  "capacity_response_mismatch",
];

export type LongitudinalInterpretationRecord = {
  id: string;
  userId: string;
  // Free text — see header note. Not yet a locked vocabulary.
  domain: string;
  rulesetVersion: string;
  windowDefinition: Record<string, unknown>;
  windowStartDate: string | null;
  windowEndDate: string | null;
  // Free text — see header note. Not yet a locked vocabulary.
  resultState: string;
  resultDetail: Record<string, unknown>;
  generatedAt: string;
};

// One interpretation's full provenance — everything needed to reconstruct
// "what this row is based on" without re-deriving it. Assembled from five
// separate join tables server-side (see longitudinalInterpretationServer.ts)
// rather than stored inline, so each reference stays a real, queryable FK.
export type InterpretationProvenance = {
  interpretationId: string;
  reasonCodes: InterpretationReasonCode[];
  rehabSessionIds: string[];
  morningResponseIds: string[];
  toleranceEvaluationIds: string[];
  prescriptionVersionIds: string[];
  heuristicIds: string[];
};

export function mapLongitudinalInterpretationRow(row: Record<string, unknown>): LongitudinalInterpretationRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    domain: row.domain as string,
    rulesetVersion: row.ruleset_version as string,
    windowDefinition: (row.window_definition as Record<string, unknown>) ?? {},
    windowStartDate: (row.window_start_date as string | null) ?? null,
    windowEndDate: (row.window_end_date as string | null) ?? null,
    resultState: row.result_state as string,
    resultDetail: (row.result_detail as Record<string, unknown>) ?? {},
    generatedAt: row.generated_at as string,
  };
}
