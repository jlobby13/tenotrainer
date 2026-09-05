"use client";

import { useEffect, useState } from "react";

const DEFAULT_REST_SECONDS = 60; // v1 placeholder default, not a clinical recommendation

export function RestTimer({
  prescribedRestSeconds,
  onDone,
}: {
  prescribedRestSeconds: number | null;
  onDone: () => void;
}) {
  // Ephemeral presentation state — deliberately not persisted. If the patient
  // navigates away mid-rest and returns, we don't reconstruct elapsed time;
  // resuming simply presents the next set as ready.
  const [remaining, setRemaining] = useState(prescribedRestSeconds ?? DEFAULT_REST_SECONDS);

  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-center">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Rest</p>
      <p className="text-3xl font-bold text-gray-900 mt-1">{Math.max(remaining, 0)}s</p>
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          onClick={() => setRemaining((r) => r + 30)}
          className="flex-1 px-3 py-2 text-sm font-semibold text-gray-700 border border-gray-200 rounded-lg"
        >
          +30 sec
        </button>
        <button
          type="button"
          onClick={onDone}
          className="flex-1 px-3 py-2 text-sm font-semibold text-white bg-brand-600 rounded-lg"
        >
          Skip Rest
        </button>
      </div>
      {remaining <= 0 && (
        <button
          type="button"
          onClick={onDone}
          className="mt-3 w-full px-3 py-2 text-sm font-semibold text-white bg-brand-600 rounded-lg"
        >
          Continue
        </button>
      )}
    </div>
  );
}
