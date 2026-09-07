import type { ToleranceEvaluationRecord } from "@/lib/morningResponseTypes";

// Patient-facing interpretation copy, keyed off the persisted, deterministic
// evaluation only — never re-derived or re-worded per raw inputs here. Locked
// constraints from the Stage 4 brief: never say "increase your load," never
// imply a specific percentage reduction, and acute_override reuses the
// existing M3 escalation copy verbatim (see OutcomeScreen.tsx) rather than
// inventing new safety language.
function guidanceCopy(evaluation: ToleranceEvaluationRecord, escalationLevel: number | null): { title: string; body: string; tone: "green" | "amber" | "red" | "gray" } {
  if (evaluation.toleranceClassification === "insufficient_data") {
    return {
      title: "More Data Needed",
      body: "We don't have enough information yet to interpret this response. Continue your plan as prescribed, and complete the remaining check-in questions when you can.",
      tone: "gray",
    };
  }

  if (evaluation.toleranceClassification === "acute_override") {
    if (escalationLevel === 5) {
      return {
        title: "Stop Loading",
        body: "Do not continue your Achilles exercises. Protect and offload the affected leg. Seek prompt medical evaluation.",
        tone: "red",
      };
    }
    return {
      title: "Your symptoms warrant review.",
      body: "Avoid further Achilles loading today and contact your clinician for guidance.",
      tone: "red",
    };
  }

  if (evaluation.immediateGuidance === "reduce_modify") {
    return {
      title: "Caution",
      body: "Your response suggests this was more than your Achilles is ready for right now. Consider reducing or modifying today's session — your care team can help guide the best adjustment.",
      tone: "amber",
    };
  }

  if (evaluation.immediateGuidance === "maintain_cautiously") {
    return {
      title: "Caution",
      body: "Your response suggests some irritation. Continue your plan as prescribed, but pay closer attention to how your Achilles responds today.",
      tone: "amber",
    };
  }

  if (evaluation.toleranceClassification === "caution") {
    return {
      title: "Caution",
      body: "Your response suggests some mild irritation, but nothing concerning. Continue your plan as prescribed, and keep monitoring how you feel.",
      tone: "amber",
    };
  }

  return {
    title: "Well Tolerated",
    body: "Your Achilles responded well to your previous rehab session. Continue with your plan as prescribed.",
    tone: "green",
  };
}

const TONE_CLASSES: Record<string, string> = {
  green: "bg-green-50 border-green-200 text-green-900",
  amber: "bg-amber-50 border-amber-200 text-amber-900",
  red: "bg-red-50 border-red-200 text-red-900",
  gray: "bg-gray-50 border-gray-200 text-gray-900",
};

// Section 7 of the founder-acceptance patch: external loading is an
// observation, never a cause. This note may state that reported activity
// "may have contributed to the overall loading context" — it must never
// state that the activity caused the response, and it never changes the
// title/tone/classification/guidance above it.
const EXTERNAL_LOAD_NOTE =
  "You reported some additional activity around this session — that may have contributed to your overall loading context.";

export function ToleranceResultsCard({
  evaluation,
  escalationLevel,
}: {
  evaluation: ToleranceEvaluationRecord;
  escalationLevel: number | null;
}) {
  const { title, body, tone } = guidanceCopy(evaluation, escalationLevel);
  const hasExternalLoad = evaluation.reasonCodes.includes("external_loading_reported");

  return (
    <div className={`rounded-xl border-2 p-4 text-left ${TONE_CLASSES[tone]}`}>
      <p className="text-sm font-bold">{title}</p>
      <p className="text-sm mt-1">{body}</p>
      {hasExternalLoad && <p className="text-sm mt-2 opacity-80">{EXTERNAL_LOAD_NOTE}</p>}
    </div>
  );
}
