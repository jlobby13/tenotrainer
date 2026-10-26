"use client";

import { useId, useState } from "react";
import type { C5PatientGuidance } from "@/lib/c5RuntimeTypes";

// PEC — "How to do it", from the session snapshot ONLY (frozen at first
// performance; the pre-start preview carries the current library copy).
// Starts collapsed (the founder's guidance preference, as in the legacy
// player). Renders nothing when the snapshot has no guidance (version-1
// sessions) — never a live-library fallback. Media: nothing is rendered
// unless a frozen https URL exists; no placeholders.
export function C5ExerciseGuidance({ guidance, exerciseName }: { guidance: C5PatientGuidance | null; exerciseName: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!guidance) return null;
  const hasContent = guidance.explanation || guidance.setup || guidance.cues.length > 0 || guidance.watchFor.length > 0 || guidance.mediaUrl;
  if (!hasContent) return null;
  return (
    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40" data-c5-guidance>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm font-semibold text-teal-200 hover:text-teal-100"
        data-c5-guidance-toggle
      >
        <span>How to do it<span className="sr-only">: {exerciseName}</span></span>
        <span aria-hidden="true" className="text-slate-400">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div id={panelId} className="space-y-3 px-3 pb-3 text-sm leading-relaxed text-slate-300" data-c5-guidance-panel>
          {guidance.explanation && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Why it helps</h4>
              <p className="mt-1">{guidance.explanation}</p>
            </div>
          )}
          {guidance.setup && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Setup</h4>
              <p className="mt-1">{guidance.setup}</p>
            </div>
          )}
          {guidance.cues.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">How to do it</h4>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                {guidance.cues.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
            </div>
          )}
          {guidance.watchFor.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Watch out for</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {guidance.watchFor.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {guidance.mediaUrl && (
            <a href={guidance.mediaUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-teal-300 underline">
              Watch a demonstration
            </a>
          )}
        </div>
      )}
    </div>
  );
}
