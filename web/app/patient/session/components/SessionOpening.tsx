"use client";

import { useState } from "react";
import type { SessionExercise } from "@/lib/fastapi";
import { titleCase } from "@/lib/exerciseDisplay";

export function SessionOpening({
  sessionPlan,
  reminderAlreadyDismissed,
  onBegin,
}: {
  sessionPlan: SessionExercise[];
  reminderAlreadyDismissed: boolean;
  onBegin: (dismissReminder: boolean) => void;
}) {
  // Ephemeral — only committed to a preference when the patient proceeds.
  const [dismissChecked, setDismissChecked] = useState(false);

  const categories = Array.from(
    new Set(sessionPlan.map((item) => item.exercise.category).filter(Boolean))
  ).map(titleCase);

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold text-gray-900">Today&apos;s Rehab</h1>
      <p className="text-sm text-gray-500 mt-1">
        {sessionPlan.length} exercise{sessionPlan.length !== 1 ? "s" : ""} today
      </p>

      {categories.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {categories.map((c) => (
            <span key={c} className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
              {c}
            </span>
          ))}
        </div>
      )}

      {!reminderAlreadyDismissed && (
        <div className="mt-6 bg-gray-50 border border-gray-100 rounded-xl p-4">
          <p className="text-sm text-gray-600">
            TenoTrainer will track what you complete today and ask you to document your response when you finish.
          </p>
          <label className="flex items-center gap-2 mt-3 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={dismissChecked}
              onChange={(e) => setDismissChecked(e.target.checked)}
            />
            Don&apos;t show this reminder again
          </label>
        </div>
      )}

      <button
        type="button"
        onClick={() => onBegin(dismissChecked)}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
      >
        Begin Session
      </button>
    </div>
  );
}
