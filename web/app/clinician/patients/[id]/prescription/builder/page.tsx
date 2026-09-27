import { notFound, redirect } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { findEditingDraftId, getClinicianDisplayName } from "@/lib/prescriptionManagementServer";
import { getDraft } from "@/lib/prescriptionDraftServer";
import { listCanonicalExercisesForClinician, getCanonicalExerciseNamesByIds } from "@/lib/canonicalExerciseLibraryServer";
import { BuilderShell } from "./BuilderShell";
import type { BuilderDraftWorkout } from "./types";

export const metadata = { title: "Prescription Builder — TenoTrainer" };

type RawExercise = {
  id: string;
  canonical_exercise_id: string;
  order_index: number;
  status: "active" | "paused";
  prescription_exercise_dosage: unknown;
};
type RawWorkout = { id: string; order_index: number; prescription_exercises: RawExercise[] | null };

// C5.4A — Builder route (brief §3). Same authorization sequence as the
// entry point: requireClinicianAuth() -> assertSupervises() -> notFound().
// If there is no OPEN (status='editing') draft for this patient, redirect
// back to the management route rather than rendering a fake/empty builder
// — never invents draft state client-side.
export default async function PrescriptionBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const draftId = await findEditingDraftId(patientId);
  if (!draftId) redirect(`/clinician/patients/${patientId}/prescription`);

  const { draft, workouts } = await getDraft({ clinicianId, draftId });
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
      orderIndex: w.order_index,
      exercises: (w.prescription_exercises ?? [])
        .slice()
        .sort((a, b) => a.order_index - b.order_index)
        .map((e) => {
          const dosage = Array.isArray(e.prescription_exercise_dosage) ? e.prescription_exercise_dosage[0] : e.prescription_exercise_dosage;
          const meta = nameById.get(e.canonical_exercise_id);
          return {
            id: e.id,
            canonicalExerciseId: e.canonical_exercise_id,
            orderIndex: e.order_index,
            status: e.status,
            exerciseName: meta?.name ?? "Unknown exercise",
            loadingProfile: meta?.loadingProfile ?? null,
            dosageConfigured: !!dosage,
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
    />
  );
}
