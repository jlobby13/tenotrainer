import {
  formatDimensionComparisonLabel,
  formatLoadingDirectionLabel,
  formatOverallSymptomsLabel,
  formatTrainingResponseInsufficientLabel,
  formatTrainingResponseStateLabel,
  formatUsablePairEvidence,
  type TrainingResponseConstructResultDetail,
} from "@/lib/clinicianPatientProgress";
import type { TrainingResponseState } from "@/lib/capacityTypes";
import type { OverallSymptomsState } from "@/lib/symptomClassifier";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import type { TrainingResponseSection } from "@/lib/clinicianPatientProgressServer";
import { ProvenanceFooter } from "./ProvenanceFooter";
import { StatePreviousChip } from "./StatePreviousChip";

// C3 — Training Response domain. Renders the EXISTING persisted Stage 3C
// classification verbatim — never re-pairs exposures, never averages
// comparisons, never re-votes the multi-construct aggregation. "Training
// Response" is explicitly labeled as how the tendon responds to loading,
// never described as Capacity or adherence, never turned into a
// recommendation.
export function TrainingResponseSectionCard({ trainingResponse, now }: { trainingResponse: TrainingResponseSection; now: Date }) {
  const { current, previous, provenance, constructDisplayNames } = trainingResponse;
  const dateByRehabSessionId = new Map((provenance?.rehabSessionDates ?? []).map((s) => [s.rehabSessionId, s.patientLocalDate]));

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Training Response</h2>
      <p className="text-xs text-gray-400 mb-3">How the tendon responds to loading.</p>

      {!current ? (
        <p className="text-sm text-gray-500 py-2">No longitudinal interpretation yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium text-gray-900">
              {current.resultState === "more_data_needed" ? formatTrainingResponseInsufficientLabel() : formatTrainingResponseStateLabel(current.resultState as TrainingResponseState)}
            </span>
            <StatePreviousChip
              current={current.resultState}
              previous={previous?.resultState ?? null}
              previousLabel={
                previous
                  ? previous.resultState === "more_data_needed"
                    ? formatTrainingResponseInsufficientLabel()
                    : formatTrainingResponseStateLabel(previous.resultState as TrainingResponseState)
                  : null
              }
            />
          </div>

          {current.detail.status === "generated" && (
            <div className="text-sm text-gray-600 space-y-0.5">
              <p>Symptoms input: {formatOverallSymptomsLabel(current.detail.overallSymptomsState as OverallSymptomsState)}</p>
              <p>Loading comparison: {formatLoadingDirectionLabel(current.detail.overallLoadingDirection)}</p>
            </div>
          )}

          <details className="group">
            <summary className="cursor-pointer text-sm text-brand-600 font-medium list-none">
              Why this interpretation? <span className="text-gray-400 group-open:hidden">(show)</span>
              <span className="text-gray-400 hidden group-open:inline">(hide)</span>
            </summary>
            <div className="mt-3 space-y-3">
              {current.detail.status === "generated" &&
                current.detail.constructResults.map((c) => (
                  <ConstructResultBlock
                    key={JSON.stringify(c.construct)}
                    result={c}
                    displayName={constructDisplayNames.get(JSON.stringify(c.construct)) ?? c.construct.exId}
                    dateByRehabSessionId={dateByRehabSessionId}
                    now={now}
                  />
                ))}
              {current.detail.status === "insufficient" && <p className="text-sm text-gray-500">Not enough Symptoms history yet to align a loading-comparison window.</p>}
            </div>
            <ProvenanceFooter provenance={provenance} now={now} />
          </details>
        </div>
      )}
    </section>
  );
}

function ConstructResultBlock({
  result,
  displayName,
  dateByRehabSessionId,
  now,
}: {
  result: TrainingResponseConstructResultDetail;
  displayName: string;
  dateByRehabSessionId: Map<string, string>;
  now: Date;
}) {
  const formatSessionDate = (id: string) => {
    const date = dateByRehabSessionId.get(id);
    return date ? formatLastSessionLabel(date, now) : id;
  };
  const unmatchedCount = result.unmatchedPreviousRehabSessionIds.length + result.unmatchedRecentRehabSessionIds.length;

  return (
    <div className="border border-gray-100 rounded-lg p-3 text-sm">
      <p className="font-medium text-gray-900 mb-1">{displayName}</p>
      <p className="text-gray-600 mb-1">
        {result.direction === "insufficient" ? "Not enough usable pairs for this exercise." : `Direction: ${formatLoadingDirectionLabel(result.direction)}`}
      </p>
      <p className="text-xs text-gray-500 mb-2">{formatUsablePairEvidence(result)}</p>

      {result.pairs.length > 0 && (
        <ul className="text-xs text-gray-500 space-y-0.5 mb-1">
          {result.pairs.map((p, i) => (
            <li key={i}>
              {formatSessionDate(p.previousRehabSessionId)} → {formatSessionDate(p.recentRehabSessionId)}: {formatDimensionComparisonLabel(p.comparison)}
            </li>
          ))}
        </ul>
      )}

      {unmatchedCount > 0 && (
        <p className="text-xs text-gray-400">
          {unmatchedCount} session{unmatchedCount === 1 ? "" : "s"} in this window {unmatchedCount === 1 ? "was" : "were"} not paired.
        </p>
      )}
    </div>
  );
}
