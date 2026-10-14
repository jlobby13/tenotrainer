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
import { validateDosageInput, deriveDosageType, type DosageDraft } from "./dosageEditor";
import { loadProgramContent, computeDraftFingerprint, parseReviewFingerprint } from "./prescriptionProgramServer";
import type {
  DraftSource,
  DraftStatus,
  SchedulingMode,
  RehabPhase,
  PerformanceFocus,
  ExerciseStatus,
  DosageInput,
  DosageType,
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
  target_sessions_per_week: number | null;
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

type DraftRowWithPatient = DraftRow & { patient_prescriptions: { patient_id: string } | null };

async function loadEditableDraft(supabase: Supabase, clinicianId: string, draftId: string): Promise<DraftRow> {
  const { data, error } = await supabase
    .from("prescription_drafts")
    .select("*, patient_prescriptions(patient_id)")
    .eq("id", draftId)
    .maybeSingle();
  if (error || !data) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  return assertEditableDraft(clinicianId, data as DraftRowWithPatient);
}

// The ownership/patient-authorization checks themselves, applied to an
// already-loaded draft row. Shared by loadEditableDraft() and the
// single-read loaders below, so the checks are never duplicated.
async function assertEditableDraft(clinicianId: string, draft: DraftRowWithPatient): Promise<DraftRow> {
  const patientId = draft.patient_prescriptions?.patient_id;
  if (!patientId) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");

  if (draft.status !== "editing") throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  if (draft.editing_clinician_id !== clinicianId) throw new PrescriptionDraftError("DRAFT_NOT_OWNED_BY_CALLER");
  return draft;
}

// C5.4 Performance Pass — workout-scoped mutations previously resolved
// workout → draft id, then loaded the draft, as two sequential Supabase
// round trips before the authorization check could even start. This loads
// the workout's draft (with its patient) in ONE embedded read and then runs
// the exact same assertEditableDraft() checks. Missing workout/draft still
// surfaces as DRAFT_NOT_FOUND, exactly as before.
async function loadEditableDraftForWorkout(
  supabase: Supabase,
  clinicianId: string,
  workoutId: string
): Promise<{ draftId: string; draftRow: DraftRowWithPatient; check: () => Promise<DraftRow> }> {
  const { data, error } = await supabase
    .from("prescription_workouts")
    .select("prescription_draft_id, prescription_drafts(*, patient_prescriptions(patient_id))")
    .eq("id", workoutId)
    .maybeSingle();
  const draftRow = (data?.prescription_drafts ?? null) as unknown as DraftRowWithPatient | null;
  if (error || !data?.prescription_draft_id || !draftRow) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  return { draftId: data.prescription_draft_id as string, draftRow, check: () => assertEditableDraft(clinicianId, draftRow) };
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
  targetSessionsPerWeek?: number | null;
  performanceFocuses?: PerformanceFocus[];
}): Promise<void> {
  const supabase = createServiceRoleClient();
  const draft = await loadEditableDraft(supabase, params.clinicianId, params.draftId);

  const patch: Record<string, unknown> = { updated_by: params.clinicianId, updated_at: new Date().toISOString() };
  if (params.phase !== undefined) patch.phase = params.phase;

  let targetSessionsPerWeek = params.targetSessionsPerWeek;

  // C5.4C §7 — authoritative server-side mode-switch cleanup. Fires ONLY on
  // an actual transition detected within this call (comparing the
  // just-loaded persisted mode against the incoming one) — never as a
  // blanket enforcement on every unrelated metadata save, and never left to
  // client-side React state to perform.
  if (params.schedulingMode !== undefined) {
    patch.scheduling_mode = params.schedulingMode;

    if (params.schedulingMode === "sequence" && draft.scheduling_mode !== "sequence") {
      // Calendar -> Sequence: clear days_of_week from every workout in this
      // draft. Workouts/labels/order/exercises/dosage/phase/performance
      // focus are all untouched (no other column in this table or
      // prescription_workouts is written here).
      const { error: clearDaysError } = await supabase
        .from("prescription_workouts")
        .update({ days_of_week: null })
        .eq("prescription_draft_id", params.draftId);
      if (clearDaysError) throw new PrescriptionDraftError("INTERNAL_ERROR");
    }
    if (params.schedulingMode === "calendar" && draft.scheduling_mode !== "calendar") {
      // Sequence -> Calendar: force-clear the target regardless of what the
      // caller passed — never applicable to Calendar mode. workout
      // order_index is untouched (nothing here writes it).
      targetSessionsPerWeek = null;
    }
  }

  if (targetSessionsPerWeek !== undefined) patch.target_sessions_per_week = targetSessionsPerWeek;

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

// Returns the workout's persisted label/days after the update (same round
// trip as the update itself), so a caller can reconcile against the
// authoritative row without re-reading the whole draft.
export async function updateWorkout(params: {
  clinicianId: string;
  workoutId: string;
  label?: string | null;
  daysOfWeek?: number[] | null;
}): Promise<{ id: string; label: string | null; daysOfWeek: number[] | null }> {
  const supabase = createServiceRoleClient();
  const { draftId, check } = await loadEditableDraftForWorkout(supabase, params.clinicianId, params.workoutId);

  // C5.4C §6 — authoritative reject of a weekday already claimed by ANOTHER
  // workout in this draft, enforced HERE (at mutation time, not merely at
  // publish/validateDraft preview) — "do not rely solely on disabled client
  // controls" per the founder brief. validate_prescription_draft's
  // calendar_weekdays_exclusive rule remains the final publish-time
  // authority underneath this; this is the earlier, mutation-time guard.
  //
  // C5.4 Performance Pass — the sibling read runs in parallel with the
  // authorization check (it is a read only; nothing is written until both
  // have completed and the check has passed).
  const needsSiblingCheck = params.daysOfWeek != null && params.daysOfWeek.length > 0;
  const [, siblingResult] = await Promise.all([
    check(),
    needsSiblingCheck
      ? supabase.from("prescription_workouts").select("days_of_week").eq("prescription_draft_id", draftId).neq("id", params.workoutId)
      : Promise.resolve(null),
  ]);
  if (needsSiblingCheck && params.daysOfWeek) {
    const { data: siblingWorkouts, error: siblingError } = siblingResult!;
    if (siblingError) throw new PrescriptionDraftError("INTERNAL_ERROR");
    const claimedElsewhere = new Set((siblingWorkouts ?? []).flatMap((w) => (w.days_of_week as number[] | null) ?? []));
    if (params.daysOfWeek.some((d) => claimedElsewhere.has(d))) {
      throw new PrescriptionDraftError(
        "VALIDATION_FAILED",
        "One or more selected weekdays are already assigned to another workout in this prescription."
      );
    }
  }

  const patch: Record<string, unknown> = {};
  if (params.label !== undefined) patch.label = params.label;
  if (params.daysOfWeek !== undefined) patch.days_of_week = params.daysOfWeek;
  const { data: updated, error } = await supabase.from("prescription_workouts").update(patch).eq("id", params.workoutId).select("id, label, days_of_week").single();
  if (error || !updated) throw new PrescriptionDraftError("VALIDATION_FAILED");
  return { id: updated.id as string, label: (updated.label as string | null) ?? null, daysOfWeek: (updated.days_of_week as number[] | null) ?? null };
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
  const { check } = await loadEditableDraftForWorkout(supabase, params.clinicianId, params.workoutId);

  // C5.4 Performance Pass — the canonical-exercise existence read runs in
  // parallel with the authorization check; the insert still only happens
  // after both complete and the check has passed. An authorization failure
  // still wins over EXERCISE_UNAVAILABLE: a rejected check() rejects the
  // Promise.all, and the existence result is only inspected afterwards.
  const [, { data: exercise }] = await Promise.all([
    check(),
    supabase.from("canonical_exercises").select("id").eq("id", params.canonicalExerciseId).maybeSingle(),
  ]);
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

// C5.4C §6/§14 — the audit's identified gap: the existing reorder RPC is
// strictly same-parent (it asserts the ordered-ids count matches the
// TARGET workout's current exercise count, so it structurally cannot move
// anything across workouts). This is a plain single-column UPDATE, not a
// new RPC — prescription_exercises.id (identity), its dosage row (FK'd to
// the exercise id, never the workout), its additional_instructions, and its
// status are all untouched by construction; only prescription_workout_id
// and order_index change. The source workout is left with a gap in
// order_index, which is safe: only WORKOUT order_index is contiguity-
// checked (and only under Sequence mode) — prescription_exercises.order_index
// has no contiguity requirement, only the existing UNIQUE(workout, order)
// constraint, which appending at the end of the target always satisfies.
export async function moveExercise(params: { clinicianId: string; exerciseId: string; targetWorkoutId: string }): Promise<void> {
  const supabase = createServiceRoleClient();
  const sourceWorkoutId = await resolveWorkoutIdForExercise(supabase, params.exerciseId);
  const sourceDraftId = await resolveDraftIdForWorkout(supabase, sourceWorkoutId);
  await loadEditableDraft(supabase, params.clinicianId, sourceDraftId);

  if (sourceWorkoutId === params.targetWorkoutId) return;

  // Never move across drafts/patients — target must belong to the exact
  // same draft as the source (already ownership-checked above).
  const targetDraftId = await resolveDraftIdForWorkout(supabase, params.targetWorkoutId);
  if (targetDraftId !== sourceDraftId) throw new PrescriptionDraftError("VALIDATION_FAILED");

  const { data: exerciseRow, error: exerciseError } = await supabase
    .from("prescription_exercises")
    .select("canonical_exercise_id")
    .eq("id", params.exerciseId)
    .maybeSingle();
  if (exerciseError || !exerciseRow) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");

  // Reject rather than create a same-workout duplicate or auto-merge dosage
  // (C5.4C §14 — explicit founder decision).
  const { count: duplicateCount, error: duplicateError } = await supabase
    .from("prescription_exercises")
    .select("id", { count: "exact", head: true })
    .eq("prescription_workout_id", params.targetWorkoutId)
    .eq("canonical_exercise_id", exerciseRow.canonical_exercise_id);
  if (duplicateError) throw new PrescriptionDraftError("INTERNAL_ERROR");
  if ((duplicateCount ?? 0) > 0) {
    throw new PrescriptionDraftError("EXERCISE_UNAVAILABLE", "This exercise already exists in the target workout.");
  }

  const { count: targetCount, error: countError } = await supabase
    .from("prescription_exercises")
    .select("id", { count: "exact", head: true })
    .eq("prescription_workout_id", params.targetWorkoutId);
  if (countError) throw new PrescriptionDraftError("INTERNAL_ERROR");

  const { error: moveError } = await supabase
    .from("prescription_exercises")
    .update({ prescription_workout_id: params.targetWorkoutId, order_index: targetCount ?? 0 })
    .eq("id", params.exerciseId);
  if (moveError) throw new PrescriptionDraftError("VALIDATION_FAILED");
}

// ---------------------------------------------------------------------------
// Dosage — upsert (one row per exercise, 1:1 by DB constraint). C5.4B: the
// row object below explicitly sets EVERY dosage column from the incoming
// DosageInput (never a partial patch) — switching dosage type therefore
// automatically nulls out every field belonging to the PREVIOUS type,
// because the caller constructs a fresh DosageInput containing only the
// newly-selected type's fields. This is deliberate: it is what gives C5.4B
// §20's "no stale hidden fields survive a type switch" guarantee for free,
// with no separate clear-then-write step needed.
//
// validateDosageInput() (lib/dosageEditor.ts, pure/isomorphic) is called
// here BEFORE the upsert — the exact same validator the client editor runs
// for immediate feedback, never duplicated or re-implemented differently
// per caller (C5.4B §21). The DB's own CHECK constraints remain the true,
// final authority underneath this — this call exists to turn what would
// otherwise be an opaque Postgres constraint violation into an early,
// specific, clinician-readable rejection.
// ---------------------------------------------------------------------------

export async function updateDosage(params: { clinicianId: string; exerciseId: string; dosage: DosageInput }): Promise<DosageInput> {
  const supabase = createServiceRoleClient();
  // C5.4 Performance Pass — exercise → workout → draft (with patient) plus
  // the existing dosage_type in ONE embedded read, replacing four
  // sequential round trips; the same assertEditableDraft() checks follow.
  const { data: exerciseRow, error: exerciseError } = await supabase
    .from("prescription_exercises")
    .select("id, prescription_exercise_dosage(dosage_type), prescription_workouts(prescription_draft_id, prescription_drafts(*, patient_prescriptions(patient_id)))")
    .eq("id", params.exerciseId)
    .maybeSingle();
  const workoutRow = (exerciseRow?.prescription_workouts ?? null) as unknown as { prescription_draft_id: string; prescription_drafts: DraftRowWithPatient | null } | null;
  if (exerciseError || !exerciseRow || !workoutRow?.prescription_drafts) throw new PrescriptionDraftError("DRAFT_NOT_FOUND");
  await assertEditableDraft(params.clinicianId, workoutRow.prescription_drafts);
  const rawExisting = exerciseRow.prescription_exercise_dosage as unknown;
  const existingRow = (Array.isArray(rawExisting) ? rawExisting[0] : rawExisting) as { dosage_type: DosageType } | null | undefined;

  // C5.4 Revision B — the clinician no longer chooses dosage_type at all;
  // it is derived here, authoritatively, from whichever dimensions were
  // actually populated (never trusted verbatim from the request body — see
  // deriveDosageType()'s header in dosageEditor.ts for the exact rule).
  const d: DosageInput = {
    ...params.dosage,
    dosageType: deriveDosageType(params.dosage as DosageDraft, (existingRow?.dosage_type as DosageType | undefined) ?? null),
  };
  const validationErrors = validateDosageInput(d);
  if (validationErrors.length > 0) {
    throw new PrescriptionDraftError("VALIDATION_FAILED", validationErrors[0].message, { fieldErrors: validationErrors });
  }

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
    distance_mode: d.distanceMode ?? null,
    distance_exact_value: d.distanceExactValue ?? null,
    distance_min_value: d.distanceMinValue ?? null,
    distance_max_value: d.distanceMaxValue ?? null,
    distance_unit: d.distanceUnit ?? null,
    concentric_duration_seconds: d.concentricDurationSeconds ?? null,
    rep_hold_duration_seconds: d.repHoldDurationSeconds ?? null,
    eccentric_duration_seconds: d.eccentricDurationSeconds ?? null,
    tempo_description: d.tempoDescription ?? null,
    rest_seconds: d.restSeconds ?? null,
    load_type: d.loadType ?? "not_applicable",
    load_value_exact: d.loadValueExact ?? null,
    load_unit: d.loadUnit ?? null,
    load_mode: d.loadMode ?? null,
    load_value_min: d.loadValueMin ?? null,
    load_value_max: d.loadValueMax ?? null,
    rpe: d.rpe ?? null,
    rir: d.rir ?? null,
    rom: d.rom ?? null,
    assistance_level: d.assistanceLevel ?? null,
    side: d.side ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("prescription_exercise_dosage").upsert(row, { onConflict: "prescription_exercise_id" });
  if (error) throw new PrescriptionDraftError("VALIDATION_FAILED");
  return d;
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

// C5.4D — expectedFingerprint (optional, sent by Review): the draft content
// must still be exactly what the clinician reviewed, else DRAFT_CHANGED.
// Computed from the database, never from client state; omitting it keeps
// the C5.3 contract unchanged. Publication VALIDITY is not decided here:
// every blocking rule (including C5.4D's workouts_have_active_exercise and
// active_exercise_dosage_valid) is enforced by validate_prescription_draft
// inside publish_prescription_draft's transaction, with the draft row locked
// FOR UPDATE against concurrent content writes (20261010000001).
export async function publishDraft(params: {
  clinicianId: string;
  draftId: string;
  expectedFingerprint?: string | null;
}): Promise<{ versionId: string; versionNumber: number | null }> {
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

  let expectedRevision: number | null = null;
  if (params.expectedFingerprint != null) {
    const expected = parseReviewFingerprint(params.expectedFingerprint);
    expectedRevision = expected.revision;
    let program;
    try {
      program = await loadProgramContent(supabase, { kind: "draft", id: params.draftId }, draft);
    } catch {
      throw new PrescriptionDraftError("INTERNAL_ERROR");
    }
    if (computeDraftFingerprint(draft, program) !== expected.contentHash) {
      throw new PrescriptionDraftError("DRAFT_CHANGED");
    }
  }

  // C5.6C — the revision is re-verified inside the RPC under the draft row
  // lock, so a write landing after the hash check above is still refused.
  const { data, error } = await supabase.rpc("publish_prescription_draft", {
    p_draft_id: params.draftId,
    p_clinician_id: params.clinicianId,
    p_expected_revision: expectedRevision,
  });
  if (error) throw mapRpcError(error);
  const versionId = data as string;

  // The version is already committed; a failed number lookup must not turn
  // a successful publication into a reported failure.
  const { data: version } = await supabase.from("prescription_versions").select("version_number").eq("id", versionId).maybeSingle();
  return { versionId, versionNumber: (version?.version_number as number | undefined) ?? null };
}

// C5.4D §20 — authoritative reconciliation after an ambiguous publish
// response (network loss, timeout, 5xx). Read tier, like getDraft: any
// actively-supervising clinician may ask. A draft can only reach 'published'
// inside publish_prescription_draft, which writes the draft's updated_at and
// the new version's published_at from the same transaction's now() — so
// equality on those two timestamps identifies exactly the version this draft
// produced, never a later one.
export async function getDraftPublicationOutcome(params: { clinicianId: string; draftId: string }): Promise<{
  status: DraftStatus;
  version: { id: string; versionNumber: number; isCurrent: boolean } | null;
}> {
  const supabase = createServiceRoleClient();
  const draft = await loadEditableDraftOrReadable(supabase, params.clinicianId, params.draftId);
  if (draft.status !== "published") return { status: draft.status, version: null };

  const [{ data: version }, { data: pp }] = await Promise.all([
    supabase
      .from("prescription_versions")
      .select("id, version_number")
      .eq("patient_prescription_id", draft.patient_prescription_id)
      .eq("published_at", draft.updated_at)
      .maybeSingle(),
    supabase.from("patient_prescriptions").select("current_prescription_version_id").eq("id", draft.patient_prescription_id).maybeSingle(),
  ]);
  if (!version) return { status: draft.status, version: null };
  return {
    status: draft.status,
    version: {
      id: version.id as string,
      versionNumber: version.version_number as number,
      isCurrent: pp?.current_prescription_version_id === version.id,
    },
  };
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
