"use client";

import { useState } from "react";
import { STIFFNESS_DURATIONS, type C5MorningCheckIn, type C5MorningResponseInput, type C5StiffnessDuration } from "@/lib/c5ResponseTypes";
import { shortDate } from "@/app/patient/session/components/c5/c5Display";
import { ScoreScale } from "./ScoreScale";

// C5.6E — next-morning check-in: pain 0-10, stiffness 0-10, how long the
// stiffness lasted (only when stiffness > 0), optional note. "I don't
// remember" is always available but secondary; it stores no values.
// The answers describe the REFERENCE morning, even when given later.

const SECTION = "rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:p-5";
const NOTE_MAX = 500;

export function C5MorningForm({
  checkIn,
  patientToday,
  pending,
  onSubmit,
}: {
  checkIn: C5MorningCheckIn;
  patientToday: string | null;
  pending: boolean;
  onSubmit: (response: C5MorningResponseInput) => void;
}) {
  const [pain, setPain] = useState<number | null>(null);
  const [stiffness, setStiffness] = useState<number | null>(null);
  const [duration, setDuration] = useState<C5StiffnessDuration | null>(null);
  const [note, setNote] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);

  const isToday = patientToday !== null && checkIn.referenceLocalDate === patientToday;
  const morning = isToday ? "this morning" : `on the morning of ${shortDate(checkIn.referenceLocalDate)}`;
  const needsDuration = stiffness !== null && stiffness > 0;
  const complete = pain !== null && stiffness !== null && (!needsDuration || duration !== null);
  const trimmedNote = note.trim();

  function submit() {
    if (!complete) return;
    onSubmit({
      resolution: "answered",
      next_morning_pain: pain!,
      next_morning_stiffness: stiffness!,
      ...(needsDuration ? { stiffness_duration: duration! } : {}),
      ...(trimmedNote ? { patient_note: trimmedNote } : {}),
    });
  }

  return (
    <div className="space-y-4" data-c5-morning-form>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">Morning check-in</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-50">How did you feel {morning}?</h1>
        {!isToday && <p className="mt-1 text-sm text-slate-400">Answer for that morning, as best you can.</p>}
      </div>

      <section className={SECTION}>
        <h2 className="text-base font-semibold text-slate-50">Pain {morning}</h2>
        <div className="mt-3">
          <ScoreScale name="morning-pain" value={pain} onChange={setPain} />
        </div>
        <p className="mt-2 text-xs text-slate-500">0 = no pain · 10 = worst pain imaginable</p>
      </section>

      <section className={SECTION}>
        <h2 className="text-base font-semibold text-slate-50">Stiffness {morning}</h2>
        <div className="mt-3">
          <ScoreScale
            name="morning-stiffness"
            value={stiffness}
            onChange={(v) => {
              setStiffness(v);
              if (v === 0) setDuration(null);
            }}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">0 = no stiffness · 10 = extremely stiff</p>
        {needsDuration && (
          <fieldset className="mt-4" data-stiffness-duration>
            <legend className="text-sm font-medium text-slate-100">How long did the stiffness last?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {STIFFNESS_DURATIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={duration === d.value}
                  onClick={() => setDuration(d.value)}
                  className={`min-h-11 rounded-xl border px-3 text-sm font-medium transition-colors ${
                    duration === d.value ? "border-teal-300 bg-teal-400 text-slate-950" : "border-slate-700 bg-slate-950/60 text-slate-200 hover:border-teal-400/60"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}
      </section>

      <section className={SECTION}>
        <label htmlFor="c5-morning-note" className="text-base font-semibold text-slate-50">
          Anything else? <span className="text-sm font-normal text-slate-500">(optional)</span>
        </label>
        <textarea
          id="c5-morning-note"
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="mt-2 block w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-base text-slate-50 focus:border-teal-400 focus:outline-none"
        />
        <p className="mt-1 text-right text-xs text-slate-500">
          {note.length}/{NOTE_MAX}
        </p>
      </section>

      <button
        type="button"
        disabled={!complete || pending}
        onClick={submit}
        className="min-h-12 w-full rounded-xl bg-teal-400 px-4 text-sm font-semibold text-slate-950 hover:bg-teal-300 disabled:opacity-40"
      >
        {pending ? "Saving…" : "Submit check-in"}
      </button>

      <div className="text-center">
        {confirmForget ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300" data-forget-confirm>
            <p>Submit this check-in as “I don’t remember”? No scores will be recorded.</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                disabled={pending}
                onClick={() => onSubmit({ resolution: "unable_to_recall", ...(trimmedNote ? { patient_note: trimmedNote } : {}) })}
                className="min-h-11 rounded-xl border border-slate-600 px-4 font-semibold text-slate-100 disabled:opacity-40"
              >
                Yes, I don’t remember
              </button>
              <button type="button" onClick={() => setConfirmForget(false)} className="min-h-11 rounded-xl px-4 text-slate-400">
                Go back
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmForget(true)} className="min-h-11 text-sm text-slate-400 underline hover:text-slate-200">
            I don’t remember
          </button>
        )}
      </div>
    </div>
  );
}
