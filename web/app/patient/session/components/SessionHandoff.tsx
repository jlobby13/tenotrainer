"use client";

import type { ActiveSessionState } from "@/lib/activeSession";

// Intentionally neutral and minimal — no pain/difficulty questions, no tolerance
// language, no safety logic. This screen is a placeholder handoff point that
// Milestone 3 replaces wholesale, the same way this route itself replaced
// Milestone 1's placeholder.
export function SessionHandoff({ session, onDone }: { session: ActiveSessionState; onDone: () => void }) {
  const endedEarly = session.status === "ended_early";
  const completedExerciseCount = session.exerciseStates.filter((ex) => ex.status === "completed").length;
  const totalExercises = session.prescriptionSnapshot.exercises.length;
  const completedSetCount = session.exerciseStates.reduce((sum, ex) => sum + ex.actualSets.length, 0);

  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-gray-900">
        {endedEarly ? "Session ended early" : "Session complete"}
      </h1>
      <p className="text-sm text-gray-500 mt-2">
        {completedExerciseCount} of {totalExercises} exercises · {completedSetCount} sets logged
      </p>
      <button
        type="button"
        onClick={onDone}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Done
      </button>
    </div>
  );
}
