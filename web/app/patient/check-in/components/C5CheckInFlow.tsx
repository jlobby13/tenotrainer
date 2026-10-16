"use client";

import Link from "next/link";
import { useState } from "react";
import { C5NetworkError, submitImmediate, submitMorning } from "@/lib/c5RuntimeClient";
import { responseMessage, type C5CheckIns, type C5ImmediateResponseInput, type C5MorningResponseInput } from "@/lib/c5ResponseTypes";
import type { C5TrainingState } from "@/lib/c5RuntimeTypes";
import { C5TodaysRehabCard } from "@/app/patient/dashboard/components/C5TodaysRehabCard";
import { C5ImmediateForm } from "./C5ImmediateForm";
import { C5MorningForm } from "./C5MorningForm";

// C5.6E — one outstanding check-in at a time (post-session first, then the
// oldest due morning). After a submission the server returns the FRESH
// authoritative training state (read after reconciliation), which is what
// the patient sees next — the form never decides whether training is now
// available.

type Saved = { state: C5TrainingState; checkIns: C5CheckIns; replayed: boolean };

export function C5CheckInFlow({ initialCheckIns, initialState }: { initialCheckIns: C5CheckIns; initialState: C5TrainingState }) {
  const [checkIns, setCheckIns] = useState(initialCheckIns);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remounts the form for the next obligation.
  const [formKey, setFormKey] = useState(0);

  const immediate = checkIns.immediate[0] ?? null;
  const morning = immediate ? null : (checkIns.mornings[0] ?? null);

  async function send(kind: "immediate" | "morning", sessionId: string, response: C5ImmediateResponseInput | C5MorningResponseInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r =
        kind === "immediate"
          ? await submitImmediate(sessionId, response as C5ImmediateResponseInput)
          : await submitMorning(sessionId, response as C5MorningResponseInput);
      if (r.result === "submitted") {
        setSaved({ state: r.state, checkIns: r.checkIns, replayed: r.replayed === true });
        setCheckIns(r.checkIns);
      } else if (r.result === "already_submitted" || r.result === "response_not_found") {
        setError(responseMessage(r.result));
        setCheckIns(r.checkIns);
        setFormKey((k) => k + 1);
      } else {
        setError(responseMessage(r.result));
      }
    } catch (e) {
      // Not known to be saved: the same answers can be re-sent safely.
      setError(
        e instanceof C5NetworkError && e.message === "SAFETY_CHECK_FAILED"
          ? "Your answers may have been saved, but we couldn't finish the safety check. Please try again."
          : "We couldn't reach the server. Your answers are still here — please try again."
      );
    } finally {
      setPending(false);
    }
  }

  if (saved) {
    const more = saved.checkIns.immediate.length + saved.checkIns.mornings.length;
    return (
      <div className="space-y-4" data-c5-checkin-saved>
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 text-center">
          <h1 className="text-xl font-semibold text-slate-50">Check-in saved</h1>
          <p className="mt-1 text-sm text-slate-300">Thanks — your answers have been recorded.</p>
          {more > 0 && (
            <button
              type="button"
              onClick={() => {
                setSaved(null);
                setFormKey((k) => k + 1);
              }}
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-400 px-5 text-sm font-semibold text-slate-950"
            >
              Next check-in
            </button>
          )}
        </section>
        {more === 0 && (
          <>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">What&apos;s next</p>
            <C5TodaysRehabCard state={saved.state} />
          </>
        )}
      </div>
    );
  }

  if (!immediate && !morning) {
    return (
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5" data-c5-no-checkins>
          <h1 className="text-xl font-semibold text-slate-50">No check-ins due</h1>
          <p className="mt-1 text-sm text-slate-300">There&apos;s nothing to answer right now.</p>
        </section>
        <C5TodaysRehabCard state={initialState} />
      </div>
    );
  }

  return (
    <div>
      {error && (
        <p className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100" role="alert" data-c5-checkin-error>
          {error}
        </p>
      )}
      {immediate ? (
        <C5ImmediateForm key={`i-${immediate.sessionId}-${formKey}`} checkIn={immediate} pending={pending} onSubmit={(r) => send("immediate", immediate.sessionId, r)} />
      ) : (
        <C5MorningForm
          key={`m-${morning!.sessionId}-${formKey}`}
          checkIn={morning!}
          patientToday={checkIns.patientToday}
          pending={pending}
          onSubmit={(r) => send("morning", morning!.sessionId, r)}
        />
      )}
      <div className="mt-6 text-center">
        <Link href="/patient/dashboard" className="inline-flex min-h-11 items-center text-sm text-slate-400 hover:text-slate-200">
          Back to Today&apos;s Rehab
        </Link>
      </div>
    </div>
  );
}
