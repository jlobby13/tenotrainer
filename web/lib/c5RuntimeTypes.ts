// C5.6D — patient runtime types + pure input-shaping helpers. Client-safe
// (no server-only import, no I/O).
//
// AUTHORITY: every lifecycle decision — may the patient train, which
// workout, Sequence/Calendar resolution, response gates, acute safety,
// pause, Finish/Stop classification — is made by the C5.6C RPCs
// (20261014000001/2). The types below only carry those results to the UI.
// The helpers at the bottom decide which INPUT FIELD a unit needs (mirroring
// c5_performance_error's primary-quantity rule) so the form asks for the
// right number; the server still validates every unit.

import type { DosageInput } from "./prescriptionDraftTypes";

export type C5SchedulingMode = "sequence" | "calendar";
export type C5TrainingStatus = "started" | "finished" | "stopped_early" | "stopped_pause" | "stopped_acute";
export type C5SequenceChoice = "repeat_previous" | "advance_next";
export type C5AcuteGate =
  | "acute_safety_review_required"
  | "acute_safety_professional_review_required"
  | "acute_safety_reconciliation_required";

export type C5SnapshotExercise = {
  exerciseId: string;
  name: string;
  orderIndex: number;
  additionalInstructions: string | null;
  dosage: DosageInput;
};

// The immutable session snapshot (c5_build_session_snapshot). Before Start
// the same builder supplies a display-only preview of the eligible workout.
export type C5Snapshot = {
  versionId: string;
  versionNumber: number | null;
  schedulingMode: C5SchedulingMode;
  workout: { id: string; label: string | null; orderIndex: number };
  exercises: C5SnapshotExercise[];
};

export type C5UnitOutcome = {
  exerciseId: string;
  unitIndex: number;
  outcome: "completed" | "skipped";
  actualReps: number | null;
  actualLoad: number | null;
  actualLoadUnit: "kg" | "lb" | null;
  actualDurationSeconds: number | null;
  actualDistanceM: number | null;
  wasEdited: boolean;
};

export type C5SessionView = {
  id: string;
  trainingStatus: C5TrainingStatus;
  snapshot: C5Snapshot;
  outcomes: C5UnitOutcome[];
  patientLocalDate: string;
  startedAt: string;
  closedAt: string | null;
};

// One workout the server says may be started now.
export type C5WorkoutOption = {
  key: "first" | "next" | "single" | "repeat_previous" | "advance_next" | "scheduled_today" | "make_up";
  workoutId: string;
  // Passed back verbatim to c5_record_first_performance; null unless the
  // server reported a pending Repeat/Advance choice.
  sequenceChoice: C5SequenceChoice | null;
  calendarScheduledDate: string | null;
  preview: C5Snapshot;
};

// Today's Rehab state — a 1:1 translation of c5_get_start_eligibility's
// result codes. Clinically different states stay distinct.
export type C5TrainingState =
  | { kind: "no_active_prescription" }
  | { kind: "prescription_paused" }
  | { kind: "acute_blocked"; gate: C5AcuteGate; brakeLevel: number | null }
  | { kind: "acute_resolution_required"; gate: C5AcuteGate; brakeLevel: number | null; paused: boolean; session: C5SessionView }
  | { kind: "resume"; paused: boolean; session: C5SessionView }
  | { kind: "immediate_response_required" }
  | { kind: "morning_response_required" }
  | { kind: "timezone_required" }
  | { kind: "already_trained_today"; patientLocalDate: string | null }
  | { kind: "not_scheduled_today"; patientLocalDate: string | null }
  | {
      kind: "available";
      versionId: string;
      schedulingMode: C5SchedulingMode;
      patientLocalDate: string;
      // true only for the Repeat previous / Move to next choice.
      choiceRequired: boolean;
      options: C5WorkoutOption[];
    }
  | { kind: "unavailable"; reason: "safety_check_failed" | "unexpected" };

// What the browser sends for one unit (snake_case = the RPC's own shape).
export type C5PerformancePayload = {
  exercise_id: string;
  unit_index: number;
  outcome: "completed" | "skipped";
  actual_reps?: number | null;
  actual_load?: number | null;
  actual_load_unit?: "kg" | "lb" | null;
  actual_duration_seconds?: number | null;
  actual_distance_m?: number | null;
};

export type C5UnitKey = `${string}#${number}`;
export function unitKey(exerciseId: string, unitIndex: number): C5UnitKey {
  return `${exerciseId}#${unitIndex}`;
}

// ---------------------------------------------------------------------------
// Input shaping (mirrors c5_performance_error; the server re-validates).
// ---------------------------------------------------------------------------

// A unit is a set / round / bout: units = COALESCE(sets, interval_rounds, 1).
export function unitCount(d: DosageInput): number {
  return d.sets ?? d.intervalRounds ?? 1;
}

const METERS_PER: Record<string, number> = { m: 1, km: 1000, ft: 0.3048, mi: 1609.344 };

export type C5UnitEntry = {
  field: "reps" | "contacts" | "duration" | "distance";
  label: string;
  // Only a single exact prescribed value can be one-tap confirmed or used as
  // a default; a range never becomes a fabricated number.
  prescribedExact: number | null;
  distanceUnit: string | null;
  // External load the patient may record (prefilled only from an exact value).
  load: { unit: "kg" | "lb"; prescribedExact: number | null } | null;
};

export function unitEntry(d: DosageInput): C5UnitEntry {
  const load =
    d.loadType === "external"
      ? { unit: d.loadUnit ?? "kg", prescribedExact: d.loadMode === "range" ? null : (d.loadValueExact ?? null) }
      : null;
  if (d.dosageType === "hold" || d.dosageType === "time") {
    const exact =
      d.dosageType === "hold"
        ? d.holdDurationMode === "exact" ? (d.holdDurationExactSeconds ?? null) : null
        : d.timeDurationMode === "exact" ? (d.timeDurationExactSeconds ?? null) : (d.intervalWorkSeconds ?? null);
    return { field: "duration", label: "Seconds", prescribedExact: exact, distanceUnit: null, load };
  }
  if (d.dosageType === "distance") {
    return {
      field: "distance",
      label: d.distanceUnit ?? "m",
      prescribedExact: d.distanceMode === "exact" ? (d.distanceExactValue ?? null) : null,
      distanceUnit: d.distanceUnit ?? "m",
      load,
    };
  }
  if (d.dosageType === "contact") {
    return { field: "contacts", label: "Contacts", prescribedExact: d.contactsMode === "exact" ? (d.contactsExact ?? null) : null, distanceUnit: null, load };
  }
  return { field: "reps", label: "Reps", prescribedExact: d.repsMode === "exact" ? (d.repsExact ?? null) : null, distanceUnit: null, load };
}

// Build a completed-unit payload from what the patient entered.
export function completedPayload(
  exerciseId: string,
  unitIndex: number,
  entry: C5UnitEntry,
  value: number,
  load: number | null
): C5PerformancePayload {
  const p: C5PerformancePayload = { exercise_id: exerciseId, unit_index: unitIndex, outcome: "completed" };
  if (entry.field === "reps" || entry.field === "contacts") p.actual_reps = value;
  else if (entry.field === "duration") p.actual_duration_seconds = value;
  else p.actual_distance_m = Math.round(value * (METERS_PER[entry.distanceUnit ?? "m"] ?? 1) * 100) / 100;
  if (entry.load && load != null) {
    p.actual_load = load;
    p.actual_load_unit = entry.load.unit;
  }
  return p;
}

export function skippedPayload(exerciseId: string, unitIndex: number): C5PerformancePayload {
  return { exercise_id: exerciseId, unit_index: unitIndex, outcome: "skipped" };
}

// The patient-facing number for a recorded unit, in the prescription's unit.
export function outcomeValue(entry: C5UnitEntry, o: Pick<C5UnitOutcome, "actualReps" | "actualDurationSeconds" | "actualDistanceM">): number | null {
  if (entry.field === "reps" || entry.field === "contacts") return o.actualReps;
  if (entry.field === "duration") return o.actualDurationSeconds;
  if (o.actualDistanceM == null) return null;
  return Math.round((o.actualDistanceM / (METERS_PER[entry.distanceUnit ?? "m"] ?? 1)) * 100) / 100;
}

export function payloadToOutcome(p: C5PerformancePayload, wasEdited = false): C5UnitOutcome {
  return {
    exerciseId: p.exercise_id,
    unitIndex: p.unit_index,
    outcome: p.outcome,
    actualReps: p.actual_reps ?? null,
    actualLoad: p.actual_load ?? null,
    actualLoadUnit: p.actual_load_unit ?? null,
    actualDurationSeconds: p.actual_duration_seconds ?? null,
    actualDistanceM: p.actual_distance_m ?? null,
    wasEdited,
  };
}

export function sessionUnitKeys(snapshot: C5Snapshot): C5UnitKey[] {
  return snapshot.exercises.flatMap((e) => Array.from({ length: unitCount(e.dosage) }, (_, i) => unitKey(e.exerciseId, i)));
}

// ---------------------------------------------------------------------------
// Patient copy for authoritative rejections (result codes from C5.6C).
// ---------------------------------------------------------------------------
export const C5_RESULT_MESSAGES: Record<string, string> = {
  no_active_prescription: "You don't have an active rehab program right now.",
  prescription_paused: "Your clinician has paused your program.",
  acute_safety_review_required: "A safety check-in is needed before more training.",
  acute_safety_professional_review_required: "Training is on hold until you've been reviewed.",
  acute_safety_reconciliation_required: "We're checking your safety status. Please try again in a moment.",
  acute_resolution_required: "This session needs to be stopped for safety.",
  resume_existing_session: "You already have a session in progress.",
  immediate_response_required: "Your post-session check-in is needed before your next workout.",
  morning_response_required: "Your morning check-in is needed before your next workout.",
  timezone_required: "We need your time zone before scheduling your rehab.",
  already_trained_today: "You've already trained today.",
  not_scheduled_today: "No workout is scheduled for today.",
  version_changed: "Your clinician updated your program. Here is the latest version.",
  workout_not_eligible: "This workout isn't available right now.",
  sequence_choice_required: "Choose which workout to do today.",
  sequence_choice_not_applicable: "Your workout options changed. Please choose again.",
  invalid_performance: "That entry couldn't be saved. Check the number and try again.",
  performance_already_recorded: "This set was already saved with a different value.",
  performance_not_recorded: "This set hasn't been saved yet.",
  session_closed: "This session has already ended.",
  session_already_closed: "This session has already ended.",
  session_not_found: "We couldn't find that session.",
  no_performance_recorded: "No exercises have been completed yet.",
  invalid_acute_report: "That safety report couldn't be read. Please try again.",
};

export function resultMessage(code: string): string {
  return C5_RESULT_MESSAGES[code] ?? "Something went wrong. Please try again.";
}
