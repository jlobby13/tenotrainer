"use client";

import { useState } from "react";
import { CONTRIBUTOR_REASONS, type ContributorReason } from "@/lib/rehabSessionTypes";

const LABELS: Record<ContributorReason, string> = {
  specific_exercise: "A specific exercise",
  overall_session_too_much: "The overall session felt like too much",
  symptoms_higher_before_start: "My symptoms were higher before I started",
  other_physical_activity: "Other physical activity or training",
  fatigue_poor_recovery: "Fatigue / poor recovery",
  unsure: "I'm not sure",
  other: "Other",
};

export function ContributorScreen({
  exercises,
  onSubmit,
}: {
  exercises: { exId: string; name: string; hadReport: boolean }[];
  onSubmit: (result: { reason: ContributorReason; exerciseId?: string; otherText?: string }) => void;
}) {
  const [reason, setReason] = useState<ContributorReason | null>(null);
  const [exerciseId, setExerciseId] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");

  // Exercises already associated with a pain/problem report surface first.
  const sortedExercises = [...exercises].sort((a, b) => Number(b.hadReport) - Number(a.hadReport));

  const canContinue =
    reason != null &&
    (reason !== "specific_exercise" || exerciseId != null);

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">What contributed most?</h1>
      <p className="text-sm text-gray-500 mt-1">
        This helps give your clinician useful context. Choose &quot;I&apos;m not sure&quot; if nothing fits.
      </p>

      <div className="mt-6 space-y-2">
        {CONTRIBUTOR_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(r)}
            className={`w-full text-left px-4 py-3 rounded-lg border-2 text-sm font-medium ${
              reason === r ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
            }`}
          >
            {LABELS[r]}
          </button>
        ))}
      </div>

      {reason === "specific_exercise" && (
        <div className="mt-3 space-y-2">
          {sortedExercises.map((ex) => (
            <button
              key={ex.exId}
              type="button"
              onClick={() => setExerciseId(ex.exId)}
              className={`w-full text-left px-3 py-2 rounded-lg border text-sm ${
                exerciseId === ex.exId ? "border-brand-500 bg-brand-50" : "border-gray-200"
              }`}
            >
              {ex.name}
              {ex.hadReport && <span className="ml-2 text-xs text-amber-700">(reported during session)</span>}
            </button>
          ))}
        </div>
      )}

      {reason === "other" && (
        <textarea
          value={otherText}
          onChange={(e) => setOtherText(e.target.value)}
          placeholder="Optional — a short note"
          className="mt-3 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          rows={2}
        />
      )}

      <button
        type="button"
        disabled={!canContinue}
        onClick={() =>
          reason &&
          onSubmit({
            reason,
            exerciseId: reason === "specific_exercise" ? (exerciseId ?? undefined) : undefined,
            otherText: reason === "other" ? otherText.trim() || undefined : undefined,
          })
        }
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}
