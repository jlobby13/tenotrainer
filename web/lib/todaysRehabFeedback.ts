// Milestone 5, Stage 2 — Today's Rehab feedback view model. Pure,
// deterministic, client-safe (no server-only import, no DB access) — takes
// the Stage 1 derived-guidance facts (web/lib/guidance.ts) and maps them to
// exactly what Today's Rehab should show, without inventing any new
// clinical fact. Mirrors the guidance.ts/guidanceServer.ts and
// toleranceEvaluation.ts/route split of "pure decision logic" from
// "server-only DB wiring" — see todaysRehabFeedbackServer.ts for the latter.
//
// Two things this module deliberately does NOT do:
//   - it never changes what tolerance_evaluations/prescription_versions say
//     (no new rules, no new thresholds — see toleranceEvaluation.ts, which
//     this module only reads the OUTPUT of);
//   - it never claims more than the Stage 1 facts support (a newer
//     prescription version is reported as a plain chronology fact — see
//     PRESCRIPTION_UPDATED_NOTE below — never as "your clinician reviewed
//     this" or "addressed," matching guidance.ts's own LOCKED distinction).

import type { RelevantGuidance, VersionComparison } from "./guidance";
import { selectPrimaryReasonExplanations, EXTERNAL_LOAD_EXPLANATION } from "./reasonCodeExplanations";

export type FeedbackTone = "positive" | "caution" | "attention" | "reduce";

export type TodaysRehabFeedback =
  | { kind: "none" }
  | {
      kind: "acute";
      title: string;
      body: string;
    }
  | {
      kind: "response";
      tone: FeedbackTone;
      title: string;
      body: string;
      reasonExplanations: string[];
      externalLoadNote: string | null;
      // Set exactly when a newer prescription version exists — see
      // PRESCRIPTION_UPDATED_NOTE. When set, the caller should render this
      // response as demoted/historical context, not as the dominant
      // current-plan message (Section 4 of the Stage 2 brief).
      prescriptionUpdatedNote: string | null;
      // True under the same condition as prescriptionUpdatedNote !== null —
      // exposed as its own boolean so a consumer doesn't need to string-
      // compare prescriptionUpdatedNote to decide how to style the card.
      demoted: boolean;
      // Only ever "Continue to Today's Rehab", and only for an active
      // (non-demoted) reduce_modify state — null means the caller should
      // use its own default CTA label ("Start Today's Rehab").
      ctaLabelOverride: string | null;
      // Passthrough of the Stage 1 fact, unrendered as its own sentence in
      // Stage 2 — a harmless placeholder for Stage 3, which will persist
      // "patient proceeded under unresolved Reduce/Modify guidance" and
      // needs to know whether the next session (if any) used the same
      // prescription version. Stage 2 does not act on this beyond passing
      // it through.
      subsequentSessionVersionComparison: VersionComparison | null;
    };

const PRESCRIPTION_UPDATED_NOTE = "Your rehab plan has been updated since your last response.";

function acuteFeedback(escalationLevel: number | null): TodaysRehabFeedback {
  // Reuses the EXACT existing M3/M4 acute-safety copy verbatim (see
  // web/app/patient/morning-response/components/ToleranceResultsCard.tsx) —
  // Stage 2 does not invent new safety language, per Section 6.
  if (escalationLevel === 5) {
    return {
      kind: "acute",
      title: "Stop Loading",
      body: "Do not continue your Achilles exercises. Protect and offload the affected leg. Seek prompt medical evaluation.",
    };
  }
  return {
    kind: "acute",
    title: "Your symptoms warrant review.",
    body: "Avoid further Achilles loading today and contact your clinician for guidance.",
  };
}

export type ComputeTodaysRehabFeedbackInput = {
  guidance: RelevantGuidance | null;
  // Only meaningful when guidance.evaluation.toleranceClassification ===
  // "acute_override" — see todaysRehabFeedbackServer.ts, which only fetches
  // it in that case.
  escalationLevel: number | null;
  // The existing M4 Stage 3 gate is authoritative (Section 7) — when an
  // outstanding morning response exists, Stage 2 feedback must not render
  // at all, so it can never compete with or imply a result the gate hasn't
  // let the patient produce yet.
  hasOutstandingMorningResponse: boolean;
};

export function computeTodaysRehabFeedback(input: ComputeTodaysRehabFeedbackInput): TodaysRehabFeedback {
  if (input.hasOutstandingMorningResponse) return { kind: "none" };

  const { guidance } = input;
  if (!guidance) return { kind: "none" }; // Section 8: absence of evaluation is not a favorable evaluation

  // Defensive: getRelevantGuidanceForPatient always selects the globally
  // latest evaluation, so this should already be false by construction —
  // but never let a superseded evaluation be presented as current/primary
  // feedback regardless of how the guidance object arrived here (Section 5).
  if (guidance.supersededByNewerEvaluation) return { kind: "none" };

  const { evaluation } = guidance;

  if (evaluation.toleranceClassification === "acute_override") {
    // Safety supersedes ordinary Stage 2 states (Section 6) — no newer-
    // version demotion, no reason-code explanations, no CTA override. This
    // branch returns unconditionally before any of that logic runs.
    return acuteFeedback(input.escalationLevel);
  }

  const demoted = guidance.newerPrescriptionVersion.exists;
  const reasonExplanations =
    evaluation.toleranceClassification === "well_tolerated" ? [] : selectPrimaryReasonExplanations(evaluation.reasonCodes);
  const externalLoadNote = evaluation.reasonCodes.includes("external_loading_reported") ? EXTERNAL_LOAD_EXPLANATION : null;
  const prescriptionUpdatedNote = demoted ? PRESCRIPTION_UPDATED_NOTE : null;

  let tone: FeedbackTone;
  let title: string;
  let body: string;
  let ctaLabelOverride: string | null = null;

  if (evaluation.toleranceClassification === "well_tolerated") {
    tone = "positive";
    title = "Last session: Well Tolerated";
    body = "Your tendon response remained within the preferred range after your last session.";
  } else if (evaluation.immediateGuidance === "reduce_modify") {
    tone = "reduce";
    title = "Your last response suggests the current loading plan may need adjustment.";
    body =
      "Your response indicates that some part of your current loading plan may need to be modified. Today's prescribed rehab is still available, but this response deserves extra attention.";
    // Once the plan has actually changed, "continue anyway" framing no
    // longer fits the current situation — revert to the normal CTA label
    // and let the plan-updated note (already set above) carry the message.
    if (!demoted) ctaLabelOverride = "Continue to Today's Rehab";
  } else if (evaluation.immediateGuidance === "maintain_cautiously") {
    tone = "attention";
    title = "Monitor today's response";
    body =
      "Your last response was near the edge of the preferred range. Continue with your prescribed rehab while paying attention to how your tendon responds.";
  } else {
    // caution + maintain
    tone = "caution";
    title = "Last session: Caution";
    body = "Your response had something worth monitoring, but your current prescribed rehab remains available.";
  }

  return {
    kind: "response",
    tone,
    title,
    body,
    reasonExplanations,
    externalLoadNote,
    prescriptionUpdatedNote,
    demoted,
    ctaLabelOverride,
    subsequentSessionVersionComparison: guidance.subsequentSession.versionComparison,
  };
}
