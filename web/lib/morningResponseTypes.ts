// Milestone 4, Stage 1 — durable types for the Morning Response step.
// Mirrors supabase/migrations/20260906000001_m4_stage1_foundation.sql exactly.
// Client-safe (no server-only import).

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
  patientNote: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Direction only — Stage 1 creates no logic that assigns these. See
// tolerance_evaluations' migration comment: the column is free TEXT, not a
// CHECK-constrained enum, specifically so this list is not accidentally
// locked in via a schema detail before it's clinically approved.
export type ToleranceClassification = "well_tolerated" | "maintain" | "adjust" | "insufficient_data";

export type ToleranceEvaluationRecord = {
  id: string;
  rehabSessionId: string;
  morningResponseId: string;
  toleranceClassification: string;
  patientFacingLabel: string;
  reason: string;
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
    patientNote: (row.patient_note as string | null) ?? null,
    submittedAt: (row.submitted_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
