import { getSymptomsCopy } from "@/lib/progressInterpretationLabels";
import type { SymptomsInterpretationSummary } from "@/lib/progressInterpretationTypes";

// Milestone 6, Stage 4, Section B — "Symptoms interpretation". Question:
// "How are my symptoms changing?" Renders the latest persisted
// symptoms_short_window interpretation's patient-safe label + sentence
// (lib/progressInterpretationLabels.ts) — never the raw resultState. When
// no interpretation exists yet (Stage 2 history may still exist), renders
// the restrained SYMPTOMS_FALLBACK_COPY rather than an empty section (§15
// no-interpretation fallback).

const STATE_STYLES: Record<string, string> = {
  symptoms_improving: "bg-green-50 text-green-700 border-green-100",
  symptoms_trending_better: "bg-green-50 text-green-700 border-green-100",
  symptoms_stable: "bg-gray-50 text-gray-600 border-gray-100",
  mixed_symptom_response: "bg-amber-50 text-amber-700 border-amber-100",
  symptoms_trending_higher: "bg-amber-50 text-amber-700 border-amber-100",
};
const DEFAULT_STYLE = "bg-gray-50 text-gray-500 border-gray-100";

export function SymptomsInterpretationCard({ symptoms }: { symptoms: SymptomsInterpretationSummary }) {
  const copy = getSymptomsCopy(symptoms?.resultState ?? null);
  const style = (symptoms && STATE_STYLES[symptoms.resultState]) ?? DEFAULT_STYLE;

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Symptoms</h2>
      <p className="text-xs text-gray-500 mb-4">How are my symptoms changing?</p>
      <div className="flex items-start gap-3">
        <span className={`shrink-0 text-xs font-medium rounded-full border px-2.5 py-1 ${style}`}>{copy.label}</span>
        <div>
          <p className="text-sm text-gray-700">{copy.sentence}</p>
          {copy.secondarySentence && <p className="text-xs text-gray-500 mt-1">{copy.secondarySentence}</p>}
        </div>
      </div>
    </section>
  );
}
