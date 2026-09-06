"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type {
  ExternalLoadCategory,
  ExternalLoadTiming,
  MorningPainTolerability,
  MorningResponseRecord,
  StiffnessDuration,
  ToleranceEvaluationRecord,
} from "@/lib/morningResponseTypes";
import { EXTERNAL_LOAD_CATEGORIES, EXTERNAL_LOAD_TIMINGS } from "@/lib/morningResponseTypes";
import { submitMorningResponseCheckpoint } from "@/lib/morningResponseClient";
import { PatientTimeline } from "@/app/patient/dashboard/components/PatientTimeline";
import { HandoffSnapshot } from "./HandoffSnapshot";
import { ToleranceResultsCard } from "./ToleranceResultsCard";

const NOTE_MAX_LENGTH = 500;

const CATEGORY_LABELS: Record<ExternalLoadCategory, string> = {
  running: "Running",
  sport: "Sport",
  prolonged_walking_standing: "Prolonged walking or standing",
  other_lower_body_training: "Other lower-body training",
  unusually_high_activity: "Unusually high activity",
  other: "Other",
  none: "None",
};

const TIMING_LABELS: Record<ExternalLoadTiming, string> = {
  previous_day: "The day before",
  same_day_before_rehab: "Same day, before your rehab session",
  same_day_after_rehab: "Same day, after your rehab session",
};

const STIFFNESS_DURATION_LABELS: Record<Exclude<StiffnessDuration, "not_applicable">, string> = {
  lt_5_min: "Less than 5 minutes",
  min_5_15: "5–15 minutes",
  min_15_30: "15–30 minutes",
  gt_30_min: "More than 30 minutes",
};

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
  escalationLevel: number | null;
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
  const [stiffnessDuration, setStiffnessDuration] = useState<StiffnessDuration | null>(
    morningResponse.stiffnessDuration
  );
  const [tolerability, setTolerability] = useState<MorningPainTolerability | null>(
    morningResponse.morningPainTolerability
  );
  const [loadCategories, setLoadCategories] = useState<ExternalLoadCategory[]>(
    morningResponse.externalLoadCategories ?? []
  );
  const [loadTiming, setLoadTiming] = useState<ExternalLoadTiming[]>(morningResponse.externalLoadTiming ?? []);
  const [note, setNote] = useState(morningResponse.patientNote ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(morningResponse.submittedAt !== null);
  const [evaluation, setEvaluation] = useState<ToleranceEvaluationRecord | null>(null);
  const noteBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stiffness duration is only required (and only asked) once stiffness > 0
  // — the server auto-sets "not_applicable" whenever stiffness is 0, so a
  // patient who reports zero stiffness is never blocked on a question that
  // doesn't apply to them. Section 8: tolerability is only asked when pain
  // is exactly 5, never "unnecessarily" for clearly low or high pain.
  const needsStiffnessDuration = stiffness !== null && stiffness > 0;
  const needsTolerability = pain === 5;

  const canSubmit =
    pain !== null &&
    stiffness !== null &&
    (!needsStiffnessDuration || stiffnessDuration !== null) &&
    (!needsTolerability || tolerability !== null) &&
    !submitting;

  async function handlePainSelect(value: number) {
    setPain(value);
    if (value !== 5) setTolerability(null);
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
    // "not_applicable" is only ever valid when stiffness === 0 (the server
    // auto-sets it there). A resumed checkpoint can load with stiffness=0
    // and stiffnessDuration="not_applicable" already set — if the patient
    // then raises stiffness above 0, that stale value must be cleared back
    // to null (never silently carried forward as an answered duration),
    // forcing the duration question to reappear and be required again.
    setStiffnessDuration((prev) => (value === 0 ? null : prev === "not_applicable" ? null : prev));
    try {
      await submitMorningResponseCheckpoint(morningResponse.id, { nextMorningStiffness: value });
    } catch {
      // Same reasoning as handlePainSelect.
    }
  }

  async function handleStiffnessDurationSelect(value: StiffnessDuration) {
    setStiffnessDuration(value);
    try {
      await submitMorningResponseCheckpoint(morningResponse.id, { stiffnessDuration: value });
    } catch {
      // Best-effort — the value still carries through on final submit.
    }
  }

  async function handleTolerabilitySelect(value: MorningPainTolerability) {
    setTolerability(value);
    try {
      await submitMorningResponseCheckpoint(morningResponse.id, { morningPainTolerability: value });
    } catch {
      // Best-effort — the value still carries through on final submit.
    }
  }

  function toggleCategory(category: ExternalLoadCategory) {
    // "None" is a fast, exclusive answer — selecting it clears any other
    // category (and its timing, which no longer applies); selecting any
    // real category clears "None" if it was previously chosen. These stay
    // deliberately distinct from "not yet answered" (empty array).
    if (category === "none") {
      setLoadCategories((prev) => (prev.includes("none") ? [] : ["none"]));
      setLoadTiming([]);
      return;
    }
    setLoadCategories((prev) => {
      const withoutNone = prev.filter((c) => c !== "none");
      return withoutNone.includes(category)
        ? withoutNone.filter((c) => c !== category)
        : [...withoutNone, category];
    });
  }

  function toggleTiming(timing: ExternalLoadTiming) {
    setLoadTiming((prev) => (prev.includes(timing) ? prev.filter((t) => t !== timing) : [...prev, timing]));
  }

  async function handleSubmit() {
    if (pain === null || stiffness === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitMorningResponseCheckpoint(morningResponse.id, {
        nextMorningPain: pain,
        nextMorningStiffness: stiffness,
        stiffnessDuration: stiffnessDuration ?? undefined,
        morningPainTolerability: tolerability ?? undefined,
        externalLoadCategories: loadCategories.length > 0 ? loadCategories : undefined,
        externalLoadTiming: loadTiming.length > 0 ? loadTiming : undefined,
        patientNote: note.trim() || null,
        finalize: true,
      });
      setEvaluation(result.toleranceEvaluation);
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
          <PatientTimeline sessionResponseDone morningResponseDone resultsAvailable={evaluation !== null} />
        </div>

        <h1 className="text-xl font-bold text-gray-900 text-center">Morning Response Recorded</h1>
        <p className="text-sm text-gray-500 text-center mt-1">Your morning check-in has been recorded.</p>

        {evaluation && (
          <div className="mt-6">
            <ToleranceResultsCard evaluation={evaluation} escalationLevel={previousSession.escalationLevel} />
          </div>
        )}

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

      {needsTolerability && (
        <div className="mt-6">
          <p className="text-sm font-semibold text-gray-900">How manageable was your Achilles pain this morning?</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => handleTolerabilitySelect("manageable")}
              className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-semibold border-2 disabled:opacity-60 ${
                tolerability === "manageable" ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
              }`}
            >
              Manageable
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => handleTolerabilitySelect("difficult_to_tolerate")}
              className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-semibold border-2 disabled:opacity-60 ${
                tolerability === "difficult_to_tolerate"
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-gray-200 text-gray-700"
              }`}
            >
              Difficult to tolerate
            </button>
          </div>
        </div>
      )}

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">How stiff does your Achilles feel this morning?</p>
        <div className="mt-2">
          <ScaleGrid value={stiffness} onSelect={handleStiffnessSelect} disabled={submitting} />
        </div>
        <p className="text-xs text-gray-400 mt-2">0 = no stiffness · 10 = extremely stiff</p>
      </div>

      {needsStiffnessDuration && (
        <div className="mt-6">
          <p className="text-sm font-semibold text-gray-900">How long did the stiffness last?</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(Object.keys(STIFFNESS_DURATION_LABELS) as Exclude<StiffnessDuration, "not_applicable">[]).map((d) => (
              <button
                key={d}
                type="button"
                disabled={submitting}
                onClick={() => handleStiffnessDurationSelect(d)}
                className={`px-3 py-2.5 rounded-lg text-sm font-semibold border-2 disabled:opacity-60 ${
                  stiffnessDuration === d ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
                }`}
              >
                {STIFFNESS_DURATION_LABELS[d]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6">
        <p className="text-sm font-semibold text-gray-900">
          Any extra activity? <span className="text-gray-400 font-normal">(optional)</span>
        </p>
        <p className="text-xs text-gray-400 mt-0.5">Running, sport, or other lower-body activity since your last session.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXTERNAL_LOAD_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              disabled={submitting}
              onClick={() => toggleCategory(c)}
              className={`px-3 py-2 rounded-full text-sm font-medium border-2 disabled:opacity-60 ${
                loadCategories.includes(c) ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
              }`}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
          <button
            type="button"
            disabled={submitting}
            onClick={() => toggleCategory("none")}
            className={`px-3 py-2 rounded-full text-sm font-medium border-2 disabled:opacity-60 ${
              loadCategories.includes("none") ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
            }`}
          >
            None
          </button>
        </div>

        {loadCategories.length > 0 && !loadCategories.includes("none") && (
          <div className="mt-3">
            <p className="text-xs font-semibold text-gray-500">When?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {EXTERNAL_LOAD_TIMINGS.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={submitting}
                  onClick={() => toggleTiming(t)}
                  className={`px-3 py-2 rounded-full text-sm font-medium border-2 disabled:opacity-60 ${
                    loadTiming.includes(t) ? "border-brand-600 bg-brand-600 text-white" : "border-gray-200 text-gray-700"
                  }`}
                >
                  {TIMING_LABELS[t]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-6">
        <label className="text-sm font-semibold text-gray-900" htmlFor="morning-note">
          Add a note <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <textarea
          id="morning-note"
          value={note}
          onChange={(e) => {
            const trimmedToMax = e.target.value.slice(0, NOTE_MAX_LENGTH);
            setNote(trimmedToMax);
            if (noteBlurTimer.current) clearTimeout(noteBlurTimer.current);
            noteBlurTimer.current = setTimeout(() => {
              submitMorningResponseCheckpoint(morningResponse.id, { patientNote: trimmedToMax || null }).catch(() => {
                // Best-effort — the current value is also sent explicitly on final submit.
              });
            }, 800);
          }}
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
