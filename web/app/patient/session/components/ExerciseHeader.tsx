"use client";

import type { SessionExercise } from "@/lib/fastapi";
import type { DotState } from "@/lib/activeSession";
import { titleCase, dosageSummary, tempoLabel } from "@/lib/exerciseDisplay";
import { ProgressDots } from "./ProgressDots";

export function ExerciseHeader({
  exercise,
  exerciseIndex,
  totalExercises,
  currentSetNumber,
  totalSets,
  problemReportCount = 0,
  setDotStates,
}: {
  exercise: SessionExercise;
  exerciseIndex: number;
  totalExercises: number;
  currentSetNumber: number;
  totalSets: number;
  problemReportCount?: number;
  setDotStates: DotState[];
}) {
  const tempo = tempoLabel(exercise.dosage);
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4">
      <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide">
        Exercise {exerciseIndex + 1} of {totalExercises}
      </p>
      {/* The exercise name is the single dominant element on this screen —
          patients must never have to infer which exercise they're doing. */}
      <h1 className="text-3xl font-extrabold text-gray-900 mt-1 leading-tight">{exercise.exercise.name}</h1>
      <div className="flex items-center gap-2 flex-wrap mt-2">
        {exercise.exercise.category && (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
            {titleCase(exercise.exercise.category)}
          </span>
        )}
        {problemReportCount > 0 && (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
            {problemReportCount === 1 ? "1 problem reported" : `${problemReportCount} problems reported`}
          </span>
        )}
      </div>
      <p className="text-base text-gray-700 font-medium mt-3">
        {dosageSummary(exercise.dosage)}
        {tempo && <span> · Tempo {tempo}</span>}
      </p>
      <div className="flex items-center justify-between mt-3">
        <p className="text-sm font-semibold text-gray-500">
          Set {currentSetNumber} of {totalSets}
        </p>
        <ProgressDots states={setDotStates} label="Set progress" />
      </div>
    </div>
  );
}
