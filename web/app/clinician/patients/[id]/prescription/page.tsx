import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getPrescriptionManagementState } from "@/lib/prescriptionManagementServer";
import { formatLastSessionLabel } from "@/lib/clinicianRoster";
import { PatientNav } from "../components/PatientNav";
import { createDraftAction } from "./actions";

export const metadata = { title: "Prescription — TenoTrainer" };

const ERROR_MESSAGES: Record<string, string> = {
  PATIENT_NOT_AUTHORIZED: "Prescription creation could not be authorized for this patient. Please refresh and try again.",
  DRAFT_ALREADY_EXISTS: "A draft already exists for this patient — reloading the current draft.",
  INTERNAL_ERROR: "Something went wrong creating the prescription draft. Please try again.",
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
  searchParams: Promise<{ error?: string }>;
}) {
  const { id: patientId } = await params;
  const { error } = await searchParams;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const state = await getPrescriptionManagementState({ clinicianId, patientId });
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
          <h1 className="text-2xl font-bold text-gray-900 mb-3">Prescription</h1>
          <PatientNav patientId={patientId} active="prescription" />
        </div>

        {error && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">
            {ERROR_MESSAGES[error] ?? "Something went wrong. Please try again."}
          </div>
        )}

        {state.operationalStatus === "paused" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3 font-medium">
            Prescription Paused — the patient will not see daily rehab until this is resumed. Draft editing remains available below.
          </div>
        )}

        {state.draft ? (
          <DraftExistsCard patientId={patientId} draft={state.draft} now={now} />
        ) : state.hasActivePrescription && state.activeSummary ? (
          <ActivePrescriptionCard patientId={patientId} summary={state.activeSummary} now={now} />
        ) : (
          <NoPrescriptionCard patientId={patientId} />
        )}
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
  now,
}: {
  patientId: string;
  summary: { versionId: string; versionNumber: number; stage: number; publishedAt: string };
  now: Date;
}) {
  return (
    <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-4">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Active Prescription</h2>
      <div className="space-y-2 text-sm">
        <Row label="Version" value={`v${summary.versionNumber}`} />
        <Row label="Stage" value={`Stage ${summary.stage}`} />
        <Row label="Published" value={formatLastSessionLabel(summary.publishedAt, now)} />
      </div>
      <form action={createDraftAction}>
        <input type="hidden" name="patientId" value={patientId} />
        <input type="hidden" name="source" value="clone_active" />
        <input type="hidden" name="sourceVersionId" value={summary.versionId} />
        <button type="submit" className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Edit Prescription
        </button>
      </form>
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
      <Link
        href={`/clinician/patients/${patientId}/prescription/builder`}
        className="inline-flex items-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        {draft.isOwnedByCaller ? "Continue Editing" : "View Draft"}
      </Link>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value}</span>
    </div>
  );
}
