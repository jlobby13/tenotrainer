import {
  buildCapacitySetRows,
  formatCapacityMoreDataReasonLabel,
  formatCapacityQualifyingEvidence,
  formatCapacityStateLabel,
  formatLoadingProfileLabel,
  formatPerformanceUnitLabel,
  formatToleranceClassificationLabel,
  mechanicalComparisonLabelFor,
  type CapacityOpportunityDetail,
  type CapacityResultDetail,
} from "@/lib/clinicianPatientProgress";
import { formatImmediateGuidanceLabel } from "@/lib/clinicianPatientOverview";
import type { CapacityState } from "@/lib/capacityTypes";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import type { CapacityConstructSection } from "@/lib/clinicianPatientProgressServer";
import { ProvenanceFooter } from "./ProvenanceFooter";
import { StatePreviousChip } from "./StatePreviousChip";

// C3 — one card per Capacity construct (LOCKED — Section 9: never an
// overall Capacity state, never merged/averaged across constructs even for
// the same exercise). Renders the EXISTING persisted Stage 3C
// classification verbatim; "Recent loading has been lower" is the ONLY
// wording ever used for recent_loading_lower — never "declining".
export function CapacityConstructCard({ section, now }: { section: CapacityConstructSection; now: Date }) {
  const { current, previous, provenance, displayName } = section;
  const detail = current.detail;

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{displayName}</h3>
          <p className="text-xs text-gray-500">
            {formatLoadingProfileLabel(detail.construct.loadingProfile)} · {formatPerformanceUnitLabel(detail.construct.performanceUnit)}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-base font-medium text-gray-900">{formatCapacityStateLabel(current.resultState as CapacityState)}</span>
        <StatePreviousChip
          current={current.resultState}
          previous={previous?.resultState ?? null}
          previousLabel={previous ? formatCapacityStateLabel(previous.resultState as CapacityState) : null}
        />
      </div>

      <p className="text-sm text-gray-600 mb-3">
        {detail.moreDataNeededReason ? formatCapacityMoreDataReasonLabel(detail.moreDataNeededReason) : formatCapacityQualifyingEvidence(detail)}
      </p>

      <details className="group">
        <summary className="cursor-pointer text-sm text-brand-600 font-medium list-none">
          Why this interpretation? <span className="text-gray-400 group-open:hidden">(show)</span>
          <span className="text-gray-400 hidden group-open:inline">(hide)</span>
        </summary>
        <div className="mt-3 space-y-3">
          {detail.recentOpportunities
            .slice()
            .sort((a, b) => a.patientLocalDate.localeCompare(b.patientLocalDate))
            .map((opp) => (
              <CapacityOpportunityBlock key={opp.rehabSessionId} opportunity={opp} detail={detail} now={now} />
            ))}
        </div>
        <ProvenanceFooter provenance={provenance} now={now} />
      </details>
    </section>
  );
}

function findBaselineId(detail: CapacityResultDetail): string | null {
  // baselineRehabSessionId isn't part of this module's frozen
  // CapacityResultDetail contract (it lives on window_definition, not
  // result_detail) — derived here defensively from the one opportunity that
  // is neither mechanically-higher nor mechanically-lower NOR a qualifying
  // demonstration AND is the earliest by date among recentOpportunities,
  // matching the engine's own "baseline = the 5th-back exposure" placement.
  // If this heuristic ever mismatches, the mechanical-comparison tag simply
  // omits itself (mechanicalComparisonLabelFor returns null) — never a
  // wrong label.
  const candidates = detail.recentOpportunities
    .filter((o) => !detail.mechanicallyHigherRehabSessionIds.includes(o.rehabSessionId) && !detail.mechanicallyLowerRehabSessionIds.includes(o.rehabSessionId))
    .sort((a, b) => a.patientLocalDate.localeCompare(b.patientLocalDate));
  return candidates[0]?.rehabSessionId ?? null;
}

function CapacityOpportunityBlock({ opportunity, detail, now }: { opportunity: CapacityOpportunityDetail; detail: CapacityResultDetail; now: Date }) {
  const sets = buildCapacitySetRows(opportunity);
  const mechanicalLabel = mechanicalComparisonLabelFor(opportunity.rehabSessionId, detail, findBaselineId(detail));

  return (
    <div className="border border-gray-100 rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm mb-2">
        <span className="font-medium text-gray-900">{formatLastSessionLabel(opportunity.patientLocalDate, now)}</span>
        {mechanicalLabel && <span className="text-xs text-gray-500">{mechanicalLabel}</span>}
        <span className="text-xs text-gray-500">{formatToleranceClassificationLabel(opportunity.toleranceClassification)}</span>
        {opportunity.immediateGuidance && <span className="text-xs text-gray-500">{formatImmediateGuidanceLabel(opportunity.immediateGuidance)}</span>}
        {opportunity.isSuccessfulExposure && <span className="text-xs text-green-700">Successful exposure</span>}
      </div>

      <table className="hidden md:table w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="pr-4 py-1 font-medium">Set</th>
            <th className="pr-4 py-1 font-medium">Prescribed</th>
            <th className="py-1 font-medium">Actual</th>
          </tr>
        </thead>
        <tbody>
          {sets.map((s) => (
            <tr key={s.setIndex} className="border-t border-gray-50">
              <td className="pr-4 py-1 text-gray-500">{s.setIndex}</td>
              <td className="pr-4 py-1 text-gray-700">{s.prescribedLabel}</td>
              <td className="py-1 text-gray-700">{s.actualLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="md:hidden space-y-2 text-sm">
        {sets.map((s) => (
          <div key={s.setIndex} className="border-t border-gray-50 pt-2 first:border-0 first:pt-0">
            <p className="text-gray-500">Set {s.setIndex}</p>
            <p className="text-gray-700">Prescribed: {s.prescribedLabel}</p>
            <p className="text-gray-700">Actual: {s.actualLabel}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
