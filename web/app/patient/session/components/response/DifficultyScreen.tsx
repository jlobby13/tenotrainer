"use client";

import { useState } from "react";
import type { Difficulty } from "@/lib/rehabSessionTypes";

const OPTIONS: { value: Difficulty; label: string }[] = [
  { value: "easy", label: "Easy" },
  { value: "moderate", label: "Moderate" },
  { value: "hard", label: "Hard" },
  { value: "too_hard", label: "Too Hard" },
];

// Clinician context only — never consumed by the automated tendon-tolerance
// rule engine. Required, explicit selection, no default.
export function DifficultyScreen({ onSubmit }: { onSubmit: (value: Difficulty) => void }) {
  const [selected, setSelected] = useState<Difficulty | null>(null);

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">Overall Difficulty</h1>
      <p className="text-sm text-gray-500 mt-1">How did today&apos;s session feel overall?</p>

      <div className="mt-6 space-y-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setSelected(opt.value)}
            className={`w-full text-left px-4 py-3 rounded-lg border-2 text-sm font-semibold ${
              selected === opt.value ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={!selected}
        onClick={() => selected && onSubmit(selected)}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
