// Milestone 6, Stage 3B — pure response-episode construction/eligibility.
// No I/O: takes already-fetched raw rows and returns ResponseEpisode
// objects. Mirrors progressCompare.ts's "pure comparison logic, no server-
// only import" convention.
//
// LOCKED (Stage 3B brief section 1): the atomic eligible longitudinal unit
// is "completed rehab session + actual performance + completed M4
// next-morning response + persisted tolerance evaluation." A raw session
// that doesn't satisfy ALL FOUR of those never becomes a ResponseEpisode at
// all — it is simply excluded upstream (see isBaseResponseEpisode). This is
// distinct from `eligibleForSymptomAnalysis`, which further requires P/MP/MS
// (and MSD when MS>0) to actually be present.
//
// UNKNOWN != ZERO: MS = 0 with stiffness_duration = 'not_applicable' is a
// legitimate, COMPLETE episode. MS > 0 with a null stiffness_duration is
// INCOMPLETE for symptom analysis — the episode exists, but is excluded from
// 5+5 window membership. Never coerce either case into the other.

import type { StiffnessDuration } from "./morningResponseTypes";
import type { ExternalLoadObservation, ResponseEpisode, SymptomIneligibilityReason } from "./responseEpisodeTypes";

export type RawResponseEpisodeInput = {
  rehabSessionId: string;
  userId: string;
  patientLocalDate: string;
  prescriptionVersionId: string | null;
  prescriptionInstanceId: string;
  sessionStatus: string;
  // Actual performance — at least one set_outcomes row is required for the
  // base episode to exist (see isBaseResponseEpisode). The rows themselves
  // aren't retained on the episode: they're already traceable via
  // rehab_session_id, and Stage 3A has no dedicated provenance join table
  // for them (only rehab_sessions/morning_responses/tolerance_evaluations/
  // prescription_versions/heuristics — see the Stage 3A migration).
  hasSetOutcomes: boolean;

  morningResponseId: string | null;
  morningResponseSubmittedAt: string | null;
  nextMorningPain: number | null;
  nextMorningStiffness: number | null;
  stiffnessDuration: StiffnessDuration | null;

  toleranceEvaluationId: string | null;

  peakSessionPain: number | null;

  externalLoadObservations: ExternalLoadObservation[];
  hasAcuteSafetyContext: boolean;
};

// The base gate: is this even a response episode at all? All four
// conditions from the locked definition, checked independently (never
// inferred solely from rehab_sessions.status, since that value is this
// codebase's summary flag, not itself the source of truth for each
// sub-condition).
export function isBaseResponseEpisode(raw: RawResponseEpisodeInput): boolean {
  const completedSession = raw.sessionStatus === "response_complete";
  const hasActualPerformance = raw.hasSetOutcomes;
  const hasFinalizedMorningResponse = raw.morningResponseId != null && raw.morningResponseSubmittedAt != null;
  const hasToleranceEvaluation = raw.toleranceEvaluationId != null;
  return completedSession && hasActualPerformance && hasFinalizedMorningResponse && hasToleranceEvaluation;
}

function computeSymptomEligibility(raw: RawResponseEpisodeInput): {
  eligible: boolean;
  reasons: SymptomIneligibilityReason[];
} {
  const reasons: SymptomIneligibilityReason[] = [];
  if (raw.peakSessionPain == null) reasons.push("missing_peak_session_pain");
  if (raw.nextMorningPain == null) reasons.push("missing_next_morning_pain");
  if (raw.nextMorningStiffness == null) {
    reasons.push("missing_next_morning_stiffness");
  } else if (raw.nextMorningStiffness > 0 && raw.stiffnessDuration == null) {
    // MS > 0 and MSD unknown: incomplete for formal symptom analysis. MS ===
    // 0 with stiffnessDuration === null is NOT flagged here on purpose — a
    // legitimate 'not_applicable' value is expected in that case, but its
    // absence doesn't independently disqualify the episode the way a
    // missing duration for a real (>0) stiffness report does.
    reasons.push("missing_stiffness_duration_with_nonzero_stiffness");
  }
  return { eligible: reasons.length === 0, reasons };
}

// Only call this for raw rows that pass isBaseResponseEpisode — this
// function does not re-check the base gate.
export function buildResponseEpisode(raw: RawResponseEpisodeInput): ResponseEpisode {
  const { eligible, reasons } = computeSymptomEligibility(raw);
  return {
    rehabSessionId: raw.rehabSessionId,
    userId: raw.userId,
    patientLocalDate: raw.patientLocalDate,
    prescriptionVersionId: raw.prescriptionVersionId,
    prescriptionInstanceId: raw.prescriptionInstanceId,
    morningResponseId: raw.morningResponseId as string,
    toleranceEvaluationId: raw.toleranceEvaluationId,
    peakSessionPain: raw.peakSessionPain,
    nextMorningPain: raw.nextMorningPain,
    nextMorningStiffness: raw.nextMorningStiffness,
    stiffnessDuration: raw.stiffnessDuration,
    externalLoadObservations: raw.externalLoadObservations,
    hasAcuteSafetyContext: raw.hasAcuteSafetyContext,
    eligibleForSymptomAnalysis: eligible,
    symptomIneligibilityReasons: reasons,
  };
}

// Builds every ResponseEpisode from a list of raw rows (already ordered by
// the caller). Rows that don't satisfy the base gate are silently excluded
// — they were never response episodes, not incomplete ones.
export function buildResponseEpisodes(rawRows: RawResponseEpisodeInput[]): ResponseEpisode[] {
  return rawRows.filter(isBaseResponseEpisode).map(buildResponseEpisode);
}

// The 5+5 window's required episode count per side — LOCKED (Stage 3B
// brief section 2). Not calendar days; ten eligible COMPLETE response
// episodes are required for the full classifier, and only eligible
// episodes may occupy a window slot.
export const SHORT_WINDOW_SIZE = 5;

export type ShortWindows = { previous: ResponseEpisode[]; recent: ResponseEpisode[] } | null;

// Selects the two most-recent-first-ordered windows of SHORT_WINDOW_SIZE
// eligible, complete episodes each from a list already sorted NEWEST FIRST
// (by patient_local_date/started_at descending — caller's responsibility).
// Returns null when fewer than 2*SHORT_WINDOW_SIZE eligible episodes exist
// — "insufficient data" is the caller's job to report; this function simply
// declines to fabricate a window. Incomplete episodes are already excluded
// upstream by buildResponseEpisodes only including base episodes with
// eligibleForSymptomAnalysis computed — callers must filter to
// `.eligibleForSymptomAnalysis` before calling this.
export function selectShortWindows(eligibleEpisodesNewestFirst: ResponseEpisode[]): ShortWindows {
  if (eligibleEpisodesNewestFirst.length < SHORT_WINDOW_SIZE * 2) return null;
  const recentNewestFirst = eligibleEpisodesNewestFirst.slice(0, SHORT_WINDOW_SIZE);
  const previousNewestFirst = eligibleEpisodesNewestFirst.slice(SHORT_WINDOW_SIZE, SHORT_WINDOW_SIZE * 2);
  // Oldest-first within each window — a natural, reproducible internal
  // ordering (doesn't affect any statistic, which is order-independent).
  return {
    recent: [...recentNewestFirst].reverse(),
    previous: [...previousNewestFirst].reverse(),
  };
}
