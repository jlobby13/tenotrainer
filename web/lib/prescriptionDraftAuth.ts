import "server-only";

// High-consequence clinician-write authorization. Every one of: create
// prescription draft, publish, pause, resume and the M1 professional-review
// release MUST call verifyHighConsequenceAuthorization() before any
// mutation, and each of those database functions re-checks the active
// assignment inside its own transaction (so a revocation is effective at
// action time).
//
// M2 — Postgres is the sole assignment authority. The former synchronous
// FastAPI/SQLite re-check (/api/internal/supervisor-status) is removed: it
// only ever re-confirmed the legacy SQLite assignment fact that Postgres
// mirrored, and SQLite is no longer authoritative. It is deliberately NOT
// recreated anywhere. The check is the shared clinician_patient_access()
// primitive (assertSupervises): authenticated clinician + clinician role in
// the assignment's organization + active assignment.
//
// FAIL CLOSED: any failure is PATIENT_NOT_AUTHORIZED, never a distinct code.

import { assertSupervises } from "./clinicianAuth";
import { PrescriptionDraftError } from "./prescriptionDraftErrors";

export async function verifyHighConsequenceAuthorization(clinicianId: string, patientId: string): Promise<void> {
  if (!(await assertSupervises(clinicianId, patientId))) {
    throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");
  }
}

// C5.3 — explicit server-side publish feature gate (C5.3A §21/24, LOCKED
// in C5.3B decision 2). Unset, empty, or any value other than the exact
// string "true" means DISABLED — never accidentally enabled by a missing
// or misconfigured environment variable. This is the actual safety
// boundary; a missing "Publish" button in a future C5.4 UI is not. Must
// not be removed until the C5.6 cutover is explicitly authorized.
export function assertPublishEnabled(): void {
  if (!isPublishEnabled()) {
    throw new PrescriptionDraftError("PUBLISH_DISABLED");
  }
}

// C5.4D — the same predicate, read-only, so the Review page can tell the
// clinician publishing is unavailable instead of offering a button that
// can only fail. Display only: assertPublishEnabled() above stays the
// enforcement point inside publishDraft().
export function isPublishEnabled(): boolean {
  return process.env.C5_PRESCRIPTION_PUBLISH_ENABLED === "true";
}
