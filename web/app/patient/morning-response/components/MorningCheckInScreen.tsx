"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { MorningResponseRecord } from "@/lib/morningResponseTypes";
import { submitMorningResponseCheckpoint } from "@/lib/morningResponseClient";
import { PatientTimeline } from "@/app/patient/dashboard/components/PatientTimeline";
import { HandoffSnapshot } from "./HandoffSnapshot";

const NOTE_MAX_LENGTH = 500;

function ScaleGrid({
  value,
  onSelect,
  disabled,
}: {
  value: number | null;
  onSelect: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-6 gap-2">
      {Array.from({ length: 11 }, (_, i) => i).map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(n)}
          className={`aspect-square rounded-lg text-sm font-semibold border-2 disabled:opacity-60 ${
            value === n ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

type PreviousSession = {
  patientLocalDate: string;
  exerciseNames: string[];
  completedSets: number;
  skippedSets: number;
  peakSessionPain: number | null;
  difficulty: string | null;
};

export function MorningCheckInScreen({
  morningResponse,
  previousSession,
}: {
  morningResponse: MorningResponseRecord;
  previousSession: PreviousSession;
}) {
  const router = useRouter();
  const [pain, setPain] = useState<number | null>(morningResponse.nextMorningPain);
  const [stiffness, setStiffness] = useState<number | null>(morningResponse.nextMorningStiffness);
  const [note, setNote] = useState(morningResponse.patientNote ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(morningResponse.submittedAt !== null);
  const noteBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canSubmit = pain !== null && stiffness !== null && !submitting;

  async function handlePainSelect(value: number) {
    setPain(value);
    try {
      await submitMorningResponseCheckpoint(morningResponse.id, { nextMorningPain: value });
    } catch {
      // Progressive save is best-effort per tap; the value still carries
      // through in the final submit request, so a transient network blip
      // here doesn't lose the answer.
    }
  }

  async function handleStiffnessSelect(value: number) {
    setStiffness(value);
    try {
      await submitMorningResponseCheckpoint(morningResponse.id, { nextMorningStiffness: value });
    } catch {
      // Same reasoning as handlePainSelect.
    }
  }

  function handleNoteChange(value: string) {
    const trimmedToMax = value.slice(0, NOTE_MAX_LENGTH);
    setNote(trimmedToMax);
    if (noteBlurTimer.current) clearTimeout(noteBlurTimer.current);
    noteBlurTimer.current = setTimeout(() => {
      submitMorningResponseCheckpoint(morningResponse.id, { patientNote: trimmedToMax || null }).catch(() => {
        // Best-effort — the current value is also sent explicitly on final submit.
      });
    }, 800);
  }

  async function handleSubmit() {
    if (pain === null || stiffness === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitMorningResponseCheckpoint(morningResponse.id, {
        nextMorningPain: pain,
        nextMorningStiffness: stiffness,
        patientNote: note.trim() || null,
        finalize: true,
      });
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="max-w-md mx-auto px-4 py-10">
        <div className="mb-6">
          <PatientTimeline sessionResponseDone morningResponseDone resultsAvailable={false} />
        </div>

        <h1 className="text-xl font-bold text-gray-900 text-center">Morning Response Recorded</h1>
        <p className="text-sm text-gray-500 text-center mt-1">Your morning check-in has been recorded.</p>

        <div className="mt-6">
          <HandoffSnapshot
            patientLocalDate={previousSession.patientLocalDate}
            exerciseNames={previousSession.exerciseNames}
            completedSets={previousSession.completedSets}
            skippedSets={previousSession.skippedSets}
            peakSessionPain={previousSession.peakSessionPain}
            difficulty={previousSession.difficulty}
            nextMorningPain={pain!}
            nextMorningStiffness={stiffness!}
          />
        </div>

        <button
          type="button"
          onClick={() => router.push("/patient/dashboard")}
          className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-xl font-bold text-gray-900">Morning Check-In</h1>
      <p className="text-sm text-gray-500 mt-1">
        Tell us how your Achilles feels this morning so we can understand how you responded to your last rehab
        session.
      </p>

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">How is your Achilles pain this morning?</p>
        <div className="mt-2">
          <ScaleGrid value={pain} onSelect={handlePainSelect} disabled={submitting} />
        </div>
        <p className="text-xs text-gray-400 mt-2">0 = no pain · 10 = worst pain imaginable</p>
      </div>

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">How stiff does your Achilles feel this morning?</p>
        <div className="mt-2">
          <ScaleGrid value={stiffness} onSelect={handleStiffnessSelect} disabled={submitting} />
        </div>
        <p className="text-xs text-gray-400 mt-2">0 = no stiffness · 10 = extremely stiff</p>
      </div>

      <div className="mt-6">
        <label className="text-sm font-semibold text-gray-900" htmlFor="morning-note">
          Add a note <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <textarea
          id="morning-note"
          value={note}
          onChange={(e) => handleNoteChange(e.target.value)}
          disabled={submitting}
          placeholder="e.g. felt stiff getting out of bed but loosened quickly"
          className="mt-2 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:opacity-60"
          rows={3}
          maxLength={NOTE_MAX_LENGTH}
        />
        <p className="text-xs text-gray-400 mt-1 text-right">{note.length}/{NOTE_MAX_LENGTH}</p>
      </div>

      {error && <p className="text-sm text-red-600 mt-4">{error}</p>}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleSubmit}
        className="mt-6 w-full px-4 py-3.5 bg-brand-600 text-white text-base font-semibold rounded-lg disabled:opacity-40"
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </div>
  );
}
