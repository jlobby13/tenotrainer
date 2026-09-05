"use client";

import type { ActiveSessionState } from "@/lib/activeSession";

// Intentionally neutral and minimal — no pain/difficulty questions, no tolerance
// language, no safety logic. This screen is a placeholder handoff point that
// Milestone 3 replaces wholesale, the same way this route itself replaced
// Milestone 1's placeholder. It must communicate that the EXERCISE portion is
// done without implying the whole clinical workflow is finished.
export function SessionHandoff({ session, onDone }: { session: ActiveSessionState; onDone: () => void }) {
  const endedEarly = session.status === "ended_early";
  const completedExerciseCount = session.exerciseStates.filter((ex) => ex.status === "completed").length;
  const totalExercises = session.prescriptionSnapshot.exercises.length;
  const completedSetCount = session.exerciseStates.reduce(
    (sum, ex) => sum + ex.setOutcomes.filter((o) => o.kind === "completed").length,
    0
  );
  const skippedSetCount = session.exerciseStates.reduce(
    (sum, ex) => sum + ex.setOutcomes.filter((o) => o.kind === "skipped").length,
    0
  );

  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-gray-900">
        {endedEarly ? "Session ended early" : "Exercises complete"}
      </h1>
      <p className="text-sm text-gray-500 mt-2">
        {completedExerciseCount} of {totalExercises} exercises · {completedSetCount} sets completed
        {skippedSetCount > 0 ? ` · ${skippedSetCount} skipped` : ""}
      </p>
      <div className="mt-6 bg-gray-50 border border-gray-100 rounded-xl p-4 text-left">
        <p className="text-sm text-gray-700">
          The exercise portion of today&apos;s session is complete, but your rehab session isn&apos;t fully
          logged yet.
        </p>
        <p className="text-sm text-gray-500 mt-2">The next step will be documenting your session response.</p>
      </div>
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
