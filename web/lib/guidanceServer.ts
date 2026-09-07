import "server-only";

// Milestone 5, Stage 1 — server-only data access for derived guidance.
// This is the natural existing domain layer identified in the M5
// pre-Stage-1 inspection (alongside morningResponseServer.ts, which owns
// the morning-response obligation lifecycle) — this module owns the
// separate concern of deriving "what guidance is currently relevant" from
// already-persisted rows. It never persists its own output; see guidance.ts
// for why (a mutable current_guidance record was explicitly rejected).
//
// tolerance_evaluations has no direct user_id column (see the M5
// pre-Stage-1 inspection, Q3) — every "all of this patient's evaluations"
// lookup below goes through rehab_sessions.id first, then
// `.in("rehab_session_id", sessionIds)`, matching the manual-join style
// already used elsewhere in this codebase (e.g. escalation_evaluations
// reads) rather than a PostgREST embedded-resource filter.

import { createServiceRoleClient } from "./supabase/server";
import { mapToleranceEvaluationRow, type ToleranceEvaluationRecord } from "./morningResponseTypes";
import type { PrescriptionVersionSource } from "./prescriptionVersionTypes";
import type { SessionStatus } from "./rehabSessionTypes";
import { deriveGuidance, pickLatestEvaluation, type RelevantGuidance } from "./guidance";

type SupabaseServiceClient = ReturnType<typeof createServiceRoleClient>;

type PatientFacts = {
  sessionRows: { id: string; started_at: string; status: SessionStatus; prescription_version_id: string | null }[];
  evaluationRefs: { id: string; evaluated_at: string }[];
  versionRefs: { id: string; created_at: string; source: PrescriptionVersionSource }[];
};

// Every rehab_sessions row, every tolerance_evaluations (id, evaluated_at)
// pair, and every prescription_versions (id, created_at, source) for one
// patient — three independent facts, fetched once per call, fed into the
// pure deriveGuidance() function. Both entry points below share this so a
// patient-level lookup never fetches these twice.
async function getPatientFacts(supabase: SupabaseServiceClient, userId: string): Promise<PatientFacts> {
  const { data: sessionRows, error: sessionsError } = await supabase
    .from("rehab_sessions")
    .select("id, started_at, status, prescription_version_id")
    .eq("user_id", userId);
  if (sessionsError) throw new Error(`getPatientFacts: ${sessionsError.message}`);

  const sessionIds = (sessionRows ?? []).map((r) => r.id as string);

  const [{ data: evaluationRefs, error: evalError }, { data: versionRows, error: versionsError }] = await Promise.all([
    sessionIds.length > 0
      ? supabase.from("tolerance_evaluations").select("id, evaluated_at").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("prescription_versions").select("id, created_at, source").eq("user_id", userId),
  ]);
  if (evalError) throw new Error(`getPatientFacts: ${evalError.message}`);
  if (versionsError) throw new Error(`getPatientFacts: ${versionsError.message}`);

  return {
    sessionRows: (sessionRows ?? []) as PatientFacts["sessionRows"],
    evaluationRefs: (evaluationRefs ?? []) as PatientFacts["evaluationRefs"],
    versionRefs: (versionRows ?? []) as PatientFacts["versionRefs"],
  };
}

function toGuidance(
  evaluation: ToleranceEvaluationRecord,
  sourceSession: { id: string; startedAt: string; prescriptionVersionId: string | null },
  facts: PatientFacts
): RelevantGuidance {
  return deriveGuidance({
    evaluation: {
      id: evaluation.id,
      rehabSessionId: evaluation.rehabSessionId,
      toleranceClassification: evaluation.toleranceClassification,
      immediateGuidance: evaluation.immediateGuidance,
      reasonCodes: evaluation.reasonCodes,
      evaluatedAt: evaluation.evaluatedAt,
      ruleVersion: evaluation.ruleVersion,
    },
    sourceSession,
    allPatientEvaluations: facts.evaluationRefs.map((r) => ({ id: r.id, evaluatedAt: r.evaluated_at })),
    patientPrescriptionVersions: facts.versionRefs.map((r) => ({ id: r.id, createdAt: r.created_at, source: r.source })),
    candidateSubsequentSessions: facts.sessionRows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      status: r.status,
      prescriptionVersionId: r.prescription_version_id,
    })),
  });
}

// Returns the derived guidance for one specific tolerance evaluation,
// regardless of whether it's the patient's latest. Exists separately from
// getRelevantGuidanceForPatient so a historical evaluation can be inspected
// on its own terms (e.g. "was THIS one superseded/addressed") without
// re-deriving "what's current" — useful for tests and any future audit view.
export async function getGuidanceForEvaluation(evaluationId: string): Promise<RelevantGuidance | null> {
  const supabase = createServiceRoleClient();

  const { data: evaluationRow, error: evalError } = await supabase
    .from("tolerance_evaluations")
    .select()
    .eq("id", evaluationId)
    .maybeSingle();
  if (evalError) throw new Error(`getGuidanceForEvaluation: ${evalError.message}`);
  if (!evaluationRow) return null;

  const { data: sourceSessionRow, error: sessionError } = await supabase
    .from("rehab_sessions")
    .select("id, user_id, started_at, prescription_version_id")
    .eq("id", evaluationRow.rehab_session_id)
    .maybeSingle();
  if (sessionError || !sourceSessionRow) {
    throw new Error(`getGuidanceForEvaluation: source rehab_session not found for evaluation ${evaluationId}`);
  }

  const facts = await getPatientFacts(supabase, sourceSessionRow.user_id as string);

  return toGuidance(
    mapToleranceEvaluationRow(evaluationRow),
    {
      id: sourceSessionRow.id as string,
      startedAt: sourceSessionRow.started_at as string,
      prescriptionVersionId: (sourceSessionRow.prescription_version_id as string | null) ?? null,
    },
    facts
  );
}

// The patient-facing entry point named in the M5 Stage 1 spec. Finds the
// patient's latest tolerance evaluation (by evaluated_at — never by
// rule_version comparison) and derives guidance for it. Returns null when
// the patient has no tolerance evaluation at all yet (nothing to derive —
// this is not an error, and nothing is fabricated in its place).
export async function getRelevantGuidanceForPatient(userId: string): Promise<RelevantGuidance | null> {
  const supabase = createServiceRoleClient();

  const facts = await getPatientFacts(supabase, userId);
  const latest = pickLatestEvaluation(facts.evaluationRefs.map((r) => ({ id: r.id, evaluatedAt: r.evaluated_at })));
  if (!latest) return null;

  const { data: evaluationRow, error: evalError } = await supabase
    .from("tolerance_evaluations")
    .select()
    .eq("id", latest.id)
    .maybeSingle();
  if (evalError || !evaluationRow) {
    throw new Error(`getRelevantGuidanceForPatient: latest evaluation ${latest.id} not found on re-fetch`);
  }

  const sourceSession = facts.sessionRows.find((s) => s.id === evaluationRow.rehab_session_id);
  if (!sourceSession) {
    throw new Error(`getRelevantGuidanceForPatient: source session ${evaluationRow.rehab_session_id} not found among patient's sessions`);
  }

  return toGuidance(
    mapToleranceEvaluationRow(evaluationRow),
    {
      id: sourceSession.id,
      startedAt: sourceSession.started_at,
      prescriptionVersionId: sourceSession.prescription_version_id,
    },
    facts
  );
}
