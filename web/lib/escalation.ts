// Milestone 3 escalation evaluator — deterministic, versioned, pure.
//
// Called ONLY from trusted server-side Route Handler code. The browser never
// supplies a level/reason/rule_version — this function computes them from
// raw, already-persisted facts, and the caller writes the result using the
// service-role client (bypassing RLS/column grants that block `authenticated`
// from writing escalation_evaluations or rehab_sessions.current_escalation_level
// at all). See supabase/migrations/20260905000001_m3_session_response.sql.
//
// Safety escalation is a SEPARATE system from tendon-load tolerance — this
// module must never be merged with, or read by, app/engine/rules.py.
//
// Deliberately incomplete by design: Level 2 and Level 4 have no rule here
// because their thresholds are not yet clinically approved. Inventing one
// would violate an explicit product lock. EscalationInputs already carries
// the shape a future Level 2 pattern-based rule would need.

import type { EscalationInputs, EscalationResult } from "./rehabSessionTypes";

export const ESCALATION_RULE_VERSION = "v1";

export function evaluateEscalation(inputs: EscalationInputs): EscalationResult {
  // LEVEL 5 — Emergent safety concern. Absolute trigger, checked first.
  if (inputs.popFeltOrHeard === true) {
    return {
      level: 5,
      reason: "pop_felt_or_heard",
      ruleVersion: ESCALATION_RULE_VERSION,
    };
  }

  // LEVEL 3 — Acute clinical concern.
  if (inputs.suddenOrSharpPain === true || inputs.newFunctionalDifficulty === true) {
    const reason =
      inputs.suddenOrSharpPain === true && inputs.newFunctionalDifficulty === true
        ? "sudden_or_sharp_pain_and_new_functional_difficulty"
        : inputs.suddenOrSharpPain === true
          ? "sudden_or_sharp_pain"
          : "new_functional_difficulty";
    return { level: 3, reason, ruleVersion: ESCALATION_RULE_VERSION };
  }

  // LEVEL 4 — not implemented. Exact combination/severity rule is unresolved
  // and must not be invented. No input pattern produces Level 4 in v1.

  // LEVEL 2 — not implemented. "Recurrent loading concern" requires a
  // recent-history threshold that is not yet approved. No input pattern
  // produces Level 2 in v1; EscalationInputs has no recent-history field yet
  // because none is consumed — adding one prematurely would invite exactly
  // the kind of invented threshold this lock prohibits.

  // LEVEL 1 — Isolated loading concern. ONLY a clinically meaningful loading
  // concern, never "any session event" (equipment/other/ran-out-of-time do
  // NOT qualify — see the audit correction this implements).
  if (inputs.hasPainLimitingEvent || inputs.endedEarlyForSymptoms) {
    const reason = inputs.hasPainLimitingEvent ? "pain_limiting_report" : "symptom_related_early_termination";
    return { level: 1, reason, ruleVersion: ESCALATION_RULE_VERSION };
  }

  // LEVEL 0 — Routine loading exposure. Not yet formally "well tolerated" —
  // that classification waits for Milestone 4's next-morning data.
  return { level: 0, reason: "routine_loading_exposure", ruleVersion: ESCALATION_RULE_VERSION };
}
