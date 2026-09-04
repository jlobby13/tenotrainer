"use client";

import type { SessionExercise } from "@/lib/fastapi";
import { dosageSummary } from "@/lib/exerciseDisplay";

export function ExerciseCompleteTransition({
  nextExercise,
  onNext,
  onReview,
}: {
  nextExercise: SessionExercise;
  onNext: () => void;
  onReview: () => void;
}) {
  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <p className="text-green-500 text-3xl">✓</p>
      <h1 className="text-xl font-bold text-gray-900 mt-2">Exercise Complete</h1>

      <div className="mt-6 bg-gray-50 border border-gray-100 rounded-xl p-4 text-left">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Up Next</p>
        <p className="text-base font-semibold text-gray-900 mt-1">{nextExercise.exercise.name}</p>
        <p className="text-sm text-gray-600 mt-0.5">{dosageSummary(nextExercise.dosage)}</p>
      </div>

      <button
        type="button"
        onClick={onNext}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Next Exercise
      </button>
      <button type="button" onClick={onReview} className="mt-2 w-full px-4 py-2 text-xs text-gray-400 underline">
        Review / edit that exercise&apos;s sets
      </button>
    </div>
  );
}
