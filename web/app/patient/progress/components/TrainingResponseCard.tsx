import { getTrainingResponseCopy } from "@/lib/progressInterpretationLabels";
import type { TrainingResponseSummary } from "@/lib/progressInterpretationTypes";

// Milestone 6, Stage 4, Section E — "Training Response". Question: "How is
// my tendon responding to my rehab loading?" Renders the latest persisted
// training_response_series interpretation's patient-safe label + sentence.
// The internal `limited_comparable_exposures` reason code is never
// rendered directly — only its approved patient-safe substitute sentence
// (see getTrainingResponseCopy).

const STATE_STYLES: Record<string, string> = {
  loading_tolerance_improving: "bg-green-50 text-green-700 border-green-100",
  stable_training_response: "bg-gray-50 text-gray-600 border-gray-100",
  variable_training_response: "bg-amber-50 text-amber-700 border-amber-100",
  training_response_remains_unsettled: "bg-amber-50 text-amber-700 border-amber-100",
};
const DEFAULT_STYLE = "bg-gray-50 text-gray-500 border-gray-100";

export function TrainingResponseCard({ trainingResponse }: { trainingResponse: TrainingResponseSummary }) {
  const { copy, limitedComparableConstructsNote } = getTrainingResponseCopy({
    resultState: trainingResponse?.resultState ?? null,
    overallLoadingDirection: trainingResponse?.overallLoadingDirection ?? null,
    hasInsufficientConstruct: trainingResponse?.hasInsufficientConstruct ?? false,
  });
  const style = (trainingResponse && STATE_STYLES[trainingResponse.resultState]) ?? DEFAULT_STYLE;

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Training Response</h2>
      <p className="text-xs text-gray-500 mb-4">How is my tendon responding to my rehab loading?</p>
      <div className="flex items-start gap-3">
        <span className={`shrink-0 text-xs font-medium rounded-full border px-2.5 py-1 ${style}`}>{copy.label}</span>
        <div>
          <p className="text-sm text-gray-700">{copy.sentence}</p>
          {copy.secondarySentence && <p className="text-xs text-gray-500 mt-1">{copy.secondarySentence}</p>}
          {limitedComparableConstructsNote && <p className="text-xs text-gray-500 mt-1">{limitedComparableConstructsNote}</p>}
        </div>
      </div>
    </section>
  );
}
