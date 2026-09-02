import { redirect, notFound } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getPatientDetail } from "@/lib/fastapi";

export const metadata = { title: "Patient Detail — TenoTrainer" };

const SEVERITY_COLOR: Record<string, string> = {
  high:   "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low:    "bg-gray-100 text-gray-600 border-gray-200",
};

function PainPill({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const color = value <= 3 ? "text-green-600" : value <= 6 ? "text-amber-600" : "text-red-600";
  return (
    <span className="text-xs text-gray-500">
      {label}: <span className={`font-semibold ${color}`}>{value}/10</span>
    </span>
  );
}

export default async function PatientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const patientId = parseInt(id, 10);
  if (isNaN(patientId)) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) redirect("/login");

  const session = await getSessionInfo();
  const role = session.memberships[0]?.role ?? "member";

  if (role !== "clinician" && role !== "clinician_admin") redirect("/dashboard");

  let detail;
  try {
    detail = await getPatientDetail(patientId, authUser.email!);
  } catch (err) {
    // Patient not found or not assigned — treat as 404
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("403") || msg.includes("404")) notFound();
    throw err;
  }

  const { patient, current_plan, recent_logs } = detail;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <a href="/clinician/dashboard" className="text-sm text-gray-500 hover:text-brand-600">
          ← Patients
        </a>
        <span className="text-sm text-gray-300">|</span>
        <span className="text-sm font-medium text-gray-700">{patient.name || patient.email}</span>
        <div className="ml-auto flex items-center gap-4">
          <a
            href={`/api/auth/launch-dashboard?dest=${encodeURIComponent(`/supervisor/patients/${patientId}`)}`}
            className="text-sm text-gray-600 hover:text-brand-600 font-medium"
          >
            Full Patient View
          </a>
          <a href="/logout" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
            Log out
          </a>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        {/* Patient header */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">{patient.name || "—"}</h1>
              <p className="text-sm text-gray-400 mt-0.5">{patient.email}</p>
            </div>
            <a
              href={`/api/auth/launch-dashboard?dest=${encodeURIComponent(`/supervisor/patients/${patientId}/assessment`)}`}
              className="px-4 py-2 border border-brand-300 text-brand-600 text-sm font-semibold rounded-lg hover:bg-brand-50 transition-colors"
            >
              Add Assessment
            </a>
          </div>

          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {patient.stage != null && (
              <span className="px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                Stage {patient.stage}
              </span>
            )}
            {patient.irritability && (
              <span className="px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-medium capitalize">
                {patient.irritability} irritability
              </span>
            )}
            <span className="text-xs text-gray-500">
              {patient.sessions_28d} sessions in last 28 days
              {patient.adherence_pct != null && ` · ${patient.adherence_pct}% adherence`}
            </span>
            {patient.last_session_date && (
              <span className="text-xs text-gray-500">
                Last session:{" "}
                {new Date(patient.last_session_date + "T00:00:00").toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
        </div>

        {/* Alerts */}
        {patient.alerts.length > 0 && (
          <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-3">
              Active Alerts ({patient.alerts.length})
            </h2>
            <ul className="space-y-2">
              {patient.alerts.map((alert) => (
                <li
                  key={alert.id}
                  className={`text-sm px-4 py-3 rounded-lg border ${SEVERITY_COLOR[alert.severity] ?? SEVERITY_COLOR.low}`}
                >
                  <span className="font-medium capitalize">{alert.type}</span>
                  {" — "}
                  {alert.message}
                  <span className="ml-2 text-xs opacity-60">{alert.created_at}</span>
                </li>
              ))}
            </ul>
            <a
              href={`/api/auth/launch-dashboard?dest=${encodeURIComponent(`/supervisor/patients/${patientId}`)}`}
              className="mt-3 inline-block text-xs text-brand-600 font-medium hover:underline"
            >
              Resolve alerts in full view →
            </a>
          </div>
        )}

        {/* Current rehab plan */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Current Rehab Plan</h2>
          {current_plan ? (
            <div className="space-y-2 text-sm text-gray-700">
              <div className="flex gap-6">
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wide">Stage</span>
                  <p className="font-semibold text-gray-900">{current_plan.stage}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wide">Irritability</span>
                  <p className="font-semibold text-gray-900 capitalize">{current_plan.irritability}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wide">Decision</span>
                  <p className="font-semibold text-gray-900">{current_plan.decision || "—"}</p>
                </div>
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wide">Created</span>
                  <p className="font-semibold text-gray-900">{current_plan.created_at}</p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100">
                <a
                  href={`/api/auth/launch-dashboard?dest=${encodeURIComponent(`/supervisor/patients/${patientId}/assessment`)}`}
                  className="text-xs text-brand-600 font-medium hover:underline"
                >
                  Edit plan via assessment →
                </a>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No rehab plan on file.</p>
          )}
        </div>

        {/* Recent sessions */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Recent Sessions</h2>
          {recent_logs.length === 0 ? (
            <p className="text-sm text-gray-500">No sessions logged yet.</p>
          ) : (
            <div className="space-y-4">
              {recent_logs.map((log) => (
                <div key={log.id} className="border-b border-gray-50 last:border-0 pb-3 last:pb-0">
                  <p className="text-xs font-medium text-gray-400 mb-1.5">
                    {new Date(log.date + "T00:00:00").toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <PainPill label="During" value={log.pain_during} />
                    <PainPill label="After" value={log.pain_after} />
                    <PainPill label="Next day" value={log.next_day_pain} />
                    <PainPill label="Stiffness" value={log.morning_stiffness} />
                  </div>
                  {log.note && (
                    <p className="mt-1.5 text-xs text-gray-500 italic">&ldquo;{log.note}&rdquo;</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
