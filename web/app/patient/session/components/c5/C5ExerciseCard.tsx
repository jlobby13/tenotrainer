"use client";

import { describeDosage } from "@/lib/prescriptionProgram";
import { unitCount, unitEntry, unitKey, type C5SnapshotExercise, type C5UnitKey } from "@/lib/c5RuntimeTypes";
import { C5UnitRow, type C5UnitDisplay, type C5UnitSyncView } from "./C5UnitRow";

// C5.6D — one exercise of the frozen snapshot (or the pre-Start preview)
// with a row per unit.
export function C5ExerciseCard({
  exercise,
  position,
  total,
  displayFor,
  syncFor,
  interactive,
  allowUndoSkip,
  onComplete,
  onSkip,
  onUndoSkip,
  onRetry,
  onSkipExercise,
}: {
  exercise: C5SnapshotExercise;
  position: number;
  total: number;
  displayFor: (key: C5UnitKey) => C5UnitDisplay;
  syncFor: (key: C5UnitKey) => C5UnitSyncView;
  interactive: boolean;
  allowUndoSkip: boolean;
  onComplete: (unitIndex: number, value: number, load: number | null) => void;
  onSkip: (unitIndex: number) => void;
  onUndoSkip: (unitIndex: number) => void;
  onRetry: (unitIndex: number) => void;
  onSkipExercise: () => void;
}) {
  const units = unitCount(exercise.dosage);
  const entry = unitEntry(exercise.dosage);
  const dosage = describeDosage(exercise.dosage);
  const keys = Array.from({ length: units }, (_, i) => unitKey(exercise.exerciseId, i));
  const anyPending = keys.some((k) => displayFor(k).kind === "pending");
  const unitWord = exercise.dosage.sets != null ? "Set" : exercise.dosage.intervalRounds != null ? "Round" : "Bout";

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5" data-c5-exercise={exercise.exerciseId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">
            Exercise {position} of {total}
          </p>
          <h3 className="mt-0.5 break-words text-base font-semibold text-slate-50">{exercise.name}</h3>
          {dosage.headline && <p className="mt-1 text-sm font-medium text-teal-300">{dosage.headline}</p>}
          {(dosage.details.length > 0 || dosage.modifiers.length > 0) && (
            <p className="mt-1 text-xs leading-relaxed text-slate-400">{[...dosage.details, ...dosage.modifiers].join(" · ")}</p>
          )}
        </div>
      </div>
      {exercise.additionalInstructions && (
        <p className="mt-3 rounded-lg bg-slate-950/50 px-3 py-2 text-sm leading-relaxed text-slate-300">{exercise.additionalInstructions}</p>
      )}
      <div className="mt-4 space-y-2">
        {keys.map((k, i) => (
          <C5UnitRow
            key={k}
            title={units === 1 ? unitWord : `${unitWord} ${i + 1} of ${units}`}
            entry={entry}
            display={displayFor(k)}
            sync={syncFor(k)}
            interactive={interactive}
            allowUndoSkip={allowUndoSkip}
            onComplete={(v, l) => onComplete(i, v, l)}
            onSkip={() => onSkip(i)}
            onUndoSkip={() => onUndoSkip(i)}
            onRetry={() => onRetry(i)}
          />
        ))}
      </div>
      {interactive && anyPending && units > 1 && (
        <button type="button" onClick={onSkipExercise} className="mt-3 min-h-11 text-sm font-medium text-slate-400 underline hover:text-slate-200">
          Skip this exercise
        </button>
      )}
    </section>
  );
}
