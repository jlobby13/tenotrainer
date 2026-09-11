import type { StiffnessDurationPoint } from "@/lib/progressTypes";
import { STIFFNESS_DURATION_LABELS } from "@/lib/progressLabels";

// Milestone 6, Stage 2 — stiffness duration is ordinal/categorical data
// (supabase/migrations/...m4_stage4_tolerance_interpretation.sql's fixed
// bucket vocabulary), never converted into an invented number of minutes,
// so it gets its own categorical timeline rather than sharing TrendChart's
// numeric 0-10 axis.

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function StiffnessDurationTimeline({ points }: { points: StiffnessDurationPoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-gray-400 py-4 text-center">Not enough recorded data yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {points.map((p, i) => (
        <div key={`${p.date}-${i}`} className="rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-1.5 text-xs">
          <span className="text-gray-500">{formatShortDate(p.date)}</span>{" "}
          <span className="font-semibold text-amber-800">{STIFFNESS_DURATION_LABELS[p.bucket]}</span>
        </div>
      ))}
    </div>
  );
}
