import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getPublishedVersionView } from "@/lib/prescriptionReviewServer";
import { ProgramView } from "../../components/ProgramView";
import { LocalDateTime } from "../../components/LocalDateTime";
import { createDraftAction } from "../../actions";

export const metadata = { title: "Published Prescription — TenoTrainer" };

// C5.4D §18 — read-only view of one published prescription version, current
// or historical. Everything shown is read from the version's own immutable
// rows (never the open draft). There is no editing here: changing the
// current prescription goes through the established C5.3 Edit Active flow
// (createDraftAction source=clone_active -> a new draft -> Review -> a NEW
// version), which this page only links into.
export default async function PublishedPrescriptionPage({ params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id: patientId, versionId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const view = await getPublishedVersionView({ clinicianId, patientId, versionId });
  if (!view) notFound();

  const { version } = view;
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
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-gray-900">Prescription — Version {version.versionNumber}</h1>
            {version.isCurrent ? (
              <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800" data-testid="version-status" data-status="current">
                Current
              </span>
            ) : (
              <span className="rounded-full bg-gray-200 px-2.5 py-0.5 text-xs font-semibold text-gray-700" data-testid="version-status" data-status="historical">
                Historical
              </span>
            )}
            <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">Published · read-only</span>
          </div>
          <p className="text-sm text-gray-600" data-testid="version-published-meta">
            Published
            {version.publishedAt && (
              <>
                {" "}
                <LocalDateTime iso={version.publishedAt} />
              </>
            )}
            {version.publishedByName ? ` by ${version.publishedByName}` : ""}
          </p>
          {!version.isCurrent && (
            <p className="text-sm text-gray-600">This version has been superseded. It is kept unchanged in the prescription history.</p>
          )}
        </header>

        {view.paused && version.isCurrent && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">This patient&apos;s prescription is currently paused.</div>
        )}

        <ProgramView program={view.program} />

        <section className="bg-white rounded-xl shadow border border-gray-100 p-4 text-sm space-y-3" data-testid="version-actions">
          <p className="text-gray-600">Published versions cannot be edited. Changes are made in a new draft and published as a new version.</p>
          <div className="flex flex-wrap gap-2">
            {version.isCurrent && !view.openDraft && (
              <form action={createDraftAction}>
                <input type="hidden" name="patientId" value={patientId} />
                <input type="hidden" name="source" value="clone_active" />
                <input type="hidden" name="sourceVersionId" value={version.id} />
                <button type="submit" className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700" data-testid="edit-active">
                  Edit Prescription
                </button>
              </form>
            )}
            {view.openDraft && (
              <Link
                href={`${overviewHref}/builder`}
                className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700"
                data-testid="open-draft"
              >
                {view.openDraft.isOwnedByCaller ? "Continue Editing Draft" : `View Draft (${view.openDraft.editingClinicianName})`}
              </Link>
            )}
            <Link href={overviewHref} className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 hover:bg-gray-50">
              Prescription overview
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
