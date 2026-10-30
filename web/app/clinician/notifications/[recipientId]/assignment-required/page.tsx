import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { getFallbackAssignmentTarget, getSafetyInbox } from "@/lib/safetyNotificationsServer";

export const metadata = { title: "Clinician assignment required — TenoTrainer" };

// M3.2 (founder Decision 2) — copy-only operational state for a fallback
// clinician_admin recipient. Shows only that the patient has no assigned
// clinician; no clinical detail, no patient access, no release authority.
// The only action is a link to the EXISTING M2 assignment surface, which
// keeps its own authorization (this page grants nothing).
export default async function AssignmentRequiredPage({ params }: { params: Promise<{ recipientId: string }> }) {
  const { recipientId } = await params;
  const { clinicianId } = await requireClinicianAuth();
  const item = (await getSafetyInbox(clinicianId)).find((i) => i.recipientId === recipientId && i.basis === "fallback_clinician_admin");
  if (!item) notFound();
  const target = await getFallbackAssignmentTarget(recipientId, clinicianId);
  const assignHref = target
    ? `/admin/assignments?org=${encodeURIComponent(target.organizationId)}&patient=${encodeURIComponent(target.patientId)}`
    : "/admin/assignments";

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <Link href="/clinician/dashboard" className="text-xl font-bold text-brand-600">TenoTrainer</Link>
        <Link href="/clinician/notifications" className="text-sm font-medium text-gray-600 hover:text-brand-700">Safety notifications</Link>
      </nav>
      <main className="max-w-xl mx-auto px-4 py-10">
        <div className="bg-white rounded-xl shadow border border-amber-200 p-6" data-testid="assignment-required">
          <h1 className="text-lg font-semibold text-gray-900 mb-2">Clinician assignment required</h1>
          <p className="text-sm text-gray-700 mb-3" data-testid="assignment-required-patient">Patient: {item.patientName ?? "Patient"}</p>
          <p className="text-sm text-gray-700 mb-3">
            No clinician is currently assigned to this patient. The safety review cannot be completed from this notification.
          </p>
          <p className="text-sm text-gray-700">
            A clinician must be assigned by an administrator with assignment authority before the safety review can be completed.
          </p>
          <a href={assignHref} className="mt-4 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700" data-testid="assignment-required-cta">
            Assign clinician
          </a>
        </div>
      </main>
    </div>
  );
}
