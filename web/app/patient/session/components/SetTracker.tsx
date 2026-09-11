"use client";

import { useState } from "react";
import type { SessionExercise } from "@/lib/fastapi";
import type { ExerciseExecutionState } from "@/lib/activeSession";
import { getPrescribedSet, getTotalSets, getNextPendingSetIndex, getSetOutcome } from "@/lib/activeSession";
import { prescribedSetLabel, repsOrHoldLabel } from "@/lib/exerciseDisplay";

function EditForm({
  initialReps,
  initialLoad,
  prescribedText,
  onCancel,
  onSubmit,
}: {
  // null (never a fabricated number) whenever the prescribed dosage isn't a
  // plain rep count — e.g. a hold duration or rep range. See
  // lib/activeSession.ts's getPrescribedSet for why.
  initialReps: number | null;
  initialLoad?: number;
  // The exact prescribed-dosage text (e.g. "45s hold", "8-12"), shown as
  // reference only when initialReps is null — never converted into a number.
  prescribedText?: string | null;
  onCancel: () => void;
  onSubmit: (actual: { reps: number; load?: number }) => void;
}) {
  // Ephemeral — not persisted until the patient confirms. Empty (never a
  // guessed number) when there is no genuine numeric prescription to prefill.
  const [reps, setReps] = useState(initialReps != null ? String(initialReps) : "");
  const [load, setLoad] = useState(initialLoad != null ? String(initialLoad) : "");

  const parsedReps = parseFloat(reps);
  const canSubmit = Number.isFinite(parsedReps);

  return (
    <div className="mt-2 space-y-2 bg-white border border-gray-200 rounded-lg p-3">
      {prescribedText && initialReps == null && (
        <p className="text-xs text-gray-500">
          Prescribed: <span className="font-medium text-gray-700">{prescribedText}</span> — enter what you actually did below.
        </p>
      )}
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-500">
          Reps / Hold (sec)
          <input
            type="number"
            inputMode="numeric"
            value={reps}
            onChange={(e) => setReps(e.target.value)}
            placeholder={initialReps == null ? "Enter a number" : undefined}
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
          disabled={!canSubmit}
          onClick={() => {
            if (!canSubmit) return; // no fallback to a fabricated value — a real number is required
            const parsedLoad = load.trim() === "" ? undefined : parseFloat(load);
            onSubmit({ reps: parsedReps, load: parsedLoad });
          }}
          className="flex-1 px-3 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Complete Set
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-2 text-sm font-medium text-gray-500">
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
  onSkipSet,
  onUndoSetOutcome,
}: {
  exercise: SessionExercise;
  exerciseState: ExerciseExecutionState;
  onCompleteSet: (setIndex: number, actual: { reps: number; load?: number }, wasEdited: boolean) => void;
  onSkipSet: (setIndex: number) => void;
  onUndoSetOutcome: (setIndex: number) => void;
}) {
  const totalSets = getTotalSets(exercise);
  const prescribed = getPrescribedSet(exercise);
  // M6 Stage 2 founder-acceptance patch: only a genuine plain-numeric
  // prescribed rep count may be one-tap-completed or used as an edit-form
  // default. A hold duration, rep range, or free-form duration (reps ===
  // null) always requires the patient to type a real number themselves —
  // see lib/activeSession.ts's getPrescribedSet.
  const hasNumericPrescription = prescribed.reps != null;
  const prescribedText = repsOrHoldLabel(exercise.dosage ?? {});
  const nextPending = getNextPendingSetIndex(exerciseState, totalSets);
  const [editingSetIndex, setEditingSetIndex] = useState<number | null>(null);

  const rows = Array.from({ length: totalSets }, (_, i) => i);

  return (
    <div className="space-y-2">
      {rows.map((setIndex) => {
        const outcome = getSetOutcome(exerciseState, setIndex);
        const isCurrent = setIndex === nextPending;
        const isEditing = editingSetIndex === setIndex;

        if (outcome?.kind === "completed") {
          return (
            <div key={setIndex} className="bg-white border border-gray-100 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    Set {setIndex + 1}: {outcome.actual.reps} reps
                    {outcome.actual.load != null ? ` · ${outcome.actual.load} kg` : ""}
                  </p>
                  {outcome.wasEdited && <p className="text-xs text-gray-400">Edited from prescription</p>}
                </div>
                <div className="flex items-center gap-3 text-xs font-semibold">
                  <button type="button" onClick={() => setEditingSetIndex(setIndex)} className="text-gray-500">
                    Edit
                  </button>
                  <button type="button" onClick={() => onUndoSetOutcome(setIndex)} className="text-gray-500">
                    Undo
                  </button>
                  <button type="button" onClick={() => onSkipSet(setIndex)} className="text-gray-400">
                    Skip
                  </button>
                </div>
              </div>
              {isEditing && (
                <EditForm
                  initialReps={outcome.actual.reps}
                  initialLoad={outcome.actual.load}
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

        if (outcome?.kind === "skipped") {
          return (
            <div key={setIndex} className="bg-amber-50 border border-amber-100 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-amber-900">Set {setIndex + 1}: Skipped</p>
                <div className="flex items-center gap-3 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() =>
                      hasNumericPrescription ? onCompleteSet(setIndex, prescribed as { reps: number; load?: number }, false) : setEditingSetIndex(setIndex)
                    }
                    className="text-brand-600"
                  >
                    Complete Set
                  </button>
                  <button type="button" onClick={() => onUndoSetOutcome(setIndex)} className="text-amber-700">
                    Undo
                  </button>
                </div>
              </div>
              {isEditing && (
                <EditForm
                  initialReps={prescribed.reps}
                  initialLoad={prescribed.load}
                  prescribedText={prescribedText}
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
                  prescribedText={prescribedText}
                  onCancel={() => setEditingSetIndex(null)}
                  onSubmit={(edited) => {
                    onCompleteSet(setIndex, edited, true);
                    setEditingSetIndex(null);
                  }}
                />
              ) : (
                <>
                  <div className="flex gap-2 mt-3">
                    {hasNumericPrescription ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onCompleteSet(setIndex, prescribed as { reps: number; load?: number }, false)}
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
                      </>
                    ) : (
                      // No genuine numeric prescribed value to one-tap-complete
                      // or default an edit form to (hold duration / rep range /
                      // free-form duration) — the patient must enter what they
                      // actually did themselves. See getPrescribedSet().
                      <button
                        type="button"
                        onClick={() => setEditingSetIndex(setIndex)}
                        className="flex-1 px-4 py-3 bg-brand-600 text-white text-base font-semibold rounded-lg"
                      >
                        Log Set
                      </button>
                    )}
                  </div>
                  {/* Deliberately a plain, low-emphasis text link so it never
                      competes visually with Complete Set. No confirmation, no
                      reason prompt — the workout stays low-friction. */}
                  <button
                    type="button"
                    onClick={() => onSkipSet(setIndex)}
                    className="mt-2 text-xs text-gray-400 underline"
                  >
                    Skip Set
                  </button>
                </>
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
