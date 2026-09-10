import Link from "next/link";
import type { DashboardFeedback } from "@/lib/dashboardFeedback";

// Milestone 5, Stage 2 (+ Acute Safety Gate milestone) — presentational
// only. Renders exactly what getTodaysRehabFeedback() decided; no clinical
// logic lives here. Reuses the existing rounded-xl/border card language
// already established by MorningResponsePendingNotice/ToleranceResultsCard
// rather than introducing a new visual primitive.
const TONE_CLASSES: Record<string, string> = {
  positive: "bg-green-50 border-green-200 text-green-900",
  caution: "bg-amber-50 border-amber-200 text-amber-900",
  attention: "bg-amber-50 border-2 border-amber-300 text-amber-900",
  reduce: "bg-amber-100 border-2 border-amber-400 text-amber-900",
};

export function RecentResponseFeedback({ feedback }: { feedback: DashboardFeedback }) {
  // Acute Safety Gate: active brake supersedes everything else (Section
  // 14) — rendered before any Stage 2 logic is even considered.
  //
  // Founder-acceptance patch: Level 4 must read as visibly more restrictive
  // than Level 3 (a distinct, escalating color step + heavier border/type),
  // while staying clearly short of Level 5's red emergency styling and
  // without making Level 3 itself any more alarming than before. Wording
  // and tone (title/body copy) are unchanged — this is presentation only.
  if (feedback.kind === "acute_brake") {
    const { display } = feedback;
    const severity = display.kind === "level5" ? "level5" : display.kind === "level4" ? "level4" : "level3";
    const tone =
      severity === "level5"
        ? "bg-red-100 border-4 border-red-500 text-red-900"
        : severity === "level4"
          ? "bg-orange-50 border-4 border-orange-500 text-orange-900"
          : "bg-amber-50 border-2 border-amber-300 text-amber-900";
    const titleClass = severity === "level3" ? "text-base font-bold" : "text-lg font-extrabold";
    return (
      <div className={`rounded-xl p-6 ${tone}`}>
        <h2 className={titleClass}>{"title" in display ? display.title : "Safety Check-In Needed"}</h2>
        <p className="text-sm mt-1">{"body" in display ? display.body : ""}</p>
        <Link
          href="/patient/acute-safety"
          className="mt-4 inline-block px-4 py-2 bg-white border border-current text-sm font-semibold rounded-lg"
        >
          Go to Safety Check-In
        </Link>
      </div>
    );
  }

  // Stage 4 founder-acceptance fix: nothing to render here —
  // MorningResponsePendingNotice already tells the patient what to do
  // next. This kind exists only so page.tsx can also suppress the
  // contradictory Start Rehab CTA (see showTodaysRehabPanel there).
  if (feedback.kind === "morning_response_pending") return null;

  if (feedback.kind === "cautious_return") {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-blue-900">{feedback.title}</h2>
        <p className="text-sm text-blue-800 mt-1">{feedback.body}</p>
      </div>
    );
  }

  // kind === "stage2" — unchanged from Stage 2, founder-approved.
  const stage2 = feedback.feedback;
  if (stage2.kind === "none") return null;

  if (stage2.kind === "acute") {
    return (
      <div className="bg-red-50 border-2 border-red-300 text-red-900 rounded-xl p-6">
        <h2 className="text-base font-bold">{stage2.title}</h2>
        <p className="text-sm mt-1">{stage2.body}</p>
      </div>
    );
  }

  if (stage2.demoted) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <p className="text-sm font-semibold text-gray-900">{stage2.prescriptionUpdatedNote}</p>
        <p className="text-xs text-gray-500 mt-1">
          Previous response: {stage2.title.replace(/^Last session: /, "")} — {stage2.body}
        </p>
      </div>
    );
  }

  const isCompact = stage2.tone === "positive" || stage2.tone === "caution";

  return (
    <div className={`rounded-xl p-4 ${isCompact ? "border" : "border p-5"} ${TONE_CLASSES[stage2.tone]}`}>
      <h2 className={`font-semibold ${isCompact ? "text-sm" : "text-base"}`}>{stage2.title}</h2>
      <p className="text-sm mt-1">{stage2.body}</p>
      {stage2.reasonExplanations.length > 0 && (
        <ul className="text-sm mt-2 space-y-0.5 opacity-90 list-disc list-inside">
          {stage2.reasonExplanations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {stage2.externalLoadNote && <p className="text-sm mt-2 opacity-80">{stage2.externalLoadNote}</p>}
    </div>
  );
}
