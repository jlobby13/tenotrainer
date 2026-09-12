// Milestone 6, Stage 3B — coverage. Pure functions only.
//
// FOUNDER DECISION: formal session-completion coverage and complete-response
// coverage (brief section 10) are NOT computed or persisted in Stage 3B.
// An earlier pass here used an interim proxy denominator (distinct attempted
// + safety-blocked prescription_instance_ids) — the founder rejected that
// proxy: it cannot detect a prescribed opportunity that was never attempted
// and left no trace at all (no session, no safety block), so it would
// systematically OVERSTATE coverage. That entire ratio-producing code path
// has been removed, not just hidden, so nothing downstream can accidentally
// consume it as real coverage.
//
// What this module does instead: expose the LOCKED distinction (session
// completion vs. complete-response, never collapsed) as an explicit
// "not_computable" status, plus the raw, non-misleading counts needed to
// reconstruct authoritative coverage once a real "eligible prescribed
// loading opportunities" denominator exists (see rehabSchedule.ts's own
// header note on why that denominator can't be derived yet —
// rehab_days_of_week is null for every real patient today). No calendar-day
// denominator is invented as a substitute; no new proxy is introduced here.
export const FORMAL_COVERAGE_UNAVAILABLE_REASON =
  "No authoritative 'eligible prescribed loading opportunities' denominator exists yet (rehab_days_of_week is null for every current patient, and no other opportunity-reconstruction primitive has been approved). Formal session-completion and complete-response coverage are deferred until that denominator is defined — see docs/m6-stage3b-symptom-engine.md.";

export type CoverageContext = {
  sessionCompletionCoverage: "not_computable";
  completeResponseCoverage: "not_computable";
  reason: string;
  // Raw, purely descriptive facts — NOT a ratio, NOT "coverage". Preserved
  // so a future authoritative-denominator pass doesn't have to re-derive
  // them from scratch. Never surfaced to a patient or clinician as-is.
  rawCounts: {
    attemptedSessionCount: number;
    completedSessionCount: number;
    completeResponseEpisodeCount: number;
    safetyBlockedOnlyCount: number;
  };
};

export function buildCoverageContext(params: {
  // Every prescription_instance_id that produced a rehab_sessions row in the
  // span, regardless of outcome. Deduplicated defensively (rehab_sessions_
  // one_per_prescription_instance already guarantees no real duplicates —
  // see the M3 migration — so this dedup is a safety net, not a correction).
  attemptedPrescriptionInstanceIds: string[];
  // The subset of the above where the session's exercise_outcome === 'completed'.
  completedPrescriptionInstanceIds: string[];
  // prescription_instance_ids blocked by an acute-safety hold that never
  // produced a rehab_sessions row at all — a legitimate clinical hold, kept
  // as its own descriptive count, never folded into a noncompletion tally.
  blockedOnlyPrescriptionInstanceIds: string[];
  // Count of eligibleForSymptomAnalysis response episodes within the same span.
  completeResponseEpisodeCount: number;
}): CoverageContext {
  const attempted = new Set(params.attemptedPrescriptionInstanceIds);
  const completed = new Set(params.completedPrescriptionInstanceIds);
  const blockedOnly = new Set([...params.blockedOnlyPrescriptionInstanceIds].filter((id) => !attempted.has(id)));

  return {
    sessionCompletionCoverage: "not_computable",
    completeResponseCoverage: "not_computable",
    reason: FORMAL_COVERAGE_UNAVAILABLE_REASON,
    rawCounts: {
      attemptedSessionCount: attempted.size,
      completedSessionCount: completed.size,
      completeResponseEpisodeCount: params.completeResponseEpisodeCount,
      safetyBlockedOnlyCount: blockedOnly.size,
    },
  };
}
