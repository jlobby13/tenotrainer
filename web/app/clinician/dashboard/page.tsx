import Link from "next/link";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { getClinicianRoster, type ClinicianRosterEntry } from "@/lib/clinicianServer";
import { formatLastSessionLabel, formatRecentActivityLabel, formatStageLabel } from "@/lib/clinicianRoster";

export const metadata = { title: "Clinician Dashboard — TenoTrainer" };

// C1B — Clinician Dashboard & Roster. Fully Next.js/Supabase-native, same
// as C1A: no FastAPI dependency of any kind. Adds the roster's factual
// status facts (last session, 14-day activity, acute review, morning
// response) on top of C1A's identity + UUID routing — see
// lib/clinicianRoster.ts and lib/clinicianServer.ts for the locked
// founder decisions this renders. Deliberately NOT the final clinician
// redesign: existing design conventions only, improved just enough for
// scan-friendly hierarchy on desktop (table) and mobile (cards). No
// composite "needs attention"/risk/priority score — each status is an
// independent, factual badge.
export default async function ClinicianDashboardPage() {
  const { clinicianId } = await requireClinicianAuth();
  const roster = await getClinicianRoster(clinicianId);
  const now = new Date();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <span className="text-sm text-gray-500">Clinician</span>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-8 lg:py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Patients</h1>
        <p className="text-sm text-gray-500 mb-6">Patients you actively supervise.</p>

        {roster.length === 0 ? (
          <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
            <p className="text-sm text-gray-500 py-4 text-center">No active patients assigned yet.</p>
          </div>
        ) : (
          <>
            {/* Desktop / tablet: scan-friendly table. */}
            <div className="hidden md:block bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                    <th className="px-6 py-3">Patient</th>
                    <th className="px-6 py-3">Current Stage</th>
                    <th className="px-6 py-3">Last Session</th>
                    <th className="px-6 py-3">Recent Activity</th>
                    <th className="px-6 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((patient) => (
                    <tr key={patient.patientId} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-0 py-0">
                        <Link href={`/clinician/patients/${patient.patientId}`} className="block px-6 py-4 font-medium text-gray-900">
                          {patient.displayName}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-gray-700">{formatStageLabel(patient.currentStage)}</td>
                      <td className="px-6 py-4 text-gray-700">{formatLastSessionLabel(patient.lastSessionAt, now)}</td>
                      <td className="px-6 py-4 text-gray-700">{formatRecentActivityLabel(patient.recentSessionCount)}</td>
                      <td className="px-6 py-4">
                        <RosterStatusBadges patient={patient} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: patient cards, same facts and semantic ordering as desktop. */}
            <div className="md:hidden space-y-3">
              {roster.map((patient) => (
                <Link
                  key={patient.patientId}
                  href={`/clinician/patients/${patient.patientId}`}
                  className="block bg-white rounded-xl shadow border border-gray-100 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium text-gray-900">{patient.displayName}</span>
                    <span className="text-sm text-gray-400 shrink-0">View &rarr;</span>
                  </div>
                  <div className="mt-2 space-y-1 text-sm text-gray-600">
                    <div>{formatStageLabel(patient.currentStage)}</div>
                    <div>{formatLastSessionLabel(patient.lastSessionAt, now)}</div>
                    <div>{formatRecentActivityLabel(patient.recentSessionCount)}</div>
                  </div>
                  <div className="mt-2">
                    <RosterStatusBadges patient={patient} />
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// Independent badges — never combined into a single classification, never
// a traffic-light composite. Absent entirely when there is nothing to
// show (no active episode, no due/pending morning response).
function RosterStatusBadges({ patient }: { patient: ClinicianRosterEntry }) {
  if (!patient.acuteReviewActive && patient.morningResponseStatus === null) {
    return <span className="text-sm text-gray-300">&mdash;</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {patient.acuteReviewActive && (
        <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Clinical review active</span>
      )}
      {patient.morningResponseStatus === "due" && (
        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Morning response due</span>
      )}
      {patient.morningResponseStatus === "pending" && (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Morning response pending</span>
      )}
    </div>
  );
}
