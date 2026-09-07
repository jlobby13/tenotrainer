// Milestone 4, Stage 4 — deterministic, versioned, single-session tolerance
// evaluator. Human-authored rules only; no LLM, no weighted opaque score.
//
// Pipeline (matches the Stage 4 brief exactly):
//   raw observations -> acute safety override -> required-data validation
//   -> session response evaluation -> morning response evaluation
//   -> contextual observations (informational only) -> tolerance
//   classification -> reason codes -> immediate loading guidance
//   -> (caller persists the result).
//
// Design note on thresholds: every threshold that traces to an explicit
// number or an explicit anchor case in the Stage 4 brief is marked "locked".
// A small number of thresholds are NOT given explicit numbers by the brief
// (the exact intensity cutoff within the 5-15min and 15-30min stiffness
// duration bands, and the precise split between "elevated_session_pain" and
// "elevated_session_pain_with_mild_response" for peak==5). Those are marked
// **TenoTrainer v1 clinician-designed conservative thresholds** — a
// disclosed, deliberate implementation choice for the v1 cold-start model,
// NOT a literature-validated physiological boundary. They were chosen to
// fill the small number of unspecified gaps between anchors without
// independently widening what counts as "reduce/modify" beyond what an
// anchor case already requires, and without inventing a universal reduction
// rule the brief explicitly warned against. They are approved to stand as
// implemented for v1 review; a future rule version may replace them with a
// clinically re-derived matrix without rewriting past evaluations (see
// TOLERANCE_RULE_VERSION).
//
// Founder-acceptance patch (post-Stage-4 review): the v1 evaluator
// previously escalated the tolerance LABEL to "poorly_tolerated" whenever
// 2+ independent reduce-tier candidates fired simultaneously. That rule was
// an unapproved author invention, not a locked or anchor-derived behavior,
// and has been REMOVED. "poorly_tolerated" remains in the schema/type
// vocabulary for a future, explicitly clinically-defined rule, but the v1
// evaluator never emits it — every candidate-driven outcome that used to
// reach reduce_modify still does; only the classification label is now
// always "caution" rather than sometimes "poorly_tolerated". Guidance
// (maintain/maintain_cautiously/reduce_modify/clinical_review) is unchanged
// and remains a separate concept from tolerance classification.

import type { ImmediateGuidance, MorningPainTolerability, StiffnessDuration, ToleranceClassification } from "./morningResponseTypes";
import type { ExternalLoadCategory } from "./sessionLoadObservations";

export const TOLERANCE_RULE_VERSION = "v1";

export type ToleranceEvaluationInputs = {
  peakSessionPain: number;
  nextMorningPain: number;
  nextMorningStiffness: number;
  stiffnessDuration: StiffnessDuration | null;
  morningPainTolerability: MorningPainTolerability | null;
  // Existing M3 acute escalation output (rehab_sessions.current_escalation_level)
  // — an independent, already-authoritative system. Level 3-5 overrides
  // everything below; Stage 4 does not redesign or reconsume this.
  escalationLevel: number | null;
  // Contextual observations — NEVER read by the classification logic below,
  // only echoed into reason codes for explanation. Enforced by construction:
  // no branch in evaluateTolerance() below inspects these values.
  externalLoadCategories: ExternalLoadCategory[] | null;
  hasExerciseSpecificSymptomResponse: boolean;
  hasPainLimitedTermination: boolean;
};

export type ToleranceEvaluationResult = {
  classification: ToleranceClassification;
  guidance: ImmediateGuidance;
  reasonCodes: string[];
  patientFacingLabel: string;
  reason: string;
  ruleVersion: string;
};

// Every rule-driven candidate is "caution" — v1 never emits "poorly_tolerated"
// from a candidate rule (see the founder-acceptance patch note above). The
// field is kept (rather than dropped) only so a future clinically-approved
// rule can introduce it without reshaping this type again.
type Candidate = { classification: "caution"; guidance: ImmediateGuidance; reasonCode: string };

const GUIDANCE_RANK: Record<ImmediateGuidance, number> = {
  maintain: 0,
  maintain_cautiously: 1,
  reduce_modify: 2,
  clinical_review: 3,
};

const PATIENT_LABELS: Record<ToleranceClassification, string> = {
  well_tolerated: "Well Tolerated",
  caution: "Caution",
  poorly_tolerated: "Caution",
  acute_override: "Safety Review Needed",
  insufficient_data: "More Data Needed",
};

function insufficientDataResult(reasonCode: string): ToleranceEvaluationResult {
  return {
    classification: "insufficient_data",
    guidance: "maintain", // placeholder value only — never surfaced; see the route's handling of insufficient_data
    reasonCodes: [reasonCode],
    patientFacingLabel: PATIENT_LABELS.insufficient_data,
    reason: "More data is needed before we can interpret your tendon response.",
    ruleVersion: TOLERANCE_RULE_VERSION,
  };
}

export function evaluateTolerance(inputs: ToleranceEvaluationInputs): ToleranceEvaluationResult {
  // --- Step 1: acute safety override (locked — existing M3 system, level 3-5) ---
  if (inputs.escalationLevel !== null && inputs.escalationLevel >= 3) {
    return {
      classification: "acute_override",
      guidance: "clinical_review",
      reasonCodes: ["acute_safety_override"],
      patientFacingLabel: PATIENT_LABELS.acute_override,
      reason: "An acute safety finding from this session takes priority over routine tolerance interpretation.",
      ruleVersion: TOLERANCE_RULE_VERSION,
    };
  }

  // --- Step 2: required-data validation (locked) ---
  // UNKNOWN != ZERO: an unanswered stiffness duration (when stiffness > 0)
  // or an unanswered borderline-pain tolerability clarification (when
  // morning pain === 5) must never be interpreted as favorable.
  //
  // Founder-acceptance patch: this evaluator must independently reject an
  // inconsistent stiffness-duration combination rather than relying only on
  // UI/API validation to prevent it from ever arriving here. Two states are
  // invalid whenever stiffness > 0: `null` (never answered) and
  // `"not_applicable"` (a value that is only ever a legitimate answer when
  // stiffness === 0 — see the canonical storage representation in
  // morningResponseTypes.ts). Both must produce insufficient_data, never a
  // silently-skipped stiffness rule (see Step 5's switch, which would
  // otherwise treat an inconsistent "not_applicable" as a no-op).
  if (inputs.nextMorningStiffness > 0) {
    if (inputs.stiffnessDuration === null || inputs.stiffnessDuration === "not_applicable") {
      return insufficientDataResult("incomplete_required_response_data");
    }
  }
  if (inputs.nextMorningPain === 5 && inputs.morningPainTolerability === null) {
    return insufficientDataResult("incomplete_required_response_data");
  }

  const candidates: Candidate[] = [];

  // --- Step 3: session response evaluation (peak session pain — locked bands) ---
  // 0-3 preferred, 4 acceptable-but-monitor (no independent escalation — see
  // anchor C), 5 upper edge, >=6 concerning but never automatically
  // "poorly tolerated" on its own (see anchor D).
  if (inputs.peakSessionPain === 5) {
    // Author's conservative choice, not given a numeric threshold by the
    // brief: distinguishing plain "elevated_session_pain" (anchor G — a
    // clean guidance of "maintain") from a slightly more cautious variant
    // when the morning response reaches the TOP of its own still-favorable
    // band (anchor H: morning pain=3, morning stiffness=3 — both at the
    // upper edge of "0-3 preferred" — vs G's morning pain=1/stiffness=1,
    // solidly low) is necessary to produce G != H, which the brief
    // requires. The >=3 threshold mirrors the same "0-3 favorable" band
    // boundary already used for morning pain elsewhere. This does not
    // change WHICH cases are escalated to reduce/modify — only whether
    // "maintain" or "maintain_cautiously" is recommended among two
    // already-caution-tier anchors.
    const morningResponseNotable = inputs.nextMorningPain >= 3 || inputs.nextMorningStiffness >= 3;
    candidates.push(
      morningResponseNotable
        ? { classification: "caution", guidance: "maintain_cautiously", reasonCode: "elevated_session_pain_with_mild_response" }
        : { classification: "caution", guidance: "maintain", reasonCode: "elevated_session_pain" }
    );
  } else if (inputs.peakSessionPain >= 6) {
    // Locked: explicit anchor D and explicit reason-code example in the brief.
    candidates.push({ classification: "caution", guidance: "maintain_cautiously", reasonCode: "elevated_session_pain_recovered" });
  }

  // --- Step 4: morning response evaluation (locked bands + combined rule) ---

  // Combined mild factors (locked via anchor F): peak==4 AND morning pain==4
  // simultaneously escalates to caution, even though peak==4 alone (anchor
  // C) or morning pain==4 alone do not.
  if (inputs.peakSessionPain === 4 && inputs.nextMorningPain === 4) {
    candidates.push({ classification: "caution", guidance: "maintain_cautiously", reasonCode: "combined_elevated_morning_symptoms" });
  }

  // Morning pain bands (locked): 0-3 favorable, 4 mild (no independent
  // escalation — mirrors peak==4's treatment), 5 borderline (requires the
  // tolerability clarification, already validated above), >=6 always
  // reduce/modify regardless of anything else (anchor U).
  if (inputs.nextMorningPain === 5) {
    candidates.push(
      inputs.morningPainTolerability === "difficult_to_tolerate"
        ? { classification: "caution", guidance: "reduce_modify", reasonCode: "borderline_morning_pain_difficult" }
        : { classification: "caution", guidance: "maintain_cautiously", reasonCode: "borderline_morning_pain_manageable" }
    );
  } else if (inputs.nextMorningPain >= 6) {
    candidates.push({ classification: "caution", guidance: "reduce_modify", reasonCode: "elevated_morning_pain" });
  }

  // --- Step 5: morning stiffness evaluated as intensity x duration (locked pattern) ---
  if (inputs.nextMorningStiffness > 0 && inputs.stiffnessDuration) {
    const intensity = inputs.nextMorningStiffness;
    switch (inputs.stiffnessDuration) {
      case "lt_5_min":
        // Locked: rapid resolution is reassuring regardless of intensity
        // (anchors Q, V) — this never independently escalates guidance
        // beyond "maintain", but a notably elevated intensity still keeps
        // the CLASSIFICATION at "caution" rather than silently vanishing
        // into "well_tolerated" (anchor Q is explicitly "Caution,
        // favorable", not well_tolerated). Author's conservative choice:
        // the brief gives no exact cutoff for "notably elevated" here; 4 is
        // used as the same mild-band boundary used elsewhere (peak/morning
        // pain's own "4" band).
        if (intensity >= 4) {
          candidates.push({ classification: "caution", guidance: "maintain", reasonCode: "elevated_stiffness_rapid_resolution" });
        }
        break;
      case "min_5_15":
        // Locked: "neutral to mild caution... do not force reduction
        // solely from this duration." Author's conservative choice (no
        // anchor covers this band at high intensity): only very high
        // intensity (>=7) gets even a mild-caution bump here, and it never
        // reaches reduce_modify from this band alone.
        if (intensity >= 7) {
          candidates.push({ classification: "caution", guidance: "maintain_cautiously", reasonCode: "elevated_stiffness_neutral_duration" });
        }
        break;
      case "min_15_30":
        // Locked: "stronger caution modifier... do not invent a universal
        // automatic reduction rule for every 15-30 minute response." Author's
        // conservative choice for the exact intensity cutoffs (no anchor
        // covers this band): moderate-or-higher intensity (>=3) reaches
        // maintain_cautiously; only quite high intensity (>=7) reaches
        // reduce_modify — deliberately NOT every 15-30 minute response,
        // per the brief's explicit instruction.
        if (intensity >= 7) {
          candidates.push({ classification: "caution", guidance: "reduce_modify", reasonCode: "prolonged_morning_stiffness" });
        } else if (intensity >= 3) {
          candidates.push({ classification: "caution", guidance: "maintain_cautiously", reasonCode: "elevated_stiffness_moderate_duration" });
        }
        break;
      case "gt_30_min":
        // Locked: ">30 minutes ... is sufficient to recommend reduce/modify,
        // even if stiffness intensity and morning pain are relatively low"
        // — unconditional on intensity (anchors R, S, T, W all confirm this,
        // including T at intensity=3).
        candidates.push({
          classification: "caution",
          guidance: "reduce_modify",
          reasonCode: intensity >= 6 ? "elevated_and_prolonged_morning_stiffness" : "prolonged_morning_stiffness",
        });
        break;
      case "not_applicable":
        // Unreachable here: Step 2 above already redirects stiffness > 0
        // paired with "not_applicable" to insufficient_data before any
        // candidate is ever considered. This case only exists so the
        // switch remains exhaustive over the full StiffnessDuration type.
        break;
    }
  }

  // Contextual observations — informational only, appended regardless of
  // which branch below fires, and never read anywhere above this point
  // (enforced by construction: no candidate-producing rule inspects them).
  const contextualReasonCodes: string[] = [];
  if (inputs.hasExerciseSpecificSymptomResponse) contextualReasonCodes.push("exercise_specific_symptom_response");
  if (inputs.hasPainLimitedTermination) contextualReasonCodes.push("pain_limited_termination");
  if (inputs.externalLoadCategories && inputs.externalLoadCategories.some((c) => c !== "none")) {
    contextualReasonCodes.push("external_loading_reported");
  }

  // --- Aggregate: take the worst guidance among all fired candidates. If
  // nothing fired, the response is well_tolerated. Founder-acceptance patch:
  // the classification for any fired candidate is always "caution" — v1 does
  // NOT escalate to "poorly_tolerated" merely because 2+ independent
  // reduce_modify-tier candidates fired simultaneously (that rule was an
  // unapproved author invention and has been removed; see the header
  // comment). Guidance can still reach reduce_modify from a single factor,
  // and stays reduce_modify when multiple factors independently reach it —
  // only the tolerance LABEL is capped at "caution" in v1. ---
  if (candidates.length === 0) {
    return {
      classification: "well_tolerated",
      guidance: "maintain",
      reasonCodes: ["normal_response", ...contextualReasonCodes],
      patientFacingLabel: PATIENT_LABELS.well_tolerated,
      reason: "Your tendon response stayed within the expected range after this session.",
      ruleVersion: TOLERANCE_RULE_VERSION,
    };
  }

  const worstGuidanceRank = Math.max(...candidates.map((c) => GUIDANCE_RANK[c.guidance]));
  const classification: ToleranceClassification = "caution";
  const guidance = (Object.keys(GUIDANCE_RANK) as ImmediateGuidance[]).find((g) => GUIDANCE_RANK[g] === worstGuidanceRank)!;

  const reasonCodes = [...candidates.map((c) => c.reasonCode), ...contextualReasonCodes];

  const primaryReasonText: Record<string, string> = {
    elevated_session_pain: "Pain during the session was at the upper edge of the preferred range.",
    elevated_session_pain_with_mild_response: "Pain during the session was elevated, and the morning response was not entirely quiet.",
    elevated_session_pain_recovered: "Session pain was elevated, but your morning response was reassuring.",
    combined_elevated_morning_symptoms: "Session pain and next-morning pain were both mildly elevated.",
    borderline_morning_pain_manageable: "Next-morning pain was borderline but you described it as manageable.",
    borderline_morning_pain_difficult: "Next-morning pain was borderline and difficult to tolerate.",
    elevated_morning_pain: "Next-morning pain was elevated.",
    elevated_stiffness_rapid_resolution: "Morning stiffness was elevated but resolved quickly.",
    elevated_stiffness_neutral_duration: "Morning stiffness intensity was high.",
    elevated_stiffness_moderate_duration: "Morning stiffness lasted longer than ideal.",
    prolonged_morning_stiffness: "Morning stiffness lasted more than 30 minutes.",
    elevated_and_prolonged_morning_stiffness: "Morning stiffness was both elevated and prolonged.",
  };
  const primaryReasonCode = candidates.find((c) => GUIDANCE_RANK[c.guidance] === worstGuidanceRank)!.reasonCode;

  return {
    classification,
    guidance,
    reasonCodes,
    patientFacingLabel: PATIENT_LABELS[classification],
    reason: primaryReasonText[primaryReasonCode] ?? "Your response to this session showed some notable elements.",
    ruleVersion: TOLERANCE_RULE_VERSION,
  };
}
