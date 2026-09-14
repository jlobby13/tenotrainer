import { getCapacityCopy, disambiguateCapacityDisplayNames, CAPACITY_SECTION_EMPTY_COPY } from "@/lib/progressInterpretationLabels";
import type { CapacityConstructSummary } from "@/lib/progressInterpretationTypes";

// Milestone 6, Stage 4, Section D — "Loading Capacity". Question: "What am
// I able to do?" Capacity is always construct-specific — one card per
// comparable construct (lib/progressInterpretationLabels.ts's
// disambiguateCapacityDisplayNames resolves the patient-facing exercise
// name/disambiguation). NEVER computes or displays an overall Capacity
// score, and NEVER hides a construct solely because its state is
// more_comparable_data_needed — every construct the patient has a
// persisted interpretation for gets its own card.

const STATE_STYLES: Record<string, string> = {
  loading_capacity_improving: "bg-green-50 text-green-700 border-green-100",
  loading_capacity_stable: "bg-gray-50 text-gray-600 border-gray-100",
  capacity_building: "bg-blue-50 text-blue-700 border-blue-100",
  loading_pattern_variable: "bg-amber-50 text-amber-700 border-amber-100",
};
const DEFAULT_STYLE = "bg-gray-50 text-gray-500 border-gray-100";

function ConstructCard({ construct, displayName }: { construct: CapacityConstructSummary; displayName: string }) {
  const copy = getCapacityCopy(construct.resultState, construct.moreDataNeededReason);
  const style = STATE_STYLES[construct.resultState] ?? DEFAULT_STYLE;

  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
        <p className="text-sm font-medium text-gray-900">{displayName}</p>
        <span className={`shrink-0 text-xs font-medium rounded-full border px-2.5 py-0.5 ${style}`}>{copy.label}</span>
      </div>
      <p className="text-sm text-gray-700">{copy.sentence}</p>
      {copy.secondarySentence && <p className="text-xs text-gray-500 mt-1">{copy.secondarySentence}</p>}
    </div>
  );
}

export function CapacityConstructSection({ capacityConstructs }: { capacityConstructs: CapacityConstructSummary[] }) {
  const withDisplayNames = disambiguateCapacityDisplayNames(capacityConstructs);

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-base font-semibold text-gray-900 mb-1">Loading Capacity</h2>
      <p className="text-xs text-gray-500 mb-4">What am I able to do?</p>
      {withDisplayNames.length === 0 ? (
        <p className="text-sm text-gray-400">{CAPACITY_SECTION_EMPTY_COPY.sentence}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {withDisplayNames.map((c) => (
            <ConstructCard key={c.constructKey} construct={c} displayName={c.displayName} />
          ))}
        </div>
      )}
    </section>
  );
}
