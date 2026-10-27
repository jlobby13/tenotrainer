import "server-only";

// C5.6E — trusted server boundary for C5 response submission.
//
//   browser -> /api/patient/c5/check-ins/** -> this module
//           -> c5_submit_*_response (ONE transaction: validate + resolve the
//              obligation [+ record the v1 escalation evaluation])
//           -> reconcile_missing_acute_episodes (its OWN transaction, after
//              the submission committed — a failure here never undoes a
//              submitted fact; the C5 gate fails closed until it succeeds)
//           -> c5_get_start_eligibility (fresh authoritative state)
//
// The patient id is always the authenticated session's (requireC5Patient);
// ownership of the session is enforced inside the RPCs (user filter). The
// only reads here are display reads of the patient's own obligation rows.

import { createServiceRoleClient } from "./supabase/server";
import { getC5TrainingState } from "./c5RuntimeServer";
import type { C5TrainingState } from "./c5RuntimeTypes";
import type { C5CheckIns, C5ImmediateResponseInput, C5MorningResponseInput, C5SubmitResult } from "./c5ResponseTypes";
import { assertMutationAllowed } from "./operatingMode";

type Json = Record<string, unknown>;

function localDate(tz: string | null, at: Date = new Date()): string | null {
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
  } catch {
    return null;
  }
}

// The patient's outstanding C5 obligations, oldest first. Display only:
// whether one BLOCKS training is decided by c5_get_start_eligibility.
export async function getC5CheckIns(patientId: string): Promise<C5CheckIns> {
  const admin = createServiceRoleClient();
  const [{ data: immediates }, { data: mornings }, { data: profile }] = await Promise.all([
    admin
      .from("session_immediate_responses")
      .select("rehab_session_id, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, created_at, rehab_sessions!inner(training_status, patient_local_date, prescription_snapshot)")
      .eq("user_id", patientId)
      .is("resolved_at", null)
      .order("created_at"),
    admin
      .from("morning_responses")
      .select("rehab_session_id, scheduled_eligible_at, reference_local_date, rehab_sessions!inner(training_status, patient_local_date)")
      .eq("user_id", patientId)
      .is("submitted_at", null)
      .not("rehab_sessions.training_status", "is", null)
      .order("scheduled_eligible_at"),
    admin.from("profiles").select("timezone").eq("id", patientId).maybeSingle(),
  ]);
  const now = Date.now();
  const upcoming = (mornings ?? []).find((r) => r.scheduled_eligible_at && new Date(r.scheduled_eligible_at as string).getTime() > now);
  return {
    patientToday: localDate((profile?.timezone as string | null) ?? null),
    patientTimezone: (profile?.timezone as string | null) ?? null,
    upcomingMorning: upcoming ? { dueAt: upcoming.scheduled_eligible_at as string } : null,
    immediate: (immediates ?? []).map((r) => {
      const s = r.rehab_sessions as unknown as Json;
      const workout = ((s.prescription_snapshot as Json | null)?.workout ?? null) as Json | null;
      return {
        sessionId: r.rehab_session_id as string,
        trainingStatus: s.training_status as string,
        sessionLocalDate: s.patient_local_date as string,
        workout: workout ? { label: (workout.label as string | null) ?? null, orderIndex: (workout.order_index as number) ?? 0 } : null,
        // Only TRUE facts are pre-recorded (reported at Stop); they are fixed.
        recordedSafety: {
          sudden_or_sharp_pain: r.sudden_or_sharp_pain === true,
          pop_felt_or_heard: r.pop_felt_or_heard === true,
          new_functional_difficulty: r.new_functional_difficulty === true,
        },
      };
    }),
    mornings: (mornings ?? [])
      .filter((r) => r.scheduled_eligible_at && new Date(r.scheduled_eligible_at as string).getTime() <= now)
      .map((r) => ({
        sessionId: r.rehab_session_id as string,
        dueAt: r.scheduled_eligible_at as string,
        referenceLocalDate: r.reference_local_date as string,
        sessionLocalDate: (r.rehab_sessions as unknown as Json).patient_local_date as string,
      })),
  };
}

const IMMEDIATE_KEYS = [
  "peak_session_pain",
  "peak_pain_unable_to_recall",
  "overall_session_rpe",
  "rpe_unable_to_recall",
  "sudden_or_sharp_pain",
  "pop_felt_or_heard",
  "new_functional_difficulty",
] as const;
const MORNING_KEYS = ["resolution", "next_morning_pain", "next_morning_stiffness", "stiffness_duration", "patient_note"] as const;

// Shape-only: keeps known keys; the RPC validates every value.
function pick(raw: unknown, keys: readonly string[]): Json | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Json;
  const out: Json = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}
export const sanitizeImmediate = (raw: unknown) => pick(raw, IMMEDIATE_KEYS) as C5ImmediateResponseInput | null;
export const sanitizeMorning = (raw: unknown) => pick(raw, MORNING_KEYS) as C5MorningResponseInput | null;

async function submit(patientId: string, rpc: string, sessionId: string, response: Json): Promise<C5SubmitResult> {
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc(rpc, { p_patient_id: patientId, p_session_id: sessionId, p_response: response });
  if (error) throw new Error(`${rpc} failed: ${error.message}`);
  const r = (data ?? {}) as Json;
  // Committed (or refused) above. Reconciliation + the fresh state read run
  // afterwards, each in its own transaction (getC5TrainingState reconciles
  // first and reports a failed safety check as an unavailable state).
  const state: C5TrainingState = await getC5TrainingState(patientId);
  return {
    result: r.result as string,
    detail: (r.detail as string | undefined) ?? undefined,
    item: (r.item as string | undefined) ?? undefined,
    replayed: (r.replayed as boolean | undefined) ?? undefined,
    state,
    checkIns: await getC5CheckIns(patientId),
  };
}

export function submitImmediateResponse(patientId: string, sessionId: string, response: C5ImmediateResponseInput) {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  return submit(patientId, "c5_submit_immediate_response", sessionId, response as Json);
}

export function submitMorningResponse(patientId: string, sessionId: string, response: C5MorningResponseInput) {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  return submit(patientId, "c5_submit_morning_response", sessionId, response as Json);
}
