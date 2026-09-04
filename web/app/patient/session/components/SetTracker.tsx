"use client";

import { useState } from "react";
import type { SessionExercise } from "@/lib/fastapi";
import type { ExerciseExecutionState } from "@/lib/activeSession";
import { getPrescribedSet, getTotalSets, getNextPendingSetIndex } from "@/lib/activeSession";
import { prescribedSetLabel } from "@/lib/exerciseDisplay";

function EditForm({
  initialReps,
  initialLoad,
  onCancel,
  onSubmit,
}: {
  initialReps: number;
  initialLoad?: number;
  onCancel: () => void;
  onSubmit: (actual: { reps: number; load?: number }) => void;
}) {
  // Ephemeral — not persisted until the patient confirms.
  const [reps, setReps] = useState(String(initialReps));
  const [load, setLoad] = useState(initialLoad != null ? String(initialLoad) : "");

  return (
    <div className="mt-2 space-y-2 bg-white border border-gray-200 rounded-lg p-3">
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-500">
          Reps / Hold (sec)
          <input
            type="number"
            inputMode="numeric"
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex-1 text-xs text-gray-500">
          Load (kg)
          <input
            type="number"
            inputMode="decimal"
            value={load}
            onChange={(e) => setLoad(e.target.value)}
            className="mt-1 w-full border border-gray-200 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            const parsedReps = parseFloat(reps);
            const parsedLoad = load.trim() === "" ? undefined : parseFloat(load);
            onSubmit({ reps: Number.isFinite(parsedReps) ? parsedReps : initialReps, load: parsedLoad });
          }}
          className="flex-1 px-3 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg"
        >
          Complete Set
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 text-sm font-medium text-gray-500"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function SetTracker({
  exercise,
  exerciseState,
  onCompleteSet,
  onUndoSet,
}: {
  exercise: SessionExercise;
  exerciseState: ExerciseExecutionState;
  onCompleteSet: (setIndex: number, actual: { reps: number; load?: number }, wasEdited: boolean) => void;
  onUndoSet: (setIndex: number) => void;
}) {
  const totalSets = getTotalSets(exercise);
  const prescribed = getPrescribedSet(exercise);
  const nextPending = getNextPendingSetIndex(exerciseState, totalSets);
  const [editingSetIndex, setEditingSetIndex] = useState<number | null>(null);

  const rows = Array.from({ length: totalSets }, (_, i) => i);

  return (
    <div className="space-y-2">
      {rows.map((setIndex) => {
        const actual = exerciseState.actualSets.find((s) => s.setIndex === setIndex) ?? null;
        const isCurrent = setIndex === nextPending;
        const isEditing = editingSetIndex === setIndex;

        if (actual) {
          return (
            <div key={setIndex} className="bg-white border border-gray-100 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    Set {setIndex + 1}: {actual.reps} reps
                    {actual.load != null ? ` · ${actual.load} kg` : ""}
                  </p>
                  {actual.wasEdited && <p className="text-xs text-gray-400">Edited from prescription</p>}
                </div>
                <div className="flex items-center gap-3 text-xs font-semibold">
                  <button type="button" onClick={() => setEditingSetIndex(setIndex)} className="text-gray-500">
                    Edit
                  </button>
                  <button type="button" onClick={() => onUndoSet(setIndex)} className="text-gray-500">
                    Undo
                  </button>
                </div>
              </div>
              {isEditing && (
                <EditForm
                  initialReps={actual.reps}
                  initialLoad={actual.load}
                  onCancel={() => setEditingSetIndex(null)}
                  onSubmit={(edited) => {
                    onCompleteSet(setIndex, edited, true);
                    setEditingSetIndex(null);
                  }}
                />
              )}
            </div>
          );
        }

        if (isCurrent) {
          return (
            <div key={setIndex} className="bg-white border-2 border-brand-200 rounded-lg p-4">
              <p className="text-sm font-semibold text-gray-900">
                Set {setIndex + 1} of {totalSets}
              </p>
              <p className="text-sm text-gray-600 mt-0.5">{prescribedSetLabel(exercise.dosage)}</p>

              {isEditing ? (
                <EditForm
                  initialReps={prescribed.reps}
                  initialLoad={prescribed.load}
                  onCancel={() => setEditingSetIndex(null)}
                  onSubmit={(edited) => {
                    onCompleteSet(setIndex, edited, true);
                    setEditingSetIndex(null);
                  }}
                />
              ) : (
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => onCompleteSet(setIndex, prescribed, false)}
                    className="flex-1 px-4 py-3 bg-brand-600 text-white text-base font-semibold rounded-lg"
                  >
                    Complete Set
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingSetIndex(setIndex)}
                    className="px-3 py-3 text-sm font-medium text-gray-500 border border-gray-200 rounded-lg"
                  >
                    Edit Reps / Load
                  </button>
                </div>
              )}
            </div>
          );
        }

        return (
          <div key={setIndex} className="bg-gray-50 border border-gray-100 rounded-lg p-3 opacity-50">
            <p className="text-sm text-gray-400">
              Set {setIndex + 1}: {prescribedSetLabel(exercise.dosage)}
            </p>
          </div>
        );
      })}
    </div>
  );
}
