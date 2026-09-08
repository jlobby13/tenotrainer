// Milestone 5, Stage 3 — immutable session-guidance-handoff types. Mirrors
// the Postgres schema in
// supabase/migrations/20260910000001_m5_stage3_session_guidance_contexts.sql
// exactly. Client-safe (no server-only import).
//
// A row here is a FACT snapshot: "this evaluation, with this classification/
// guidance, existed and was the most recent one when this session began,
// and the two sessions' prescription versions compared this way." It is
// NEVER interpretation — see the migration's header comment for the full
// list of concepts this must not be read as (noncompliance, override,
// clinician review/approval, guidance resolution, escalation, etc.).

import type { ImmediateGuidance, ToleranceClassification } from "./morningResponseTypes";
import type { VersionComparison } from "./guidance";

export type SessionGuidanceContextRecord = {
  id: string;
  rehabSessionId: string;
  sourceToleranceEvaluationId: string;
  sourceRehabSessionId: string;
  sourceToleranceClassification: ToleranceClassification;
  sourceImmediateGuidance: ImmediateGuidance;
  sourcePrescriptionVersionId: string | null;
  sessionPrescriptionVersionId: string | null;
  prescriptionVersionComparison: VersionComparison;
  createdAt: string;
};

// Postgres/PostgREST returns raw snake_case column names — see
// rehabSessionTypes.ts's mapRehabSessionRow for why this mapper exists.
export function mapSessionGuidanceContextRow(row: Record<string, unknown>): SessionGuidanceContextRecord {
  return {
    id: row.id as string,
    rehabSessionId: row.rehab_session_id as string,
    sourceToleranceEvaluationId: row.source_tolerance_evaluation_id as string,
    sourceRehabSessionId: row.source_rehab_session_id as string,
    sourceToleranceClassification: row.source_tolerance_classification as ToleranceClassification,
    sourceImmediateGuidance: row.source_immediate_guidance as ImmediateGuidance,
    sourcePrescriptionVersionId: (row.source_prescription_version_id as string | null) ?? null,
    sessionPrescriptionVersionId: (row.session_prescription_version_id as string | null) ?? null,
    prescriptionVersionComparison: row.prescription_version_comparison as VersionComparison,
    createdAt: row.created_at as string,
  };
}
