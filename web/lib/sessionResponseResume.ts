// Pure resume-position logic for the Milestone 3 response flow, split out of
// SessionResponseFlow.tsx (which is JSX) so it can be unit-tested directly
// rather than via a hand-duplicated copy of the same decision logic.

import type { ActiveSessionState } from "./activeSession";
import { hasPainLimitingReport, hasPopReport } from "./activeSession";
import { acuteAssessmentRequired, type RehabSessionRecord } from "./rehabSessionTypes";

export type ResumeStep =
  | { kind: "level5" }
  | { kind: "peak_pain" }
  | { kind: "difficulty" }
  | { kind: "external_load" }
  | { kind: "contributor" }
  | { kind: "acute" }
  | { kind: "outcome"; escalationLevel: number };

// Resume position is DERIVED from the server record every time this is
// called — never from locally-tracked UI state — so a refresh mid-flow lands
// exactly where the patient left off, per the mid-flow-durability
// requirement. escalationLevel: -1 is a sentinel meaning "everything required
// is present but finalize has not yet been called" — the caller must
// finalize before actually showing an outcome screen.
//
// externalLoadAnswered is local-only state (like level5Acknowledged), NOT
// derived from a rehab_sessions column — the M3 external-load question
// (founder-acceptance patch) writes to session_load_observations, a
// separate table this pure function has no server record for. It is
// optional/non-blocking exposure context, so re-showing it after a
// same-session refresh (before finalize) is an accepted, disclosed scope
// limitation, exactly mirroring level5Acknowledged's existing behavior.
export function deriveStep(
  server: RehabSessionRecord,
  local: ActiveSessionState,
  level5Acknowledged: boolean,
  externalLoadAnswered: boolean
): ResumeStep {
  const hasPop = hasPopReport(local);
  if (hasPop && !level5Acknowledged) return { kind: "level5" };

  if (server.peakSessionPain == null) return { kind: "peak_pain" };
  if (server.difficulty == null) return { kind: "difficulty" };
  if (!externalLoadAnswered) return { kind: "external_load" };

  const hasPainLimiting = hasPainLimitingReport(local);
  const contributorTriggered = server.exerciseOutcome === "ended_early" && hasPainLimiting;
  if (contributorTriggered && server.contributorReason == null) return { kind: "contributor" };

  const acuteRequired = acuteAssessmentRequired({
    exerciseOutcome: server.exerciseOutcome,
    earlyEndReason: server.earlyEndReason,
    hasPopEvent: hasPop,
    hasPainLimitingEvent: hasPainLimiting,
  });
  if (
    acuteRequired &&
    (server.suddenOrSharpPain == null || server.popFeltOrHeard == null || server.newFunctionalDifficulty == null)
  ) {
    return { kind: "acute" };
  }

  if (server.status === "awaiting_morning_response") {
    return { kind: "outcome", escalationLevel: server.currentEscalationLevel ?? 0 };
  }

  return { kind: "outcome", escalationLevel: -1 };
}
