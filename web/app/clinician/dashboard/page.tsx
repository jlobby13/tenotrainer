import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getClinicianPatients, type PatientRow } from "@/lib/fastapi";

export const metadata = { title: "Clinician Dashboard — TenoTrainer" };

const STATUS_CONFIG: Record<PatientRow["status"], { label: string; dot: string; text: string }> = {
  red:      { label: "Alert",    dot: "bg-red-500",    text: "text-red-700"    },
  yellow:   { label: "Review",   dot: "bg-amber-400",  text: "text-amber-700"  },
  inactive: { label: "Inactive", dot: "bg-gray-400",   text: "text-gray-600"   },
  green:    { label: "On track", dot: "bg-green-500",  text: "text-green-700"  },
};

function StatusBadge({ status }: { status: PatientRow["status"] }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.green;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
      <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function PatientTable({ patients }: { patients: PatientRow[] }) {
  if (patients.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-4 text-center">
        No active patients assigned yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-xs text-gray-400 uppercase tracking-wide">
            <th className="text-left py-2 pr-4 font-medium">Patient</th>
            <th className="text-left py-2 pr-4 font-medium">Status</th>
            <th className="text-left py-2 pr-4 font-medium">Stage</th>
            <th className="text-left py-2 pr-4 font-medium">Last Session</th>
            <th className="text-left py-2 pr-4 font-medium">Sessions (28d)</th>
            <th className="text-left py-2 font-medium">Adherence</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {patients.map((p) => (
            <tr key={p.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
              <td className="py-3 pr-4">
                <div>
                  <p className="font-medium text-gray-900">{p.name || "—"}</p>
                  <p className="text-xs text-gray-400">{p.email}</p>
                </div>
              </td>
              <td className="py-3 pr-4">
                <StatusBadge status={p.status} />
                {p.alert_count > 0 && (
                  <span className="ml-2 text-xs text-red-500 font-medium">
                    {p.alert_count} alert{p.alert_count !== 1 ? "s" : ""}
                  </span>
                )}
              </td>
              <td className="py-3 pr-4 text-gray-700">
                {p.stage != null ? `Stage ${p.stage}` : "—"}
              </td>
              <td className="py-3 pr-4 text-gray-600">
                {p.last_session_date
                  ? new Date(p.last_session_date + "T00:00:00").toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  : "Never"}
              </td>
              <td className="py-3 pr-4 text-gray-600">{p.sessions_28d}</td>
              <td className="py-3 text-gray-600">
                {p.adherence_pct != null ? `${p.adherence_pct}%` : "—"}
              </td>
              <td className="py-3 pl-2">
                <a
                  href={`/clinician/patients/${p.id}`}
                  className="text-xs text-brand-600 font-medium hover:underline"
                >
                  View →
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function ClinicianDashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) redirect("/login");

  const session = await getSessionInfo();
  const role = session.memberships[0]?.role ?? "member";

  if (role === "super_user") redirect("/super/dashboard");
  if (role === "tester" || role === "member") redirect("/patient/dashboard");

  let patients: PatientRow[] = [];
  let fetchError: string | null = null;
  try {
    const data = await getClinicianPatients(authUser.email!);
    patients = data.patients;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unable to load patient data";
  }

  const name = session.profile?.name ?? authUser.email ?? "";
  const alertPatients = patients.filter((p) => p.status === "red" || p.status === "yellow");
  const inactivePatients = patients.filter((p) => p.status === "inactive");

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <div className="flex items-center gap-4">
          <a
            href="/admin/invitations"
            className="text-sm text-gray-600 hover:text-brand-600 font-medium"
          >
            Invitations
          </a>
          <a
            href="/api/auth/launch-dashboard?dest=/supervisor/dashboard"
            className="text-sm text-gray-600 hover:text-brand-600 font-medium"
          >
            Full Dashboard
          </a>
          <span className="text-sm text-gray-400">{authUser.email}</span>
          <a href="/logout" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
            Log out
          </a>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-10 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {name ? `Welcome back, ${name.split(" ")[0]}` : "Clinician Dashboard"}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>

        {fetchError && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-5 py-4 text-sm text-yellow-800">
            <strong>Patient data unavailable:</strong> {fetchError}
            <br />
            <a
              href="/api/auth/launch-dashboard?dest=/supervisor/dashboard"
              className="mt-2 inline-block text-brand-600 font-medium underline"
            >
              Open full supervisor dashboard
            </a>
          </div>
        )}

        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl shadow border border-gray-100 px-5 py-4">
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Active Patients</p>
            <p className="text-3xl font-bold text-gray-900">{patients.length}</p>
          </div>
          <div className="bg-white rounded-xl shadow border border-gray-100 px-5 py-4">
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Need Attention</p>
            <p className={`text-3xl font-bold ${alertPatients.length > 0 ? "text-red-600" : "text-gray-900"}`}>
              {alertPatients.length}
            </p>
          </div>
          <div className="bg-white rounded-xl shadow border border-gray-100 px-5 py-4">
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Inactive (&gt;5 days)</p>
            <p className={`text-3xl font-bold ${inactivePatients.length > 0 ? "text-amber-600" : "text-gray-900"}`}>
              {inactivePatients.length}
            </p>
          </div>
        </div>

        {/* Patient table */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">My Patients</h2>
            <a
              href="/api/auth/launch-dashboard?dest=/supervisor/cases"
              className="text-xs text-brand-600 font-medium hover:underline"
            >
              Full caseload view →
            </a>
          </div>
          <PatientTable patients={patients} />
        </div>
      </main>
    </div>
  );
}
