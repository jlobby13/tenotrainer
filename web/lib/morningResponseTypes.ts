// Milestone 4 — durable types for the Morning Response step and its Stage 4
// tolerance interpretation. Mirrors the M4 migrations exactly. Client-safe
// (no server-only import).

export type StiffnessDuration = "not_applicable" | "lt_5_min" | "min_5_15" | "min_15_30" | "gt_30_min";
export type MorningPainTolerability = "manageable" | "difficult_to_tolerate";

export type ExternalLoadCategory =
  | "running"
  | "sport"
  | "prolonged_walking_standing"
  | "other_lower_body_training"
  | "unusually_high_activity"
  | "other"
  | "none";

export type ExternalLoadTiming = "previous_day" | "same_day_before_rehab" | "same_day_after_rehab";

export const EXTERNAL_LOAD_CATEGORIES: ExternalLoadCategory[] = [
  "running",
  "sport",
  "prolonged_walking_standing",
  "other_lower_body_training",
  "unusually_high_activity",
  "other",
];

export const EXTERNAL_LOAD_TIMINGS: ExternalLoadTiming[] = [
  "previous_day",
  "same_day_before_rehab",
  "same_day_after_rehab",
];

export type MorningResponseRecord = {
  id: string;
  rehabSessionId: string;
  userId: string;
  // NULL until the patient's IANA timezone is known — see
  // morningResponseServer.ts. UNKNOWN TIMEZONE != UTC TIMEZONE: this is never
  // defaulted to a computed value just because it's missing.
  scheduledEligibleAt: string | null;
  nextMorningPain: number | null;
  nextMorningStiffness: number | null;
  // "not_applicable" is itself a real, valid value (set once stiffness=0 is
  // known) — distinct from null (not yet known/asked). See
  // toleranceEvaluation.ts's required-data validation.
  stiffnessDuration: StiffnessDuration | null;
  // Only ever asked/required when nextMorningPain === 5 (see section 8 of
  // the Stage 4 brief) — null otherwise, never fabricated.
  morningPainTolerability: MorningPainTolerability | null;
  // null = not asked/answered yet (UNKNOWN). An explicit ["none"] means the
  // patient was asked and confirmed nothing relevant happened — these are
  // deliberately distinct states, never conflated.
  externalLoadCategories: ExternalLoadCategory[] | null;
  externalLoadTiming: ExternalLoadTiming[] | null;
  patientNote: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Locked in Stage 4 — see tolerance_evaluations_classification_check.
export type ToleranceClassification =
  | "well_tolerated"
  | "caution"
  | "poorly_tolerated"
  | "acute_override"
  | "insufficient_data";

// Persisted as a SEPARATE concept from tolerance, per the Stage 4 brief:
// "Well Tolerated != Progress" — this is deliberately never a positive
// "progress"/"advance" value. See tolerance_evaluations_guidance_check.
export type ImmediateGuidance = "maintain" | "maintain_cautiously" | "reduce_modify" | "clinical_review";

export type ToleranceEvaluationRecord = {
  id: string;
  rehabSessionId: string;
  morningResponseId: string;
  toleranceClassification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance;
  patientFacingLabel: string;
  reason: string;
  reasonCodes: string[];
  ruleVersion: string;
  inputsSnapshot: Record<string, unknown>;
  evaluatedAt: string;
};

// Postgres/PostgREST returns raw snake_case column names — see
// rehabSessionTypes.ts's mapRehabSessionRow for why this mapper exists.
export function mapMorningResponseRow(row: Record<string, unknown>): MorningResponseRecord {
  return {
    id: row.id as string,
    rehabSessionId: row.rehab_session_id as string,
    userId: row.user_id as string,
    scheduledEligibleAt: (row.scheduled_eligible_at as string | null) ?? null,
    nextMorningPain: (row.next_morning_pain as number | null) ?? null,
    nextMorningStiffness: (row.next_morning_stiffness as number | null) ?? null,
    stiffnessDuration: (row.stiffness_duration as StiffnessDuration | null) ?? null,
    morningPainTolerability: (row.morning_pain_tolerability as MorningPainTolerability | null) ?? null,
    externalLoadCategories: (row.external_load_categories as ExternalLoadCategory[] | null) ?? null,
    externalLoadTiming: (row.external_load_timing as ExternalLoadTiming[] | null) ?? null,
    patientNote: (row.patient_note as string | null) ?? null,
    submittedAt: (row.submitted_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapToleranceEvaluationRow(row: Record<string, unknown>): ToleranceEvaluationRecord {
  return {
    id: row.id as string,
    rehabSessionId: row.rehab_session_id as string,
    morningResponseId: row.morning_response_id as string,
    toleranceClassification: row.tolerance_classification as ToleranceClassification,
    immediateGuidance: row.immediate_guidance as ImmediateGuidance,
    patientFacingLabel: row.patient_facing_label as string,
    reason: row.reason as string,
    reasonCodes: (row.reason_codes as string[] | null) ?? [],
    ruleVersion: row.rule_version as string,
    inputsSnapshot: (row.inputs_snapshot as Record<string, unknown>) ?? {},
    evaluatedAt: row.evaluated_at as string,
  };
}
