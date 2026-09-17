import "server-only";

// C1A/C1B — Clinician Foundation server composition layer. Every function
// here assumes authorization has ALREADY happened (requireClinicianAuth()
// +, for a specific patient, assertSupervises() — see lib/clinicianAuth.ts).
// Nothing in this file performs its own authorization check; it composes
// already-existing, generically patient-id-parameterized server helpers
// (which themselves use the service-role client and enforce nothing) into
// clinician-shaped view models. This split keeps the authorization
// boundary in exactly one place (clinicianAuth.ts) and testable in
// isolation from data composition.
//
// C1B scope: roster identity + factual roster facts (last session, 14-day
// recent-activity count, prescription stage, acute-safety review flag,
// morning-response due/pending badge). Deliberately NOT an adherence
// metric, composite risk/attention score, or M6 interpretation — see
// clinicianRoster.ts's header for the locked founder decisions this
// composes. Rich M6 interpretation data (Progress, Symptoms, Capacity,
// Training Response) remains deferred to a later phase on the patient
// detail route — do not extend THIS roster composition with M6 reads.

import { createServiceRoleClient } from "./supabase/server";
import { getLatestPrescriptionVersion } from "./prescriptionVersionsServer";
import { getActiveBrakeStatus } from "./acuteSafetyServer";
import { compareRosterEntries, deriveMorningResponseBadge, type RosterMorningResponseStatus } from "./clinicianRoster";

const RECENT_ACTIVITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ClinicianRosterEntry = {
  patientId: string;
  displayName: string;
  // Latest native prescription_versions.stage, or null when the patient has
  // no prescription_versions row at all — see
  // clinicianRoster.ts's formatStageLabel ("No current prescription", never
  // "Stage 0").
  currentStage: number | null;
  // Most recent QUALIFYING session's rehab_sessions.started_at (the
  // existing authoritative session timestamp — see
  // idx_rehab_sessions_user_started and every other M6 longitudinal module's
  // own ordering), or null when no qualifying session has ever occurred.
  // Qualifying = exercise_outcome IS NOT NULL, per the founder's locked
  // definition — deliberately NOT response_complete (legitimate recent
  // rehab may still be awaiting its morning response) and NOT a bare
  // in_progress session with no exercise outcome yet.
  lastSessionAt: string | null;
  // Count of qualifying sessions (same definition as lastSessionAt) with
  // started_at within the last 14 days. A factual count only — see
  // clinicianRoster.ts's formatRecentActivityLabel for why this is never
  // labeled adherence/compliance/consistency/participation/activity score.
  recentSessionCount: number;
  // True iff get_patient_acute_brake_status() (the existing canonical
  // acute-safety RPC — this module reuses it verbatim rather than
  // reimplementing escalation logic) returns an active unreleased episode.
  acuteReviewActive: boolean;
  // due/pending/null — see clinicianRoster.ts's deriveMorningResponseBadge
  // for the exact locked rules (UNKNOWN != ZERO; no "overdue" concept).
  morningResponseStatus: RosterMorningResponseStatus;
};

// The roster IS the active-supervision predicate, applied as a query
// filter rather than a per-row check — a dismissed relationship's patient
// is absent from this result by construction, never filtered out
// afterward. A legacy relationship that was never migrated (see the C1A.1
// dry run's UNRESOLVABLE rows) is likewise simply absent — there is
// nothing to filter, because no such row exists in Postgres at all.
//
// Query architecture (Option A, per the C1B audit): one relationships
// query establishes the authorized patient-id set, then every roster fact
// is composed with batched `.in(...)` queries against exactly that set —
// never per-patient round trips, except the acute-safety RPC (Section 5 of
// the founder brief explicitly permits parallel per-patient calls there,
// reusing the existing canonical helper rather than a new batch RPC).
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

  const [profilesRes, prescriptionRes, sessionsRes, awaitingRes] = await Promise.all([
    supabase.from("profiles").select("id, name").in("id", patientIds),
    supabase
      .from("prescription_versions")
      .select("user_id, stage, created_at")
      .in("user_id", patientIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("rehab_sessions")
      .select("user_id, started_at")
      .in("user_id", patientIds)
      .not("exercise_outcome", "is", null)
      .order("started_at", { ascending: false }),
    supabase.from("rehab_sessions").select("id, user_id").in("user_id", patientIds).eq("status", "awaiting_morning_response"),
  ]);
  if (profilesRes.error) throw new Error(`getClinicianRoster failed: ${profilesRes.error.message}`);
  if (prescriptionRes.error) throw new Error(`getClinicianRoster failed: ${prescriptionRes.error.message}`);
  if (sessionsRes.error) throw new Error(`getClinicianRoster failed: ${sessionsRes.error.message}`);
  if (awaitingRes.error) throw new Error(`getClinicianRoster failed: ${awaitingRes.error.message}`);

  // Latest prescription_versions row per patient — first row wins because
  // the query is already ordered created_at DESC (same "no is_current
  // flag, this IS the derivation" convention as
  // getLatestPrescriptionVersion).
  const stageByPatient = new Map<string, number>();
  for (const row of prescriptionRes.data ?? []) {
    const patientId = row.user_id as string;
    if (!stageByPatient.has(patientId)) stageByPatient.set(patientId, row.stage as number);
  }

  // Last qualifying session + 14-day count per patient, in one pass over
  // the already-started_at-DESC-ordered qualifying-session rows.
  const now = new Date();
  const recentCutoffMs = now.getTime() - RECENT_ACTIVITY_WINDOW_MS;
  const lastSessionByPatient = new Map<string, string>();
  const recentCountByPatient = new Map<string, number>();
  for (const row of sessionsRes.data ?? []) {
    const patientId = row.user_id as string;
    const startedAt = row.started_at as string;
    if (!lastSessionByPatient.has(patientId)) lastSessionByPatient.set(patientId, startedAt);
    if (new Date(startedAt).getTime() >= recentCutoffMs) {
      recentCountByPatient.set(patientId, (recentCountByPatient.get(patientId) ?? 0) + 1);
    }
  }

  // Outstanding morning-response obligations per patient. A session with
  // status='awaiting_morning_response' but no morning_responses row yet
  // (never backfilled by ensureMorningResponseExists, which this read-only
  // roster deliberately never calls — no write side effect belongs on a
  // dashboard read) is treated as scheduledEligibleAt=null: eligibility is
  // genuinely unknown, same as an existing row whose column is null.
  const awaitingSessions = awaitingRes.data ?? [];
  const awaitingSessionIds = awaitingSessions.map((s) => s.id as string);
  const morningRes = awaitingSessionIds.length
    ? await supabase
        .from("morning_responses")
        .select("rehab_session_id, scheduled_eligible_at, submitted_at")
        .in("rehab_session_id", awaitingSessionIds)
    : { data: [] as { rehab_session_id: string; scheduled_eligible_at: string | null; submitted_at: string | null }[], error: null };
  if (morningRes.error) throw new Error(`getClinicianRoster failed: ${morningRes.error.message}`);

  const morningRowBySessionId = new Map((morningRes.data ?? []).map((r) => [r.rehab_session_id as string, r]));
  const outstandingByPatient = new Map<string, { scheduledEligibleAt: string | null }[]>();
  for (const session of awaitingSessions) {
    const patientId = session.user_id as string;
    const morningRow = morningRowBySessionId.get(session.id as string);
    // Defensive only: status=awaiting_morning_response already implies not
    // yet submitted, but never treat an actually-submitted row as still
    // outstanding if this ever raced with a submission mid-query.
    if (morningRow && morningRow.submitted_at !== null) continue;
    const list = outstandingByPatient.get(patientId) ?? [];
    list.push({ scheduledEligibleAt: morningRow?.scheduled_eligible_at ?? null });
    outstandingByPatient.set(patientId, list);
  }

  // Acute-safety status — reuses the existing canonical RPC verbatim
  // (getActiveBrakeStatus -> get_patient_acute_brake_status()), one
  // parallel call per patient. Explicitly permitted by the founder brief
  // rather than introducing a new batch RPC/migration for C1B.
  const acuteEntries = await Promise.all(patientIds.map(async (patientId) => [patientId, await getActiveBrakeStatus(patientId)] as const));
  const acuteByPatient = new Map(acuteEntries);

  const entries: ClinicianRosterEntry[] = (profilesRes.data ?? []).map((profile) => {
    const patientId = profile.id as string;
    return {
      patientId,
      displayName: profile.name as string,
      currentStage: stageByPatient.get(patientId) ?? null,
      lastSessionAt: lastSessionByPatient.get(patientId) ?? null,
      recentSessionCount: recentCountByPatient.get(patientId) ?? 0,
      acuteReviewActive: acuteByPatient.get(patientId) != null,
      morningResponseStatus: deriveMorningResponseBadge(outstandingByPatient.get(patientId) ?? [], now),
    };
  });

  // LOCKED sort: alphabetical by display name only — never by any clinical
  // signal above, no matter how attention-worthy it looks.
  return entries.sort(compareRosterEntries);
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
