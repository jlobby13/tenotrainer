import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth, assertSupervises } from "@/lib/clinicianAuth";
import { getClinicianPatientReview } from "@/lib/clinicianPatientReviewServer";
import { PatientNav } from "../components/PatientNav";
import { SafetySection } from "./components/SafetySection";
import { WhatChangedSection } from "./components/WhatChangedSection";
import { ReviewContextSection } from "./components/ReviewContextSection";

export const metadata = { title: "Patient Review — TenoTrainer" };

// C4 — Clinical Decision Support. Exposes already-persisted C2/C3 evidence
// as neutral, factual review signals — never a recommendation, never a
// score, never an automated prescription action. See
// clinicianPatientReviewServer.ts's header for the exact read-only
// composition boundary this page renders.
//
// Authorization sequence UNCHANGED from C1A/C2/C3: requireClinicianAuth()
// -> assertSupervises() -> notFound() before ANY review data is read ->
// getClinicianPatientReview() only after supervision is confirmed.
//
// C5 handoff (Section 26): no "Review prescription" button is rendered —
// the C5 route does not exist yet, and a placeholder that goes nowhere
// would be a fake action. This page intentionally has NO action affordance
// at all; that is the correct v1 behavior, not an oversight.
export default async function ClinicianPatientReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: patientId } = await params;
  const { clinicianId } = await requireClinicianAuth();

  const supervises = await assertSupervises(clinicianId, patientId);
  if (!supervises) notFound();

  const review = await getClinicianPatientReview(patientId);
  if (!review) notFound();

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
          <h1 className="text-2xl font-bold text-gray-900 mb-3">{review.displayName}</h1>
          <PatientNav patientId={review.patientId} active="review" />
        </div>

        <SafetySection active={review.acuteReviewActive} />
        <WhatChangedSection review={review} now={now} />
        <ReviewContextSection review={review} />
      </main>
    </div>
  );
}
