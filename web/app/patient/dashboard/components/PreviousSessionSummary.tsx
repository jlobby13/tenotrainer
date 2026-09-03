import type { RecentLog } from "@/lib/fastapi";

function factLine(label: string, value: number | null) {
  if (value === null) return null;
  return (
    <div key={label} className="flex justify-between text-sm">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value}/10</span>
    </div>
  );
}

export function PreviousSessionSummary({ recentLogs }: { recentLogs: RecentLog[] }) {
  if (recentLogs.length === 0) return null;

  const last = recentLogs[0];

  // Deliberately excludes pain_after — that field is scheduled for elimination
  // and must not gain renewed prominence in the new UI.
  const lines = [
    factLine("Peak pain", last.pain_during),
    factLine("Next-morning pain", last.next_day_pain),
    factLine("Morning stiffness", last.morning_stiffness),
  ].filter(Boolean);

  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Last Session</h2>
      <p className="text-xs text-gray-400 mb-3">
        {new Date(last.date + "T00:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        })}
      </p>
      {lines.length > 0 ? (
        <div className="space-y-2">{lines}</div>
      ) : (
        <p className="text-sm text-gray-400">No response data recorded.</p>
      )}
    </div>
  );
}
