"use client";

import { useState } from "react";
import type { SessionExercise } from "@/lib/fastapi";

// Faithful mapping from canonical exercise-library fields onto the patient-facing
// SETUP / PERFORM / KEY CUE structure. No new clinical content is invented:
//   SETUP    <- setup_instructions, verbatim
//   PERFORM  <- the full execution_cues list, in order
//   KEY CUE  <- the first execution_cues entry, repeated and emphasized
// Limitation (reported, not papered over): the canonical data has no field that
// semantically marks a cue as "the key one" — using the first cue as the headline
// is a presentation convention, not asserted new clinical meaning. Revisit if the
// library ever adds an explicit key-cue field.
//
// Media slots (start/finish position images, video) are named here so a future
// canonical-library addition can plug in without redesigning this component —
// but none exist today, so nothing renders in their place. No broken image icons,
// no empty placeholder boxes.
export function ExerciseGuidance({
  exercise,
  startPositionImageUrl,
  finishPositionImageUrl,
  videoUrl,
}: {
  exercise: SessionExercise;
  startPositionImageUrl?: string | null;
  finishPositionImageUrl?: string | null;
  videoUrl?: string | null;
}) {
  // Defaults to expanded for the founder-acceptance pass so guidance is
  // immediately visible rather than requiring discovery. Whether experienced
  // users should get a persistent "start collapsed" preference is a later
  // decision, not made here.
  const [expanded, setExpanded] = useState(true);
  const explanation = exercise.exercise.patient_facing_explanation?.trim();
  const setup = exercise.exercise.setup_instructions?.trim();
  const cues = exercise.exercise.execution_cues ?? [];
  const keyCue = cues[0];
  const performCues = cues;
  const hasMedia = Boolean(startPositionImageUrl || finishPositionImageUrl || videoUrl);

  if (!setup && cues.length === 0 && !hasMedia && !explanation) return null;

  return (
    <div className="border border-gray-100 rounded-xl bg-gray-50">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-gray-700"
      >
        <span>How to do this exercise</span>
        <span className="text-gray-400">{expanded ? "Hide" : "Show"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          {hasMedia && (
            <div className="grid grid-cols-2 gap-2">
              {startPositionImageUrl && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 mb-1">Start Position</p>
                  <img src={startPositionImageUrl} alt="Start position" className="rounded-lg w-full" />
                </div>
              )}
              {finishPositionImageUrl && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 mb-1">Finish Position</p>
                  <img src={finishPositionImageUrl} alt="Finish position" className="rounded-lg w-full" />
                </div>
              )}
            </div>
          )}
          {videoUrl && (
            <a
              href={videoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-sm font-semibold text-brand-600 underline"
            >
              Watch Video
            </a>
          )}

          {explanation && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">Why This Exercise</p>
              <p className="text-sm text-gray-700">{explanation}</p>
            </div>
          )}

          {setup && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">Setup</p>
              <p className="text-sm text-gray-700">{setup}</p>
            </div>
          )}

          {performCues.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">Perform</p>
              <ul className="text-sm text-gray-700 list-disc list-inside space-y-0.5">
                {performCues.map((cue, i) => (
                  <li key={i}>{cue}</li>
                ))}
              </ul>
            </div>
          )}

          {keyCue && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">Key Cue</p>
              <p className="text-sm font-medium text-gray-900">{keyCue}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
