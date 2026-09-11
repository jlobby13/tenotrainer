import type { ToleranceHistoryEntry } from "@/lib/progressTypes";
import { IMMEDIATE_GUIDANCE_LABELS } from "@/lib/progressLabels";

// Milestone 6, Stage 2, Section E — "Response / Tolerance History". Shows
// each persisted classification + immediate guidance exactly as it was
// originally computed — historical rows are never retroactively
// recomputed under a newer rule version (see progressServer.ts /
// lib/progressCompare.ts's ruleVersionChanged). Raw rule-version strings
// ("v1"/"v2") are never shown to the patient; interpretationMethodChanged
// only ever renders a subtle factual note, and is inert today since every
// row currently in the system is the same rule version.
//
// "Well Tolerated" is shown as a plain classification label only — never
// framed as physiological adaptation or overall recovery.

// Founder-acceptance patch: deliberately NOT a green -> amber -> orange ->
// red ordinal ramp — that visually implies a validated disease-severity
// scale the tolerance evaluator was never designed to be (see the M4 Stage
// 4 brief's "Well Tolerated != Progress"). well_tolerated/caution get a
// restrained, single-step positive/attention treatment; poorly_tolerated is
// neutral (a distinct category, not "one step worse than caution"). Only
// acute_override keeps genuinely stronger safety styling, matching the
// separate acute-safety system's own red treatment elsewhere in the app —
// that system, unlike ordinary tolerance, actually warrants it.
const CLASSIFICATION_STYLES: Record<string, string> = {
  well_tolerated: "bg-green-50 text-green-700 border-green-100",
  caution: "bg-amber-50 text-amber-700 border-amber-100",
  poorly_tolerated: "bg-slate-100 text-slate-600 border-slate-200",
  acute_override: "bg-red-50 text-red-700 border-red-100",
  insufficient_data: "bg-gray-50 text-gray-500 border-gray-100",
};

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ToleranceHistorySection({ toleranceHistory }: { toleranceHistory: ToleranceHistoryEntry[] }) {
  const mostRecentFirst = [...toleranceHistory].reverse();
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Response / Tolerance History</h2>
      <p className="text-xs text-gray-500 mb-4">How each session's response was classified at the time — not a score.</p>
      {mostRecentFirst.length === 0 ? (
        <p className="text-sm text-gray-400">No responses recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {mostRecentFirst.map((entry) => (
            <div key={entry.rehabSessionId} className="flex items-center justify-between gap-2 py-1.5 border-b border-gray-50 last:border-b-0">
              <span className="text-xs text-gray-400 w-16 shrink-0">{formatDate(entry.date)}</span>
              <span
                className={`text-xs font-medium rounded-full border px-2 py-0.5 ${CLASSIFICATION_STYLES[entry.classification] ?? "bg-gray-50 text-gray-600 border-gray-100"}`}
              >
                {entry.patientFacingLabel}
              </span>
              <span className="text-xs text-gray-500 flex-1 text-right">{IMMEDIATE_GUIDANCE_LABELS[entry.immediateGuidance]}</span>
              {entry.interpretationMethodChanged && (
                <span className="text-[0.6875rem] text-gray-400 italic shrink-0">Interpretation method updated</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
