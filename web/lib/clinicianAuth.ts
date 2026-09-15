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
// ALSO a clinician/clinician_admin via a separate membership role gets in
// because of THAT role, not because of super_user status; today's role
// model only carries one role per (user, org) membership row, and
// `getSessionInfo()` surfaces only the first membership — so a super_user
// cannot currently ALSO present as clinician in the same request. That is
// the exact "future permission-model question" flagged for the founder
// (see the C1A report) rather than silently worked around here.
const CLINICIAN_ROLES: ReadonlySet<string> = new Set<ClinicianRole>(["clinician", "clinician_admin"]);

// Redirects (never throws) — every clinician route calls this first, before
// touching any patient data. Unauthenticated -> /login. Authenticated but
// not an allowed clinician role -> /dashboard (the same role-router every
// other part of the app redirects an out-of-place role to).
export async function requireClinicianAuth(): Promise<ClinicianAuth> {
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");

  const role = session.memberships[0]?.role;
  if (!role || !CLINICIAN_ROLES.has(role)) redirect("/dashboard");

  return { clinicianId: session.user.id, role: role as ClinicianRole };
}

// LOCKED canonical active-supervision predicate — the ONLY thing that
// grants clinical patient access. Never inferred from shared organization
// membership. Uses the service-role client because this is the actual
// authorization boundary itself, not a redundant check layered on top of
// RLS — see clinicianServer.ts's header note on why patient-data reads
// happen only after this call succeeds, using helpers that do not enforce
// authorization themselves.
//
// Fails CLOSED: any error (including a malformed `patientId` that isn't
// valid UUID syntax — Postgres would otherwise raise a type-cast error)
// is treated as "not supervised," not surfaced as a distinct failure mode.
// This is deliberate — an invalid UUID and a valid-but-unauthorized UUID
// must be externally indistinguishable (never leak whether a UUID belongs
// to a real patient, or to a patient supervised by someone else).
export async function assertSupervises(clinicianId: string, patientId: string): Promise<boolean> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("supervisor_patients")
    .select("id")
    .eq("supervisor_id", clinicianId)
    .eq("patient_id", patientId)
    .eq("status", "active")
    .maybeSingle();
  if (error) return false;
  return data != null;
}
