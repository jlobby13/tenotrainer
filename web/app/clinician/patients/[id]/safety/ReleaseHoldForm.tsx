"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const MAX_NOTE = 1000;

// M1 — explicit clinician release of a professional-review training hold.
// The note is required (1–1000 characters) and kept as release provenance.
export function ReleaseHoldForm({ patientId, episodeId }: { patientId: string; episodeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = note.trim();

  async function submit() {
    if (!trimmed || trimmed.length > MAX_NOTE || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/clinician/patients/${patientId}/acute-safety/${episodeId}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: trimmed }),
      });
      const json = (await res.json().catch(() => ({}))) as { result?: string };
      if (json.result === "released" || json.result === "already_released") {
        router.refresh();
        return;
      }
      setError(
        json.result === "invalid_note"
          ? "A release note of 1–1000 characters is required."
          : json.result === "clinician_release_not_required"
            ? "This episode no longer needs a clinician release. Refresh to see its current state."
            : json.result === "not_authorized"
              ? "This release could not be authorized. Please refresh and try again."
              : "The release could not be saved. Please try again."
      );
    } catch {
      setError("The release could not be saved. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
        data-testid="release-open"
      >
        Release training hold
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4" data-testid="release-form">
      <label htmlFor={`release-note-${episodeId}`} className="block text-sm font-medium text-gray-900">
        Release note (required)
      </label>
      <p className="mt-0.5 text-xs text-gray-500">Record why training can resume. This note is kept with the release and cannot be edited later.</p>
      <textarea
        id={`release-note-${episodeId}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={MAX_NOTE}
        rows={3}
        className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
      />
      <p className="mt-1 text-xs text-gray-500">
        {trimmed.length}/{MAX_NOTE}
      </p>
      {error && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!trimmed || submitting}
          className="inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
          data-testid="release-confirm"
        >
          {submitting ? "Releasing…" : "Confirm release"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="inline-flex min-h-10 items-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
