import type { SessionLoadingHistoryEntry, ExerciseLoadingHistory, SetLoadingFact } from "@/lib/progressTypes";
import { EXTERNAL_LOAD_CATEGORY_LABELS, EXTERNAL_LOAD_TIMING_LABELS } from "@/lib/progressLabels";

// Milestone 6, Stage 2, Section C — "Loading History". Reconstructed
// per-session from that session's OWN prescription_snapshot + set_outcomes
// (see progressServer.ts) — never the live/current exercise definition.
// Rep-based and hold-based exercises are shown with their own unit; unlike
// loading profiles are never aggregated into one number. No Capacity claim
// is made here — this is the factual record only.

const HOLD_BASED_PROFILES = new Set(["isometric", "stretching"]);

function actualUnitLabel(loadingProfile: string | null): string {
  return loadingProfile && HOLD_BASED_PROFILES.has(loadingProfile) ? "s held" : " reps";
}

function SetRow({ set, loadingProfile }: { set: SetLoadingFact; loadingProfile: string | null }) {
  const unit = actualUnitLabel(loadingProfile);
  return (
    <div className="flex items-center justify-between text-xs py-1 border-b border-gray-50 last:border-b-0">
      <span className="text-gray-400">Set {set.setIndex + 1}</span>
      <span className="text-gray-500">
        Prescribed:{" "}
        {set.prescribedReps != null ? `${set.prescribedReps}${unit}` : set.prescribedDisplay ?? "—"}
        {set.prescribedLoad != null ? ` · ${set.prescribedLoad} kg` : ""}
      </span>
      <span className="font-medium text-gray-900">
        {set.outcome === "skipped"
          ? "Skipped"
          : `${set.actualReps ?? "—"}${unit}${set.actualLoad != null ? ` · ${set.actualLoad} kg added` : ""}`}
      </span>
    </div>
  );
}

function ExerciseBlock({ exercise }: { exercise: ExerciseLoadingHistory }) {
  return (
    <div className="rounded-lg border border-gray-100 p-3">
      <p className="text-sm font-medium text-gray-900">{exercise.name}</p>
      {exercise.sets.length === 0 ? (
        <p className="text-xs text-gray-400 mt-1">No sets recorded.</p>
      ) : (
        <div className="mt-1.5">
          {exercise.sets.map((s) => (
            <SetRow key={s.setIndex} set={s} loadingProfile={exercise.loadingProfile} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function SessionEntry({ entry }: { entry: SessionLoadingHistoryEntry }) {
  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <div className="flex items-center justify-between flex-wrap gap-1 mb-2">
        <p className="text-sm font-semibold text-gray-900">{formatDate(entry.date)}</p>
        {entry.comparedToPrevious === "different" && (
          <span className="text-[0.6875rem] font-medium text-brand-600 bg-brand-50 rounded-full px-2 py-0.5">Rehab plan updated</span>
        )}
      </div>

      {entry.externalLoad.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {entry.externalLoad.map((tag, i) => (
            <span key={i} className="text-[0.6875rem] text-gray-500 bg-gray-50 border border-gray-100 rounded-full px-2 py-0.5">
              {EXTERNAL_LOAD_CATEGORY_LABELS[tag.category] ?? tag.category}
              {tag.timing ? ` (${EXTERNAL_LOAD_TIMING_LABELS[tag.timing] ?? tag.timing})` : ""}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {entry.exercises.map((ex) => (
          <ExerciseBlock key={ex.exId} exercise={ex} />
        ))}
      </div>
    </div>
  );
}

// Restrained amount of information per screen (Stage 2 UX principle) —
// shows the most recent handful by default rather than the full 90-session
// query result. No pagination built yet; revisit only if a real need shows up.
const VISIBLE_LIMIT = 10;

export function LoadingHistorySection({ loadingHistory }: { loadingHistory: SessionLoadingHistoryEntry[] }) {
  const mostRecentFirst = [...loadingHistory].reverse();
  const visible = mostRecentFirst.slice(0, VISIBLE_LIMIT);
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Loading History</h2>
      <p className="text-xs text-gray-500 mb-4">
        What was prescribed and what was actually completed, session by session. Different loading types (reps, holds) are shown
        separately and never combined into one number.
      </p>
      {visible.length === 0 ? (
        <p className="text-sm text-gray-400">No sessions recorded yet.</p>
      ) : (
        <>
          <div className="space-y-3">
            {visible.map((entry) => (
              <SessionEntry key={entry.rehabSessionId} entry={entry} />
            ))}
          </div>
          {mostRecentFirst.length > VISIBLE_LIMIT && (
            <p className="mt-3 text-xs text-gray-400">Showing your {VISIBLE_LIMIT} most recent sessions.</p>
          )}
        </>
      )}
    </section>
  );
}
