import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getClinicianPatientProgress } from "@/lib/clinicianPatientProgressServer";
import { ACTIVE_ACUTE_REVIEW_CAVEAT } from "@/lib/clinicianPatientProgress";
import { PatientNav } from "../components/PatientNav";
import { SymptomsSectionCard } from "./components/SymptomsSectionCard";
import { CapacityConstructCard } from "./components/CapacityConstructCard";
import { TrainingResponseSectionCard } from "./components/TrainingResponseSectionCard";

export const metadata = { title: "Patient Progress — TenoTrainer" };

// C3 — Longitudinal Clinical Progress. Exposes the EXISTING M6 persisted
// interpretation architecture to clinicians — Symptoms, Capacity, Training
// Response, kept visibly independent (never a combined/recovery/readiness
// score). Fully Next.js/Supabase-native, no FastAPI dependency.
//
// Authorization sequence UNCHANGED from C1A/C2: requireClinicianAuth() ->
// assertSupervises() -> notFound() before ANY interpretation data is read
// -> getClinicianPatientProgress() only after supervision is confirmed.
//
// Current M6 generation behavior does NOT suppress or restart interpretation
// because of an active acute-safety brake, and does NOT create an
// acute-event-driven Capacity series boundary — this page represents that
// honestly with a visible caveat when active, never by hiding, recomputing,
// or invalidating any interpretation. Whether a persistent L4/L5 brake
// SHOULD force a Capacity series boundary remains an intentionally
// unresolved founder/clinical-model question (see docs/m6-stage3c-
// capacity-training-response.md) — this page does not answer it.
export default async function ClinicianPatientProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const progress = await getClinicianPatientProgress(patientId);
  if (!progress) notFound();

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
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{progress.displayName}</h1>
          <PatientNav patientId={progress.patientId} active="progress" />
        </div>

        {progress.acuteReviewActive && (
          <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-800">{ACTIVE_ACUTE_REVIEW_CAVEAT}</div>
        )}

        <SymptomsSectionCard symptoms={progress.symptoms} now={now} />

        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Capacity</h2>
          {progress.capacityConstructs.length === 0 ? (
            <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
              <p className="text-sm text-gray-500 text-center py-4">No Capacity interpretation yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {progress.capacityConstructs.map((section) => (
                <CapacityConstructCard key={section.constructKey} section={section} now={now} />
              ))}
            </div>
          )}
        </section>

        <TrainingResponseSectionCard trainingResponse={progress.trainingResponse} now={now} />
      </main>
    </div>
  );
}
