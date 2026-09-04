// Client-side Active Rehab Session state — Milestone 2.
//
// Conceptual separation preserved per architecture lock:
//   prescriptionSnapshot  = what was prescribed when this workout began (frozen, never mutated)
//   exerciseStates        = what actually occurred during this workout (actual performance, events)
//
// This is durable-but-local state (localStorage) for Milestone 2 only. Milestone 3 owns
// validating/submitting it into a real server-side session record. Ephemeral UI state
// (open/closed sheets, in-progress edit-form values, rest-timer countdown, animations)
// must never be persisted here — it lives in component-local React state instead.
// Previous-performance history is read-only context, not part of this record — held
// separately by the caller, never merged into ActiveSessionState.

import type { SessionExercise } from "./fastapi";

export const SESSION_SCHEMA_VERSION = 1 as const;

export type ExerciseExecutionStatus = "not_started" | "in_progress" | "completed" | "skipped";

export type ProblemType = "equipment" | "too_difficult" | "pain_limiting" | "other";

export type EarlyEndReason =
  | "finished_what_i_could"
  | "ran_out_of_time"
  | "equipment_unavailable"
  | "pain_symptoms"
  | "other";

// Milestone 2 only completes the guided-exercise portion — "completed_exercises",
// not a generic "completed". Milestone 3 still owns peak pain, difficulty, safety
// follow-up, and final submission before a session is truly complete.
export type SessionStatus = "active" | "paused" | "completed_exercises" | "ended_early";

export type ActualSet = {
  setIndex: number;
  reps: number;
  load?: number;
  wasEdited: boolean;
  completedAt: string;
};

export type ProblemReport = {
  id: string;
  type: ProblemType;
  occurredAt: string;
  exerciseId: string;
  setNumber?: number;
  note?: string;
};

export type ExerciseExecutionState = {
  exerciseId: string;
  status: ExerciseExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  actualSets: ActualSet[]; // only completed/edited sets appear; prescribed values are derived, never stored here
  problemReports: ProblemReport[];
};

export type PrescriptionSnapshot = {
  takenAt: string;
  exercises: SessionExercise[]; // frozen copy of session_plan at session start — never mutated
};

export type ActiveSessionState = {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  sessionInstanceId: string;
  patientId: string;
  planId: string | null;
  startedAt: string;
  lastUpdatedAt: string;
  pausedAt: string | null;
  completedAt: string | null;
  status: SessionStatus;
  earlyEndReason?: EarlyEndReason;
  prescriptionSnapshot: PrescriptionSnapshot;
  exerciseStates: ExerciseExecutionState[]; // parallel to prescriptionSnapshot.exercises
  // Current SET position is deliberately not persisted here — it's fully and
  // reliably derivable from exerciseStates[currentExerciseIndex].actualSets via
  // getNextPendingSetIndex(), so storing it separately would be a redundant,
  // easy-to-desync source of truth.
  currentExerciseIndex: number;
};

// ---------------------------------------------------------------------------
// Derived values — never persisted, always computed from the snapshot/state
// ---------------------------------------------------------------------------

function toNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

export function getTotalSets(exercise: SessionExercise): number {
  return toNumber(exercise.dosage?.sets, 1);
}

export function getPrescribedSet(exercise: SessionExercise): { reps: number; load?: number } {
  // Canonical field is "reps_or_hold_time" (not "reps") and may be a descriptive
  // string ("45s hold") — this extracts its numeric magnitude for recording an
  // actual value; display code should use exerciseDisplay's repsOrHoldLabel
  // instead, which preserves the original wording.
  const reps = toNumber(exercise.dosage?.reps_or_hold_time, 0);
  const loadRaw = exercise.dosage?.load_kg ?? exercise.dosage?.load;
  const load = loadRaw === undefined || loadRaw === null ? undefined : toNumber(loadRaw, 0);
  return { reps, load };
}

export function isExerciseFullyCompleted(state: ExerciseExecutionState, totalSets: number): boolean {
  if (totalSets <= 0) return false;
  const done = new Set(state.actualSets.map((s) => s.setIndex));
  for (let i = 0; i < totalSets; i++) if (!done.has(i)) return false;
  return true;
}

export function getNextPendingSetIndex(state: ExerciseExecutionState, totalSets: number): number | null {
  const done = new Set(state.actualSets.map((s) => s.setIndex));
  for (let i = 0; i < totalSets; i++) if (!done.has(i)) return i;
  return null; // all sets completed
}

export function hasPainLimitingReport(state: ActiveSessionState): boolean {
  return state.exerciseStates.some((ex) => ex.problemReports.some((r) => r.type === "pain_limiting"));
}

export function isSessionFinished(state: ActiveSessionState): boolean {
  return state.status === "completed_exercises" || state.status === "ended_early";
}

export function isStale(state: ActiveSessionState, maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  return Date.now() - new Date(state.lastUpdatedAt).getTime() > maxAgeMs;
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function touch(state: ActiveSessionState): ActiveSessionState {
  return { ...state, lastUpdatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

export function createSession(params: {
  patientId: string;
  planId: string | null;
  sessionPlan: SessionExercise[];
}): ActiveSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionInstanceId: genId(),
    patientId: params.patientId,
    planId: params.planId,
    startedAt: now,
    lastUpdatedAt: now,
    pausedAt: null,
    completedAt: null,
    status: "active",
    prescriptionSnapshot: { takenAt: now, exercises: params.sessionPlan },
    exerciseStates: params.sessionPlan.map((ex) => ({
      exerciseId: ex.exercise.ex_id,
      status: "not_started",
      startedAt: null,
      completedAt: null,
      actualSets: [],
      problemReports: [],
    })),
    currentExerciseIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// Set-level transitions
// ---------------------------------------------------------------------------

export function completeSet(
  state: ActiveSessionState,
  exerciseIndex: number,
  setIndex: number,
  actual: { reps: number; load?: number },
  wasEdited: boolean
): ActiveSessionState {
  const now = new Date().toISOString();
  const exerciseStates = state.exerciseStates.map((ex, i) => {
    if (i !== exerciseIndex) return ex;
    const withoutThisSet = ex.actualSets.filter((s) => s.setIndex !== setIndex);
    const actualSets = [
      ...withoutThisSet,
      { setIndex, reps: actual.reps, load: actual.load, wasEdited, completedAt: now },
    ].sort((a, b) => a.setIndex - b.setIndex);
    const totalSets = getTotalSets(state.prescriptionSnapshot.exercises[i]);
    const fullyDone = isExerciseFullyCompleted({ ...ex, actualSets }, totalSets);
    return {
      ...ex,
      status: (fullyDone ? "completed" : "in_progress") as ExerciseExecutionStatus,
      startedAt: ex.startedAt ?? now,
      completedAt: fullyDone ? now : null,
      actualSets,
    };
  });
  return touch({ ...state, exerciseStates });
}

export function undoSet(state: ActiveSessionState, exerciseIndex: number, setIndex: number): ActiveSessionState {
  const exerciseStates = state.exerciseStates.map((ex, i) => {
    if (i !== exerciseIndex) return ex;
    const actualSets = ex.actualSets.filter((s) => s.setIndex !== setIndex);
    return {
      ...ex,
      actualSets,
      status: (actualSets.length > 0 ? "in_progress" : "not_started") as ExerciseExecutionStatus,
      completedAt: null,
    };
  });
  return touch({ ...state, exerciseStates });
}

// ---------------------------------------------------------------------------
// Exercise-level transitions
// ---------------------------------------------------------------------------

export function skipExercise(state: ActiveSessionState, exerciseIndex: number): ActiveSessionState {
  const now = new Date().toISOString();
  const exerciseStates = state.exerciseStates.map((ex, i) =>
    i === exerciseIndex ? { ...ex, status: "skipped" as ExerciseExecutionStatus, completedAt: now } : ex
  );
  return touch({ ...state, exerciseStates });
}

export function advanceToNextExercise(state: ActiveSessionState): ActiveSessionState {
  return touch({ ...state, currentExerciseIndex: state.currentExerciseIndex + 1 });
}

export function completeAllExercises(state: ActiveSessionState): ActiveSessionState {
  const now = new Date().toISOString();
  return touch({ ...state, status: "completed_exercises", completedAt: now });
}

// ---------------------------------------------------------------------------
// Problem reports
// ---------------------------------------------------------------------------

export function reportProblem(
  state: ActiveSessionState,
  exerciseIndex: number,
  report: { type: ProblemType; note?: string; setNumber?: number }
): ActiveSessionState {
  const now = new Date().toISOString();
  const exerciseId = state.prescriptionSnapshot.exercises[exerciseIndex]?.exercise.ex_id ?? "";
  const exerciseStates = state.exerciseStates.map((ex, i) => {
    if (i !== exerciseIndex) return ex;
    const problemReports: ProblemReport[] = [
      ...ex.problemReports,
      {
        id: genId(),
        type: report.type,
        occurredAt: now,
        exerciseId,
        setNumber: report.setNumber,
        note: report.note,
      },
    ];
    return { ...ex, problemReports };
  });
  return touch({ ...state, exerciseStates });
}

// ---------------------------------------------------------------------------
// Session-level lifecycle
// ---------------------------------------------------------------------------

export function pauseSession(state: ActiveSessionState): ActiveSessionState {
  const now = new Date().toISOString();
  return touch({ ...state, status: "paused", pausedAt: now });
}

export function resumeSession(state: ActiveSessionState): ActiveSessionState {
  return touch({ ...state, status: "active", pausedAt: null });
}

export function endSessionEarly(state: ActiveSessionState, reason: EarlyEndReason): ActiveSessionState {
  const now = new Date().toISOString();
  return touch({ ...state, status: "ended_early", earlyEndReason: reason, completedAt: now });
}

// ---------------------------------------------------------------------------
// localStorage persistence — durable session state only
// ---------------------------------------------------------------------------

function storageKey(patientId: string): string {
  return `tenotrainer.activeSession.v${SESSION_SCHEMA_VERSION}.${patientId}`;
}

export function loadSession(patientId: string): ActiveSessionState | null {
  try {
    const raw = window.localStorage.getItem(storageKey(patientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveSessionState;
    if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION) return null;
    if (parsed.patientId !== patientId) return null;
    if (isStale(parsed)) return null;
    if (isSessionFinished(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(state: ActiveSessionState): void {
  try {
    window.localStorage.setItem(storageKey(state.patientId), JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode, quota, disabled) — session just won't survive a refresh this time.
  }
}

export function clearSession(patientId: string): void {
  try {
    window.localStorage.removeItem(storageKey(patientId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Session-opening reminder dismissal — a standing preference, not session data.
// Deliberately a separate key so it isn't wiped when a session completes/resets.
// ---------------------------------------------------------------------------

function reminderKey(patientId: string): string {
  return `tenotrainer.sessionReminderDismissed.${patientId}`;
}

export function isReminderDismissed(patientId: string): boolean {
  try {
    return window.localStorage.getItem(reminderKey(patientId)) === "true";
  } catch {
    return false;
  }
}

export function setReminderDismissed(patientId: string): void {
  try {
    window.localStorage.setItem(reminderKey(patientId), "true");
  } catch {
    // ignore
  }
}
