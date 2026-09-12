import "server-only";

// Milestone 6, Stage 3A — server-only read access for persisted longitudinal
// interpretations. READ-ONLY by design: no inference engine exists yet
// (Stage 3B+), so this module deliberately exposes no write/create function
// at all — there is nothing for one to call. When that engine is built, its
// writes go through the service-role client directly (or a SECURITY DEFINER
// RPC, if a future stage needs the same "derive everything server-side,
// accept nothing from the caller" shape as capture_session_guidance_context()
// in 20260910000001_m5_stage3_session_guidance_contexts.sql) — this module
// is not the place that decision gets made.
//
// m6_longitudinal_interpretations and every provenance/reason-code table it
// joins have no permissive INSERT/UPDATE/DELETE policy for `authenticated`
// at all (RLS default-denies it, REVOKE as defense in depth) — identical
// trust tier to escalation_evaluations/tolerance_evaluations/
// prescription_versions. This module uses the service-role client for
// reads for the same reason todaysRehabFeedbackServer.ts and
// prescriptionVersionsServer.ts do: the calling page/route has already
// authenticated and resolved which patient's data is being requested, so a
// second RLS-filtered round trip would be redundant, not safer.

import { createServiceRoleClient } from "./supabase/server";
import {
  mapLongitudinalInterpretationRow,
  type LongitudinalInterpretationRecord,
  type InterpretationProvenance,
  type InterpretationReasonCode,
} from "./longitudinalInterpretationTypes";

// 1. Fetch a single persisted interpretation by id.
export async function getLongitudinalInterpretationById(
  interpretationId: string
): Promise<LongitudinalInterpretationRecord | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("m6_longitudinal_interpretations")
    .select()
    .eq("id", interpretationId)
    .maybeSingle();
  if (error) throw new Error(`getLongitudinalInterpretationById failed: ${error.message}`);
  return data ? mapLongitudinalInterpretationRow(data) : null;
}

// 2. List a patient's persisted interpretations, most recent first.
// `domain` narrows to one interpretation domain when given (see
// longitudinalInterpretationTypes.ts's header note on why this is a plain
// string, not a locked union). Unfiltered by default — callers needing only
// the "current" interpretation for a domain should take result[0] after
// filtering by domain, mirroring prescription_versions' own
// "current = latest row by created_at, no is_current flag" derivation.
export async function listLongitudinalInterpretationsForPatient(
  userId: string,
  params?: { domain?: string; limit?: number }
): Promise<LongitudinalInterpretationRecord[]> {
  const supabase = createServiceRoleClient();
  let query = supabase
    .from("m6_longitudinal_interpretations")
    .select()
    .eq("user_id", userId)
    .order("generated_at", { ascending: false });
  if (params?.domain) query = query.eq("domain", params.domain);
  if (params?.limit) query = query.limit(params.limit);
  const { data, error } = await query;
  if (error) throw new Error(`listLongitudinalInterpretationsForPatient failed: ${error.message}`);
  return (data ?? []).map(mapLongitudinalInterpretationRow);
}

// 3. Full provenance for one interpretation — reason codes plus every
// linked source-observation id, assembled from the five normalized join
// tables (see the migration's "Provenance" section for why these are
// separate typed tables rather than one polymorphic blob).
export async function getInterpretationProvenance(interpretationId: string): Promise<InterpretationProvenance> {
  const supabase = createServiceRoleClient();

  const [reasonCodesRes, sessionsRes, morningRes, toleranceRes, prescriptionRes, heuristicsRes] = await Promise.all([
    supabase.from("m6_interpretation_reason_codes").select("reason_code").eq("interpretation_id", interpretationId),
    supabase.from("m6_interpretation_rehab_sessions").select("rehab_session_id").eq("interpretation_id", interpretationId),
    supabase.from("m6_interpretation_morning_responses").select("morning_response_id").eq("interpretation_id", interpretationId),
    supabase.from("m6_interpretation_tolerance_evaluations").select("tolerance_evaluation_id").eq("interpretation_id", interpretationId),
    supabase.from("m6_interpretation_prescription_versions").select("prescription_version_id").eq("interpretation_id", interpretationId),
    supabase.from("m6_interpretation_heuristics").select("heuristic_id").eq("interpretation_id", interpretationId),
  ]);
  for (const res of [reasonCodesRes, sessionsRes, morningRes, toleranceRes, prescriptionRes, heuristicsRes]) {
    if (res.error) throw new Error(`getInterpretationProvenance failed: ${res.error.message}`);
  }

  return {
    interpretationId,
    reasonCodes: (reasonCodesRes.data ?? []).map((r) => r.reason_code as InterpretationReasonCode),
    rehabSessionIds: (sessionsRes.data ?? []).map((r) => r.rehab_session_id as string),
    morningResponseIds: (morningRes.data ?? []).map((r) => r.morning_response_id as string),
    toleranceEvaluationIds: (toleranceRes.data ?? []).map((r) => r.tolerance_evaluation_id as string),
    prescriptionVersionIds: (prescriptionRes.data ?? []).map((r) => r.prescription_version_id as string),
    heuristicIds: (heuristicsRes.data ?? []).map((r) => r.heuristic_id as string),
  };
}
