import "server-only";

// C5.3 — high-consequence clinician-write authorization (C5.3A §4-5,
// LOCKED in C5.3B decision 1). Every one of: create prescription draft,
// publish, pause, resume MUST call verifyHighConsequenceAuthorization()
// before any mutation. Draft micro-edits (add/reorder/remove workout or
// exercise, dosage edits on an already-open draft) continue to use the
// lower-consequence assertSupervises() from clinicianAuth.ts, per the
// approved audit — do not upgrade those to this check without a founder
// decision, and do not downgrade any of the four high-consequence
// operations to assertSupervises() alone.
//
// FAIL CLOSED, no exceptions: inactive relationship, unresolvable
// identity, missing bridge secret, network error, timeout, non-2xx
// response, or a malformed body are ALL treated identically — the caller
// only ever sees PATIENT_NOT_AUTHORIZED, never which of these occurred.
// There is deliberately no PG-only fallback path anywhere in this
// function; the Postgres check and the legacy check are both mandatory.

import { createServiceRoleClient } from "./supabase/server";
import { PrescriptionDraftError } from "./prescriptionDraftErrors";

const LEGACY_CHECK_TIMEOUT_MS = 5000;
const FASTAPI_URL = process.env.FASTAPI_URL ?? "http://localhost:8000";

export async function verifyHighConsequenceAuthorization(clinicianId: string, patientId: string): Promise<void> {
  const supabase = createServiceRoleClient();

  // 1. Existing Postgres relationship check (necessary, not sufficient).
  const { data: pgRow, error: pgError } = await supabase
    .from("supervisor_patients")
    .select("id")
    .eq("supervisor_id", clinicianId)
    .eq("patient_id", patientId)
    .eq("status", "active")
    .maybeSingle();
  if (pgError || !pgRow) {
    throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");
  }

  // 2. Resolve both identities to email — the legacy system has no concept
  // of a Supabase UUID and can only be queried by the same email-bridge
  // convention already established by the C1A sync route.
  const bridgeSecret = process.env.BRIDGE_SECRET;
  const [clinicianUser, patientUser] = await Promise.all([
    supabase.auth.admin.getUserById(clinicianId),
    supabase.auth.admin.getUserById(patientId),
  ]);
  const supervisorEmail = clinicianUser.data.user?.email;
  const patientEmail = patientUser.data.user?.email;
  if (!bridgeSecret || !supervisorEmail || !patientEmail) {
    console.error("verifyHighConsequenceAuthorization: cannot resolve identity/bridge secret for the legacy check — blocking (fail closed).");
    throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");
  }

  // 3. Synchronous authoritative legacy re-check. Any failure to
  // positively confirm "active" blocks the mutation.
  let legacyActive = false;
  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), LEGACY_CHECK_TIMEOUT_MS);
    const url = new URL("/api/internal/supervisor-status", FASTAPI_URL);
    url.searchParams.set("supervisor_email", supervisorEmail);
    url.searchParams.set("patient_email", patientEmail);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${bridgeSecret}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!response.ok) {
      console.error(`verifyHighConsequenceAuthorization: legacy check returned HTTP ${response.status} — blocking (fail closed).`);
      throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");
    }
    const body: unknown = await response.json();
    legacyActive = typeof body === "object" && body !== null && (body as { active?: unknown }).active === true;
  } catch (err) {
    if (err instanceof PrescriptionDraftError) throw err;
    console.error("verifyHighConsequenceAuthorization: legacy check unreachable or timed out — blocking (fail closed).", err);
    throw new PrescriptionDraftError("PATIENT_NOT_AUTHORIZED");
  }

  if (!legacyActive) {
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
  if (process.env.C5_PRESCRIPTION_PUBLISH_ENABLED !== "true") {
    throw new PrescriptionDraftError("PUBLISH_DISABLED");
  }
}
