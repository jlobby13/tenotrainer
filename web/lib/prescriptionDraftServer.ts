import "server-only";

// C5.3 — Draft & Publish Engine service layer. This is the ONE place UI
// code (future C5.4) or routes call into — never raw table/RPC access from
// a route handler. Every exported function re-derives authorization from
// server/DB state; callers must NEVER pass a client-supplied clinicianId,
// role, ownership flag, or patient-authorization result — clinicianId here
// always originates from requireClinicianAuth() at the route boundary.
//
// Authorization tiers (C5.3A, locked in C5.3B):
//   - create/publish/pause/resume: verifyHighConsequenceAuthorization()
//     (PG + synchronous legacy re-check, fail closed, no PG-only fallback).
//   - everything else (draft micro-edits, reads): assertSupervises() only,
//     matching the C1-C4 precedent — a draft is never patient-visible and
//     is fully discardable, so the lower tier is an accepted, bounded risk.
//
// RPC vs plain writes: create/publish/pause/resume/reorder go through the
// SECURITY DEFINER RPCs in 20260917000001 (true cross-row atomicity, or a
// two-phase reindex that a single REST call can't express safely). Every
// other operation here is a single-table write via the service-role
// client — deliberately not wrapped in its own RPC, per C5.3A's explicit
// instruction not to create "dozens of unnecessary RPCs."

import { createServiceRoleClient } from "./supabase/server";
import { assertSupervises } from "./clinicianAuth";
import { verifyHighConsequenceAuthorization, assertPublishEnabled } from "./prescriptionDraftAuth";
import { PrescriptionDraftError, mapRpcError } from "./prescriptionDraftErrors";
import type {
  DraftSource,
  DraftStatus,
  SchedulingMode,
  RehabPhase,
  PerformanceFocus,
  ExerciseStatus,
  DosageInput,
  ValidationRuleResult,
} from "./prescriptionDraftTypes";

type Supabase = ReturnType<typeof createServiceRoleClient>;

type DraftRow = {
  id: string;
  patient_prescription_id: string;
  status: DraftStatus;
  source: DraftSource;
  based_on_prescription_version_id: string | null;
  stale_base_prescription_version_id: string | null;
  source_template_id: string | null;
  phase: RehabPhase | null;
  scheduling_mode: SchedulingMode | null;
  created_by: string;
  editing_clinician_id: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Shared helpers — every draft-content mutation goes through one of these
// two so the ownership/patient-authorization check is never duplicated
// ad hoc per operation.
// ---------------------------------------------------------------------------

async function loadEditableDraft(supabase: Supabase, clinicianId: string, draftId: string): Promise<DraftRow> {
  const { data, error } = await supabase
    .from("prescription_drafts")
    .select("*, patient_prescriptions(patient_id)")
    .eq("id", draftId)
    .maybeSingle();
  if (error || !data) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  const draft = data as DraftRow & { patient_prescriptions: { patient_id: string } | null };
  const patientId = draft.patient_prescriptions?.patient_id;
  if (!patientId) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");

  if (draft.status !== "editing") throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  if (draft.editing_clinician_id !== clinicianId) throw new PrescriptionDraftError("DRAFT_NOT_OWNED_BY_CALLER");
  return draft;
}

async function resolveDraftIdForWorkout(supabase: Supabase, workoutId: string): Promise<string> {
  const { data, error } = await supabase
    .from("prescription_workouts")
    .select("prescription_draft_id")
    .eq("id", workoutId)
    .maybeSingle();
  if (error || !data?.prescription_draft_id) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  return data.prescription_draft_id as string;
}

async function resolveWorkoutIdForExercise(supabase: Supabase, exerciseId: string): Promise<string> {
  const { data, error } = await supabase
    .from("prescription_exercises")
    .select("prescription_workout_id")
    .eq("id", exerciseId)
    .maybeSingle();
  if (error || !data?.prescription_workout_id) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  return data.prescription_workout_id as string;
}

// ---------------------------------------------------------------------------
// Creation (high-consequence)
// ---------------------------------------------------------------------------

export async function createDraft(params: {
  clinicianId: string;
  patientId: string;
  source: DraftSource;
  sourceVersionId?: string | null;
  templateId?: string | null;
}): Promise<{ draftId: string }> {
  await verifyHighConsequenceAuthorization(params.clinicianId, params.patientId);
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("create_prescription_draft", {
    p_patient_id: params.patientId,
    p_clinician_id: params.clinicianId,
    p_source: params.source,
    p_source_version_id: params.sourceVersionId ?? null,
    p_template_id: params.templateId ?? null,
  });
  if (error) throw mapRpcError(error);
  return { draftId: data as string };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getDraft(params: { clinicianId: string; draftId: string }) {
  const supabase = createServiceRoleClient();
  const draft = await loadEditableDraftOrReadable(supabase, params.clinicianId, params.draftId);

  const [{ data: workouts }, { data: focuses }] = await Promise.all([
    supabase
      .from("prescription_workouts")
      .select("*, prescription_exercises(*, prescription_exercise_dosage(*))")
      .eq("prescription_draft_id", params.draftId)
      .order("order_index", { ascending: true }),
    supabase.from("prescription_draft_performance_focus").select("focus").eq("prescription_draft_id", params.draftId),
  ]);

  return {
    draft,
    workouts: workouts ?? [],
    performanceFocuses: (focuses ?? []).map((f: { focus: PerformanceFocus }) => f.focus),
  };
}

// getDraft is intentionally read-only for ANY actively-supervising
// clinician (not just the editing owner) — "other authorized clinicians
// may VIEW it" (C5.3A §3). Ownership is only enforced on writes.
async function loadEditableDraftOrReadable(supabase: Supabase, clinicianId: string, draftId: string): Promise<DraftRow> {
  const { data, error } = await supabase
    .from("prescription_drafts")
    .select("*, patient_prescriptions(patient_id)")
    .eq("id", draftId)
    .maybeSingle();
  if (error || !data) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  const draft = data as DraftRow & { patient_prescriptions: { patient_id: string } | null };
  const patientId = draft.patient_prescriptions?.patient_id;
  if (!patientId) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");
  return draft;
}

// ---------------------------------------------------------------------------
// Draft metadata / performance focus
// ---------------------------------------------------------------------------

export async function updateDraftMetadata(params: {
  clinicianId: string;
  draftId: string;
  phase?: RehabPhase | null;
  schedulingMode?: SchedulingMode | null;
  performanceFocuses?: PerformanceFocus[];
}): Promise<void> {
  const supabase = createServiceRoleClient();
  await loadEditableDraft(supabase, params.clinicianId, params.draftId);

  const patch: Record<string, unknown> = { updated_by: params.clinicianId, updated_at: new Date().toISOString() };
  if (params.phase !== undefined) patch.phase = params.phase;
  if (params.schedulingMode !== undefined) patch.scheduling_mode = params.schedulingMode;
  const { error } = await supabase.from("prescription_drafts").update(patch).eq("id", params.draftId);
  if (error) throw new PrescriptionDraftError("INTERNAL_ERROR");

  if (params.performanceFocuses !== undefined) {
    const { error: deleteError } = await supabase
      .from("prescription_draft_performance_focus")
      .delete()
      .eq("prescription_draft_id", params.draftId);
    if (deleteError) throw new PrescriptionDraftError("INTERNAL_ERROR");
    if (params.performanceFocuses.length > 0) {
      const { error: insertError } = await supabase
        .from("prescription_draft_performance_focus")
        .insert(params.performanceFocuses.map((focus) => ({ prescription_draft_id: params.draftId, focus })));
      if (insertError) throw new PrescriptionDraftError("INTERNAL_ERROR");
    }
  }
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

export async function addWorkout(params: {
  clinicianId: string;
  draftId: string;
  label?: string | null;
  orderIndex: number;
  daysOfWeek?: number[] | null;
}): Promise<{ workoutId: string }> {
  const supabase = createServiceRoleClient();
  await loadEditableDraft(supabase, params.clinicianId, params.draftId);
  const { data, error } = await supabase
    .from("prescription_workouts")
    .insert({
      prescription_draft_id: params.draftId,
      label: params.label ?? null,
      order_index: params.orderIndex,
      days_of_week: params.daysOfWeek ?? null,
    })
    .select("id")
    .single();
  if (error) throw new PrescriptionDraftError("VALIDATION_FAILED");
  return { workoutId: data.id as string };
}

export async function updateWorkout(params: {
  clinicianId: string;
  workoutId: string;
  label?: string | null;
  daysOfWeek?: number[] | null;
}): Promise<void> {
  const supabase = createServiceRoleClient();
  const draftId = await resolveDraftIdForWorkout(supabase, params.workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);
  const patch: Record<string, unknown> = {};
  if (params.label !== undefined) patch.label = params.label;
  if (params.daysOfWeek !== undefined) patch.days_of_week = params.daysOfWeek;
  const { error } = await supabase.from("prescription_workouts").update(patch).eq("id", params.workoutId);
  if (error) throw new PrescriptionDraftError("VALIDATION_FAILED");
}

export async function removeWorkout(params: { clinicianId: string; workoutId: string }): Promise<void> {
  const supabase = createServiceRoleClient();
  const draftId = await resolveDraftIdForWorkout(supabase, params.workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);
  const { error } = await supabase.from("prescription_workouts").delete().eq("id", params.workoutId);
  if (error) throw new PrescriptionDraftError("INTERNAL_ERROR");
}

export async function reorderWorkouts(params: { clinicianId: string; draftId: string; orderedWorkoutIds: string[] }): Promise<void> {
  const supabase = createServiceRoleClient();
  await loadEditableDraft(supabase, params.clinicianId, params.draftId);
  const { error } = await supabase.rpc("reorder_prescription_workouts", {
    p_draft_id: params.draftId,
    p_clinician_id: params.clinicianId,
    p_ordered_ids: params.orderedWorkoutIds,
  });
  if (error) throw mapRpcError(error);
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

export async function addExercise(params: {
  clinicianId: string;
  workoutId: string;
  canonicalExerciseId: string;
  orderIndex: number;
  additionalInstructions?: string | null;
}): Promise<{ exerciseId: string }> {
  const supabase = createServiceRoleClient();
  const draftId = await resolveDraftIdForWorkout(supabase, params.workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);

  const { data: exercise } = await supabase
    .from("canonical_exercises")
    .select("id")
    .eq("id", params.canonicalExerciseId)
    .maybeSingle();
  if (!exercise) throw new PrescriptionDraftError("EXERCISE_UNAVAILABLE");

  const { data, error } = await supabase
    .from("prescription_exercises")
    .insert({
      prescription_workout_id: params.workoutId,
      canonical_exercise_id: params.canonicalExerciseId,
      order_index: params.orderIndex,
      additional_instructions: params.additionalInstructions ?? null,
    })
    .select("id")
    .single();
  if (error) throw new PrescriptionDraftError("VALIDATION_FAILED");
  return { exerciseId: data.id as string };
}

export async function updateExercise(params: {
  clinicianId: string;
  exerciseId: string;
  status?: ExerciseStatus;
  additionalInstructions?: string | null;
}): Promise<void> {
  const supabase = createServiceRoleClient();
  const workoutId = await resolveWorkoutIdForExercise(supabase, params.exerciseId);
  const draftId = await resolveDraftIdForWorkout(supabase, workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);
  const patch: Record<string, unknown> = {};
  if (params.status !== undefined) patch.status = params.status;
  if (params.additionalInstructions !== undefined) patch.additional_instructions = params.additionalInstructions;
  const { error } = await supabase.from("prescription_exercises").update(patch).eq("id", params.exerciseId);
  if (error) throw new PrescriptionDraftError("VALIDATION_FAILED");
}

export async function removeExercise(params: { clinicianId: string; exerciseId: string }): Promise<void> {
  const supabase = createServiceRoleClient();
  const workoutId = await resolveWorkoutIdForExercise(supabase, params.exerciseId);
  const draftId = await resolveDraftIdForWorkout(supabase, workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);
  const { error } = await supabase.from("prescription_exercises").delete().eq("id", params.exerciseId);
  if (error) throw new PrescriptionDraftError("INTERNAL_ERROR");
}

export async function reorderExercises(params: { clinicianId: string; workoutId: string; orderedExerciseIds: string[] }): Promise<void> {
  const supabase = createServiceRoleClient();
  const draftId = await resolveDraftIdForWorkout(supabase, params.workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);
  const { error } = await supabase.rpc("reorder_prescription_exercises", {
    p_workout_id: params.workoutId,
    p_clinician_id: params.clinicianId,
    p_ordered_ids: params.orderedExerciseIds,
  });
  if (error) throw mapRpcError(error);
}

// ---------------------------------------------------------------------------
// Dosage — upsert (one row per exercise, 1:1 by DB constraint)
// ---------------------------------------------------------------------------

export async function updateDosage(params: { clinicianId: string; exerciseId: string; dosage: DosageInput }): Promise<void> {
  const supabase = createServiceRoleClient();
  const workoutId = await resolveWorkoutIdForExercise(supabase, params.exerciseId);
  const draftId = await resolveDraftIdForWorkout(supabase, workoutId);
  await loadEditableDraft(supabase, params.clinicianId, draftId);

  const d = params.dosage;
  const row = {
    prescription_exercise_id: params.exerciseId,
    dosage_type: d.dosageType,
    sets: d.sets ?? null,
    reps_mode: d.repsMode ?? null,
    reps_exact: d.repsExact ?? null,
    reps_min: d.repsMin ?? null,
    reps_max: d.repsMax ?? null,
    contacts_mode: d.contactsMode ?? null,
    contacts_exact: d.contactsExact ?? null,
    contacts_min: d.contactsMin ?? null,
    contacts_max: d.contactsMax ?? null,
    hold_duration_mode: d.holdDurationMode ?? null,
    hold_duration_exact_seconds: d.holdDurationExactSeconds ?? null,
    hold_duration_min_seconds: d.holdDurationMinSeconds ?? null,
    hold_duration_max_seconds: d.holdDurationMaxSeconds ?? null,
    time_duration_mode: d.timeDurationMode ?? null,
    time_duration_exact_seconds: d.timeDurationExactSeconds ?? null,
    time_duration_min_seconds: d.timeDurationMinSeconds ?? null,
    time_duration_max_seconds: d.timeDurationMaxSeconds ?? null,
    interval_work_seconds: d.intervalWorkSeconds ?? null,
    interval_recovery_seconds: d.intervalRecoverySeconds ?? null,
    interval_rounds: d.intervalRounds ?? null,
    concentric_duration_seconds: d.concentricDurationSeconds ?? null,
    rep_hold_duration_seconds: d.repHoldDurationSeconds ?? null,
    eccentric_duration_seconds: d.eccentricDurationSeconds ?? null,
    tempo_description: d.tempoDescription ?? null,
    rest_seconds: d.restSeconds ?? null,
    load_type: d.loadType ?? "not_applicable",
    load_value_exact: d.loadValueExact ?? null,
    load_unit: d.loadUnit ?? null,
    rpe: d.rpe ?? null,
    rir: d.rir ?? null,
    rom: d.rom ?? null,
    assistance_level: d.assistanceLevel ?? null,
    side: d.side ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("prescription_exercise_dosage").upsert(row, { onConflict: "prescription_exercise_id" });
  if (error) throw new PrescriptionDraftError("VALIDATION_FAILED");
}

// ---------------------------------------------------------------------------
// Discard / Validate
// ---------------------------------------------------------------------------

export async function discardDraft(params: { clinicianId: string; draftId: string }): Promise<void> {
  const supabase = createServiceRoleClient();
  await loadEditableDraft(supabase, params.clinicianId, params.draftId);
  const { error } = await supabase
    .from("prescription_drafts")
    .update({ status: "discarded", updated_by: params.clinicianId, updated_at: new Date().toISOString() })
    .eq("id", params.draftId);
  if (error) throw new PrescriptionDraftError("INTERNAL_ERROR");
}

export async function validateDraft(params: { clinicianId: string; draftId: string }): Promise<ValidationRuleResult[]> {
  const supabase = createServiceRoleClient();
  // Read-only preview: any actively-supervising clinician may check, not
  // just the editing owner (matches getDraft's read tier).
  await loadEditableDraftOrReadable(supabase, params.clinicianId, params.draftId);
  const { data, error } = await supabase.rpc("validate_prescription_draft", { p_draft_id: params.draftId });
  if (error) throw mapRpcError(error);
  return (data ?? []) as ValidationRuleResult[];
}

// ---------------------------------------------------------------------------
// Publish (high-consequence + feature-gated)
// ---------------------------------------------------------------------------

export async function publishDraft(params: { clinicianId: string; draftId: string }): Promise<{ versionId: string }> {
  assertPublishEnabled();

  const supabase = createServiceRoleClient();
  const draft = await loadEditableDraftOrReadable(supabase, params.clinicianId, params.draftId);
  if (draft.editing_clinician_id !== params.clinicianId) throw new PrescriptionDraftError("DRAFT_NOT_OWNED_BY_CALLER");
  if (draft.status !== "editing") throw new PrescriptionDraftError("DRAFT_NOT_FOUND");

  const { data: pp } = await supabase
    .from("patient_prescriptions")
    .select("patient_id")
    .eq("id", draft.patient_prescription_id)
    .maybeSingle();
  if (!pp) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");

  await verifyHighConsequenceAuthorization(params.clinicianId, pp.patient_id as string);

  const { data, error } = await supabase.rpc("publish_prescription_draft", {
    p_draft_id: params.draftId,
    p_clinician_id: params.clinicianId,
  });
  if (error) throw mapRpcError(error);
  return { versionId: data as string };
}

// ---------------------------------------------------------------------------
// Pause / Resume (high-consequence)
// ---------------------------------------------------------------------------

export async function pausePrescription(params: { clinicianId: string; patientId: string }): Promise<void> {
  await verifyHighConsequenceAuthorization(params.clinicianId, params.patientId);
  const supabase = createServiceRoleClient();
  const { data: pp } = await supabase.from("patient_prescriptions").select("id").eq("patient_id", params.patientId).maybeSingle();
  if (!pp) throw new PrescriptionDraftError("VALIDATION_FAILED");
  const { error } = await supabase.rpc("pause_prescription", {
    p_patient_prescription_id: pp.id,
    p_clinician_id: params.clinicianId,
  });
  if (error) throw mapRpcError(error);
}

export async function resumePrescription(params: { clinicianId: string; patientId: string }): Promise<void> {
  await verifyHighConsequenceAuthorization(params.clinicianId, params.patientId);
  const supabase = createServiceRoleClient();
  const { data: pp } = await supabase.from("patient_prescriptions").select("id").eq("patient_id", params.patientId).maybeSingle();
  if (!pp) throw new PrescriptionDraftError("VALIDATION_FAILED");
  const { error } = await supabase.rpc("resume_prescription", {
    p_patient_prescription_id: pp.id,
    p_clinician_id: params.clinicianId,
  });
  if (error) throw mapRpcError(error);
}
