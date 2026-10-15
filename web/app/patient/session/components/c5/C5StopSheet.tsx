"use client";

import { useState } from "react";

// C5.6D — Stop Today's Session, with an optional in-session safety report.
// The browser never chooses the stop type: c5_stop_session classifies it
// (stopped_early / stopped_pause / stopped_acute) on the server.

export type C5AcuteReportInput = { sudden_or_sharp_pain?: boolean; pop_felt_or_heard?: boolean; new_functional_difficulty?: boolean };

const SAFETY_ITEMS: { key: keyof C5AcuteReportInput; label: string }[] = [
  { key: "sudden_or_sharp_pain", label: "Sudden or sharp pain" },
  { key: "pop_felt_or_heard", label: "Felt or heard a pop" },
  { key: "new_functional_difficulty", label: "New difficulty using the affected area" },
];

export function C5StopSheet({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: boolean;
  onConfirm: (report: C5AcuteReportInput | null) => void;
  onCancel: () => void;
}) {
  const [report, setReport] = useState<C5AcuteReportInput>({});
  const anyReported = SAFETY_ITEMS.some((i) => report[i.key]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="c5-stop-title">
      <div className="w-full max-w-md rounded-t-2xl border border-slate-800 bg-slate-900 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-2xl">
        <h2 id="c5-stop-title" className="text-lg font-semibold text-slate-50">
          Stop today&apos;s session?
        </h2>
        <p className="mt-1 text-sm text-slate-300">Everything you&apos;ve completed is kept.</p>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-slate-200">Did any of these happen during this session?</legend>
          <div className="mt-2 space-y-2">
            {SAFETY_ITEMS.map((item) => (
              <label key={item.key} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-slate-800 px-3 py-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={report[item.key] === true}
                  onChange={(e) => setReport((r) => ({ ...r, [item.key]: e.target.checked }))}
                  className="h-5 w-5 accent-teal-400"
                />
                {item.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Leave these unticked if none happened.</p>
        </fieldset>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            disabled={pending}
            onClick={() => onConfirm(anyReported ? report : null)}
            className="min-h-11 flex-1 rounded-xl bg-teal-400 px-4 text-sm font-semibold text-slate-950 hover:bg-teal-300 disabled:opacity-40"
          >
            {pending ? "Stopping…" : "Stop today's session"}
          </button>
          <button type="button" onClick={onCancel} disabled={pending} className="min-h-11 flex-1 rounded-xl border border-slate-700 px-4 text-sm font-medium text-slate-200">
            Keep going
          </button>
        </div>
      </div>
    </div>
  );
}
