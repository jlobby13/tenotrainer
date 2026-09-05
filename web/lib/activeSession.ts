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

// Bumped for the founder-acceptance correction pass: exerciseStates now store a
// unified per-set outcome (completed | skipped) instead of a completed-only
// actualSets array, and the session now carries a prescriptionInstanceKey.
// Per the existing "discard, don't migrate" policy, an old-shape (v1) session
// found in storage is simply discarded, never partially read.
export const SESSION_SCHEMA_VERSION = 2 as const;

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

// ---------------------------------------------------------------------------
// Set-level outcome — a discriminated union, not two parallel arrays.
//
// Why this shape over a parallel `skippedSets[]` array: both cost roughly the
// same amount of code, but this one gives "completed and skipped are mutually
// exclusive" BY CONSTRUCTION — a given setIndex has at most one entry in
// `setOutcomes`, of exactly one kind. A parallel-array design only gives that
// guarantee by convention in the transition functions, which is weaker and
// requires extra invariant-checking to prevent the same index appearing in
// both arrays. It also lets completing a previously-skipped set (or vice
// versa) be one uniform "replace the outcome at this index" operation instead
// of two different code paths. Pending is never stored — it's the absence of
// an outcome for that index, derived against the prescription snapshot.
// ---------------------------------------------------------------------------

export type CompletedSetOutcome = {
  setIndex: number;
  kind: "completed";
  actual: { reps: number; load?: number };
  wasEdited: boolean;
  completedAt: string;
};

export type SkippedSetOutcome = {
  setIndex: number;
  kind: "skipped";
  skippedAt: string;
};

export type SetOutcome = CompletedSetOutcome | SkippedSetOutcome;

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
  setOutcomes: SetOutcome[]; // sparse — only addressed (completed or skipped) sets appear
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
  // Smallest-safe v1 stand-in for a real prescription-instance identifier —
  // see computePrescriptionInstanceKey's doc comment for what Milestone 3 must
  // replace this with once real server-side prescriptions/sessions exist.
  prescriptionInstanceKey: string;
  startedAt: string;
  lastUpdatedAt: string;
  pausedAt: string | null;
  completedAt: string | null;
  status: SessionStatus;
  earlyEndReason?: EarlyEndReason;
  prescriptionSnapshot: PrescriptionSnapshot;
  exerciseStates: ExerciseExecutionState[]; // parallel to prescriptionSnapshot.exercises
  // Current SET position is deliberately not persisted here — it's fully and
  // reliably derivable from exerciseStates[currentExerciseIndex].setOutcomes via
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

export function getSetOutcome(state: ExerciseExecutionState, setIndex: number): SetOutcome | null {
  return state.setOutcomes.find((o) => o.setIndex === setIndex) ?? null;
}

export function isExerciseFullyAddressed(state: ExerciseExecutionState, totalSets: number): boolean {
  if (totalSets <= 0) return false;
  const addressed = new Set(state.setOutcomes.map((o) => o.setIndex));
  for (let i = 0; i < totalSets; i++) if (!addressed.has(i)) return false;
  return true;
}

export function getNextPendingSetIndex(state: ExerciseExecutionState, totalSets: number): number | null {
  const addressed = new Set(state.setOutcomes.map((o) => o.setIndex));
  for (let i = 0; i < totalSets; i++) if (!addressed.has(i)) return i;
  return null; // every set addressed (completed and/or skipped)
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

// ---------------------------------------------------------------------------
// Progress-dot derivation — glanceable, non-color-only progress indicators.
// ---------------------------------------------------------------------------

export type DotState = "pending" | "completed" | "skipped";

export function getSetDotStates(state: ExerciseExecutionState, totalSets: number): DotState[] {
  return Array.from({ length: totalSets }, (_, i) => {
    const outcome = getSetOutcome(state, i);
    if (!outcome) return "pending";
    return outcome.kind;
  });
}

export function getExerciseDotStates(session: ActiveSessionState): DotState[] {
  return session.exerciseStates.map((ex) => {
    if (ex.status === "completed") return "completed";
    if (ex.status === "skipped") return "skipped";
    return "pending";
  });
}

// ---------------------------------------------------------------------------
// Prescription-instance identity
//
// The v1 architecture has no durable, unique identifier for "today's specific
// prescribed session" distinct from the ongoing rehab_plans row, which spans
// many days at the same stage/irritability. This key is the smallest safe
// stand-in: (planId, local calendar day). It correctly resets on a new day OR
// when the underlying plan itself changes (e.g. stage progression), and does
// NOT hardcode "one workout per calendar day" as a universal rule — it keys
// off the prescription, not the date alone. Milestone 3 must replace this with
// a real server-side prescription/session-instance id once one exists; this
// key is not designed to distinguish multiple same-day sessions under a
// future clinician-authored multi-session-per-day program.
// ---------------------------------------------------------------------------

export function computePrescriptionInstanceKey(planId: string | null): string {
  return `${planId ?? "no-plan"}:${new Date().toDateString()}`;
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
    prescriptionInstanceKey: computePrescriptionInstanceKey(params.planId),
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
      setOutcomes: [],
      problemReports: [],
    })),
    currentExerciseIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// Set-level transitions
// ---------------------------------------------------------------------------

function applySetOutcome(
  state: ActiveSessionState,
  exerciseIndex: number,
  outcome: SetOutcome,
  now: string
): ActiveSessionState {
  const exerciseStates = state.exerciseStates.map((ex, i) => {
    if (i !== exerciseIndex) return ex;
    const setOutcomes = [...ex.setOutcomes.filter((o) => o.setIndex !== outcome.setIndex), outcome].sort(
      (a, b) => a.setIndex - b.setIndex
    );
    const totalSets = getTotalSets(state.prescriptionSnapshot.exercises[i]);
    const fullyAddressed = isExerciseFullyAddressed({ ...ex, setOutcomes }, totalSets);
    return {
      ...ex,
      status: (fullyAddressed ? "completed" : "in_progress") as ExerciseExecutionStatus,
      startedAt: ex.startedAt ?? now,
      completedAt: fullyAddressed ? now : null,
      setOutcomes,
    };
  });
  return touch({ ...state, exerciseStates });
}

// One tap: prescribed values become the actual performance. Also used (with
// edited values) when the patient completes a previously-skipped set — this
// uniformly replaces whatever outcome (if any) was at that index.
export function completeSet(
  state: ActiveSessionState,
  exerciseIndex: number,
  setIndex: number,
  actual: { reps: number; load?: number },
  wasEdited: boolean
): ActiveSessionState {
  const now = new Date().toISOString();
  return applySetOutcome(
    state,
    exerciseIndex,
    { setIndex, kind: "completed", actual, wasEdited, completedAt: now },
    now
  );
}

// Records that a set was intentionally not performed — never populates actual
// reps/load, never zero-fills. No reason is required or attached in Milestone 2.
// Also used to convert an already-completed set into skipped, replacing that
// outcome the same way completeSet replaces a skip.
export function skipSet(state: ActiveSessionState, exerciseIndex: number, setIndex: number): ActiveSessionState {
  const now = new Date().toISOString();
  return applySetOutcome(state, exerciseIndex, { setIndex, kind: "skipped", skippedAt: now }, now);
}

// Reverts a set to pending, whichever outcome (completed or skipped) it had.
export function undoSetOutcome(
  state: ActiveSessionState,
  exerciseIndex: number,
  setIndex: number
): ActiveSessionState {
  const exerciseStates = state.exerciseStates.map((ex, i) => {
    if (i !== exerciseIndex) return ex;
    const setOutcomes = ex.setOutcomes.filter((o) => o.setIndex !== setIndex);
    return {
      ...ex,
      setOutcomes,
      status: (setOutcomes.length > 0 ? "in_progress" : "not_started") as ExerciseExecutionStatus,
      completedAt: null,
    };
  });
  return touch({ ...state, exerciseStates });
}

// ---------------------------------------------------------------------------
// Exercise-level transitions
// ---------------------------------------------------------------------------

// Whole-exercise skip (via Report a Problem) — a coarser, separate concept
// from an individual set skip. Also fills in a skipped outcome for every
// not-yet-addressed set, so the per-set clinician-visible record stays
// complete rather than having a gap for exercises skipped outright.
export function skipExercise(state: ActiveSessionState, exerciseIndex: number): ActiveSessionState {
  const now = new Date().toISOString();
  const totalSets = getTotalSets(state.prescriptionSnapshot.exercises[exerciseIndex]);
  const exerciseStates = state.exerciseStates.map((ex, i) => {
    if (i !== exerciseIndex) return ex;
    const addressed = new Set(ex.setOutcomes.map((o) => o.setIndex));
    const fillIns: SetOutcome[] = [];
    for (let s = 0; s < totalSets; s++) {
      if (!addressed.has(s)) fillIns.push({ setIndex: s, kind: "skipped", skippedAt: now });
    }
    const setOutcomes = [...ex.setOutcomes, ...fillIns].sort((a, b) => a.setIndex - b.setIndex);
    return { ...ex, status: "skipped" as ExerciseExecutionStatus, completedAt: now, setOutcomes };
  });
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

// currentPlanId is required so a finished session can be judged against
// "is this still the same prescription instance" — see
// computePrescriptionInstanceKey. A finished session for a DIFFERENT
// prescription instance (new day, or the plan itself changed) is discarded
// as stale; a finished session for the SAME instance is returned as-is so the
// caller can block re-starting today's already-executed prescription.
export function loadSession(patientId: string, currentPlanId: string | null): ActiveSessionState | null {
  try {
    const raw = window.localStorage.getItem(storageKey(patientId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveSessionState;
    if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION) return null;
    if (parsed.patientId !== patientId) return null;
    if (isSessionFinished(parsed)) {
      return parsed.prescriptionInstanceKey === computePrescriptionInstanceKey(currentPlanId) ? parsed : null;
    }
    if (isStale(parsed)) return null;
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
