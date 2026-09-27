"use client";

// C5.4A/C5.4B — Draft panel (brief §4 right panel, §14-15; C5.4B §2 dosage
// editor location). Single-workout model for this milestone (A/B/C workout
// management is explicitly out of scope — see BuilderShell's handleAdd
// comment); reorder controls operate within that one workout.

import { formatLoadingProfileLabel } from "@/lib/canonicalExerciseLibrary";
import { formatDosageSummary } from "@/lib/dosageEditor";
import type { DosageInput } from "@/lib/prescriptionDraftTypes";
import { DosageEditor } from "./DosageEditor";
import type { BuilderDraftWorkout, BuilderLibraryExercise } from "./types";

type Props = {
  workouts: BuilderDraftWorkout[];
  isOwner: boolean;
  onRemove: (exerciseId: string) => void;
  onMove: (workoutId: string, exerciseId: string, direction: "up" | "down") => void;
  busy: boolean;
  exercisesById: Map<string, BuilderLibraryExercise>;
  editingDosageExerciseId: string | null;
  onOpenDosageEditor: (exerciseId: string) => void;
  onCloseDosageEditor: () => void;
  onSaveDosage: (exerciseId: string, dosage: DosageInput, additionalInstructions: string | null) => Promise<{ ok: true } | { ok: false; message: string }>;
};

export function DraftPanel({
  workouts,
  isOwner,
  onRemove,
  onMove,
  busy,
  exercisesById,
  editingDosageExerciseId,
  onOpenDosageEditor,
  onCloseDosageEditor,
  onSaveDosage,
}: Props) {
  const allExercises = workouts.flatMap((w) => w.exercises);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Prescription Draft</h2>

      {allExercises.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 text-center">
          <p className="text-sm text-gray-500">No exercises in this draft yet.</p>
          <p className="text-xs text-gray-400 mt-1">Add exercises from the library to get started.</p>
        </div>
      ) : (
        workouts.map((workout) => (
          <div key={workout.id} className="space-y-2" data-testid="draft-exercise-list">
            {workout.exercises.map((exercise, index) => {
              const isEditing = editingDosageExerciseId === exercise.id;
              const referenceDosage = exercisesById.get(exercise.canonicalExerciseId)?.referenceDosage ?? null;
              return (
                <div key={exercise.id} className="bg-white rounded-lg border border-gray-100 shadow-sm p-3" data-testid="draft-exercise-row">
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs font-medium flex items-center justify-center">{index + 1}</span>

                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">{exercise.exerciseName}</div>
                      <div className="text-xs text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                        {formatLoadingProfileLabel(exercise.loadingProfile) && <span>{formatLoadingProfileLabel(exercise.loadingProfile)}</span>}
                        {isOwner ? (
                          <button
                            onClick={() => onOpenDosageEditor(exercise.id)}
                            data-testid="dosage-affordance"
                            className={
                              exercise.dosage
                                ? "text-gray-600 underline decoration-dotted hover:text-brand-600"
                                : "inline-flex items-center rounded-full bg-amber-50 text-amber-700 text-xs font-medium px-2 py-0.5 hover:bg-amber-100"
                            }
                          >
                            {exercise.dosage ? formatDosageSummary(exercise.dosage) : "Dosage needed"}
                          </button>
                        ) : exercise.dosage ? (
                          <span className="text-gray-600" data-testid="dosage-summary-readonly">
                            {formatDosageSummary(exercise.dosage)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 text-xs font-medium px-2 py-0.5">Dosage needed</span>
                        )}
                      </div>
                    </div>

                    {isOwner && (
                      <div className="shrink-0 flex items-center gap-1">
                        <button
                          onClick={() => onMove(workout.id, exercise.id, "up")}
                          disabled={busy || index === 0}
                          aria-label="Move up"
                          className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:text-brand-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => onMove(workout.id, exercise.id, "down")}
                          disabled={busy || index === workout.exercises.length - 1}
                          aria-label="Move down"
                          className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:text-brand-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => onRemove(exercise.id)}
                          disabled={busy}
                          aria-label="Remove from draft"
                          className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>

                  {isEditing && isOwner && (
                    <DosageEditor
                      initialDosage={exercise.dosage}
                      initialInstructions={exercise.additionalInstructions}
                      referenceDosage={referenceDosage}
                      onSave={(dosage, additionalInstructions) => onSaveDosage(exercise.id, dosage, additionalInstructions)}
                      onCancel={onCloseDosageEditor}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
