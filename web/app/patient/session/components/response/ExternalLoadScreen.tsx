"use client";

import { useState } from "react";
import {
  EXTERNAL_LOAD_CATEGORIES,
  EXTERNAL_LOAD_CATEGORY_LABELS,
  EXTERNAL_LOAD_TIMING_LABELS,
  M3_TIMING_OPTIONS,
  type ExternalLoadCategory,
  type ExternalLoadSelection,
  type ExternalLoadTiming,
} from "@/lib/sessionLoadObservations";

// M3-provenance capture only — a brief exposure observation, not an
// activity diary and not a causal-attribution question (that's the
// existing, separate contributor_reason === "other_physical_activity"
// field — see ContributorScreen.tsx). Timing is restricted to what could
// plausibly be known right after finishing today's exercises: the day
// before, or earlier the same day. "None" is a one-tap fast path.
export function ExternalLoadScreen({
  onSubmit,
}: {
  onSubmit: (selection: ExternalLoadSelection) => void;
}) {
  const [categories, setCategories] = useState<ExternalLoadCategory[]>([]);
  const [timing, setTiming] = useState<ExternalLoadTiming | null>(null);

  function toggleCategory(category: ExternalLoadCategory) {
    setCategories((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  const canContinue = categories.length > 0 && timing !== null;

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">Other Activity</h1>
      <p className="text-sm text-gray-500 mt-1">Any other relevant physical activity leading into today&apos;s rehab?</p>

      <button
        type="button"
        onClick={() => onSubmit({ categories: ["none"], timing: null })}
        className="mt-6 w-full text-left px-4 py-3.5 rounded-lg border-2 border-gray-200 text-sm font-semibold text-gray-700"
      >
        None
      </button>

      <p className="text-xs font-semibold text-gray-500 mt-6">Add activity</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {EXTERNAL_LOAD_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => toggleCategory(c)}
            className={`px-3 py-2 rounded-full text-sm font-medium border-2 ${
              categories.includes(c) ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
            }`}
          >
            {EXTERNAL_LOAD_CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      {categories.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-gray-500">When?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {M3_TIMING_OPTIONS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTiming(t)}
                className={`px-3 py-2 rounded-full text-sm font-medium border-2 ${
                  timing === t ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
                }`}
              >
                {EXTERNAL_LOAD_TIMING_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        disabled={!canContinue}
        onClick={() => canContinue && onSubmit({ categories, timing })}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
