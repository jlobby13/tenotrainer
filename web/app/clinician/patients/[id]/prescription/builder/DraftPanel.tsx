"use client";

// C5.4A — Draft panel (brief §4 right panel, §14-15). Single-workout model
// for this milestone (A/B/C workout management is explicitly out of scope
// — see BuilderShell's handleAdd comment); reorder controls operate within
// that one workout.

import { formatLoadingProfileLabel } from "@/lib/canonicalExerciseLibrary";
import type { BuilderDraftWorkout } from "./types";

type Props = {
  workouts: BuilderDraftWorkout[];
  isOwner: boolean;
  onRemove: (exerciseId: string) => void;
  onMove: (workoutId: string, exerciseId: string, direction: "up" | "down") => void;
  busy: boolean;
};

export function DraftPanel({ workouts, isOwner, onRemove, onMove, busy }: Props) {
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
            {workout.exercises.map((exercise, index) => (
              <div key={exercise.id} className="bg-white rounded-lg border border-gray-100 shadow-sm p-3 flex items-center gap-3" data-testid="draft-exercise-row">
                <span className="shrink-0 w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs font-medium flex items-center justify-center">{index + 1}</span>

                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{exercise.exerciseName}</div>
                  <div className="text-xs text-gray-500 flex flex-wrap items-center gap-x-2 gap-y-1">
                    {formatLoadingProfileLabel(exercise.loadingProfile) && <span>{formatLoadingProfileLabel(exercise.loadingProfile)}</span>}
                    {exercise.dosageConfigured ? (
                      <span className="text-gray-400">Dosage configured</span>
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
            ))}
          </div>
        ))
      )}
    </div>
  );
}
