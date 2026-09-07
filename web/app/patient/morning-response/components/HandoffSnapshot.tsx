const DIFFICULTY_LABEL: Record<string, string> = {
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
  too_hard: "Too Hard",
};

// "Previous Rehab Session," never "Yesterday's Rehab" — late responses
// remain valid data in v1, so the associated session may genuinely not have
// occurred yesterday. A compact glance at the loading exposure being
// discussed, not a workout report.
export function HandoffSnapshot({
  patientLocalDate,
  exerciseNames,
  completedSets,
  skippedSets,
  peakSessionPain,
  difficulty,
  nextMorningPain,
  nextMorningStiffness,
}: {
  patientLocalDate: string;
  exerciseNames: string[];
  completedSets: number;
  skippedSets: number;
  peakSessionPain: number | null;
  difficulty: string | null;
  nextMorningPain: number;
  nextMorningStiffness: number;
}) {
  const formattedDate = new Date(`${patientLocalDate}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-0.5">Previous Rehab Session</p>
      <p className="text-sm text-gray-500 mb-4">{formattedDate}</p>

      {exerciseNames.length > 0 && (
        <p className="text-sm text-gray-700 mb-3">{exerciseNames.join(", ")}</p>
      )}

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-gray-400">Sets Completed</p>
          <p className="font-semibold text-gray-900">
            {completedSets}
            {skippedSets > 0 && <span className="text-gray-400 font-normal"> · {skippedSets} skipped</span>}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Difficulty</p>
          <p className="font-semibold text-gray-900">{difficulty ? DIFFICULTY_LABEL[difficulty] ?? difficulty : "—"}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Peak Session Pain</p>
          <p className="font-semibold text-gray-900">{peakSessionPain ?? "—"}/10</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">This Morning</p>
          <p className="font-semibold text-gray-900">
            Pain {nextMorningPain}/10 · Stiffness {nextMorningStiffness}/10
          </p>
        </div>
      </div>
    </div>
  );
}
