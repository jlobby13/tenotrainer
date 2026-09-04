"use client";

import type { SessionExercise } from "@/lib/fastapi";
import { titleCase, dosageSummary, tempoLabel } from "@/lib/exerciseDisplay";

export function ExerciseHeader({
  exercise,
  exerciseIndex,
  totalExercises,
  currentSetNumber,
  totalSets,
  problemReportCount = 0,
}: {
  exercise: SessionExercise;
  exerciseIndex: number;
  totalExercises: number;
  currentSetNumber: number;
  totalSets: number;
  problemReportCount?: number;
}) {
  const tempo = tempoLabel(exercise.dosage);
  return (
    <div>
      <p className="text-xs font-semibold text-brand-600 uppercase tracking-wide">
        Exercise {exerciseIndex + 1} of {totalExercises}
      </p>
      <h1 className="text-xl font-bold text-gray-900 mt-1">{exercise.exercise.name}</h1>
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
      <p className="text-sm text-gray-600 mt-2">
        {dosageSummary(exercise.dosage)}
        {tempo && <span> · Tempo {tempo}</span>}
      </p>
      <p className="text-xs text-gray-400 mt-1">
        Set {currentSetNumber} of {totalSets}
      </p>
    </div>
  );
}
