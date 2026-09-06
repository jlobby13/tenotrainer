"use client";

import { useState } from "react";

// Required, explicit selection, no preselected zero — the patient must tap a
// number; nothing is chosen by default. UNKNOWN != ZERO: an unanswered state
// is simply not submittable, never silently defaulted.
export function PeakPainScreen({ onSubmit }: { onSubmit: (value: number) => void }) {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">Peak Achilles Pain</h1>
      <p className="text-sm text-gray-500 mt-1">What was the worst pain in your Achilles during today&apos;s session?</p>

      <div className="grid grid-cols-6 gap-2 mt-6">
        {Array.from({ length: 11 }, (_, i) => i).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setSelected(n)}
            className={`aspect-square rounded-lg text-sm font-semibold border-2 ${
              selected === n ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-2">0 = no pain · 10 = worst pain imaginable</p>

      <button
        type="button"
        disabled={selected === null}
        onClick={() => selected !== null && onSubmit(selected)}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
