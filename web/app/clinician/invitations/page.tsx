import Link from "next/link";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { clinicianInviteOrganizations, listClinicianPatientInvitations } from "@/lib/patientInvitationServer";
import { cancelPatientInvitationAction } from "./actions";
import { InvitePatientForm, ResendInvitation } from "./InviteForms";

export const metadata = { title: "Invite Patients — TenoTrainer" };

// M2 — native patient invitations. Accepting creates the assignment to the
// inviting clinician (Postgres is the assignment authority).
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  accepted: "bg-green-100 text-green-800",
  expired: "bg-gray-100 text-gray-600",
  cancelled: "bg-red-100 text-red-700",
};

export default async function ClinicianInvitationsPage({ searchParams }: { searchParams: Promise<{ cancelled?: string; error?: string }> }) {
  const { cancelled, error } = await searchParams;
  const { clinicianId } = await requireClinicianAuth();
  const [organizations, invitations] = await Promise.all([clinicianInviteOrganizations(clinicianId), listClinicianPatientInvitations(clinicianId)]);

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
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Invite a patient</h1>
          <p className="text-sm text-gray-500">When the patient accepts, they are added to your patients.</p>
        </div>

        {cancelled && <div className="bg-gray-50 border border-gray-200 text-gray-700 text-sm rounded-lg px-4 py-3">Invitation cancelled.</div>}
        {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">That invitation could not be cancelled.</div>}

        <section className="bg-white rounded-xl shadow border border-gray-100 p-6">
          {organizations.length === 0 ? (
            <p className="text-sm text-gray-500">You are not a clinician of any clinic.</p>
          ) : (
            <InvitePatientForm organizations={organizations} />
          )}
        </section>

        <section className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-900">Your invitations</h2>
          </div>
          {invitations.length === 0 ? (
            <p className="px-6 py-6 text-sm text-gray-500 text-center">No invitations yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100" data-testid="invitation-list">
              {invitations.map((inv) => (
                <li key={inv.id} className="px-6 py-4 flex flex-wrap items-start justify-between gap-3" data-testid="invitation-row" data-email={inv.email} data-status={inv.status}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{inv.email}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Sent {new Date(inv.createdAt).toLocaleDateString("en-US")}
                      {inv.status === "pending" ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString("en-US")}` : ""}
                      {inv.acceptedAt ? ` · accepted ${new Date(inv.acceptedAt).toLocaleDateString("en-US")}` : ""}
                    </p>
                    {inv.status === "accepted" && inv.acceptedBy && (
                      <Link href={`/clinician/patients/${inv.acceptedBy}`} className="text-xs text-brand-700 hover:underline">
                        Open patient
                      </Link>
                    )}
                  </div>
                  <div className="flex items-start gap-3 shrink-0">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[inv.status] ?? ""}`}>{inv.status}</span>
                    {(inv.status === "pending" || inv.status === "expired") && (
                      <ResendInvitation email={inv.email} organizationId={inv.organizationId} />
                    )}
                    {inv.status === "pending" && (
                      <form action={cancelPatientInvitationAction}>
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <button type="submit" className="text-xs text-red-600 hover:underline font-medium" data-testid="cancel-invitation">
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
