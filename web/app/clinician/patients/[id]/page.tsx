import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getClinicianPatientShell } from "@/lib/clinicianServer";

export const metadata = { title: "Patient — TenoTrainer" };

// C1A — Clinician Foundation patient shell. `[id]` is now the canonical
// Supabase patient UUID (LOCKED cutover — the prior `parseInt(id, 10)`
// legacy-integer interpretation is gone entirely, along with the FastAPI
// getPatientDetail() call it fed). No dual integer/UUID support: an old
// bookmarked legacy-integer URL now simply fails UUID authorization the
// same way an unrelated real patient UUID would (see the notFound() calls
// below) — intentional, not an oversight.
//
// Authorization happens BEFORE any patient data is read, in this exact
// order: role check (requireClinicianAuth) -> active-supervision check
// (assertSupervises) -> data composition (getClinicianPatientShell). An
// invalid UUID and a valid-but-unauthorized UUID are deliberately
// indistinguishable to the caller — both end in the same notFound(),
// never a different error shape, never a hint that the UUID belongs to a
// real (just unsupervised) patient.
//
// Deliberately restrained: identity + current plan-state only. No legacy
// alerts/adherence/assessments/Recent Sessions/pain-field UI, and no rich
// M6 interpretation yet — those are explicitly out of C1A's scope (see the
// C1A brief's "restrained placeholder for later clinician sections").
export default async function ClinicianPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const patient = await getClinicianPatientShell(patientId);
  if (!patient) notFound();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/clinician/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Patients
        </Link>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-8 lg:py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">{patient.displayName}</h1>
        <p className="text-sm text-gray-500 mb-6">Patient overview</p>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Current stage</span>
            <span className="text-sm font-medium text-gray-900">{patient.currentStage ?? "Not yet available"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">Irritability</span>
            <span className="text-sm font-medium text-gray-900 capitalize">{patient.currentIrritability ?? "Not yet available"}</span>
          </div>
        </div>

        <div className="mt-6 bg-white rounded-xl shadow border border-gray-100 p-6 text-sm text-gray-400">
          Recent response, longitudinal progress, and decision support are coming in a later phase.
        </div>
      </main>
    </div>
  );
}
