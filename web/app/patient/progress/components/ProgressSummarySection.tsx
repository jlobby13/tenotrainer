import { composeProgressSummary } from "@/lib/progressInterpretationLabels";
import type { ProgressInterpretationData } from "@/lib/progressInterpretationTypes";
import { disambiguateCapacityDisplayNames } from "@/lib/progressInterpretationLabels";

// Milestone 6, Stage 4, Section A — "Progress Summary". A deterministic
// copy-composition layer over the three already-computed interpretations —
// NOT a fourth clinical domain, NOT an overall score, NOT a verdict badge.
// See lib/progressInterpretationLabels.ts's composeProgressSummary for the
// exact founder-approved sentence rules. Always full width, always visible
// (never collapsible) — this section is never conditionally hidden once
// there's any rehab history at all (the page only reaches this section
// when hasAnyHistory is true).

export function ProgressSummarySection({ interpretationData }: { interpretationData: ProgressInterpretationData }) {
  const capacityForSummary = disambiguateCapacityDisplayNames(interpretationData.capacityConstructs);
  const sentences = composeProgressSummary({
    symptoms: interpretationData.symptoms,
    capacityConstructs: capacityForSummary,
    trainingResponse: interpretationData.trainingResponse,
  });

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Progress Summary</h2>
      <p className="text-sm text-gray-700 leading-relaxed">{sentences.join(" ")}</p>
    </section>
  );
}
