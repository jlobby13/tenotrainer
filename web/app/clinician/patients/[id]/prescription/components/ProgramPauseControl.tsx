"use client";

// M2 — clinician Pause / Resume program. Two-step: the first button only
// reveals the confirmation, whose copy states the locked semantics; the
// confirm button submits the server action (authoritative pause/resume).

import { useState } from "react";
import { pauseProgramAction, resumeProgramAction } from "../actions";
import { LocalDateTime } from "./LocalDateTime";

export function ProgramPauseControl({
  patientId,
  status,
  pausedAt,
  pausedByName,
}: {
  patientId: string;
  status: "active" | "paused";
  pausedAt: string | null;
  pausedByName: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const paused = status === "paused";

  return (
    <section
      className={`rounded-xl border p-6 space-y-3 ${paused ? "border-amber-200 bg-amber-50" : "border-gray-100 bg-white shadow"}`}
      data-testid="program-pause-control"
      data-status={status}
    >
      {paused ? (
        <div className="text-sm text-amber-900 space-y-1">
          <p className="font-semibold">Program Paused</p>
          <p data-testid="pause-context">
            Paused{pausedAt ? <> since <LocalDateTime iso={pausedAt} /></> : null}
            {pausedByName ? <> by {pausedByName}</> : null}. New sessions are unavailable to the patient until the program is resumed.
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-600">The program is active.</p>
      )}

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          data-testid={paused ? "resume-program" : "pause-program"}
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
        >
          {paused ? "Resume program" : "Pause program"}
        </button>
      ) : (
        <form action={paused ? resumeProgramAction : pauseProgramAction} className="space-y-3" data-testid="pause-confirmation">
          <input type="hidden" name="patientId" value={patientId} />
          {paused ? (
            <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1" data-testid="resume-semantics">
              <li>Resuming makes future eligible training available to the patient again.</li>
              <li>It does not start a session.</li>
            </ul>
          ) : (
            <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1" data-testid="pause-semantics">
              <li>Pausing blocks new sessions.</li>
              <li>A session the patient has already started is not ended — they can still finish it or stop it.</li>
              <li>No workout is cancelled or rescheduled automatically.</li>
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              data-testid={paused ? "confirm-resume" : "confirm-pause"}
              className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              {paused ? "Confirm resume" : "Confirm pause"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
