import "server-only";

// C1A — Clinician Foundation server composition layer. Every function here
// assumes authorization has ALREADY happened (requireClinicianAuth() +,
// for a specific patient, assertSupervises() — see lib/clinicianAuth.ts).
// Nothing in this file performs its own authorization check; it composes
// already-existing, generically patient-id-parameterized server helpers
// (which themselves use the service-role client and enforce nothing) into
// clinician-shaped view models. This split keeps the authorization
// boundary in exactly one place (clinicianAuth.ts) and testable in
// isolation from data composition.
//
// C1A scope only: roster identity + a restrained patient shell. Rich
// factual/interpretation data (Progress, Symptoms, Capacity, Training
// Response) is explicitly deferred to a later phase — see the C1A brief's
// "no full C1 dashboard redesign" boundary. Do not extend this file with
// M6 reads yet.

import { createServiceRoleClient } from "./supabase/server";
import { getLatestPrescriptionVersion } from "./prescriptionVersionsServer";

export type ClinicianRosterEntry = {
  patientId: string;
  displayName: string;
};

// The roster IS the active-supervision predicate, applied as a query
// filter rather than a per-row check — a dismissed relationship's patient
// is absent from this result by construction, never filtered out
// afterward. A legacy relationship that was never migrated (see the C1A.1
// dry run's UNRESOLVABLE rows) is likewise simply absent — there is
// nothing to filter, because no such row exists in Postgres at all.
export async function getClinicianRoster(clinicianId: string): Promise<ClinicianRosterEntry[]> {
  const supabase = createServiceRoleClient();
  const { data: relationships, error } = await supabase
    .from("supervisor_patients")
    .select("patient_id")
    .eq("supervisor_id", clinicianId)
    .eq("status", "active");
  if (error) throw new Error(`getClinicianRoster failed: ${error.message}`);

  const patientIds = (relationships ?? []).map((r) => r.patient_id as string);
  if (patientIds.length === 0) return [];

  const { data: profiles, error: profilesError } = await supabase.from("profiles").select("id, name").in("id", patientIds);
  if (profilesError) throw new Error(`getClinicianRoster failed: ${profilesError.message}`);

  return (profiles ?? []).map((p) => ({ patientId: p.id as string, displayName: p.name as string }));
}

export type ClinicianPatientShell = {
  patientId: string;
  displayName: string;
  currentStage: number | null;
  currentIrritability: string | null;
};

// C1A's restrained patient-detail read: identity + current plan-state only
// (reuses getLatestPrescriptionVersion(userId) — an existing, generically
// patient-id-parameterized helper, exactly the kind the C1 Foundation audit
// flagged as safe to reuse ONLY after authorization has already happened,
// which is guaranteed here since the caller must have already passed
// assertSupervises() before calling this function at all — see
// app/clinician/patients/[id]/page.tsx). Returns null when the patient
// identity itself can't be resolved (should not normally happen once
// assertSupervises() has already succeeded, since that query also requires
// a real patient_id — defensive only).
export async function getClinicianPatientShell(patientId: string): Promise<ClinicianPatientShell | null> {
  const supabase = createServiceRoleClient();
  const { data: profile, error } = await supabase.from("profiles").select("id, name").eq("id", patientId).maybeSingle();
  if (error) throw new Error(`getClinicianPatientShell failed: ${error.message}`);
  if (!profile) return null;

  const latestVersion = await getLatestPrescriptionVersion(patientId);

  return {
    patientId: profile.id as string,
    displayName: profile.name as string,
    currentStage: latestVersion?.stage ?? null,
    currentIrritability: latestVersion?.irritability ?? null,
  };
}
