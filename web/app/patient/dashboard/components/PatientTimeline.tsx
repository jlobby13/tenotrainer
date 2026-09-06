// Locked lifecycle visualization: Rehab -> Session Response -> Morning
// Response -> Results. Server-truth driven only — every prop here maps
// directly to a real persisted fact, never a guess. resultsAvailable
// defaults to false everywhere this is used today because no
// tolerance_evaluations row can exist yet (Stage 2 deliberately never
// creates one) — this component itself has no opinion on when that
// changes, it just renders whatever it's told.
export type PatientTimelineStep = "done" | "current" | "pending";

export function PatientTimeline({
  sessionResponseDone,
  morningResponseDone,
  resultsAvailable,
}: {
  sessionResponseDone: boolean;
  morningResponseDone: boolean;
  resultsAvailable: boolean;
}) {
  const steps: { label: string; state: PatientTimelineStep }[] = [
    { label: "Rehab", state: "done" },
    { label: "Session Response", state: sessionResponseDone ? "done" : "current" },
    {
      label: "Morning Response",
      state: morningResponseDone ? "done" : sessionResponseDone ? "current" : "pending",
    },
    { label: "Results", state: resultsAvailable ? "done" : "pending" },
  ];

  // flex-wrap (not overflow-x-auto): at narrow widths, four labeled steps
  // plus connectors reliably don't fit on one line — wrapping to a second
  // line is simple and always legible, whereas a horizontally-scrolling row
  // is easy to miss entirely on a phone and was found (live mobile
  // verification) to clip content instead of scrolling. Connector lines are
  // hidden below `sm` since a line between two items on different wrapped
  // rows doesn't mean anything visually.
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 py-1">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center gap-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[0.65rem] font-bold shrink-0 ${
                step.state === "done"
                  ? "bg-green-500 text-white"
                  : step.state === "current"
                    ? "bg-brand-600 text-white"
                    : "bg-gray-200 text-gray-400"
              }`}
            >
              {step.state === "done" ? "✓" : i + 1}
            </span>
            <span
              className={`text-xs font-medium whitespace-nowrap ${
                step.state === "pending" ? "text-gray-400" : "text-gray-700"
              }`}
            >
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && <span className="hidden sm:inline-block w-4 h-px bg-gray-200 shrink-0 mx-0.5" />}
        </div>
      ))}
    </div>
  );
}
