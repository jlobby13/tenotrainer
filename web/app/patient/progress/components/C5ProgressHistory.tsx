import Link from "next/link";
import { formatLocalDate, formatScore, trainingStatusLabel, type C5ImmediateFact, type C5SessionSummary, type MorningFact } from "@/lib/clinicianC5";

// M1 — a C5 patient's Progress: a minimal factual history of their own
// sessions. No automated interpretation, no trend, no judgment. Unknown
// stays explicit ("Not recorded"), never zero.

function immediateText(f: C5ImmediateFact, which: "pain" | "rpe"): string {
  if (f.kind === "none") return "—";
  if (f.kind === "pending") return "Check-in not done yet";
  const fact = which === "pain" ? f.peakPain : f.rpe;
  return fact.kind === "unable_to_recall" ? "Not recorded (couldn't recall)" : formatScore(fact, (n) => `${n}/10`);
}

function morningText(m: MorningFact): string {
  switch (m.kind) {
    case "none":
      return "—";
    case "not_yet_due":
      return "Not due yet";
    case "due":
      return "Ready to complete";
    case "answered":
      return `Pain ${m.pain}/10 · stiffness ${m.stiffness}/10`;
    case "unable_to_recall":
      return "Not recorded (couldn't recall)";
  }
}

export function C5ProgressHistory({ sessions }: { sessions: C5SessionSummary[] }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <nav className="border-b border-slate-800 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <span className="text-lg font-bold text-teal-300">TenoTrainer</span>
          <Link href="/patient/dashboard" className="inline-flex min-h-11 items-center text-sm font-medium text-slate-300 hover:text-teal-300">
            Back to Dashboard
          </Link>
        </div>
      </nav>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold text-slate-50">Progress</h1>
        <p className="mt-1 text-sm text-slate-400">Your recent sessions and check-ins.</p>
        {sessions.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-300" data-testid="c5-progress-empty">
            You haven&apos;t completed a session yet. Your sessions will appear here once you have.
          </div>
        ) : (
          <ul className="mt-6 space-y-3" data-testid="c5-progress-history">
            {sessions.map((s) => (
              <li key={s.id} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4" data-c5-progress-session={s.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-sm font-semibold text-slate-50 break-words">
                    {formatLocalDate(s.patientLocalDate)} · {s.workoutTitle}
                  </p>
                  <p className="text-sm text-slate-300">{trainingStatusLabel(s.trainingStatus)}</p>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-slate-500">Peak pain</dt>
                    <dd className="text-slate-200">{immediateText(s.immediate, "pain")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Session RPE</dt>
                    <dd className="text-slate-200">{immediateText(s.immediate, "rpe")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Morning check-in</dt>
                    <dd className="text-slate-200">{morningText(s.morning)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
