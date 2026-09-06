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
  | { kind: "contributor" }
  | { kind: "acute" }
  | { kind: "outcome"; escalationLevel: number };

// Resume position is DERIVED from the server record every time this is
// called — never from locally-tracked UI state — so a refresh mid-flow lands
// exactly where the patient left off, per the mid-flow-durability
// requirement. escalationLevel: -1 is a sentinel meaning "everything required
// is present but finalize has not yet been called" — the caller must
// finalize before actually showing an outcome screen.
export function deriveStep(
  server: RehabSessionRecord,
  local: ActiveSessionState,
  level5Acknowledged: boolean
): ResumeStep {
  const hasPop = hasPopReport(local);
  if (hasPop && !level5Acknowledged) return { kind: "level5" };

  if (server.peakSessionPain == null) return { kind: "peak_pain" };
  if (server.difficulty == null) return { kind: "difficulty" };

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
