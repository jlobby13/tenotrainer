"use client";

import type { C5WorkoutOption } from "@/lib/c5RuntimeTypes";
import { c5OptionLabel, c5WorkoutTitle } from "./c5Display";

// C5.6D — the Repeat previous / Move to next choice the server reported
// (Sequence pending_choice). Choosing here is ephemeral: it becomes
// authoritative only if the first performance Starts the session.
export function C5SequenceChoice({ options, onChoose }: { options: C5WorkoutOption[]; onChoose: (key: C5WorkoutOption["key"]) => void }) {
  return (
    <div className="space-y-4" data-c5-sequence-choice>
      <div>
        <h1 className="text-xl font-semibold text-slate-50">Choose today&apos;s workout</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-300">
          Your last workout ended early. You can repeat it, or move on to the next workout in your program.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChoose(o.key)}
            data-c5-choice={o.key}
            className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 text-left transition-colors hover:border-teal-400/60 focus:border-teal-400 focus:outline-none"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">{c5OptionLabel(o)}</p>
            <p className="mt-1.5 text-base font-semibold text-slate-50">{c5WorkoutTitle(o.preview.workout)}</p>
            <ul className="mt-2 space-y-0.5">
              {o.preview.exercises.map((e) => (
                <li key={e.exerciseId} className="truncate text-sm text-slate-400">
                  {e.name}
                </li>
              ))}
            </ul>
          </button>
        ))}
      </div>
    </div>
  );
}
