"use client";

import { describePatientDosage } from "@/lib/patientDosageDisplay";
import { lastTimeKey, unitCount, unitEntry, unitKey, type C5LastTimeMap, type C5SnapshotExercise, type C5UnitKey } from "@/lib/c5RuntimeTypes";
import { C5UnitRow, type C5UnitDisplay, type C5UnitSyncView } from "./C5UnitRow";
import { C5ExerciseGuidance } from "./C5ExerciseGuidance";
import { describeLastTime, lastTimeDate } from "./c5LastTime";

// C5.6D — one exercise of the frozen snapshot (or the pre-Start preview)
// with a row per unit. PEC: patient dosage wording, prominent rest, frozen
// "How to do it" guidance, the clinician's own note, and factual "Last
// time" context. `reviewOnly` (pre-Begin) shows the sets without any
// performance controls.
export function C5ExerciseCard({
  exercise,
  position,
  total,
  displayFor,
  syncFor,
  interactive,
  reviewOnly = false,
  allowUndoSkip,
  lastTime,
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
  reviewOnly?: boolean;
  allowUndoSkip: boolean;
  lastTime: C5LastTimeMap;
  onComplete: (unitIndex: number, value: number, load: number | null) => void;
  onSkip: (unitIndex: number) => void;
  onUndoSkip: (unitIndex: number) => void;
  onRetry: (unitIndex: number) => void;
  onSkipExercise: () => void;
}) {
  const units = unitCount(exercise.dosage);
  const entry = unitEntry(exercise.dosage);
  const dosage = describePatientDosage(exercise.dosage);
  const keys = Array.from({ length: units }, (_, i) => unitKey(exercise.exerciseId, i));
  const displays = keys.map((k) => displayFor(k));
  const anyPending = displays.some((d) => d.kind === "pending");
  const unitWord = exercise.dosage.intervalRounds != null && exercise.dosage.sets == null ? "Round" : "Set";
  const controls = interactive && !reviewOnly;
  const last = exercise.canonicalExerciseId ? lastTime[lastTimeKey(exercise.canonicalExerciseId, entry.field)] : undefined;
  // Rest is shown before the next set once one set of this exercise is done.
  const firstPendingAfterDone = displays.findIndex((d, i) => d.kind === "pending" && displays.slice(0, i).some((p) => p.kind === "completed"));

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 sm:p-5" data-c5-exercise={exercise.exerciseId}>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">
          Exercise {position} of {total}
        </p>
        <h3 className="mt-0.5 break-words text-base font-semibold text-slate-50">{exercise.name}</h3>
        {dosage.headline && <p className="mt-1 text-sm font-medium text-teal-300">{dosage.headline}</p>}
        {(dosage.details.length > 0 || dosage.modifiers.length > 0) && (
          <p className="mt-1 text-xs leading-relaxed text-slate-400" data-c5-dosage-details>
            {[...dosage.details, ...dosage.modifiers].join(" · ")}
          </p>
        )}
        {dosage.rest && (
          <p className="mt-2 inline-flex items-center rounded-full border border-sky-400/30 bg-sky-400/10 px-3 py-1 text-sm font-medium text-sky-100" data-c5-rest>
            {dosage.rest} between sets
          </p>
        )}
      </div>
      {last && (
        <p className="mt-3 text-sm text-slate-300" data-c5-last-time>
          <span className="font-medium text-slate-400">Last time · {lastTimeDate(last.sessionLocalDate)}</span>
          <br />
          {describeLastTime(last)}
        </p>
      )}
      {exercise.additionalInstructions && (
        <div className="mt-3 rounded-lg bg-slate-950/50 px-3 py-2" data-c5-clinician-note>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Note from your clinician</p>
          <p className="mt-1 text-sm leading-relaxed text-slate-300">{exercise.additionalInstructions}</p>
        </div>
      )}
      <C5ExerciseGuidance guidance={exercise.guidance} exerciseName={exercise.name} />
      <div className="mt-4 space-y-2">
        {keys.map((k, i) => (
          <C5UnitRow
            key={k}
            title={units === 1 ? unitWord : `${unitWord} ${i + 1} of ${units}`}
            entry={entry}
            display={displays[i]}
            sync={syncFor(k)}
            interactive={controls}
            allowUndoSkip={allowUndoSkip}
            restHint={controls && i === firstPendingAfterDone ? dosage.rest : null}
            onComplete={(v, l) => onComplete(i, v, l)}
            onSkip={() => onSkip(i)}
            onUndoSkip={() => onUndoSkip(i)}
            onRetry={() => onRetry(i)}
          />
        ))}
      </div>
      {controls && anyPending && units > 1 && (
        <button type="button" onClick={onSkipExercise} className="mt-3 min-h-11 text-sm font-medium text-slate-400 underline hover:text-slate-200">
          Skip this exercise
        </button>
      )}
    </section>
  );
}
