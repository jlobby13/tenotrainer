// Acute Safety Gate + Resolution Lifecycle — client-safe types. Mirrors the
// Postgres schema in
// supabase/migrations/20260911000001_m5_acute_safety_gate.sql exactly.

export type AcuteEpisodeLevel = 3 | 5;
export type EffectiveAcuteLevel = 3 | 4 | 5;
export type ReleasePath = "self_resolved_no_evaluation" | "professional_clearance" | "professional_clearance_with_prescription";
export type Level4Reason = "unresolved_over_48_hours" | "three_blocked_opportunities" | "recurrent_level_3_episodes";

export type AcuteSafetyEpisodeRecord = {
  id: string;
  userId: string;
  sourceRehabSessionId: string;
  sourceEscalationEvaluationId: string;
  initialLevel: AcuteEpisodeLevel;
  initialSuddenOrSharpPain: boolean;
  initialNewFunctionalDifficulty: boolean;
  initialPopFeltOrHeard: boolean;
  recurrenceWindowAnchorId: string | null;
  recurrenceSequenceInWindow: number;
  level4Recurrent: boolean;
  confirmedAt: string;
  createdAt: string;
};

export type AcuteSafetyReassessmentRecord = {
  id: string;
  acuteSafetyEpisodeId: string;
  userId: string;
  suddenOrSharpPainResolved: boolean | null;
  newFunctionalDifficultyResolved: boolean | null;
  evaluatedByProfessional: boolean;
  clearedByProfessional: boolean | null;
  submittedAt: string;
};

export type AcuteSafetyReleaseRecord = {
  id: string;
  acuteSafetyEpisodeId: string;
  userId: string;
  releasePath: ReleasePath;
  sourceReassessmentId: string | null;
  sourcePrescriptionVersionId: string | null;
  releasedAt: string;
};

export type BlockedLoadingOpportunityRecord = {
  id: string;
  userId: string;
  acuteSafetyEpisodeId: string;
  prescriptionInstanceId: string;
  brakeLevel: EffectiveAcuteLevel;
  blockedAt: string;
};

export type CautiousReturnContextRecord = {
  id: string;
  rehabSessionId: string;
  acuteSafetyReleaseId: string;
  acuteSafetyEpisodeId: string;
  createdAt: string;
};

// The one canonical brake-status derivation, mirroring
// get_patient_acute_brake_status()'s return shape exactly.
export type AcuteBrakeStatus = {
  episodeId: string;
  initialLevel: AcuteEpisodeLevel;
  confirmedAt: string;
  effectiveLevel: EffectiveAcuteLevel;
  level4Reasons: Level4Reason[];
  blockedOpportunityCount: number;
} | null; // null = no active brake

export function mapAcuteSafetyEpisodeRow(row: Record<string, unknown>): AcuteSafetyEpisodeRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    sourceRehabSessionId: row.source_rehab_session_id as string,
    sourceEscalationEvaluationId: row.source_escalation_evaluation_id as string,
    initialLevel: row.initial_level as AcuteEpisodeLevel,
    initialSuddenOrSharpPain: row.initial_sudden_or_sharp_pain as boolean,
    initialNewFunctionalDifficulty: row.initial_new_functional_difficulty as boolean,
    initialPopFeltOrHeard: row.initial_pop_felt_or_heard as boolean,
    recurrenceWindowAnchorId: (row.recurrence_window_anchor_id as string | null) ?? null,
    recurrenceSequenceInWindow: row.recurrence_sequence_in_window as number,
    level4Recurrent: row.level4_recurrent as boolean,
    confirmedAt: row.confirmed_at as string,
    createdAt: row.created_at as string,
  };
}

export function mapAcuteSafetyReassessmentRow(row: Record<string, unknown>): AcuteSafetyReassessmentRecord {
  return {
    id: row.id as string,
    acuteSafetyEpisodeId: row.acute_safety_episode_id as string,
    userId: row.user_id as string,
    suddenOrSharpPainResolved: (row.sudden_or_sharp_pain_resolved as boolean | null) ?? null,
    newFunctionalDifficultyResolved: (row.new_functional_difficulty_resolved as boolean | null) ?? null,
    evaluatedByProfessional: row.evaluated_by_professional as boolean,
    clearedByProfessional: (row.cleared_by_professional as boolean | null) ?? null,
    submittedAt: row.submitted_at as string,
  };
}

export function mapAcuteSafetyReleaseRow(row: Record<string, unknown>): AcuteSafetyReleaseRecord {
  return {
    id: row.id as string,
    acuteSafetyEpisodeId: row.acute_safety_episode_id as string,
    userId: row.user_id as string,
    releasePath: row.release_path as ReleasePath,
    sourceReassessmentId: (row.source_reassessment_id as string | null) ?? null,
    sourcePrescriptionVersionId: (row.source_prescription_version_id as string | null) ?? null,
    releasedAt: row.released_at as string,
  };
}
