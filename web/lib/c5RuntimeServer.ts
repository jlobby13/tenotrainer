import "server-only";

// C5.6D — the trusted server boundary between the patient UI and the C5.6C
// lifecycle engine.
//
//   browser -> /api/patient/c5/** (or a server component) -> this module
//           -> service-role RPC (c5_*) -> database
//
// The patient id ALWAYS comes from the authenticated cookie session
// (requireC5Patient), never from the request body. Every lifecycle decision
// is made by the RPCs; this module only (1) runs acute reconciliation in its
// own committed call first, (2) calls the RPC, and (3) translates the JSONB
// result into C5TrainingState / C5SessionView for rendering. Reads here are
// display reads (session snapshot, recorded units, a workout preview built
// by the same c5_build_session_snapshot the Start transaction uses).

import { createServerSupabaseClient, createServiceRoleClient } from "./supabase/server";
import { mapDosageRowToInput } from "./dosageEditor";
import type {
  C5AcuteGate,
  C5RecoveryGuidance,
  C5WeeklyProgress,
  C5PerformancePayload,
  C5SessionView,
  C5Snapshot,
  C5TrainingState,
  C5TrainingStatus,
  C5UnitOutcome,
  C5WorkoutOption,
} from "./c5RuntimeTypes";

type Admin = ReturnType<typeof createServiceRoleClient>;
type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Feature gate + routing
// ---------------------------------------------------------------------------

// OFF unless explicitly enabled for this server process. Legacy stays the
// default runtime until cutover.
export function isC5PatientRuntimeEnabled(): boolean {
  return process.env.C5_PATIENT_RUNTIME_ENABLED === "true";
}

// Cutover routing, not a lifecycle decision: with the gate on, a patient is
// served by the C5 runtime once they have a published C5 prescription or any
// C5 session (so an open C5 session is never stranded behind legacy).
export async function usesC5Runtime(patientId: string): Promise<boolean> {
  if (!isC5PatientRuntimeEnabled()) return false;
  const admin = createServiceRoleClient();
  const [{ data: pp }, { data: session }] = await Promise.all([
    admin.from("patient_prescriptions").select("current_prescription_version_id").eq("patient_id", patientId).maybeSingle(),
    admin.from("rehab_sessions").select("id").eq("user_id", patientId).not("training_status", "is", null).limit(1).maybeSingle(),
  ]);
  return Boolean(pp?.current_prescription_version_id) || Boolean(session);
}

const NON_PATIENT_ROLES = new Set(["super_user", "clinician", "clinician_admin"]);

export type C5PatientAuth =
  | { ok: true; patientId: string }
  | { ok: false; status: 401 | 403 | 404; code: "UNAUTHORIZED" | "NOT_A_PATIENT" | "C5_RUNTIME_DISABLED" };

// Identity from the authenticated session only.
export async function requireC5Patient(): Promise<C5PatientAuth> {
  if (!isC5PatientRuntimeEnabled()) return { ok: false, status: 404, code: "C5_RUNTIME_DISABLED" };
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, code: "UNAUTHORIZED" };
  const { data: memberships } = await supabase.from("organization_members").select("role").eq("user_id", user.id);
  if ((memberships ?? []).some((m) => NON_PATIENT_ROLES.has(m.role as string))) {
    return { ok: false, status: 403, code: "NOT_A_PATIENT" };
  }
  return { ok: true, patientId: user.id };
}

// ---------------------------------------------------------------------------
// Acute reconciliation — its own RPC call, therefore its own committed
// transaction, BEFORE any lifecycle call that reads the brake (C5.6C §8;
// 20260911000005). Fails closed: if it errors, no lifecycle call is made.
// ---------------------------------------------------------------------------
export class C5SafetyCheckError extends Error {}

async function reconcileAcute(admin: Admin, patientId: string): Promise<void> {
  const { error } = await admin.rpc("reconcile_missing_acute_episodes", { p_user_id: patientId });
  if (error) {
    console.error("C5 runtime: acute reconciliation failed — failing closed:", error.message);
    throw new C5SafetyCheckError("acute reconciliation failed");
  }
}

async function callRpc(admin: Admin, name: string, params: Json): Promise<Json> {
  const { data, error } = await admin.rpc(name, params);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return (data ?? {}) as Json;
}

// ---------------------------------------------------------------------------
// Display mapping
// ---------------------------------------------------------------------------
function mapSnapshot(raw: Json | null): C5Snapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const workout = (raw.workout ?? {}) as Json;
  const exercises = Array.isArray(raw.exercises) ? (raw.exercises as Json[]) : [];
  return {
    versionId: raw.prescription_version_id as string,
    versionNumber: (raw.version_number as number | null) ?? null,
    schedulingMode: raw.scheduling_mode as C5Snapshot["schedulingMode"],
    workout: { id: workout.id as string, label: (workout.label as string | null) ?? null, orderIndex: (workout.order_index as number) ?? 0 },
    exercises: exercises.map((e) => ({
      exerciseId: e.exercise_id as string,
      name: e.name as string,
      orderIndex: e.order_index as number,
      additionalInstructions: (e.additional_instructions as string | null) ?? null,
      dosage: mapDosageRowToInput(e.dosage as Json)!,
    })),
  };
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

async function loadPreview(admin: Admin, versionId: string, workoutId: string): Promise<C5Snapshot> {
  const { data, error } = await admin.rpc("c5_build_session_snapshot", { p_version_id: versionId, p_workout_id: workoutId });
  const snapshot = error ? null : mapSnapshot(data as Json);
  if (!snapshot) throw new Error("c5_build_session_snapshot returned no workout");
  return snapshot;
}

// The patient's own session only (user_id filter), C5 rows only.
export async function loadSessionView(admin: Admin, patientId: string, sessionId: string): Promise<C5SessionView | null> {
  const { data: s } = await admin
    .from("rehab_sessions")
    .select("id, training_status, prescription_snapshot, patient_local_date, started_at, training_closed_at")
    .eq("id", sessionId)
    .eq("user_id", patientId)
    .not("training_status", "is", null)
    .maybeSingle();
  if (!s) return null;
  const snapshot = mapSnapshot(s.prescription_snapshot as Json);
  if (!snapshot) return null;
  const { data: units } = await admin
    .from("set_outcomes")
    .select("exercise_id, set_index, outcome, actual_reps, actual_load, actual_load_unit, actual_duration_seconds, actual_distance_m, was_edited")
    .eq("rehab_session_id", sessionId)
    .order("set_index");
  const outcomes: C5UnitOutcome[] = (units ?? []).map((u) => ({
    exerciseId: u.exercise_id as string,
    unitIndex: u.set_index as number,
    outcome: u.outcome as C5UnitOutcome["outcome"],
    actualReps: num(u.actual_reps),
    actualLoad: num(u.actual_load),
    actualLoadUnit: (u.actual_load_unit as C5UnitOutcome["actualLoadUnit"]) ?? null,
    actualDurationSeconds: num(u.actual_duration_seconds),
    actualDistanceM: num(u.actual_distance_m),
    wasEdited: Boolean(u.was_edited),
  }));
  return {
    id: s.id as string,
    trainingStatus: s.training_status as C5TrainingStatus,
    snapshot,
    outcomes,
    patientLocalDate: s.patient_local_date as string,
    startedAt: s.started_at as string,
    closedAt: (s.training_closed_at as string | null) ?? null,
  };
}

// 1:1 translation of c5_get_start_eligibility's result. No rule is
// re-derived here: workout ids, the choice requirement and the Calendar
// date all come from the RPC; the only extra reads are display reads.
async function mapEligibility(admin: Admin, patientId: string, r: Json): Promise<C5TrainingState> {
  const result = r.result as string;
  switch (result) {
    case "no_active_prescription":
    case "prescription_paused":
    case "immediate_response_required":
    case "morning_response_required":
    case "timezone_required":
      return { kind: result };
    case "already_trained_today":
    case "not_scheduled_today":
      return { kind: result, patientLocalDate: (r.patient_local_date as string | null) ?? null };
    case "acute_safety_review_required":
    case "acute_safety_professional_review_required":
    case "acute_safety_reconciliation_required":
      return { kind: "acute_blocked", gate: result, brakeLevel: num(r.brake_level) };
    case "acute_resolution_required":
    case "resume_existing_session": {
      const session = await loadSessionView(admin, patientId, r.session_id as string);
      if (!session) return { kind: "unavailable", reason: "unexpected" };
      const paused = r.prescription_paused === true;
      return result === "resume_existing_session"
        ? { kind: "resume", paused, session }
        : { kind: "acute_resolution_required", gate: r.acute_gate as C5AcuteGate, brakeLevel: num(r.brake_level), paused, session };
    }
    case "eligible": {
      const versionId = r.prescription_version_id as string;
      const mode = r.scheduling_mode as "sequence" | "calendar";
      const base: Omit<C5WorkoutOption, "preview">[] = [];
      let choiceRequired = false;
      if (mode === "sequence") {
        const seq = (r.sequence ?? {}) as Json;
        if (seq.state === "first" || seq.state === "next") {
          base.push({ key: seq.state, workoutId: seq.workout_id as string, sequenceChoice: null, calendarScheduledDate: null });
        } else if (seq.state === "pending_choice" && seq.single_workout === true) {
          // The server resolves a single-workout choice itself.
          base.push({ key: "single", workoutId: seq.repeat_workout_id as string, sequenceChoice: null, calendarScheduledDate: null });
        } else if (seq.state === "pending_choice") {
          choiceRequired = true;
          base.push({ key: "repeat_previous", workoutId: seq.repeat_workout_id as string, sequenceChoice: "repeat_previous", calendarScheduledDate: null });
          base.push({ key: "advance_next", workoutId: seq.advance_workout_id as string, sequenceChoice: "advance_next", calendarScheduledDate: null });
        } else {
          return { kind: "unavailable", reason: "unexpected" };
        }
      } else {
        const cal = (r.calendar ?? {}) as Json;
        if (cal.state !== "scheduled_today" && cal.state !== "make_up") return { kind: "unavailable", reason: "unexpected" };
        base.push({ key: cal.state, workoutId: cal.workout_id as string, sequenceChoice: null, calendarScheduledDate: (cal.calendar_scheduled_date as string) ?? null });
      }
      const options = await Promise.all(base.map(async (o) => ({ ...o, preview: await loadPreview(admin, versionId, o.workoutId) })));
      return { kind: "available", versionId, schedulingMode: mode, patientLocalDate: r.patient_local_date as string, choiceRequired, options };
    }
    default:
      console.error("C5 runtime: unrecognised eligibility result", result);
      return { kind: "unavailable", reason: "unexpected" };
  }
}

function mapWeekly(raw: unknown): C5WeeklyProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Json;
  return {
    target: Number(w.target),
    finishedSessions: Number(w.finished_sessions),
    weekStart: w.week_start as string,
    weekEnd: w.week_end as string,
    targetReached: w.target_reached === true,
  };
}

function mapRecovery(raw: unknown): C5RecoveryGuidance | null {
  if (!raw || typeof raw !== "object" || (raw as Json).applies !== true) return null;
  const r = raw as Json;
  return {
    recommendedRecoveryDays: Number(r.recommended_recovery_days),
    anchorStartLocalDate: r.anchor_start_local_date as string,
    earliestRecommendedDate: r.earliest_recommended_date as string,
    restDaysCompleted: Number(r.rest_days_completed),
    todaysDecision: (r.todays_decision as C5RecoveryGuidance["todaysDecision"]) ?? null,
  };
}

// Eligibility (C5.6C) + the C5.6F advisory layers, from one server read.
// Weekly progress and recovery guidance are informational: they never
// change the eligibility result, and recovery is only ever present when
// the result is `eligible`.
async function readState(admin: Admin, patientId: string): Promise<C5TrainingState> {
  const g = await callRpc(admin, "c5_get_training_guidance", { p_patient_id: patientId });
  const state: C5TrainingState = await mapEligibility(admin, patientId, (g.eligibility ?? {}) as Json);
  state.weekly = mapWeekly(g.weekly);
  if (state.kind === "available") state.recovery = mapRecovery(g.recovery);
  return state;
}

// THE patient-facing training-state path (dashboard + session page + API).
export async function getC5TrainingState(patientId: string): Promise<C5TrainingState> {
  const admin = createServiceRoleClient();
  try {
    await reconcileAcute(admin, patientId);
  } catch (e) {
    if (e instanceof C5SafetyCheckError) return { kind: "unavailable", reason: "safety_check_failed" };
    throw e;
  }
  return readState(admin, patientId);
}

// ---------------------------------------------------------------------------
// Lifecycle actions. Each: reconcile (own transaction) -> one RPC.
// ---------------------------------------------------------------------------

const PERFORMANCE_KEYS = [
  "exercise_id",
  "unit_index",
  "outcome",
  "actual_reps",
  "actual_load",
  "actual_load_unit",
  "actual_duration_seconds",
  "actual_distance_m",
] as const;

// Shape-only sanitising (drops unknown keys); the RPC validates content.
export function sanitizePerformance(raw: unknown): C5PerformancePayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Json;
  const out: Json = {};
  for (const k of PERFORMANCE_KEYS) if (src[k] !== undefined) out[k] = src[k];
  if (typeof out.exercise_id !== "string" || typeof out.unit_index !== "number") return null;
  return out as C5PerformancePayload;
}

export type C5StartRequest = {
  clientRequestId: string;
  expectedVersionId: string;
  workoutId: string;
  performance: C5PerformancePayload;
  preStartSkips: { exercise_id: string; unit_index: number }[];
  sequenceChoice: "repeat_previous" | "advance_next" | null;
};

export type C5StartResponse =
  | { result: "started"; replayed: boolean; session: C5SessionView }
  | { result: string; detail?: string; state: C5TrainingState };

export async function recordFirstPerformance(patientId: string, req: C5StartRequest): Promise<C5StartResponse> {
  const admin = createServiceRoleClient();
  await reconcileAcute(admin, patientId);
  const r = await callRpc(admin, "c5_record_first_performance", {
    p_patient_id: patientId,
    p_client_request_id: req.clientRequestId,
    p_expected_version_id: req.expectedVersionId,
    p_workout_id: req.workoutId,
    p_performance: req.performance,
    p_pre_start_skips: req.preStartSkips,
    p_sequence_choice: req.sequenceChoice,
  });
  if (r.result === "started") {
    const session = await loadSessionView(admin, patientId, r.session_id as string);
    if (session) return { result: "started", replayed: r.replayed === true, session };
  }
  // Not started: hand back the authoritative state so the UI re-renders it.
  const state = await readState(admin, patientId);
  return { result: r.result as string, detail: (r.detail as string | undefined) ?? undefined, state };
}

export type C5UnitWriteResponse = { result: string; detail?: string; replayed?: boolean };

export async function writePerformance(patientId: string, sessionId: string, performance: C5PerformancePayload, edit: boolean): Promise<C5UnitWriteResponse> {
  const admin = createServiceRoleClient();
  await reconcileAcute(admin, patientId);
  const r = await callRpc(admin, edit ? "c5_edit_performance" : "c5_record_performance", {
    p_patient_id: patientId,
    p_session_id: sessionId,
    p_performance: performance,
  });
  return { result: r.result as string, detail: (r.detail as string | undefined) ?? undefined, replayed: (r.replayed as boolean | undefined) ?? undefined };
}

export type C5CloseResponse = { result: string; trainingStatus?: C5TrainingStatus; replayed?: boolean };

export type C5AcuteReport = { sudden_or_sharp_pain?: boolean; pop_felt_or_heard?: boolean; new_functional_difficulty?: boolean };

export async function closeSession(patientId: string, sessionId: string, intent: "finish" | "stop", acuteReport: C5AcuteReport | null): Promise<C5CloseResponse> {
  const admin = createServiceRoleClient();
  await reconcileAcute(admin, patientId);
  const r =
    intent === "finish"
      ? await callRpc(admin, "c5_finish_session", { p_patient_id: patientId, p_session_id: sessionId })
      : await callRpc(admin, "c5_stop_session", { p_patient_id: patientId, p_session_id: sessionId, p_acute_report: acuteReport });
  return {
    result: r.result as string,
    trainingStatus: (r.training_status as C5TrainingStatus | undefined) ?? undefined,
    replayed: (r.replayed as boolean | undefined) ?? undefined,
  };
}

// C5.6F — record Take Recovery Day / Continue. The browser sends only its
// idempotency key and the choice; the database recomputes the guidance
// (patient-local dates, current version, anchor) and refuses unless the
// guidance is currently presented. Never creates a session.
export type C5RecoveryDecisionResponse = { result: string; replayed?: boolean; decision?: string; state: C5TrainingState };

export async function recordRecoveryDecision(patientId: string, clientRequestId: string, decision: "take_recovery_day" | "continue"): Promise<C5RecoveryDecisionResponse> {
  const admin = createServiceRoleClient();
  await reconcileAcute(admin, patientId);
  const r = await callRpc(admin, "c5_record_recovery_decision", { p_patient_id: patientId, p_client_request_id: clientRequestId, p_decision: decision });
  return {
    result: r.result as string,
    replayed: (r.replayed as boolean | undefined) ?? undefined,
    decision: (r.decision as string | undefined) ?? undefined,
    state: await readState(admin, patientId),
  };
}

export async function getSessionViewForPatient(patientId: string, sessionId: string): Promise<C5SessionView | null> {
  return loadSessionView(createServiceRoleClient(), patientId, sessionId);
}
