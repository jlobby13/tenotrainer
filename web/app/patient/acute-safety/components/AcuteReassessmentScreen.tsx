"use client";

import { useState } from "react";
import Link from "next/link";
import { describeActiveBrake, describeReleasedBrake, type ReassessmentAnswers, type EffectiveLevel } from "@/lib/acuteSafety";

function YesNo({
  value,
  onChange,
  disabled,
}: {
  value: boolean | null;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2 mt-2">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(true)}
        className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-semibold disabled:opacity-60 ${
          value === true ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
        }`}
      >
        Yes
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(false)}
        className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-semibold disabled:opacity-60 ${
          value === false ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700"
        }`}
      >
        No
      </button>
    </div>
  );
}

export function AcuteReassessmentScreen({
  episodeId,
  effectiveLevel,
  initialSuddenOrSharpPain,
  initialNewFunctionalDifficulty,
  hasEverBeenProfessionallyHeld,
  latestReassessment,
}: {
  episodeId: string;
  effectiveLevel: EffectiveLevel;
  initialSuddenOrSharpPain: boolean;
  initialNewFunctionalDifficulty: boolean;
  hasEverBeenProfessionallyHeld: boolean;
  latestReassessment: ReassessmentAnswers | null;
}) {
  const [sudden, setSudden] = useState<boolean | null>(null);
  const [functional, setFunctional] = useState<boolean | null>(null);
  const [evaluated, setEvaluated] = useState<boolean | null>(null);
  const [cleared, setCleared] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ released: boolean; releasePath: string | null } | null>(null);

  const requiresProfessionalPath = effectiveLevel >= 4 || hasEverBeenProfessionallyHeld;

  // "Yes means resolution" phrasing (Section 5) — not applicable is simply
  // never asked (represented as null, never a fabricated answer) for a
  // finding that was never part of this episode.
  const suddenAnswered = !initialSuddenOrSharpPain || sudden !== null;
  const functionalAnswered = !initialNewFunctionalDifficulty || functional !== null;
  const canSubmit =
    suddenAnswered &&
    functionalAnswered &&
    evaluated !== null &&
    (evaluated === false || cleared !== null) &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/patient/acute-safety/reassessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episodeId,
          suddenOrSharpPainResolved: initialSuddenOrSharpPain ? sudden : null,
          newFunctionalDifficultyResolved: initialNewFunctionalDifficulty ? functional : null,
          evaluatedByProfessional: evaluated,
          clearedByProfessional: evaluated ? cleared : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Something went wrong.");
      setResult({ released: !!json.release, releasePath: json.release?.releasePath ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    if (result.released && result.releasePath) {
      const display = describeReleasedBrake(result.releasePath as "self_resolved_no_evaluation" | "professional_clearance" | "professional_clearance_with_prescription");
      return (
        <div className="max-w-md mx-auto px-4 py-10 text-center">
          <div className="bg-green-50 border-2 border-green-200 rounded-xl p-5 text-left">
            <p className="text-base font-bold text-green-900">{display.title}</p>
            <p className="text-sm text-green-800 mt-2">{display.body}</p>
          </div>
          <Link
            href="/patient/dashboard"
            className="mt-6 inline-block w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
          >
            Return to Dashboard
          </Link>
        </div>
      );
    }
    const display = describeActiveBrake({
      effectiveLevel,
      hasEverBeenProfessionallyHeld: requiresProfessionalPath,
      latestReassessment: {
        suddenOrSharpPainResolved: initialSuddenOrSharpPain ? sudden : null,
        newFunctionalDifficultyResolved: initialNewFunctionalDifficulty ? functional : null,
        evaluatedByProfessional: evaluated ?? false,
        clearedByProfessional: evaluated ? cleared : null,
      },
      symptomsStillPresent: (initialSuddenOrSharpPain && sudden !== true) || (initialNewFunctionalDifficulty && functional !== true),
    });
    return (
      <div className="max-w-md mx-auto px-4 py-10 text-center">
        <div className={`rounded-xl p-5 text-left border-2 ${effectiveLevel >= 4 ? "bg-amber-50 border-amber-300" : "bg-amber-50 border-amber-200"}`}>
          <p className="text-base font-bold text-amber-900">{"title" in display ? display.title : "Rehab on hold"}</p>
          <p className="text-sm text-amber-800 mt-2">{"body" in display ? display.body : ""}</p>
        </div>
        <Link href="/patient/dashboard" className="mt-6 inline-block w-full px-4 py-3.5 bg-gray-200 text-gray-800 text-base font-semibold rounded-lg">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">Safety Check-In</h1>
      <p className="text-sm text-gray-500 mt-1">
        {effectiveLevel >= 4
          ? "Because this concern has persisted or recurred, professional review is recommended. Let us know what you've learned so far."
          : "A quick follow-up before your next rehab session."}
      </p>

      {initialSuddenOrSharpPain && (
        <div className="mt-6">
          <p className="text-sm font-semibold text-gray-900">Has the sharp or pulling pain you reported resolved?</p>
          <YesNo value={sudden} onChange={setSudden} />
        </div>
      )}

      {initialNewFunctionalDifficulty && (
        <div className="mt-6">
          <p className="text-sm font-semibold text-gray-900">Has the new difficulty with normal activities resolved?</p>
          <YesNo value={functional} onChange={setFunctional} />
        </div>
      )}

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">Were you evaluated by a healthcare professional for this issue?</p>
        <YesNo value={evaluated} onChange={(v) => { setEvaluated(v); if (!v) setCleared(null); }} />
      </div>

      {/* Critical conditional UI rule (Section 5): the clearance question
          only ever renders when evaluated=true. If evaluated=No, this
          section does not exist in the DOM at all — there is no control
          through which the user could generate a clearance answer. */}
      {evaluated === true && (
        <div className="mt-6">
          <p className="text-sm font-semibold text-gray-900">Were you cleared to resume rehabilitation/loading?</p>
          <YesNo value={cleared} onChange={setCleared} />
        </div>
      )}

      {requiresProfessionalPath && evaluated === false && (
        <p className="mt-4 text-xs text-amber-700">
          Because this concern has persisted, recurred, or previously required professional evaluation, symptom improvement alone will not release your rehab hold — professional clearance is needed.
        </p>
      )}

      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleSubmit}
        className="mt-8 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        {submitting ? "Submitting…" : "Continue"}
      </button>
    </div>
  );
}
