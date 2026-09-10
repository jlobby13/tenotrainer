// Milestone 5, Stage 1 — immutable prescription-version identity types.
// Mirrors the Postgres schema in
// supabase/migrations/20260909000001_m5_stage1_prescription_versions.sql
// exactly. Client-safe (no server-only import).
//
// See that migration's header comment for the Prescription Version vs.
// rehab_sessions.prescription_snapshot distinction — this type captures
// CLINICAL PLAN STATE (stage/irritability/insertional), not exact exercise
// exposure, which remains prescription_snapshot's job.

export type Irritability = "low" | "moderate" | "high";

export type PrescriptionVersionSource =
  | "onboarding"
  | "legacy_bootstrap"
  | "clinician_change"
  | "system_progression";

export type PrescriptionVersionRecord = {
  id: string;
  userId: string;
  stage: number;
  irritability: Irritability;
  isInsertional: boolean;
  source: PrescriptionVersionSource;
  legacyPlanId: string | null;
  createdAt: string;
  // Milestone 5, Stage 4 closure patch — see
  // supabase/migrations/20260909000003_m5_stage4_rehab_schedule_eligibility.sql
  // and web/lib/rehabSchedule.ts. NULL = unknown (no schedule identity on
  // file — never treated as daily or any other guessed cadence). Elements
  // are 0=Sunday..6=Saturday. Nothing currently writes a non-NULL value.
  rehabDaysOfWeek: number[] | null;
};

// Postgres/PostgREST returns raw snake_case column names — see
// rehabSessionTypes.ts's mapRehabSessionRow for why this mapper exists.
export function mapPrescriptionVersionRow(row: Record<string, unknown>): PrescriptionVersionRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    stage: row.stage as number,
    irritability: row.irritability as Irritability,
    isInsertional: row.is_insertional as boolean,
    source: row.source as PrescriptionVersionSource,
    legacyPlanId: (row.legacy_plan_id as string | null) ?? null,
    createdAt: row.created_at as string,
    rehabDaysOfWeek: (row.rehab_days_of_week as number[] | null) ?? null,
  };
}
