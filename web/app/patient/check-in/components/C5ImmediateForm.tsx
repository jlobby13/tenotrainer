"use client";

import { useState } from "react";
import { RPE_ANCHOR_WORDS, SAFETY_QUESTIONS, type C5ImmediateCheckIn, type C5ImmediateResponseInput, type C5SafetyKey } from "@/lib/c5ResponseTypes";
import { c5WorkoutTitle, shortDate } from "@/app/patient/session/components/c5/c5Display";
import { ScoreScale } from "./ScoreScale";

// C5.6E — post-session check-in. Peak pain and Session RPE each take an
// integer 0-10 OR an explicit "I don't remember" (stored as NULL + flag,
// never 0). The three safety questions always need an explicit Yes/No — no
// "don't remember" — and a fact already reported at Stop is shown as
// reported and cannot be changed here.

const SECTION = "rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:p-5";

function ForgetToggle({ on, onChange, testId }: { on: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      data-testid={testId}
      className={`mt-2 min-h-11 text-sm underline ${on ? "font-semibold text-amber-200" : "text-slate-400 hover:text-slate-200"}`}
    >
      {on ? "Marked as “I don’t remember” — tap to answer instead" : "I don’t remember"}
    </button>
  );
}

export function C5ImmediateForm({
  checkIn,
  pending,
  onSubmit,
}: {
  checkIn: C5ImmediateCheckIn;
  pending: boolean;
  onSubmit: (response: C5ImmediateResponseInput) => void;
}) {
  const [pain, setPain] = useState<number | null>(null);
  const [painUnknown, setPainUnknown] = useState(false);
  const [rpe, setRpe] = useState<number | null>(null);
  const [rpeUnknown, setRpeUnknown] = useState(false);
  const [safety, setSafety] = useState<Partial<Record<C5SafetyKey, boolean>>>({});

  const safetyValue = (k: C5SafetyKey) => (checkIn.recordedSafety[k] ? true : safety[k]);
  const painDone = painUnknown || pain !== null;
  const rpeDone = rpeUnknown || rpe !== null;
  const safetyDone = SAFETY_QUESTIONS.every((q) => safetyValue(q.key) !== undefined);
  const complete = painDone && rpeDone && safetyDone;

  function submit() {
    if (!complete) return;
    const response: C5ImmediateResponseInput = painUnknown ? { peak_pain_unable_to_recall: true } : { peak_session_pain: pain };
    Object.assign(response, rpeUnknown ? { rpe_unable_to_recall: true } : { overall_session_rpe: rpe });
    for (const q of SAFETY_QUESTIONS) response[q.key] = safetyValue(q.key)!;
    onSubmit(response);
  }

  return (
    <div className="space-y-4" data-c5-immediate-form>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">Post-session check-in</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">How did the workout go?</h1>
        <p className="mt-1 text-sm text-slate-400">
          {checkIn.workout ? `${c5WorkoutTitle({ id: "", ...checkIn.workout })} · ` : ""}
          {shortDate(checkIn.sessionLocalDate)}
        </p>
      </div>

      <section className={SECTION}>
        <h2 className="text-base font-semibold text-slate-50">Peak pain during the workout</h2>
        <p className="mt-0.5 text-sm text-slate-400">What was the worst pain you felt?</p>
        <div className="mt-3">
          <ScoreScale
            name="peak-pain"
            label="Peak pain during the workout, from 0 (no pain) to 10 (worst pain imaginable)"
            value={painUnknown ? null : pain}
            disabled={painUnknown}
            onChange={(v) => setPain(v)}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">0 = no pain · 10 = worst pain imaginable</p>
        <ForgetToggle on={painUnknown} onChange={(v) => { setPainUnknown(v); if (v) setPain(null); }} testId="pain-unknown" />
      </section>

      <section className={SECTION}>
        <h2 className="text-base font-semibold text-slate-50">Rate of Perceived Exertion (RPE)</h2>
        <p className="mt-0.5 text-sm text-slate-300">Overall, how hard did today’s workout feel?</p>
        <div className="mt-3">
          <ScoreScale name="rpe" label="Overall, how hard did today’s workout feel? From 0 to 10" value={rpeUnknown ? null : rpe} disabled={rpeUnknown} onChange={(v) => setRpe(v)} />
        </div>
        {/* Sparse orientation words only — not tied to particular numbers and never stored. */}
        <div className="mt-2 flex justify-between gap-2 text-xs text-slate-500" aria-hidden="true" data-rpe-anchors>
          {RPE_ANCHOR_WORDS.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <ForgetToggle on={rpeUnknown} onChange={(v) => { setRpeUnknown(v); if (v) setRpe(null); }} testId="rpe-unknown" />
      </section>

      <section className={SECTION}>
        <h2 className="text-base font-semibold text-slate-50">A few important questions</h2>
        <p className="mt-0.5 text-sm text-slate-400">About this workout. Each one needs a yes or no.</p>
        <div className="mt-3 space-y-4">
          {SAFETY_QUESTIONS.map((q) => {
            const recorded = checkIn.recordedSafety[q.key];
            const v = safetyValue(q.key);
            return (
              <div key={q.key} data-safety-question={q.key}>
                <p className="text-sm font-medium text-slate-100">{q.label}</p>
                {q.hint && <p className="text-xs text-slate-500">{q.hint}</p>}
                {recorded ? (
                  <p className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100" data-recorded-safety>
                    Yes — you reported this when you stopped your session.
                  </p>
                ) : (
                  <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label={q.label}>
                    {([true, false] as const).map((answer) => (
                      <button
                        key={String(answer)}
                        type="button"
                        role="radio"
                        aria-checked={v === answer}
                        onClick={() => setSafety((s) => ({ ...s, [q.key]: answer }))}
                        className={`min-h-11 rounded-xl border text-sm font-semibold transition-colors ${
                          v === answer ? "border-teal-300 bg-teal-400 text-slate-950" : "border-slate-700 bg-slate-950/60 text-slate-200 hover:border-teal-400/60"
                        }`}
                      >
                        {answer ? "Yes" : "No"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <button
        type="button"
        disabled={!complete || pending}
        onClick={submit}
        className="min-h-12 w-full rounded-xl bg-teal-400 px-4 text-sm font-semibold text-slate-950 hover:bg-teal-300 disabled:opacity-40"
      >
        {pending ? "Saving…" : "Submit check-in"}
      </button>
      {!complete && <p className="text-center text-xs text-slate-500">Answer each question to submit.</p>}
    </div>
  );
}
