"use client";

import { useState } from "react";
import type { ProblemType } from "@/lib/activeSession";

const OPTIONS: { type: ProblemType; label: string }[] = [
  { type: "equipment", label: "Equipment unavailable" },
  { type: "too_difficult", label: "Too difficult" },
  { type: "pain_limiting", label: "Pain limiting me" },
  { type: "other", label: "Other" },
];

export function ReportProblemSheet({
  onSubmit,
  onClose,
  onSkipExercise,
}: {
  onSubmit: (report: { type: ProblemType; note?: string }) => void;
  onClose: () => void;
  onSkipExercise?: () => void;
}) {
  // Ephemeral — this component's local state never touches ActiveSessionState
  // until the patient explicitly submits.
  const [selected, setSelected] = useState<ProblemType | null>(null);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <div className="fixed inset-0 bg-black/30 flex items-end sm:items-center justify-center z-50">
        <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5">
          <p className="text-sm font-semibold text-gray-900">Reported.</p>
          <p className="text-sm text-gray-500 mt-1">You can continue this exercise, or move on.</p>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full px-4 py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg"
          >
            Continue
          </button>
          {onSkipExercise && (
            <button
              type="button"
              onClick={onSkipExercise}
              className="mt-2 w-full px-4 py-2.5 text-sm font-medium text-gray-500"
            >
              Skip This Exercise
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end sm:items-center justify-center z-50">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5">
        <p className="text-sm font-semibold text-gray-900">Report a Problem</p>
        <div className="mt-3 space-y-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              onClick={() => setSelected(opt.type)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm font-medium ${
                selected === opt.type
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-gray-200 text-gray-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note (optional)"
          className="mt-3 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          rows={2}
        />
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              onSubmit({ type: selected, note: note.trim() || undefined });
              setSubmitted(true);
            }}
            className="flex-1 px-4 py-2.5 bg-brand-600 text-white text-sm font-semibold rounded-lg disabled:opacity-40"
          >
            Submit
          </button>
          <button type="button" onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-gray-500">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
