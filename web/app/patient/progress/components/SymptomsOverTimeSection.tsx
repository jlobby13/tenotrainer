import type { SymptomsOverTime } from "@/lib/progressTypes";
import { TrendChart } from "./TrendChart";
import { StiffnessDurationTimeline } from "./StiffnessDurationTimeline";

// Milestone 6, Stage 2, Section B — "Symptoms Over Time". Three independent
// 0-10 series (each only ever containing dates where that specific value is
// actually known) plus a separate categorical timeline for stiffness
// duration. acuteEventDates are shown as a separate factual note, never
// merged into or excluded from any series — see progressServer.ts.

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SymptomsOverTimeSection({
  symptomsOverTime,
  acuteEventDates,
}: {
  symptomsOverTime: SymptomsOverTime;
  acuteEventDates: string[];
}) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Symptoms Over Time</h2>
      <p className="text-xs text-gray-500 mb-4">
        Showing recorded values only — gaps in your rehab history are not filled in or estimated.
      </p>

      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-2">Peak session pain (0–10)</h3>
          <TrendChart points={symptomsOverTime.peakSessionPain} color="#dc2626" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-2">Next-morning pain (0–10)</h3>
          <TrendChart points={symptomsOverTime.nextMorningPain} color="#d97706" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-2">Morning stiffness intensity (0–10)</h3>
          <TrendChart points={symptomsOverTime.morningStiffnessIntensity} color="#7c3aed" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-2">Morning stiffness duration</h3>
          <StiffnessDurationTimeline points={symptomsOverTime.morningStiffnessDuration} />
        </div>
      </div>

      {acuteEventDates.length > 0 && (
        <p className="mt-5 text-xs text-gray-400 border-t border-gray-100 pt-3">
          Acute safety event(s) recorded on: {acuteEventDates.map((d) => formatShortDate(d)).join(", ")}. Shown for reference only — not
          factored into the values above.
        </p>
      )}
    </section>
  );
}
