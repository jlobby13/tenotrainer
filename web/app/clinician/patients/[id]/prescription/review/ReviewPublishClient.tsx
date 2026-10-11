"use client";

// C5.4D — the only interactive part of Review: the Publish confirmation and
// the handling of every publish outcome. The server-rendered review content
// arrives as `children`.
//
// Publication is never optimistic. "Prescription published" is shown only
// after the server confirms it — either the publish response itself, or the
// read-only reconciliation endpoint when that response is lost or ambiguous
// (network failure, 5xx, DRAFT_NOT_FOUND after a duplicate submit). A
// consequential publish is never retried automatically: reconciliation
// decides whether it happened, and only a confirmed "not published" result
// re-enables the button for an informed retry.

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Props = {
  patientId: string;
  draftId: string;
  fingerprint: string;
  isOwner: boolean;
  editingClinicianName: string;
  publishEnabled: boolean;
  issueCount: number;
  replacesVersionNumber: number | null;
  editHref: string;
  children: React.ReactNode;
};

type PublishedVersion = { id: string; versionNumber: number | null };
type Phase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "publishing" }
  | { kind: "reconciling" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "unconfirmed" }
  | { kind: "published"; version: PublishedVersion | null; recovered: boolean };

// Every message states plainly that nothing was published.
const ERROR_MESSAGES: Record<string, { message: string; retryable: boolean; refresh?: boolean }> = {
  PUBLISH_DISABLED: { message: "Publishing is not enabled in this environment. Nothing was published.", retryable: false },
  PATIENT_NOT_AUTHORIZED: {
    message: "Publication could not be authorized — your active supervision of this patient could not be confirmed. Nothing was published.",
    retryable: true,
  },
  DRAFT_NOT_OWNED_BY_CALLER: { message: "Only the editing clinician can publish this draft. Nothing was published.", retryable: false },
  DRAFT_CHANGED: {
    message: "This prescription changed after you opened Review, so nothing was published. The review has been refreshed with the latest draft — check it before publishing.",
    retryable: true,
    refresh: true,
  },
  DRAFT_STALE_BASE: {
    message: "A newer prescription version was published after this draft was started, so this draft can no longer be published. Nothing was published.",
    retryable: false,
    refresh: true,
  },
  VALIDATION_FAILED: { message: "The prescription no longer passes the publication checks. Nothing was published — see the issues below.", retryable: true, refresh: true },
  EXERCISE_UNAVAILABLE: { message: "An exercise in this prescription is no longer available. Nothing was published — see the issues below.", retryable: true, refresh: true },
  UNAUTHENTICATED: { message: "Your session has expired. Sign in again, then reopen Review. Nothing was published.", retryable: false },
  CLINICIAN_ROLE_REQUIRED: { message: "Your account is not permitted to publish prescriptions. Nothing was published.", retryable: false },
};

// Outcomes where the publish itself may or may not have happened.
const AMBIGUOUS_CODES = new Set(["INTERNAL_ERROR", "DRAFT_NOT_FOUND"]);

export function ReviewPublishClient({
  patientId,
  draftId,
  fingerprint,
  isOwner,
  editingClinicianName,
  publishEnabled,
  issueCount,
  replacesVersionNumber,
  editHref,
  children,
}: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [refreshing, startRefresh] = useTransition();
  // Synchronous guard: state lands a render later, so a fast double-click
  // could otherwise send two publish requests.
  const inFlightRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const busy = phase.kind === "publishing" || phase.kind === "reconciling";
  const ready = issueCount === 0;
  const canPublish = isOwner && publishEnabled && ready && !busy && !refreshing && phase.kind !== "unconfirmed";

  useEffect(() => {
    if (phase.kind !== "confirming") return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPhase({ kind: "idle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase.kind]);

  const reconcile = async () => {
    inFlightRef.current = true;
    setPhase({ kind: "reconciling" });
    try {
      const res = await fetch(`/api/clinician/prescription-drafts/${draftId}/publication`, { cache: "no-store" });
      if (!res.ok) throw new Error(`reconcile ${res.status}`);
      const outcome: { status: string; version: { id: string; versionNumber: number } | null } = await res.json();
      if (outcome.status === "published") {
        setPhase({ kind: "published", version: outcome.version, recovered: true });
      } else if (outcome.status === "editing") {
        setPhase({
          kind: "error",
          message: "Publication did not complete. Your draft is unchanged and nothing was published. You can try again.",
          retryable: true,
        });
      } else {
        setPhase({ kind: "error", message: "This draft is no longer open (it was discarded). Nothing was published from it.", retryable: false });
        startRefresh(() => router.refresh());
      }
    } catch {
      setPhase({ kind: "unconfirmed" });
    } finally {
      inFlightRef.current = false;
    }
  };

  const publish = async () => {
    if (inFlightRef.current || !canPublishNow()) return;
    inFlightRef.current = true;
    setPhase({ kind: "publishing" });

    let res: Response;
    try {
      res = await fetch(`/api/clinician/prescription-drafts/${draftId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedFingerprint: fingerprint }),
        cache: "no-store",
      });
    } catch {
      // The request may or may not have reached the server.
      await reconcile();
      return;
    }

    let body: { versionId?: string; versionNumber?: number | null; error?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.ok && body?.versionId) {
      inFlightRef.current = false;
      setPhase({ kind: "published", version: { id: body.versionId, versionNumber: body.versionNumber ?? null }, recovered: false });
      return;
    }
    const code = body?.error;
    if (res.ok || !code || res.status >= 500 || AMBIGUOUS_CODES.has(code)) {
      await reconcile();
      return;
    }

    inFlightRef.current = false;
    const known = ERROR_MESSAGES[code] ?? { message: "Publication failed. Nothing was published.", retryable: true };
    setPhase({ kind: "error", message: known.message, retryable: known.retryable });
    if (known.refresh) startRefresh(() => router.refresh());
  };

  // Read at click time (not from the render closure) so the confirmation
  // button can never act on a stale canPublish after a refresh.
  const canPublishNow = () => isOwner && publishEnabled && ready;

  if (phase.kind === "published") {
    return <PublishedSuccess patientId={patientId} version={phase.version} recovered={phase.recovered} replacesVersionNumber={replacesVersionNumber} />;
  }

  const blockedReason = !isOwner
    ? `Only the editing clinician (${editingClinicianName}) can publish this draft.`
    : !publishEnabled
      ? "Publishing is not enabled in this environment yet. You can review this prescription, but it cannot be published."
      : !ready
        ? "Resolve the issues above before publishing."
        : null;

  return (
    <>
      {phase.kind === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert" data-testid="publish-error">
          {phase.message}
        </div>
      )}
      {phase.kind === "unconfirmed" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-2" role="alert" data-testid="publish-unconfirmed">
          <p>
            <strong>We couldn&apos;t confirm whether the prescription was published.</strong> The connection was interrupted before the server responded. Don&apos;t publish
            again until the status is confirmed.
          </p>
          <button type="button" onClick={reconcile} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100" data-testid="publish-check-again">
            Check publication status
          </button>
        </div>
      )}
      {phase.kind === "reconciling" && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700" role="status" data-testid="publish-reconciling">
          Confirming publication status…
        </div>
      )}

      {children}

      <div className="sticky bottom-0 z-10 -mx-4 border-t border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-sm sm:mx-0 sm:rounded-xl sm:border sm:shadow" data-testid="review-action-bar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={editHref} className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50" data-testid="edit-prescription">
            {isOwner ? "Edit Prescription" : "View Draft"}
          </Link>
          <button
            type="button"
            onClick={() => setPhase({ kind: "confirming" })}
            disabled={!canPublish}
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500"
            data-testid="publish-prescription"
          >
            {busy ? "Publishing…" : "Publish Prescription"}
          </button>
        </div>
        {blockedReason && (
          <p className="mt-2 text-xs text-gray-600" data-testid="publish-blocked-reason">
            {blockedReason}
          </p>
        )}
      </div>

      {(phase.kind === "confirming" || phase.kind === "publishing") && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/40 p-4 sm:items-center" data-testid="publish-dialog-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl space-y-3" data-testid="publish-dialog">
            <h2 id="publish-dialog-title" className="text-lg font-semibold text-gray-900">
              Publish this prescription?
            </h2>
            <p className="text-sm text-gray-700">This will make this version the patient&apos;s current prescription. Published versions cannot be edited.</p>
            <p className="text-sm text-gray-700">Future changes will require creating a new draft and publishing a new version.</p>
            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setPhase({ kind: "idle" })}
                disabled={phase.kind === "publishing"}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid="publish-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={publish}
                disabled={phase.kind === "publishing"}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-wait disabled:bg-brand-400"
                data-testid="publish-confirm"
              >
                {phase.kind === "publishing" ? "Publishing…" : "Publish Prescription"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// No claim about the patient's app, Today's Rehab, or next workout:
// publication establishes the authoritative prescription only (C5.6 has not
// cut the patient runtime over to it).
function PublishedSuccess({
  patientId,
  version,
  recovered,
  replacesVersionNumber,
}: {
  patientId: string;
  version: PublishedVersion | null;
  recovered: boolean;
  replacesVersionNumber: number | null;
}) {
  const versionText = version?.versionNumber != null ? `Version ${version.versionNumber}` : "The new version";
  return (
    <section className="bg-white rounded-xl shadow border border-green-200 p-6 space-y-3" role="status" data-testid="publish-success">
      <h2 className="text-xl font-semibold text-gray-900">Prescription published</h2>
      <p className="text-gray-700" data-testid="publish-success-version">
        {versionText} is now the patient&apos;s current prescription.
      </p>
      <p className="text-sm text-gray-600" data-testid="publish-success-history">
        {replacesVersionNumber == null
          ? "This is the patient's first published prescription."
          : `Version ${replacesVersionNumber} remains in the prescription history, unchanged.`}
      </p>
      {recovered && (
        <p className="text-sm text-gray-600" data-testid="publish-success-recovered">
          The connection was interrupted, but the server confirmed the publication.
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-2">
        {version && (
          <Link
            href={`/clinician/patients/${patientId}/prescription/versions/${version.id}`}
            className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            data-testid="view-published"
          >
            View Published Prescription
          </Link>
        )}
        <Link
          href={`/clinician/patients/${patientId}`}
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          data-testid="return-overview"
        >
          Return to Patient Overview
        </Link>
      </div>
    </section>
  );
}
