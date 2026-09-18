import {
  CORE_DOMAIN_NAMES,
  formatCoreDomainDirectionLabel,
  formatCoverageEvidenceSentence,
  formatFrequencyPatternLabel,
  formatMsdDefaultLabel,
  formatMsdExpandedNote,
  formatOverallSymptomsLabel,
  formatSymptomsInsufficientLabel,
  formatValuesList,
  type CoreDomainResultDetail,
} from "@/lib/clinicianPatientProgress";
import type { OverallSymptomsState } from "@/lib/symptomClassifier";
import type { SymptomsSection } from "@/lib/clinicianPatientProgressServer";
import { ProvenanceFooter } from "./ProvenanceFooter";
import { StatePreviousChip } from "./StatePreviousChip";

// C3 — Symptoms domain. Renders the EXISTING persisted Stage 3B
// interpretation verbatim (state, per-core-domain direction, MSD as
// supporting information only) — never recomputes a classification, never
// applies a threshold to raw values. `frequencyPattern` is an already-
// persisted, already-classified categorical fact — this component only
// TRANSLATES it to clinician-readable text (formatFrequencyPatternLabel);
// it never re-derives a directional tally from recentValues/previousMedian
// (a prior version did this and was founder-rejected as a partial
// reimplementation of the classifier — see clinicianPatientProgress.ts's
// header). Raw recentValues/previousValues are shown only as-is, in
// expanded evidence, never compared against each other or a threshold.
export function SymptomsSectionCard({ symptoms, now }: { symptoms: SymptomsSection; now: Date }) {
  const current = symptoms.current;
  const previous = symptoms.previous;

  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Symptoms</h2>

      {!current ? (
        <p className="text-sm text-gray-500 py-2">No longitudinal interpretation yet.</p>
      ) : current.detail.status === "insufficient" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium text-gray-900">{formatSymptomsInsufficientLabel()}</span>
            <StatePreviousChip current={current.resultState} previous={previous?.resultState ?? null} previousLabel={previous ? formatOverallSymptomsLabel(previous.resultState as OverallSymptomsState) : null} />
          </div>
          <p className="text-sm text-gray-500">
            {current.detail.eligibleEpisodeCount} of the 10 completed rehab responses needed for a symptom trend are available so far.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium text-gray-900">{formatOverallSymptomsLabel(current.resultState as OverallSymptomsState)}</span>
            <StatePreviousChip current={current.resultState} previous={previous?.resultState ?? null} previousLabel={previous ? formatOverallSymptomsLabel(previous.resultState as OverallSymptomsState) : null} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <CoreDomainTile name={CORE_DOMAIN_NAMES.P} result={current.detail.core.P} />
            <CoreDomainTile name={CORE_DOMAIN_NAMES.MP} result={current.detail.core.MP} />
            <CoreDomainTile name={CORE_DOMAIN_NAMES.MS} result={current.detail.core.MS} />
          </div>

          {formatMsdDefaultLabel(current.detail.msd) && (
            <div className="text-sm text-gray-600">
              <span className="font-medium text-gray-700">Morning stiffness duration — supporting information:</span> {formatMsdDefaultLabel(current.detail.msd)}
            </div>
          )}

          <details className="group">
            <summary className="cursor-pointer text-sm text-brand-600 font-medium list-none">
              Why this interpretation? <span className="text-gray-400 group-open:hidden">(show)</span>
              <span className="text-gray-400 hidden group-open:inline">(hide)</span>
            </summary>
            <div className="mt-3 space-y-3 text-sm text-gray-600">
              <CoreDomainEvidence name={CORE_DOMAIN_NAMES.P} result={current.detail.core.P} />
              <CoreDomainEvidence name={CORE_DOMAIN_NAMES.MP} result={current.detail.core.MP} />
              <CoreDomainEvidence name={CORE_DOMAIN_NAMES.MS} result={current.detail.core.MS} />
              <p>
                <span className="font-medium text-gray-700">Morning stiffness duration (supporting, not part of the Symptoms state):</span>{" "}
                {formatMsdExpandedNote(current.detail.msd)}
              </p>
              <p>{formatCoverageEvidenceSentence(current.detail.coverageRawCounts)}</p>
              {current.detail.distinctPrescriptionVersionIds.length > 1 && <p>This window spans {current.detail.distinctPrescriptionVersionIds.length} distinct prescription versions.</p>}
            </div>
            <ProvenanceFooter provenance={symptoms.provenance} now={now} />
          </details>
        </div>
      )}
    </section>
  );
}

function CoreDomainTile({ name, result }: { name: string; result: CoreDomainResultDetail }) {
  const patternLabel = formatFrequencyPatternLabel(result.frequencyPattern);
  return (
    <div className="border border-gray-100 rounded-lg p-3">
      <p className="text-xs font-medium text-gray-500 mb-1">{name}</p>
      <p className="text-sm font-semibold text-gray-900">{formatCoreDomainDirectionLabel(result.direction)}</p>
      {patternLabel && <p className="text-xs text-gray-500 mt-0.5">{patternLabel}</p>}
    </div>
  );
}

function CoreDomainEvidence({ name, result }: { name: string; result: CoreDomainResultDetail }) {
  const patternLabel = formatFrequencyPatternLabel(result.frequencyPattern);
  return (
    <div>
      <p className="font-medium text-gray-700">{name}</p>
      <p>
        {formatCoreDomainDirectionLabel(result.direction)}
        {patternLabel ? ` · ${patternLabel}` : ""} · consistency: {result.consistency}
      </p>
      <p className="text-xs text-gray-400">
        Recent values: {formatValuesList(result.recentValues)} · Previous values: {formatValuesList(result.previousValues)}
      </p>
      {result.recentMedian !== null && result.previousMedian !== null && (
        <p className="text-xs text-gray-400">
          Median (corroborating only): {result.previousMedian} → {result.recentMedian}
          {result.recentIqr && result.previousIqr ? ` · IQR (context only): ${result.previousIqr.iqr} → ${result.recentIqr.iqr}` : ""}
        </p>
      )}
    </div>
  );
}
