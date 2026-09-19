import Link from "next/link";
import { NO_RECENT_SESSION_TEXT } from "@/lib/clinicianPatientReview";
import type { ClinicianPatientReview } from "@/lib/clinicianPatientReviewServer";

const EXTERNAL_LOAD_NOTE = "Reported external activity was present in this interpretation window.";
const PROGRESS_EVIDENCE_LABEL = "View longitudinal evidence → Progress";
const OVERVIEW_EVIDENCE_LABEL = "View session evidence → Overview";

// C4 — Review Context. LOCKED (Sections 8-16): CURRENT persisted-state
// signals, independent of whether they just changed (a signal here may also
// appear in What Changed if it happens to have just transitioned — that
// duplication is intentional, never suppressed to avoid it). Only the exact
// founder-approved states ever produce a card: symptoms_trending_higher,
// mixed_symptom_response, variable_training_response,
// training_response_remains_unsettled, and Capacity's recent_loading_lower.
// "More data needed" is informational only, never framed as review-worthy.
// External load is attached evidence on an already-surfaced signal only —
// never a standalone card.
export function ReviewContextSection({ review }: { review: ClinicianPatientReview }) {
  const { symptoms, trainingResponse, capacityRecentLower, morningResponseStatus, noRecentQualifyingSession } = review.reviewContext;
  const progressHref = `/clinician/patients/${review.patientId}/progress`;
  const overviewHref = `/clinician/patients/${review.patientId}`;

  const hasAny =
    symptoms.signal !== null ||
    symptoms.moreDataNeeded ||
    trainingResponse.signal !== null ||
    trainingResponse.moreDataNeeded ||
    capacityRecentLower.length > 0 ||
    morningResponseStatus !== null ||
    noRecentQualifyingSession;

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Review Context</h2>
      {!hasAny ? (
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <p className="text-sm text-gray-500 text-center py-2">Nothing currently warrants review.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {symptoms.signal === "trending_higher" && (
            <SignalCard
              title="Symptoms are trending higher"
              whyShown="Based on the latest persisted Symptoms interpretation."
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
              externalLoadReported={symptoms.externalLoadReported}
            />
          )}
          {symptoms.signal === "mixed" && (
            <SignalCard
              title="Symptom response is mixed"
              whyShown="Based on the latest persisted Symptoms interpretation."
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
              externalLoadReported={symptoms.externalLoadReported}
            />
          )}
          {symptoms.moreDataNeeded && (
            <SignalCard title="Symptoms: More data needed" whyShown="The latest interpretation window did not have enough data to classify a trend." href={progressHref} linkLabel={PROGRESS_EVIDENCE_LABEL} />
          )}

          {trainingResponse.signal === "variable" && (
            <SignalCard
              title="Training Response is variable"
              whyShown="Based on the latest persisted Training Response interpretation."
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
              externalLoadReported={trainingResponse.externalLoadReported}
            />
          )}
          {trainingResponse.signal === "unsettled" && (
            <SignalCard
              title="Training Response remains unsettled"
              whyShown="Based on the latest persisted Training Response interpretation."
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
              externalLoadReported={trainingResponse.externalLoadReported}
            />
          )}
          {trainingResponse.moreDataNeeded && (
            <SignalCard title="Training Response: More data needed" whyShown="The latest interpretation window did not have enough paired data to classify a response." href={progressHref} linkLabel={PROGRESS_EVIDENCE_LABEL} />
          )}

          {capacityRecentLower.map((c) => (
            <SignalCard
              key={c.constructKey}
              title={c.displayName}
              description="Recent loading has been lower."
              whyShown="Based on the latest persisted Capacity interpretation for this construct."
              href={progressHref}
              linkLabel={PROGRESS_EVIDENCE_LABEL}
              externalLoadReported={c.externalLoadReported}
            />
          ))}

          {morningResponseStatus === "due" && (
            <SignalCard title="Morning response due" whyShown="An outstanding morning-response obligation exists for a recent session." href={overviewHref} linkLabel={OVERVIEW_EVIDENCE_LABEL} />
          )}
          {morningResponseStatus === "pending" && (
            <SignalCard title="Morning response pending" whyShown="A morning-response obligation exists but its eligibility timing is not yet known." href={overviewHref} linkLabel={OVERVIEW_EVIDENCE_LABEL} />
          )}

          {noRecentQualifyingSession && <SignalCard title={NO_RECENT_SESSION_TEXT} />}
        </div>
      )}
    </section>
  );
}

function SignalCard({
  title,
  description,
  whyShown,
  href,
  linkLabel,
  externalLoadReported,
}: {
  title: string;
  description?: string;
  whyShown?: string;
  href?: string;
  linkLabel?: string;
  externalLoadReported?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 p-4">
      <p className="text-sm font-medium text-gray-900">{title}</p>
      {description && <p className="text-sm text-gray-600 mt-1">{description}</p>}
      {whyShown && <p className="text-xs text-gray-400 mt-1">{whyShown}</p>}
      {externalLoadReported && <p className="text-xs text-gray-400 mt-1">{EXTERNAL_LOAD_NOTE}</p>}
      {href && linkLabel && (
        <Link href={href} className="text-sm text-brand-600 font-medium mt-2 inline-block">
          {linkLabel}
        </Link>
      )}
    </div>
  );
}
