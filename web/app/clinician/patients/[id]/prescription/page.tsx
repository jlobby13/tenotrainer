import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getPrescriptionManagementState } from "@/lib/prescriptionManagementServer";
import { listPublishedVersions, type PublishedVersionListItem } from "@/lib/prescriptionReviewServer";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import { PatientNav } from "../components/PatientNav";
import { isC5Patient } from "@/lib/clinicianC5Server";
import { createDraftAction } from "./actions";
import { LocalDateTime } from "./components/LocalDateTime";
import { ProgramPauseControl } from "./components/ProgramPauseControl";

export const metadata = { title: "Prescription — TenoTrainer" };

const ERROR_MESSAGES: Record<string, string> = {
  PATIENT_NOT_AUTHORIZED: "Prescription creation could not be authorized for this patient. Please refresh and try again.",
  DRAFT_ALREADY_EXISTS: "A draft already exists for this patient — reloading the current draft.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
  PRESCRIPTION_ALREADY_PAUSED: "The program was already paused — the current state is shown below.",
  PRESCRIPTION_ALREADY_ACTIVE: "The program was already active — the current state is shown below.",
  VALIDATION_FAILED: "There is no program to pause for this patient.",
};

const NOTICE_MESSAGES: Record<string, string> = {
  paused: "Program paused. New sessions are unavailable until it is resumed.",
  resumed: "Program resumed. Future eligible training is available again.",
};

// C5.4A — Prescription Management entry point (brief §1). Server-rendered,
// same authorization sequence as every other clinician patient route:
// requireClinicianAuth() -> assertSupervises() -> notFound() before any
// patient data is read. The only mutation this page can trigger (draft
// creation) goes through a Server Action -> createDraft(), which re-derives
// the full high-consequence authorization itself; this page's own
// assertSupervises() call is never treated as sufficient for that.
export default async function PrescriptionManagementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { id: patientId } = await params;
  const { error, notice } = await searchParams;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const [state, versions, c5] = await Promise.all([
    getPrescriptionManagementState({ clinicianId, patientId }),
    listPublishedVersions(patientId),
    isC5Patient(patientId),
  ]);
  const now = new Date();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/clinician/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Patients
        </Link>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-8 lg:py-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{c5 ? "Program" : "Prescription"}</h1>
          <PatientNav patientId={patientId} active="prescription" isC5={c5} />
        </div>

        {error && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">
            {ERROR_MESSAGES[error] ?? "Something went wrong. Please try again."}
          </div>
        )}

        {notice && NOTICE_MESSAGES[notice] && (
          <div className="rounded-lg border border-green-200 bg-green-50 text-green-800 text-sm px-4 py-3" data-testid="program-notice">
            {NOTICE_MESSAGES[notice]}
          </div>
        )}

        {/* M2 — clinician pause/resume (C5 programs: the C5 runtime is what
            enforces a pause). Legacy patients keep the read-only banner. */}
        {c5 && state.operationalStatus && (state.hasActivePrescription || state.operationalStatus === "paused") ? (
          <ProgramPauseControl
            patientId={patientId}
            status={state.operationalStatus}
            pausedAt={state.pause?.pausedAt ?? null}
            pausedByName={state.pause?.pausedByName ?? null}
          />
        ) : (
          state.operationalStatus === "paused" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3 font-medium">
              Prescription Paused — the patient will not see daily rehab until this is resumed. Draft editing remains available below.
            </div>
          )
        )}

        {state.draft ? (
          <DraftExistsCard patientId={patientId} draft={state.draft} now={now} />
        ) : state.hasActivePrescription && state.activeSummary ? (
          <ActivePrescriptionCard patientId={patientId} summary={state.activeSummary} />
        ) : (
          <NoPrescriptionCard patientId={patientId} />
        )}

        {versions.length > 0 && <VersionHistoryCard patientId={patientId} versions={versions} />}
      </main>
    </div>
  );
}

function NoPrescriptionCard({ patientId }: { patientId: string }) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6 text-center space-y-4">
      <p className="text-sm text-gray-500">This patient has no prescription yet.</p>
      <form action={createDraftAction}>
        <input type="hidden" name="patientId" value={patientId} />
        <input type="hidden" name="source" value="empty" />
        <button type="submit" className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Create Prescription
        </button>
      </form>
    </section>
  );
}

function ActivePrescriptionCard({
  patientId,
  summary,
}: {
  patientId: string;
  summary: { versionId: string; versionNumber: number; stage: number; publishedAt: string };
}) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Active Prescription</h2>
      <div className="space-y-2 text-sm">
        <Row label="Version" value={`v${summary.versionNumber}`} />
        <Row label="Stage" value={`Stage ${summary.stage}`} />
        <Row label="Published" value={<LocalDateTime iso={summary.publishedAt} />} />
      </div>
      <div className="flex flex-wrap gap-2">
        <form action={createDraftAction}>
          <input type="hidden" name="patientId" value={patientId} />
          <input type="hidden" name="source" value="clone_active" />
          <input type="hidden" name="sourceVersionId" value={summary.versionId} />
          <button type="submit" className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
            Edit Prescription
          </button>
        </form>
        <Link
          href={`/clinician/patients/${patientId}/prescription/versions/${summary.versionId}`}
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          data-testid="view-current-version"
        >
          View Published Prescription
        </Link>
      </div>
    </section>
  );
}

function DraftExistsCard({
  patientId,
  draft,
  now,
}: {
  patientId: string;
  draft: { source: string; createdAt: string; editingClinicianName: string; isOwnedByCaller: boolean; workoutCount: number; exerciseCount: number };
  now: Date;
}) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Draft In Progress</h2>
      <div className="space-y-2 text-sm">
        <Row label="Started" value={formatLastSessionLabel(draft.createdAt, now)} />
        <Row label="Editing clinician" value={draft.isOwnedByCaller ? "You" : draft.editingClinicianName} />
        <Row label="Exercises" value={`${draft.exerciseCount}`} />
      </div>
      {!draft.isOwnedByCaller && (
        <p className="text-sm text-gray-500">
          This draft is currently being edited by {draft.editingClinicianName}. You may open it to view progress, but only they can make changes.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/clinician/patients/${patientId}/prescription/builder`}
          className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          {draft.isOwnedByCaller ? "Continue Editing" : "View Draft"}
        </Link>
        <Link
          href={`/clinician/patients/${patientId}/prescription/review`}
          className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          data-testid="overview-review-link"
        >
          Review Prescription
        </Link>
      </div>
    </section>
  );
}

// C5.4D — every published version stays inspectable (read-only), newest
// first; the current one is marked.
function VersionHistoryCard({ patientId, versions }: { patientId: string; versions: PublishedVersionListItem[] }) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-3" data-testid="version-history">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Version History</h2>
      <ul className="divide-y divide-gray-100 text-sm">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2">
              <span className="font-medium text-gray-900">Version {v.versionNumber}</span>
              {v.isCurrent && <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">Current</span>}
              {v.publishedAt && (
                <span className="text-gray-500">
                  <LocalDateTime iso={v.publishedAt} />
                </span>
              )}
            </span>
            <Link href={`/clinician/patients/${patientId}/prescription/versions/${v.id}`} className="font-medium text-brand-700 hover:text-brand-800" data-testid="version-history-link">
              View
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  );
}
