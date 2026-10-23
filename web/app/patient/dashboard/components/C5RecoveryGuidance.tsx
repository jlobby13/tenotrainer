"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { C5NetworkError, recordRecoveryDecision } from "@/lib/c5RuntimeClient";
import { resultMessage, type C5RecoveryGuidance as Guidance, type C5WeeklyProgress } from "@/lib/c5RuntimeTypes";
import { shortDate } from "@/app/patient/session/components/c5/c5Display";

// C5.6F — ADVISORY recovery guidance with the patient's choice. Shown only
// when the server says training is otherwise available (every hard gate
// passed). Neither choice starts a session: Take Recovery Day records the
// choice and nothing else; Continue records the choice and opens the
// workout, where the first confirmed set remains the Start boundary. One
// consolidated message when the weekly target is also reached.

type Decision = "take_recovery_day" | "continue";

function daysLabel(n: number): string {
  return n === 1 ? "1 recovery day" : `${n} recovery days`;
}

export function C5RecoveryGuidance({
  recovery,
  weekly,
  variant,
  onContinue,
}: {
  recovery: Guidance;
  weekly: C5WeeklyProgress | null | undefined;
  variant: "dashboard" | "session";
  // Session page: reveal the workout in place after Continue is recorded.
  onContinue?: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(recovery.todaysDecision === "take_recovery_day");
  // One idempotency key per choice, reused on retry.
  const requestIds = useRef<Partial<Record<Decision, string>>>({});

  async function decide(decision: Decision) {
    if (pending) return;
    requestIds.current[decision] ??= crypto.randomUUID();
    setPending(decision);
    setError(null);
    try {
      const r = await recordRecoveryDecision(requestIds.current[decision]!, decision);
      if (r.result !== "recorded") {
        // A hard state now applies (or guidance no longer does): show it.
        setError(resultMessage(r.result));
        router.refresh();
        return;
      }
      if (decision === "take_recovery_day") {
        setTaken(true);
        requestIds.current.continue = undefined;
        router.refresh();
      } else if (variant === "session" && onContinue) {
        onContinue();
      } else {
        router.push("/patient/session");
      }
    } catch (e) {
      setError(e instanceof C5NetworkError && e.message === "SAFETY_CHECK_FAILED" ? "We couldn't confirm your safety status. Please try again." : "We couldn't save your choice. Please try again.");
    } finally {
      setPending(null);
    }
  }

  const earliest = shortDate(recovery.earliestRecommendedDate);
  const targetReached = weekly?.targetReached === true;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 sm:p-6" data-c5-recovery-guidance={taken ? "taken" : "offered"}>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-300">Recovery</p>
      {taken ? (
        <>
          <h2 className="mt-1.5 text-lg font-semibold text-slate-50">Recovery day</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">
            You&apos;ve chosen to take a recovery day. Your next recommended training day is {earliest}. If you change your mind, you can still
            continue today.
          </p>
        </>
      ) : (
        <>
          <h2 className="mt-1.5 text-lg font-semibold text-slate-50">Recovery day recommended</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-300" data-c5-recovery-message>
            {targetReached && weekly
              ? `You've completed this week's target (${weekly.finishedSessions} of ${weekly.target} sessions), and your clinician recommended more recovery time before your next session.`
              : `Your clinician recommended ${daysLabel(recovery.recommendedRecoveryDays)} between sessions.`}{" "}
            Your last session was on {shortDate(recovery.anchorStartLocalDate)}, so your next recommended training day is {earliest}.
          </p>
          <p className="mt-2 text-sm text-slate-400">You can take a recovery day today, or continue with your workout.</p>
        </>
      )}
      {error && (
        <p className="mt-3 text-sm text-amber-200" role="status">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        {!taken && (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => decide("take_recovery_day")}
            className="min-h-11 rounded-xl bg-teal-400 px-5 text-sm font-semibold text-slate-950 hover:bg-teal-300 disabled:opacity-40"
          >
            {pending === "take_recovery_day" ? "Saving…" : "Take Recovery Day"}
          </button>
        )}
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => decide("continue")}
          className="min-h-11 rounded-xl border border-slate-700 px-5 text-sm font-semibold text-slate-200 hover:border-teal-400/60 disabled:opacity-40"
        >
          {pending === "continue" ? "Saving…" : taken ? "Continue to workout" : "Continue"}
        </button>
      </div>
    </section>
  );
}

// Informational weekly progress (Sequence only). Never capped, never styled
// as a warning.
export function C5WeeklyProgressLine({ weekly }: { weekly: C5WeeklyProgress }) {
  return (
    <p className="text-sm text-slate-300" data-c5-weekly>
      <span className="text-slate-500">This week:</span> {weekly.finishedSessions} of {weekly.target} sessions completed
    </p>
  );
}
