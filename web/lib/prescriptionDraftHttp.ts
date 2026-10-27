import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianAuthForRoute } from "./clinicianAuth";
import { PrescriptionDraftError } from "./prescriptionDraftErrors";
import { isMutationAllowed, MaintenanceError } from "./operatingMode";

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  CLINICIAN_ROLE_REQUIRED: 403,
  PATIENT_NOT_AUTHORIZED: 403,
  DRAFT_ALREADY_EXISTS: 409,
  DRAFT_NOT_FOUND: 404,
  DRAFT_NOT_OWNED_BY_CALLER: 403,
  DRAFT_STALE_BASE: 409,
  DRAFT_CHANGED: 409,
  VALIDATION_FAILED: 422,
  EXERCISE_UNAVAILABLE: 422,
  TEMPLATE_UNAVAILABLE: 422,
  PUBLISH_DISABLED: 403,
  PRESCRIPTION_ALREADY_PAUSED: 409,
  PRESCRIPTION_ALREADY_ACTIVE: 409,
  INTERNAL_ERROR: 500,
};

// Never surfaces raw SQL/internal error text — every route in
// web/app/api/clinician/prescription* funnels its catch block through this.
export function prescriptionDraftErrorResponse(err: unknown): NextResponse {
  if (err instanceof MaintenanceError) return NextResponse.json({ error: "MAINTENANCE" }, { status: 503 });
  if (err instanceof PrescriptionDraftError) {
    // `details` is only ever OUR OWN structured validation output (e.g.
    // C5.4B's dosage fieldErrors) — never a raw SQL/Postgres/RPC message.
    const body = err.details !== undefined ? { error: err.code, details: err.details } : { error: err.code };
    return NextResponse.json(body, { status: STATUS_BY_CODE[err.code] ?? 500 });
  }
  console.error("Unexpected prescription-draft route error:", err);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

// Every route below calls this first. Never trusts a client-supplied
// clinician id — the only identity a route ever uses is the one this
// returns.
// M3.1 — `mutation: true` (every POST/PATCH/PUT/DELETE handler) refuses the
// request in maintenance mode before anything else. Reads stay available.
export async function requireClinicianForRoute(opts: { mutation?: boolean } = {}): Promise<{ clinicianId: string } | { response: NextResponse }> {
  if (opts.mutation && !isMutationAllowed()) {
    return { response: NextResponse.json({ error: "MAINTENANCE" }, { status: 503 }) };
  }
  const auth = await requireClinicianAuthForRoute();
  if (!auth.ok) {
    const status = auth.reason === "UNAUTHENTICATED" ? 401 : 403;
    return { response: NextResponse.json({ error: auth.reason }, { status }) };
  }
  return { clinicianId: auth.clinicianId };
}
