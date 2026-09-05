"use client";

import type { DotState } from "@/lib/activeSession";

// Glanceable progress indicator — reused for both set-level and exercise-level
// progress, mobile-first, restrained (not gamified). States are distinguished
// by shape/glyph as well as color so it doesn't depend on color perception
// alone: an empty ring for pending, a filled checkmark for completed, a filled
// dash for skipped. A single summary aria-label carries the meaning for
// screen readers; individual dots are decorative (aria-hidden).
export function ProgressDots({ states, label }: { states: DotState[]; label: string }) {
  const completed = states.filter((s) => s === "completed").length;
  const skipped = states.filter((s) => s === "skipped").length;
  const pending = states.length - completed - skipped;
  const summary = `${label}: ${completed} completed${skipped > 0 ? `, ${skipped} skipped` : ""}, ${pending} remaining`;

  return (
    <div className="flex items-center gap-1" role="img" aria-label={summary}>
      {states.map((s, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={
            "inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[8px] font-bold leading-none shrink-0 " +
            (s === "completed"
              ? "bg-brand-600 text-white"
              : s === "skipped"
                ? "bg-amber-400 text-white"
                : "border border-gray-300 bg-white")
          }
        >
          {s === "completed" ? "✓" : s === "skipped" ? "–" : ""}
        </span>
      ))}
    </div>
  );
}
