import Link from "next/link";
import { NEW_CAPACITY_CONSTRUCT_TITLE, NEW_CAPACITY_CONSTRUCT_COPY, formatPrescriptionSourceLabel } from "@/lib/clinicianPatientReview";
import { formatOverallSymptomsLabel, formatTrainingResponseStateLabel, formatCapacityStateLabel, formatCapacityMoreDataReasonLabel } from "@/lib/clinicianPatientProgress";
import { formatIrritabilityLabel, formatInsertionalLabel } from "@/lib/clinicianPatientOverview";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import type { OverallSymptomsState } from "@/lib/symptomClassifier";
import type { CapacityState, TrainingResponseState } from "@/lib/capacityTypes";
import type { ClinicianPatientReview } from "@/lib/clinicianPatientReviewServer";

const PROGRESS_EVIDENCE_LABEL = "View longitudinal evidence → Progress";
const OVERVIEW_EVIDENCE_LABEL = "View session evidence → Overview";

// C4 — What Changed. LOCKED signal set only (Section 6): clean transitions
// between already-persisted snapshots — never a new interpretation of
// whether a transition is clinically good or bad beyond what the persisted
// states already mean. Every item here is produced by
// clinicianPatientReview.ts's detectStateChange/detectCapacityConstructChange/
// detectPrescriptionChange — trivial equality/difference comparisons only.
export function WhatChangedSection({ review, now }: { review: ClinicianPatientReview; now: Date }) {
  const { symptoms, trainingResponse, capacityConstructs, capacityConstructDisplayNames, prescription } = review.whatChanged;
  const progressHref = `/clinician/patients/${review.patientId}/progress`;
  const overviewHref = `/clinician/patients/${review.patientId}`;
  const hasAny = symptoms !== null || trainingResponse !== null || capacityConstructs.length > 0 || prescription !== null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">What Changed</h2>
      {!hasAny ? (
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <p className="text-sm text-gray-500 text-center py-2">No factual changes since the previous interpretation.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {symptoms && (
            <ChangeCard
              title="Symptoms state changed"
              current={formatOverallSymptomsLabel(symptoms.current as OverallSymptomsState)}
              previous={formatOverallSymptomsLabel(symptoms.previous as OverallSymptomsState)}
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
            />
          )}

          {trainingResponse && (
            <ChangeCard
              title="Training Response state changed"
              current={formatTrainingResponseStateLabel(trainingResponse.current as TrainingResponseState)}
              previous={formatTrainingResponseStateLabel(trainingResponse.previous as TrainingResponseState)}
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
            />
          )}

          {capacityConstructs.map((item) => {
            const key = JSON.stringify(item.current.construct);
            const displayName = capacityConstructDisplayNames.get(key) ?? item.current.construct.exId;

            if (item.kind === "new") {
              return (
                <div key={key} className="bg-white rounded-xl shadow border border-gray-100 p-4">
                  <p className="text-sm font-medium text-gray-900">
                    {NEW_CAPACITY_CONSTRUCT_TITLE}: {displayName}
                  </p>
                  <p className="text-sm text-gray-600 mt-1">{NEW_CAPACITY_CONSTRUCT_COPY}</p>
                  {item.current.moreDataNeededReason && item.current.moreDataNeededReason !== "recent_loading_lower" && (
                    <p className="text-xs text-gray-500 mt-1">{formatCapacityMoreDataReasonLabel(item.current.moreDataNeededReason)}</p>
                  )}
                  <Link href={progressHref} className="text-sm text-brand-600 font-medium mt-2 inline-block">
                    {PROGRESS_EVIDENCE_LABEL}
                  </Link>
                </div>
              );
            }

            return (
              <ChangeCard
                key={key}
                title={`Capacity state changed: ${displayName}`}
                current={formatCapacityStateLabel(item.current.resultState as CapacityState)}
                previous={formatCapacityStateLabel(item.previousResultState as CapacityState)}
                href={progressHref}
                linkLabel={PROGRESS_EVIDENCE_LABEL}
              />
            );
          })}

          {prescription && (
            <div className="bg-white rounded-xl shadow border border-gray-100 p-4">
              <p className="text-sm font-medium text-gray-900">Prescription version changed</p>
              <div className="text-sm text-gray-600 mt-1 space-y-0.5">
                <p>
                  Version date: {formatLastSessionLabel(prescription.previous.createdAt, now)} → {formatLastSessionLabel(prescription.current.createdAt, now)}
                </p>
                <p>
                  Stage: {prescription.previous.stage} → {prescription.current.stage}
                </p>
                <p>
                  Irritability: {formatIrritabilityLabel(prescription.previous.irritability)} → {formatIrritabilityLabel(prescription.current.irritability)}
                </p>
                <p>
                  Classification: {formatInsertionalLabel(prescription.previous.isInsertional)} → {formatInsertionalLabel(prescription.current.isInsertional)}
                </p>
                <p className="text-xs text-gray-400">
                  Source: {formatPrescriptionSourceLabel(prescription.previous.source)} → {formatPrescriptionSourceLabel(prescription.current.source)}
                </p>
              </div>
              <p className="text-xs text-gray-400 mt-2">This is chronology only — it does not imply the prescription caused any observed change.</p>
              <Link href={overviewHref} className="text-sm text-brand-600 font-medium mt-2 inline-block">
                {OVERVIEW_EVIDENCE_LABEL}
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ChangeCard({ title, current, previous, href, linkLabel }: { title: string; current: string; previous: string; href: string; linkLabel: string }) {
  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 p-4">
      <p className="text-sm font-medium text-gray-900">{title}</p>
      <p className="text-sm mt-1">
        <span className="font-medium text-gray-800">{current}</span>
        <span className="text-gray-400"> ← </span>
        <span className="text-gray-500">{previous}</span>
      </p>
      <p className="text-xs text-gray-400">Current ← Previous</p>
      <Link href={href} className="text-sm text-brand-600 font-medium mt-2 inline-block">
        {linkLabel}
      </Link>
    </div>
  );
}
