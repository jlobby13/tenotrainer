import type { NumericComparison, StiffnessDurationComparison, RecentResponse } from "@/lib/progressTypes";
import { numericComparisonDirection, numericComparisonDelta, stiffnessDurationDirection } from "@/lib/progressCompare";
import { STIFFNESS_DURATION_LABELS } from "@/lib/progressLabels";

// Milestone 6, Stage 2, Section A — "Recent Response". Layer 1 only: plain
// previous-vs-current arithmetic ("4 → 2, decreased by 2 points"), never a
// classification of whether that change means anything clinically. See
// lib/progressCompare.ts for the underlying delta/direction logic.

function Arrow({ direction }: { direction: "up" | "down" | "same" | null }) {
  if (direction === "up") return <span className="text-red-500 font-bold">↑</span>;
  if (direction === "down") return <span className="text-green-500 font-bold">↓</span>;
  if (direction === "same") return <span className="text-gray-400 font-bold">→</span>;
  return null;
}

function NumericComparisonCard({ comparison }: { comparison: NumericComparison }) {
  const direction = numericComparisonDirection(comparison);
  const delta = numericComparisonDelta(comparison);
  const { label, previous, current } = comparison;

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
      {current == null ? (
        <p className="mt-2 text-sm text-gray-400">Not yet recorded.</p>
      ) : previous == null ? (
        <>
          <p className="mt-2 text-2xl font-black text-gray-900">{current}</p>
          <p className="text-xs text-gray-400 mt-0.5">First recorded value — no prior comparison yet.</p>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-lg text-gray-400">{previous}</span>
            <span className="text-gray-300">→</span>
            <span className="text-2xl font-black text-gray-900">{current}</span>
            <Arrow direction={direction} />
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {delta === 0 ? "No change" : `${delta! > 0 ? "Increased" : "Decreased"} by ${Math.abs(delta!)} point${Math.abs(delta!) === 1 ? "" : "s"}`}
          </p>
        </>
      )}
    </div>
  );
}

function StiffnessDurationCard({ comparison }: { comparison: StiffnessDurationComparison }) {
  const direction = stiffnessDurationDirection(comparison);
  const { previous, current } = comparison;

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Morning stiffness duration</p>
      {current == null ? (
        <p className="mt-2 text-sm text-gray-400">Not yet recorded.</p>
      ) : previous == null ? (
        <>
          <p className="mt-2 text-lg font-bold text-gray-900">{STIFFNESS_DURATION_LABELS[current]}</p>
          <p className="text-xs text-gray-400 mt-0.5">First recorded value — no prior comparison yet.</p>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-gray-400">{STIFFNESS_DURATION_LABELS[previous]}</span>
            <span className="text-gray-300">→</span>
            <span className="text-lg font-bold text-gray-900">{STIFFNESS_DURATION_LABELS[current]}</span>
            <Arrow direction={direction} />
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {direction === "same" ? "No change" : direction === "up" ? "Longer than last time" : "Shorter than last time"}
          </p>
        </>
      )}
    </div>
  );
}

export function RecentResponseSection({ recentResponse }: { recentResponse: RecentResponse | null }) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Recent Response</h2>
      <p className="text-xs text-gray-500 mb-4">How your most recent recorded values compare to the time before.</p>
      {!recentResponse ? (
        <p className="text-sm text-gray-400">No sessions recorded yet — this will fill in after your first rehab session.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NumericComparisonCard comparison={recentResponse.peakSessionPain} />
          <NumericComparisonCard comparison={recentResponse.nextMorningPain} />
          <NumericComparisonCard comparison={recentResponse.morningStiffnessIntensity} />
          <StiffnessDurationCard comparison={recentResponse.morningStiffnessDuration} />
        </div>
      )}
    </section>
  );
}
