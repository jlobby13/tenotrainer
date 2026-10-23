import { notFound, redirect } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { findEditingDraftId, getClinicianDisplayName } from "@/lib/prescriptionManagementServer";
import { getDraft } from "@/lib/prescriptionDraftServer";
import { listCanonicalExercisesForClinician, getCanonicalExerciseNamesByIds } from "@/lib/canonicalExerciseLibraryServer";
import { mapDosageRowToInput } from "@/lib/dosageEditor";
import type { SchedulingMode, RehabPhase } from "@/lib/prescriptionDraftTypes";
import { BuilderShell } from "./BuilderShell";
import type { BuilderDraftWorkout } from "./types";

export const metadata = { title: "Prescription Builder — TenoTrainer" };

type RawExercise = {
  id: string;
  canonical_exercise_id: string;
  order_index: number;
  status: "active" | "paused";
  additional_instructions: string | null;
  prescription_exercise_dosage: unknown;
};
type RawWorkout = {
  id: string;
  label: string | null;
  order_index: number;
  days_of_week: number[] | null;
  prescription_exercises: RawExercise[] | null;
};

// C5.4A — Builder route (brief §3). Same authorization sequence as the
// entry point: requireClinicianAuth() -> assertSupervises() -> notFound().
// If there is no OPEN (status='editing') draft for this patient, redirect
// back to the management route rather than rendering a fake/empty builder
// — never invents draft state client-side.
//
// C5.4D — optional ?workout=&exercise=&focus= open the builder at the place a
// Review issue points to. Pure navigation hints: ids that don't belong to
// this draft are ignored (BuilderShell falls back to its normal start), and
// nothing about the draft itself is carried in the URL.
export default async function PrescriptionBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ workout?: string; exercise?: string; focus?: string }>;
}) {
  const { id: patientId } = await params;
  const { workout: focusWorkoutId, exercise: focusExerciseId, focus } = await searchParams;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const draftId = await findEditingDraftId(patientId);
  if (!draftId) redirect(`/clinician/patients/${patientId}/prescription`);

  const { draft, workouts, performanceFocuses } = await getDraft({ clinicianId, draftId });
  if (draft.status !== "editing") redirect(`/clinician/patients/${patientId}/prescription`);

  const isOwner = draft.editing_clinician_id === clinicianId;
  const editingClinicianName = isOwner ? "You" : await getClinicianDisplayName(draft.editing_clinician_id);

  const rawWorkouts = workouts as unknown as RawWorkout[];
  const allCanonicalIds = Array.from(new Set(rawWorkouts.flatMap((w) => (w.prescription_exercises ?? []).map((e) => e.canonical_exercise_id))));
  const nameById = await getCanonicalExerciseNamesByIds(allCanonicalIds);

  const initialWorkouts: BuilderDraftWorkout[] = rawWorkouts
    .slice()
    .sort((a, b) => a.order_index - b.order_index)
    .map((w) => ({
      id: w.id,
      label: w.label ?? null,
      orderIndex: w.order_index,
      daysOfWeek: w.days_of_week ?? null,
      exercises: (w.prescription_exercises ?? [])
        .slice()
        .sort((a, b) => a.order_index - b.order_index)
        .map((e) => {
          const rawDosage = Array.isArray(e.prescription_exercise_dosage) ? e.prescription_exercise_dosage[0] : e.prescription_exercise_dosage;
          const dosage = mapDosageRowToInput(rawDosage as Record<string, unknown> | null | undefined);
          const meta = nameById.get(e.canonical_exercise_id);
          return {
            id: e.id,
            canonicalExerciseId: e.canonical_exercise_id,
            orderIndex: e.order_index,
            status: e.status,
            exerciseName: meta?.name ?? "Unknown exercise",
            loadingProfile: meta?.loadingProfile ?? null,
            dosageConfigured: dosage !== null,
            dosage,
            additionalInstructions: e.additional_instructions ?? null,
          };
        }),
    }));

  const exercises = await listCanonicalExercisesForClinician(clinicianId);

  return (
    <BuilderShell
      patientId={patientId}
      draftId={draftId}
      isOwner={isOwner}
      editingClinicianName={editingClinicianName}
      initialWorkouts={initialWorkouts}
      initialExercises={exercises}
      initialSchedulingMode={(draft.scheduling_mode as SchedulingMode | null) ?? null}
      initialPhase={(draft.phase as RehabPhase | null) ?? null}
      initialTargetSessionsPerWeek={(draft as unknown as { target_sessions_per_week: number | null }).target_sessions_per_week ?? null}
      initialRecoveryDays={(draft as unknown as { recovery_days: number | null }).recovery_days ?? 0}
      initialPerformanceFocuses={performanceFocuses}
      initialFocus={{
        workoutId: typeof focusWorkoutId === "string" ? focusWorkoutId : null,
        exerciseId: typeof focusExerciseId === "string" ? focusExerciseId : null,
        section: focus === "schedule" || focus === "weekdays" ? focus : null,
      }}
    />
  );
}
