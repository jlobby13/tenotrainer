"use client";

export function ResumePrompt({
  exerciseNumber,
  totalExercises,
  setNumber,
  totalSets,
  onResume,
  onEndSession,
}: {
  exerciseNumber: number;
  totalExercises: number;
  setNumber: number;
  totalSets: number;
  onResume: () => void;
  onEndSession: () => void;
}) {
  return (
    <div className="max-w-md mx-auto px-4 py-10 text-center">
      <h1 className="text-xl font-bold text-gray-900">You have a session in progress</h1>
      <p className="text-sm text-gray-500 mt-2">
        Exercise {exerciseNumber} of {totalExercises}
        <br />
        Set {setNumber} of {totalSets}
      </p>
      <button
        type="button"
        onClick={onResume}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Resume Session
      </button>
      <button type="button" onClick={onEndSession} className="mt-3 w-full px-4 py-2.5 text-sm font-medium text-gray-500">
        End Session
      </button>
    </div>
  );
}
