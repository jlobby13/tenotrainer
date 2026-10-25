import "server-only";

// C1A — Clinician Foundation. The authorization boundary for every
// clinician-facing route. Deliberately the ONLY place a clinician route's
// role/supervision check happens — routes call these, never re-implement
// their own ad hoc check (the prior clinician dashboard's permissive-by-
// omission role check and the prior patient-detail route's complete
// absence of any Next.js-side authorization are exactly the two defects
// this module exists to close).

import { redirect } from "next/navigation";
import { getSessionInfo } from "./auth";
import { createServiceRoleClient } from "./supabase/server";

export type ClinicianRole = "clinician" | "clinician_admin";

export type ClinicianAuth = {
  clinicianId: string;
  role: ClinicianRole;
};

// LOCKED (founder decision): explicit allowlist, never permissive-by-
// omission. super_user is deliberately EXCLUDED — administrative privilege
// never implies clinician-route access on its own. A super_user who is
// ALSO a clinician/clinician_admin via a separate membership (another
// organization) gets in because of THAT role, not because of super_user
// status — one role per (user, organization) membership row.

// Redirects (never throws) — every clinician route calls this first, before
// touching any patient data. Unauthenticated -> /login. Authenticated but
// not an allowed clinician role -> /dashboard (the same role-router every
// other part of the app redirects an out-of-place role to).
export async function requireClinicianAuth(): Promise<ClinicianAuth> {
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");

  const role = clinicianRoleOf(session.memberships);
  if (!role) redirect("/dashboard");

  return { clinicianId: session.user.id, role };
}

// M2 — the clinician role is read from ANY of the user's memberships, never
// from memberships[0]. This only answers "is this a clinician at all"; which
// patients they may touch is decided per patient by assertSupervises(),
// against the organization the assignment belongs to.
function clinicianRoleOf(memberships: { role: string }[]): ClinicianRole | null {
  if (memberships.some((m) => m.role === "clinician_admin")) return "clinician_admin";
  if (memberships.some((m) => m.role === "clinician")) return "clinician";
  return null;
}

// LOCKED canonical active-supervision predicate — the ONLY thing that
// grants clinical patient access. Never inferred from shared organization
// membership. Uses the service-role client because this is the actual
// authorization boundary itself, not a redundant check layered on top of
// RLS — see clinicianServer.ts's header note on why patient-data reads
// happen only after this call succeeds, using helpers that do not enforce
// authorization themselves.
//
// M2 — Postgres is the sole assignment authority. clinician_patient_access()
// (20261025000001) is TRUE only for an ACTIVE assignment of this clinician
// to this patient in an organization where the clinician holds a
// clinician/clinician_admin membership. Every clinician read and write —
// including the high-consequence ones (prescriptionDraftAuth.ts) — goes
// through this one function; the database functions re-check the active
// assignment inside their own transactions.
//
// Fails CLOSED: any error (including a malformed `patientId` that isn't
// valid UUID syntax — Postgres would otherwise raise a type-cast error)
// is treated as "not supervised," not surfaced as a distinct failure mode.
// This is deliberate — an invalid UUID and a valid-but-unauthorized UUID
// must be externally indistinguishable (never leak whether a UUID belongs
// to a real patient, or to a patient supervised by someone else).
export async function assertSupervises(clinicianId: string, patientId: string): Promise<boolean> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("clinician_patient_access", {
    p_clinician_id: clinicianId,
    p_patient_id: patientId,
  });
  if (error) return false;
  return data === true;
}

export type ClinicianAuthResult =
  | { ok: true; clinicianId: string; role: ClinicianRole }
  | { ok: false; reason: "UNAUTHENTICATED" | "CLINICIAN_ROLE_REQUIRED" };

// C5.3 — API-route variant of requireClinicianAuth(). redirect() is only
// appropriate for page/server-component rendering; a Route Handler must
// return a structured JSON error instead. Same session lookup, same
// allowlist, never a second independently-authored check — just a
// different failure shape for a different caller kind.
export async function requireClinicianAuthForRoute(): Promise<ClinicianAuthResult> {
  const session = await getSessionInfo();
  if (!session.user) return { ok: false, reason: "UNAUTHENTICATED" };

  const role = clinicianRoleOf(session.memberships);
  if (!role) return { ok: false, reason: "CLINICIAN_ROLE_REQUIRED" };

  return { ok: true, clinicianId: session.user.id, role };
}
