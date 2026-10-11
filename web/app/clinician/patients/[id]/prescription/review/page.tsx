import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getPrescriptionReviewState } from "@/lib/prescriptionReviewServer";
import { builderHref, type ReviewIssue } from "@/lib/prescriptionProgram";
import { ProgramView } from "../components/ProgramView";
import { ReviewPublishClient } from "./ReviewPublishClient";

export const metadata = { title: "Prescription Review — TenoTrainer" };

// C5.4D — Review → Validation → Publish. Same authorization sequence as
// every clinician patient route (requireClinicianAuth -> assertSupervises ->
// notFound). Rendering is strictly read-only: it never creates a draft and
// never writes to the one it shows. Publishing goes through the existing
// C5.3 publish route, which re-derives every check server-side; nothing this
// page decides (button state, validation display) is a security boundary.
export default async function PrescriptionReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const state = await getPrescriptionReviewState({ clinicianId, patientId });
  const overviewHref = `/clinician/patients/${patientId}/prescription`;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href={overviewHref} className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          ← Prescription overview
        </Link>
      </nav>

      <main className="max-w-4xl mx-auto px-4 py-6 lg:py-8 space-y-5">
        <header>
          <h1 className="text-2xl font-bold text-gray-900">Prescription Review</h1>
          <p className="mt-1 text-sm text-gray-600">Review the complete program before publishing it.</p>
        </header>

        {state.kind === "no_draft" ? (
          <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-3 text-sm" data-testid="review-no-draft">
            <p className="font-medium text-gray-900">There is no prescription draft to review.</p>
            {state.currentVersion && (
              <p className="text-gray-600">Version {state.currentVersion.versionNumber} is the patient&apos;s current published prescription.</p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              {state.currentVersion && (
                <Link
                  href={`${overviewHref}/versions/${state.currentVersion.id}`}
                  className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                  View Published Prescription
                </Link>
              )}
              <Link href={overviewHref} className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Prescription overview
              </Link>
            </div>
          </section>
        ) : (
          <ReviewPublishClient
            patientId={patientId}
            draftId={state.draftId}
            fingerprint={state.fingerprint}
            isOwner={state.isOwner}
            editingClinicianName={state.editingClinicianName}
            publishEnabled={state.publishEnabled}
            issueCount={state.issues.length}
            replacesVersionNumber={state.currentVersion?.versionNumber ?? null}
            editHref={builderHref(patientId)}
          >
            {state.paused && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">
                This patient&apos;s prescription is currently paused. Publishing a new version does not resume it.
              </div>
            )}
            <ValidationPanel issues={state.issues} />
            <ProgramView program={state.program} issues={state.issues} />
          </ReviewPublishClient>
        )}
      </main>
    </div>
  );
}

function ValidationPanel({ issues }: { issues: ReviewIssue[] }) {
  if (issues.length === 0) {
    return (
      <section className="rounded-xl border border-green-200 bg-green-50 px-4 py-3" data-testid="validation-ready" role="status">
        <p className="font-semibold text-green-800">Ready to publish ✓</p>
        <p className="text-sm text-green-700">All publication checks passed.</p>
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 space-y-2" data-testid="validation-issues" data-issue-count={issues.length}>
      <p className="font-semibold text-red-800">
        {issues.length} {issues.length === 1 ? "issue needs" : "issues need"} attention
      </p>
      <ul className="space-y-2">
        {issues.map((issue) => (
          <li key={issue.key} className="rounded-lg bg-white/70 border border-red-100 px-3 py-2 text-sm flex flex-wrap items-start justify-between gap-x-3 gap-y-1" data-testid="validation-issue" data-rule={issue.rule}>
            <div className="min-w-0">
              {(issue.workoutLabel || issue.exerciseName) && (
                <p className="font-semibold text-gray-900 break-words" data-testid="issue-context">
                  {[issue.workoutLabel, issue.exerciseName].filter(Boolean).join(" · ")}
                </p>
              )}
              <p className="text-red-800" data-testid="issue-message">
                {issue.message}
              </p>
            </div>
            {issue.action && (
              <Link href={issue.action.href} className="shrink-0 font-medium text-brand-700 hover:text-brand-800 whitespace-nowrap" data-testid="issue-action" data-action-kind={issue.action.kind}>
                {issue.action.label} →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
