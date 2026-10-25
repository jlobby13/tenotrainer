import Link from "next/link";
import type { C5TrainingState, C5WorkoutOption } from "@/lib/c5RuntimeTypes";
import { c5WorkoutTitle, c5OptionLabel } from "@/app/patient/session/components/c5/c5Display";
import { C5RecoveryGuidance } from "./C5RecoveryGuidance";

// C5.6D — Today's Rehab for the C5 runtime. Purely presentational: one
// branch per authoritative C5TrainingState kind (from c5_get_start_eligibility
// via getC5TrainingState). Nothing here decides eligibility. Opening this
// card, or following its link, never creates a session.

const CARD = "rounded-2xl border border-slate-800 bg-slate-900/80 p-5 sm:p-6 shadow-[0_0_48px_-20px_rgba(45,212,191,0.35)]";
const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-400 px-5 text-sm font-semibold text-slate-950 hover:bg-teal-300 transition-colors";
const SECONDARY =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-5 text-sm font-semibold text-slate-200 hover:border-teal-400/60 transition-colors";

function Shell({ eyebrow, title, children, tone = "default" }: { eyebrow: string; title: string; children?: React.ReactNode; tone?: "default" | "calm" | "safety" }) {
  const accent = tone === "safety" ? "text-amber-300" : tone === "calm" ? "text-sky-300" : "text-teal-300";
  return (
    <section className={CARD} data-c5-state-card>
      <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${accent}`}>{eyebrow}</p>
      <h2 className="mt-1.5 text-lg font-semibold text-slate-50">{title}</h2>
      {children}
    </section>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-slate-300">{children}</p>;
}

function WorkoutSummary({ option }: { option: C5WorkoutOption }) {
  const exercises = option.preview.exercises;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <p className="text-sm font-semibold text-slate-100">{c5WorkoutTitle(option.preview.workout)}</p>
      <p className="mt-0.5 text-xs text-slate-400">
        {c5OptionLabel(option)} · {exercises.length} {exercises.length === 1 ? "exercise" : "exercises"}
      </p>
      <ul className="mt-3 space-y-1">
        {exercises.slice(0, 5).map((e) => (
          <li key={e.exerciseId} className="truncate text-sm text-slate-300">
            {e.name}
          </li>
        ))}
        {exercises.length > 5 && <li className="text-xs text-slate-500">+ {exercises.length - 5} more</li>}
      </ul>
    </div>
  );
}

// Shown in addition to the main card whenever the patient has an
// outstanding check-in that the main card isn't already asking for (for
// example during a safety hold or a pause — responses can still be given).
export function C5PendingCheckInCard({ count }: { count: number }) {
  return (
    <Shell eyebrow="Check-in" title={count === 1 ? "A check-in is waiting" : `${count} check-ins are waiting`} tone="calm">
      <Body>You can answer it now.</Body>
      <div className="mt-5">
        <Link href="/patient/check-in" className={SECONDARY}>
          Open check-in
        </Link>
      </div>
    </Shell>
  );
}

export function C5TodaysRehabCard({ state }: { state: C5TrainingState }) {
  switch (state.kind) {
    case "available": {
      // C5.6F — advisory recovery guidance replaces the plain "ready" card
      // until the patient has chosen Continue today.
      if (state.recovery && state.recovery.todaysDecision !== "continue") {
        return <C5RecoveryGuidance recovery={state.recovery} weekly={state.weekly} variant="dashboard" />;
      }
      if (state.choiceRequired) {
        return (
          <Shell eyebrow="Today's Rehab" title="Choose today's workout">
            <Body>Your last workout ended early. You can repeat it or move on to the next one.</Body>
            <div className="mt-5">
              <Link href="/patient/session" className={PRIMARY}>
                Choose workout
              </Link>
            </div>
          </Shell>
        );
      }
      const option = state.options[0];
      return (
        <Shell eyebrow="Today's Rehab" title={option.key === "make_up" ? "Make-up workout available" : "Your workout is ready"}>
          {state.weekly?.targetReached && <Body>You&apos;ve reached this week&apos;s target.</Body>}
          <WorkoutSummary option={option} />
          <div className="mt-5">
            <Link href="/patient/session" className={PRIMARY}>
              Open workout
            </Link>
          </div>
        </Shell>
      );
    }
    case "resume":
      return (
        <Shell eyebrow="Today's Rehab" title="Session in progress" tone={state.paused ? "calm" : "default"}>
          {state.paused ? (
            <Body>Your clinician has paused your program. You can still finish or stop the session you&apos;ve started.</Body>
          ) : (
            <Body>Pick up where you left off — {c5WorkoutTitle(state.session.snapshot.workout)}.</Body>
          )}
          <div className="mt-5">
            <Link href="/patient/session" className={PRIMARY}>
              Resume session
            </Link>
          </div>
        </Shell>
      );
    case "acute_resolution_required":
      return (
        <Shell eyebrow="Safety" title="Your session needs to be stopped" tone="safety">
          <Body>
            A safety check means no more exercises can be added today. Your recorded work is kept. Please stop this session so
            the next step can begin.
          </Body>
          <div className="mt-5">
            <Link href="/patient/session" className={PRIMARY}>
              Review and stop session
            </Link>
          </div>
        </Shell>
      );
    case "acute_blocked":
      return (
        <Shell eyebrow="Safety" title="Training is on hold" tone="safety">
          {state.gate === "acute_safety_reconciliation_required" ? (
            <Body>We&apos;re checking your safety status. Please refresh in a moment.</Body>
          ) : state.gate === "acute_safety_professional_review_required" ? (
            <Body>Training is on hold until your clinician reviews your safety check-in and releases the hold.</Body>
          ) : (
            <Body>A short safety check-in is needed before you train again.</Body>
          )}
          {state.gate !== "acute_safety_reconciliation_required" && (
            <div className="mt-5">
              <Link href="/patient/acute-safety" className={PRIMARY}>
                Go to safety check-in
              </Link>
            </div>
          )}
        </Shell>
      );
    case "prescription_paused":
      return (
        <Shell eyebrow="Today's Rehab" title="Your clinician has paused your program" tone="calm">
          <Body>There&apos;s no workout to do while your program is paused. Your workouts will appear here again when it resumes.</Body>
        </Shell>
      );
    case "immediate_response_required":
      return (
        <Shell eyebrow="Check-in" title="Post-session check-in needed" tone="calm">
          <Body>Before your next workout, tell us how your last session went.</Body>
          <div className="mt-5">
            <Link href="/patient/check-in" className={PRIMARY}>
              Start check-in
            </Link>
          </div>
        </Shell>
      );
    case "morning_response_required":
      return (
        <Shell eyebrow="Check-in" title="Morning check-in needed" tone="calm">
          <Body>Before your next workout, tell us how you felt the morning after your last session.</Body>
          <div className="mt-5">
            <Link href="/patient/check-in" className={PRIMARY}>
              Start check-in
            </Link>
          </div>
        </Shell>
      );
    case "already_trained_today":
      return (
        <Shell eyebrow="Today's Rehab" title="You've already trained today">
          <Body>Rest up — your next workout will be ready on another day.</Body>
        </Shell>
      );
    case "not_scheduled_today":
      return (
        <Shell eyebrow="Today's Rehab" title="No workout scheduled today">
          <Body>Today is a rest day in your program.</Body>
        </Shell>
      );
    case "timezone_required":
      return (
        <Shell eyebrow="Today's Rehab" title="Setting up your schedule">
          <Body>We need your time zone to plan your rehab. Refresh this page in a moment.</Body>
          <div className="mt-5">
            <a href="/patient/dashboard" className={SECONDARY}>
              Refresh
            </a>
          </div>
        </Shell>
      );
    case "no_active_prescription":
      return (
        <Shell eyebrow="Today's Rehab" title="No active program">
          <Body>Your clinician hasn&apos;t published a rehab program for you yet.</Body>
        </Shell>
      );
    case "unavailable":
      return (
        <Shell eyebrow="Today's Rehab" title="Your rehab plan is temporarily unavailable" tone="calm">
          <Body>
            {state.reason === "safety_check_failed"
              ? "We couldn't confirm your safety status, so training is held for now. Please try again shortly."
              : "Please try again shortly."}
          </Body>
          <div className="mt-5">
            <a href="/patient/dashboard" className={SECONDARY}>
              Try again
            </a>
          </div>
        </Shell>
      );
  }
}
