import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionInfo } from "@/lib/auth";
import {
  adminOrganizations,
  getPatientAssignments,
  listOrgClinicians,
  listOrgPatients,
} from "@/lib/assignmentAdminServer";
import { addAssignmentAction, endAssignmentAction } from "./actions";

export const metadata = { title: "Assignments — TenoTrainer" };

// M2 — minimal assignment management (clinician_admin / super_user): find a
// patient, see their assigned clinicians, add a clinician of the same
// organization, end an assignment with a reason. History is kept. No
// cross-organization transfer (not defined as product policy).

const RESULT_COPY: Record<string, string> = {
  added: "Clinician added. Existing clinicians are unchanged.",
  ended: "Assignment ended. That clinician no longer has access; the patient's record is unchanged.",
  already_active: "That clinician is already assigned to this patient.",
  reason_required: "Please give a reason (up to 500 characters) for ending the assignment.",
  already_ended: "That assignment had already ended.",
  clinician_not_in_organization: "That clinician is not a clinician of this organization.",
  patient_not_in_organization: "That patient is not a patient of this organization.",
  not_authorized: "You can't manage assignments for this organization.",
  not_found: "That assignment was not found.",
  error: "Something went wrong. Please try again.",
};

type Props = { searchParams: Promise<{ org?: string; q?: string; patient?: string; done?: string; error?: string }> };

export default async function AssignmentsPage({ searchParams }: Props) {
  const { org, q, patient, done, error } = await searchParams;
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");

  const orgs = await adminOrganizations(session.user.id);
  if (orgs.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8 max-w-md w-full text-center" data-testid="assignments-denied">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Access denied</h1>
          <p className="text-sm text-gray-500">You need clinician-admin or super-user access to manage assignments.</p>
          <a href="/dashboard" className="mt-4 inline-block text-brand-600 text-sm font-medium hover:underline">
            Back to dashboard
          </a>
        </div>
      </div>
    );
  }
  const current = orgs.find((o) => o.id === org) ?? orgs[0];

  const patients = await listOrgPatients(current.id);
  const query = (q ?? "").trim().toLowerCase();
  const shown = query ? patients.filter((p) => p.name.toLowerCase().includes(query) || p.email.toLowerCase().includes(query)) : patients;
  const selected = patient ? patients.find((p) => p.id === patient) ?? null : null;

  const [assignments, clinicians] = selected
    ? await Promise.all([getPatientAssignments(current.id, selected.id), listOrgClinicians(current.id)])
    : [[], []];
  const active = assignments.filter((a) => a.status === "active");
  const history = assignments.filter((a) => a.status === "dismissed");
  const addable = clinicians.filter((c) => !active.some((a) => a.clinicianId === c.id));
  const message = done ? RESULT_COPY[done] : error ? (RESULT_COPY[error] ?? RESULT_COPY.error) : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-bold text-brand-600">TenoTrainer</span>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          <span>{current.name}</span>
          <a href="/dashboard" className="hover:underline text-brand-600 font-medium">Dashboard</a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Assignments</h1>

        {orgs.length > 1 && (
          <nav className="flex flex-wrap gap-2 text-sm">
            {orgs.map((o) => (
              <Link key={o.id} href={`/admin/assignments?org=${o.id}`} className={`rounded-full border px-3 py-1 ${o.id === current.id ? "border-brand-600 text-brand-700" : "border-gray-300 text-gray-600"}`}>
                {o.name}
              </Link>
            ))}
          </nav>
        )}

        {message && (
          <div className={`text-sm rounded-lg px-4 py-3 border ${done ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-700"}`} data-testid="assignment-message" data-result={done ?? error}>
            {message}
          </div>
        )}

        <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-4">
          <form className="flex gap-2" action="/admin/assignments">
            <input type="hidden" name="org" value={current.id} />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Find a patient by name or email"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:outline-none"
              data-testid="patient-search"
            />
            <button type="submit" className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
              Search
            </button>
          </form>
          <ul className="divide-y divide-gray-100 text-sm max-h-72 overflow-y-auto" data-testid="patient-list">
            {shown.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/admin/assignments?org=${current.id}&patient=${p.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                  className={`flex items-center justify-between py-2 ${selected?.id === p.id ? "font-semibold text-brand-700" : "text-gray-800"}`}
                  data-testid="patient-option"
                  data-email={p.email}
                >
                  <span>{p.name}</span>
                  <span className="text-gray-500">{p.email}</span>
                </Link>
              </li>
            ))}
            {shown.length === 0 && <li className="py-3 text-gray-500">No patients found.</li>}
          </ul>
        </section>

        {selected && (
          <section className="bg-white rounded-xl shadow border border-gray-100 p-6 space-y-5" data-testid="patient-assignments">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{selected.name}</h2>
              <p className="text-sm text-gray-500">{selected.email}</p>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Assigned clinicians</h3>
              {active.length === 0 && <p className="text-sm text-gray-500">No active clinician. The patient&apos;s record and program are unchanged.</p>}
              {active.map((a) => (
                <div key={a.id} className="rounded-lg border border-gray-200 p-4 space-y-2" data-testid="active-assignment" data-clinician={a.clinicianId}>
                  <p className="text-sm text-gray-900">
                    <span className="font-medium">{a.clinicianName}</span>
                    <span className="text-gray-500"> · since {new Date(a.assignedAt).toLocaleDateString("en-US")}{a.viaInvitation ? " · via invitation" : a.createdByName ? ` · added by ${a.createdByName}` : ""}</span>
                  </p>
                  <form action={endAssignmentAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="org" value={current.id} />
                    <input type="hidden" name="patient" value={selected.id} />
                    <input type="hidden" name="assignment" value={a.id} />
                    <input
                      name="reason"
                      required
                      maxLength={500}
                      placeholder="Reason for ending"
                      className="flex-1 min-w-48 border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
                      data-testid="end-reason"
                    />
                    <button type="submit" className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50" data-testid="end-assignment">
                      End assignment
                    </button>
                  </form>
                </div>
              ))}
            </div>

            <form action={addAssignmentAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="org" value={current.id} />
              <input type="hidden" name="patient" value={selected.id} />
              <select name="clinician" required className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" data-testid="add-clinician-select">
                <option value="">Add a clinician…</option>
                {addable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.email ? ` (${c.email})` : ""}
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700" data-testid="add-clinician">
                Add clinician
              </button>
            </form>

            {history.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">History</h3>
                <ul className="divide-y divide-gray-100 text-sm" data-testid="assignment-history">
                  {history.map((a) => (
                    <li key={a.id} className="py-2 text-gray-700" data-testid="history-row" data-clinician={a.clinicianId}>
                      <span className="font-medium">{a.clinicianName}</span> · {new Date(a.assignedAt).toLocaleDateString("en-US")} –{" "}
                      {a.dismissedAt ? new Date(a.dismissedAt).toLocaleDateString("en-US") : ""}
                      {a.dismissedByName ? ` · ended by ${a.dismissedByName}` : ""}
                      {a.dismissedReason ? ` · “${a.dismissedReason}”` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
