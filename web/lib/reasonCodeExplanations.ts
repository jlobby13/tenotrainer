// Milestone 5, Stage 2 — patient-facing explanations for the reason codes
// persisted by the tolerance evaluator (web/lib/toleranceEvaluation.ts).
// Pure, deterministic, client-safe. Every string here is a restatement of
// what the evaluator already decided (see toleranceEvaluation.ts's own
// `primaryReasonText` map) in slightly more patient-facing phrasing — this
// module invents no new clinical interpretation, no new thresholds, and
// never names the internal code string to the patient.
//
// A code not in this map returns null from explainReasonCode() rather than
// a generic fallback sentence — an unrecognized code (e.g. a future rule
// version's new vocabulary) is omitted from the patient-facing card, never
// papered over with invented text.

// Every code the v1 evaluator can currently attach to a "caution"-tier
// candidate. Excludes: "normal_response" (well_tolerated's own baseline —
// no explanation needed, the classification copy already says it),
// "acute_safety_override" (acute state has its own separate, fixed
// messaging — see todaysRehabFeedback.ts), "incomplete_required_response_data"
// (insufficient_data is never persisted to tolerance_evaluations), and
// "external_loading_reported" (handled separately below — contextual,
// non-causal, always phrased as "may have contributed," never a cause).
const REASON_CODE_EXPLANATIONS: Record<string, string> = {
  elevated_session_pain: "Pain during your session was at the upper edge of the preferred range.",
  elevated_session_pain_with_mild_response: "Pain during the session was elevated, and your next-morning response wasn't entirely settled.",
  elevated_session_pain_recovered: "Pain was higher during the session but settled by the next morning.",
  combined_elevated_morning_symptoms: "Both session pain and next-morning pain were mildly elevated.",
  borderline_morning_pain_manageable: "Next-morning pain was at the edge of the preferred range, though manageable.",
  borderline_morning_pain_difficult: "Next-morning pain was at the edge of the preferred range and difficult to tolerate.",
  elevated_morning_pain: "Morning pain remained elevated after the session.",
  elevated_stiffness_rapid_resolution: "Morning stiffness was elevated but eased quickly.",
  elevated_stiffness_neutral_duration: "Morning stiffness intensity was higher than the preferred range.",
  elevated_stiffness_moderate_duration: "Morning stiffness lasted longer than the preferred range.",
  prolonged_morning_stiffness: "Morning stiffness lasted longer than the preferred range.",
  elevated_and_prolonged_morning_stiffness: "Morning stiffness was both more intense and longer-lasting than the preferred range.",
  // Contextual, non-clinical — kept for completeness/determinism but ranked
  // last by PRIORITY_ORDER below, since they rarely deserve one of a 1-2
  // slot budget over an actual symptom-band explanation.
  exercise_specific_symptom_response: "One exercise in particular seemed linked to your response.",
  pain_limited_termination: "Your last session ended earlier than planned because of pain.",
};

export function explainReasonCode(code: string): string | null {
  return REASON_CODE_EXPLANATIONS[code] ?? null;
}

// Most-clinically-useful-first ordering for the 1-2 explanations actually
// shown — roughly mirrors the evaluator's own guidance severity (reduce-tier
// factors first, then maintain_cautiously-tier, then mild/maintain-tier),
// so the patient sees the reason that most likely drove the guidance they
// were given, not an arbitrary or alphabetical one. Contextual codes sit at
// the very end — see the map comment above.
const PRIORITY_ORDER: string[] = [
  "prolonged_morning_stiffness",
  "elevated_and_prolonged_morning_stiffness",
  "elevated_morning_pain",
  "borderline_morning_pain_difficult",
  "combined_elevated_morning_symptoms",
  "borderline_morning_pain_manageable",
  "elevated_stiffness_moderate_duration",
  "elevated_stiffness_neutral_duration",
  "elevated_session_pain_with_mild_response",
  "elevated_session_pain_recovered",
  "elevated_session_pain",
  "elevated_stiffness_rapid_resolution",
  "exercise_specific_symptom_response",
  "pain_limited_termination",
];

// Deterministic: given the same reasonCodes array, always returns the same
// explanations in the same order. Unknown codes and codes with no mapped
// explanation are silently omitted, never replaced with invented text.
export function selectPrimaryReasonExplanations(reasonCodes: string[], maxCount = 2): string[] {
  const present = new Set(reasonCodes);
  const ordered = PRIORITY_ORDER.filter((code) => present.has(code));
  // Anything present but not in PRIORITY_ORDER (future codes this module
  // doesn't yet know how to rank) still gets a chance, after the ranked
  // ones, in their original array order — never silently dropped just for
  // being unranked, only for being genuinely unexplainable (see the filter
  // in the loop below).
  const unranked = reasonCodes.filter((c) => !PRIORITY_ORDER.includes(c));
  const candidateOrder = [...ordered, ...unranked];

  const explanations: string[] = [];
  for (const code of candidateOrder) {
    const text = explainReasonCode(code);
    if (text && !explanations.includes(text)) explanations.push(text);
    if (explanations.length >= maxCount) break;
  }
  return explanations;
}

// External loading is an observation, never a cause — see the identical
// principle already locked for the M4 morning-response results card
// (web/app/patient/morning-response/components/ToleranceResultsCard.tsx).
// Reused verbatim in spirit here for consistency across the two surfaces.
export const EXTERNAL_LOAD_EXPLANATION =
  "Other physical activity was also reported around that rehab session — it may have contributed to your overall loading context.";
