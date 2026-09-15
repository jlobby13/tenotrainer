import Link from "next/link";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { getClinicianRoster } from "@/lib/clinicianServer";

export const metadata = { title: "Clinician Dashboard — TenoTrainer" };

// C1A — Clinician Foundation dashboard. Fully Next.js/Supabase-native: no
// FastAPI dependency of any kind (contrast with the prior version, which
// called getClinicianPatients() for every field shown here). Deliberately
// minimal — proving correct native roster identity + UUID routing is the
// C1A objective; the richer roster information architecture (last session,
// pending morning response, acute-safety status, etc. — see the C1
// Foundation audit's "minimum C1 roster dataset" recommendation) is C1B's
// job, not this one. No legacy status/alert/adherence concept is
// reproduced here — those have no Postgres-native definition yet and were
// explicitly excluded from this phase.
export default async function ClinicianDashboardPage() {
  const { clinicianId } = await requireClinicianAuth();
  const roster = await getClinicianRoster(clinicianId);

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <span className="text-sm text-gray-500">Clinician</span>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-8 lg:py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Patients</h1>
        <p className="text-sm text-gray-500 mb-6">Patients you actively supervise.</p>

        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          {roster.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">No active patients assigned yet.</p>
          ) : (
            <div className="space-y-1">
              {roster.map((patient) => (
                <Link
                  key={patient.patientId}
                  href={`/clinician/patients/${patient.patientId}`}
                  className="flex items-center justify-between py-3 px-2 -mx-2 rounded-lg hover:bg-gray-50"
                >
                  <span className="text-sm font-medium text-gray-900">{patient.displayName}</span>
                  <span className="text-sm text-gray-400">View &rarr;</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
