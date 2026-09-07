// Milestone 3 — durable session-response types. Mirrors the Postgres schema
// in supabase/migrations/20260905000001_m3_session_response.sql exactly.
// Client-safe (no server-only import) — used by both API routes and UI.

export type SessionStatus =
  | "in_progress"
  | "exercises_complete"
  | "response_in_progress"
  | "awaiting_morning_response"
  | "response_complete";

export type ExerciseOutcome = "completed" | "ended_early" | "acute_terminated";

export type Difficulty = "easy" | "moderate" | "hard" | "too_hard";

export type ContributorReason =
  | "specific_exercise"
  | "overall_session_too_much"
  | "symptoms_higher_before_start"
  | "other_physical_activity"
  | "fatigue_poor_recovery"
  | "unsure"
  | "other";

// Note: "pop_reported" is the M2 Report-a-Problem event type (the patient's
// explicit action). The raw persisted fact on the session row is
// pop_felt_or_heard — see the naming distinction in the escalation evaluator.
export type SessionEventType = "equipment" | "too_difficult" | "pain_limiting" | "other" | "pop_reported";

export type PrescriptionSnapshotExercise = {
  ex_id: string;
  name: string;
  category: string;
  loading_profile: string | null;
  order_index: number;
  dosage: {
    sets?: number;
    reps_or_hold_time?: number | string;
    tempo?: string;
    rest?: string | number;
    load_kg?: number;
  };
};

export type RehabSessionRecord = {
  id: string;
  userId: string;
  planId: string | null;
  // Immutable prescription-version identity (M5 Stage 1). NULL means
  // legacy/unresolved (a session created before Stage 1) — never treat NULL
  // as "same as the current version." See
  // supabase/migrations/20260909000002_m5_stage1_session_prescription_version_link.sql
  // and web/lib/guidance.ts.
  prescriptionVersionId: string | null;
  prescriptionInstanceId: string;
  patientLocalDate: string; // YYYY-MM-DD
  status: SessionStatus;
  exerciseOutcome: ExerciseOutcome | null;
  earlyEndReason: string | null;
  startedAt: string;
  exercisesEndedAt: string | null;
  prescriptionSnapshot: PrescriptionSnapshotExercise[];
  peakSessionPain: number | null;
  difficulty: Difficulty | null;
  contributorReason: ContributorReason | null;
  contributorExerciseId: string | null;
  contributorOtherText: string | null;
  suddenOrSharpPain: boolean | null;
  popFeltOrHeard: boolean | null;
  newFunctionalDifficulty: boolean | null;
  currentEscalationLevel: number | null;
  responseRecordedAt: string | null;
};

export type SetOutcomeRecord = {
  id: string;
  rehabSessionId: string;
  exerciseId: string;
  exerciseOrderIndex: number;
  setIndex: number;
  outcome: "completed" | "skipped";
  prescribedReps: number | null;
  prescribedLoad: number | null;
  actualReps: number | null; // always null when outcome === "skipped"
  actualLoad: number | null;
  wasEdited: boolean;
  occurredAt: string;
};

export type SessionEventRecord = {
  id: string;
  rehabSessionId: string;
  exerciseId: string | null;
  setIndex: number | null;
  type: SessionEventType;
  note: string | null;
  occurredAt: string;
};

export type EscalationInputs = {
  peakSessionPain: number | null;
  suddenOrSharpPain: boolean | null;
  popFeltOrHeard: boolean | null;
  newFunctionalDifficulty: boolean | null;
  hasPainLimitingEvent: boolean;
  endedEarlyForSymptoms: boolean; // exercise_outcome === 'ended_early' && early_end_reason === 'pain_symptoms'
};

export type EscalationResult = {
  level: 0 | 1 | 2 | 3 | 4 | 5;
  reason: string;
  ruleVersion: string;
};

export type EscalationEvaluationRecord = {
  id: string;
  rehabSessionId: string;
  escalationLevel: 0 | 1 | 2 | 3 | 4 | 5;
  escalationReason: string;
  ruleVersion: string;
  inputsSnapshot: EscalationInputs;
  evaluatedAt: string;
};

export const CONTRIBUTOR_REASONS: ContributorReason[] = [
  "specific_exercise",
  "overall_session_too_much",
  "symptoms_higher_before_start",
  "other_physical_activity",
  "fatigue_poor_recovery",
  "unsure",
  "other",
];

export const DIFFICULTY_OPTIONS: Difficulty[] = ["easy", "moderate", "hard", "too_hard"];

// Postgres/PostgREST returns raw snake_case column names — every API route
// that hands a rehab_sessions row back to the client must pass it through
// this mapper first, so RehabSessionRecord's camelCase shape is actually what
// callers receive (a raw row here would silently read as all-undefined).
export function mapRehabSessionRow(row: Record<string, unknown>): RehabSessionRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    planId: (row.plan_id as string | null) ?? null,
    prescriptionVersionId: (row.prescription_version_id as string | null) ?? null,
    prescriptionInstanceId: row.prescription_instance_id as string,
    patientLocalDate: row.patient_local_date as string,
    status: row.status as SessionStatus,
    exerciseOutcome: (row.exercise_outcome as ExerciseOutcome | null) ?? null,
    earlyEndReason: (row.early_end_reason as string | null) ?? null,
    startedAt: row.started_at as string,
    exercisesEndedAt: (row.exercises_ended_at as string | null) ?? null,
    prescriptionSnapshot: (row.prescription_snapshot as PrescriptionSnapshotExercise[]) ?? [],
    peakSessionPain: (row.peak_session_pain as number | null) ?? null,
    difficulty: (row.difficulty as Difficulty | null) ?? null,
    contributorReason: (row.contributor_reason as ContributorReason | null) ?? null,
    contributorExerciseId: (row.contributor_exercise_id as string | null) ?? null,
    contributorOtherText: (row.contributor_other_text as string | null) ?? null,
    suddenOrSharpPain: (row.sudden_or_sharp_pain as boolean | null) ?? null,
    popFeltOrHeard: (row.pop_felt_or_heard as boolean | null) ?? null,
    newFunctionalDifficulty: (row.new_functional_difficulty as boolean | null) ?? null,
    currentEscalationLevel: (row.current_escalation_level as number | null) ?? null,
    responseRecordedAt: (row.response_recorded_at as string | null) ?? null,
  };
}

// Does this session's currently-known facts require the acute assessment
// (sudden/sharp pain, pop, new functional difficulty)? Per the locked
// triggers: (A) a pop was reported during M2, or (B) the session ended early
// specifically for symptoms with a pain_limiting event on record. Ordinary
// completed sessions with no such context are never shown this screen.
export function acuteAssessmentRequired(params: {
  exerciseOutcome: ExerciseOutcome | null;
  earlyEndReason: string | null;
  hasPopEvent: boolean;
  hasPainLimitingEvent: boolean;
}): boolean {
  if (params.hasPopEvent || params.exerciseOutcome === "acute_terminated") return true;
  if (params.exerciseOutcome === "ended_early" && params.earlyEndReason === "pain_symptoms" && params.hasPainLimitingEvent) {
    return true;
  }
  return false;
}
