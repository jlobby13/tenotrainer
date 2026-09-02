import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getPatientSummary, type PatientSummary } from "@/lib/fastapi";

export const metadata = { title: "Dashboard — TenoTrainer" };

const IRRITABILITY_LABEL: Record<string, string> = {
  low: "Low irritability",
  moderate: "Moderate irritability",
  high: "High irritability",
};

const STATUS_COLOR: Record<string, string> = {
  1: "bg-blue-100 text-blue-800",
  2: "bg-teal-100 text-teal-800",
  3: "bg-green-100 text-green-800",
  4: "bg-amber-100 text-amber-800",
};

function PainBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const pct = Math.min(100, (value / 10) * 100);
  const color = value <= 3 ? "bg-green-400" : value <= 6 ? "bg-amber-400" : "bg-red-500";
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span className="font-medium text-gray-700">{value}/10</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Nav({ email, hasOrgMembership }: { email: string; hasOrgMembership: boolean }) {
  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
      <div className="flex items-center gap-4">
        {hasOrgMembership && (
          <>
            <a
              href="/api/auth/launch-dashboard?dest=/daily-log"
              className="text-sm text-gray-600 hover:text-brand-600 font-medium"
            >
              Track Session
            </a>
            <a
              href="/api/auth/launch-dashboard?dest=/exercise-library"
              className="text-sm text-gray-600 hover:text-brand-600 font-medium"
            >
              Exercise Library
            </a>
          </>
        )}
        <span className="text-sm text-gray-400">{email}</span>
        <a href="/logout" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Log out
        </a>
      </div>
    </nav>
  );
}

function TodaySessionCard({
  todayLogged,
  sessionPlan,
  hasOnboarding,
  hasNoPlan,
}: {
  todayLogged: boolean;
  sessionPlan: PatientSummary["session_plan"];
  hasOnboarding: boolean;
  hasNoPlan: boolean;
}) {
  if (!hasOnboarding) {
    return (
      <div className="bg-brand-50 border border-brand-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-brand-900 mb-1">Complete your assessment</h2>
        <p className="text-sm text-brand-700 mb-4">
          Your clinician will generate your personalised rehab plan once your initial assessment is done.
        </p>
        <a
          href="/api/auth/launch-dashboard?dest=/onboarding"
          className="inline-block px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          Start Assessment
        </a>
      </div>
    );
  }

  if (hasNoPlan) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-gray-700 mb-1">Waiting for your rehab plan</h2>
        <p className="text-sm text-gray-500">
          Your assessment is complete. Your clinician will set up your personalised plan shortly.
        </p>
      </div>
    );
  }

  if (todayLogged) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-6 flex items-start gap-4">
        <span className="text-green-500 text-2xl mt-0.5">✓</span>
        <div>
          <h2 className="text-base font-semibold text-green-900">Session complete for today</h2>
          <p className="text-sm text-green-700 mt-0.5">Great work. Come back tomorrow for your next session.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Today&apos;s Rehab</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {sessionPlan.length} exercise{sessionPlan.length !== 1 ? "s" : ""} prescribed for today
          </p>
        </div>
        <a
          href="/api/auth/launch-dashboard?dest=/daily-log"
          className="shrink-0 px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          Track Session
        </a>
      </div>

      {sessionPlan.length > 0 && (
        <ul className="space-y-3">
          {sessionPlan.map((item) => (
            <li key={item.exercise.ex_id} className="flex items-start gap-3">
              <span className="mt-0.5 text-brand-400">·</span>
              <div>
                <p className="text-sm font-medium text-gray-900">{item.exercise.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">{item.reason}</p>
                {item.dosage && Object.keys(item.dosage).length > 0 && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {Object.entries(item.dosage)
                      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function PatientDashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) redirect("/login");

  const session = await getSessionInfo();
  const role = session.memberships[0]?.role ?? "member";

  // Guard — only patients land here
  if (role === "super_user") redirect("/super/dashboard");
  if (role === "clinician" || role === "clinician_admin") redirect("/clinician/dashboard");

  let summary: PatientSummary | null = null;
  let fetchError: string | null = null;
  try {
    summary = await getPatientSummary(authUser.email!);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unable to load dashboard data";
  }

  const hasOrgMembership = session.memberships.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav email={authUser.email ?? ""} hasOrgMembership={hasOrgMembership} />

      <main className="max-w-2xl mx-auto px-4 py-10 space-y-6">
        {/* Welcome */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {summary?.user.name ? `Welcome back, ${summary.user.name.split(" ")[0]}` : "Welcome back"}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>

        {/* FastAPI unavailable */}
        {fetchError && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl px-5 py-4 text-sm text-yellow-800">
            <strong>Dashboard data unavailable:</strong> {fetchError}
            <br />
            <a
              href="/api/auth/launch-dashboard"
              className="mt-2 inline-block text-brand-600 font-medium underline"
            >
              Open full dashboard
            </a>
          </div>
        )}

        {/* No org membership */}
        {!hasOrgMembership && (
          <div className="bg-white rounded-xl shadow border border-gray-100 p-6 text-sm text-gray-600">
            Your account isn&apos;t connected to a clinic yet. Ask your clinician to send you an invitation.
          </div>
        )}

        {/* Rehab plan summary */}
        {summary && (
          <>
            {/* Stage + irritability badges */}
            {summary.current_plan && (
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    STATUS_COLOR[summary.current_plan.stage] ?? "bg-gray-100 text-gray-700"
                  }`}
                >
                  Stage {summary.current_plan.stage}
                </span>
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">
                  {IRRITABILITY_LABEL[summary.current_plan.irritability] ??
                    summary.current_plan.irritability}
                </span>
              </div>
            )}

            {/* Today's session */}
            <TodaySessionCard
              todayLogged={summary.today_logged}
              sessionPlan={summary.session_plan}
              hasOnboarding={summary.has_onboarding}
              hasNoPlan={!summary.has_plan}
            />

            {/* Recent sessions */}
            {summary.recent_logs.length > 0 && (
              <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
                <h2 className="text-base font-semibold text-gray-900 mb-4">Recent Sessions</h2>
                <div className="space-y-4">
                  {summary.recent_logs.map((log) => (
                    <div key={log.id} className="border-b border-gray-50 last:border-0 pb-3 last:pb-0">
                      <p className="text-xs font-medium text-gray-400 mb-2">
                        {new Date(log.date + "T00:00:00").toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </p>
                      <div className="space-y-1.5">
                        <PainBar label="Pain during" value={log.pain_during} />
                        <PainBar label="Pain after" value={log.pain_after} />
                        <PainBar label="Next-day pain" value={log.next_day_pain} />
                        <PainBar label="Morning stiffness" value={log.morning_stiffness} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick links to legacy :8000 pages */}
            <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-3">More</h2>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Exercise Log", dest: "/exercise-log" },
                  { label: "Assessment", dest: "/onboarding" },
                  { label: "VISA-A", dest: "/visa-a" },
                  { label: "Messages", dest: "/messages" },
                  { label: "Profile", dest: "/profile" },
                  { label: "Full Dashboard", dest: "/dashboard" },
                ].map(({ label, dest }) => (
                  <a
                    key={dest}
                    href={`/api/auth/launch-dashboard?dest=${encodeURIComponent(dest)}`}
                    className="px-4 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-brand-300 hover:text-brand-600 transition-colors text-center"
                  >
                    {label}
                  </a>
                ))}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
