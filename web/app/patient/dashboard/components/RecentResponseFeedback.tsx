import type { TodaysRehabFeedback } from "@/lib/todaysRehabFeedback";

// Milestone 5, Stage 2 — presentational only. Renders exactly what
// computeTodaysRehabFeedback() decided; no clinical logic lives here.
// Reuses the existing rounded-xl/border card language already established
// by MorningResponsePendingNotice/ToleranceResultsCard rather than
// introducing a new visual primitive (Section 11 of the Stage 2 brief).
const TONE_CLASSES: Record<string, string> = {
  positive: "bg-green-50 border-green-200 text-green-900",
  caution: "bg-amber-50 border-amber-200 text-amber-900",
  attention: "bg-amber-50 border-2 border-amber-300 text-amber-900",
  reduce: "bg-amber-100 border-2 border-amber-400 text-amber-900",
};

export function RecentResponseFeedback({ feedback }: { feedback: TodaysRehabFeedback }) {
  if (feedback.kind === "none") return null;

  if (feedback.kind === "acute") {
    return (
      <div className="bg-red-50 border-2 border-red-300 text-red-900 rounded-xl p-6">
        <h2 className="text-base font-bold">{feedback.title}</h2>
        <p className="text-sm mt-1">{feedback.body}</p>
      </div>
    );
  }

  // Demoted: a newer prescription version exists — the plan-updated fact
  // is the primary line, and the prior response is shown as smaller,
  // subordinate historical context (Section 4: "should not dominate the
  // current-plan UX"), regardless of how prominent its tone would
  // otherwise be.
  if (feedback.demoted) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <p className="text-sm font-semibold text-gray-900">{feedback.prescriptionUpdatedNote}</p>
        <p className="text-xs text-gray-500 mt-1">
          Previous response: {feedback.title.replace(/^Last session: /, "")} — {feedback.body}
        </p>
      </div>
    );
  }

  const isCompact = feedback.tone === "positive" || feedback.tone === "caution";

  return (
    <div className={`rounded-xl p-4 ${isCompact ? "border" : "border p-5"} ${TONE_CLASSES[feedback.tone]}`}>
      <h2 className={`font-semibold ${isCompact ? "text-sm" : "text-base"}`}>{feedback.title}</h2>
      <p className="text-sm mt-1">{feedback.body}</p>
      {feedback.reasonExplanations.length > 0 && (
        <ul className="text-sm mt-2 space-y-0.5 opacity-90 list-disc list-inside">
          {feedback.reasonExplanations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {feedback.externalLoadNote && <p className="text-sm mt-2 opacity-80">{feedback.externalLoadNote}</p>}
    </div>
  );
}
