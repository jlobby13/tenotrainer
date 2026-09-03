import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getPatientSummary, type PatientSummary } from "@/lib/fastapi";
import { TodaysRehabPanel } from "./components/TodaysRehabPanel";
import { PreviousSessionSummary } from "./components/PreviousSessionSummary";
import { SecondaryLinks } from "./components/SecondaryLinks";

export const metadata = { title: "Dashboard — TenoTrainer" };

function Nav({ email, hasOrgMembership }: { email: string; hasOrgMembership: boolean }) {
  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
      <div className="flex items-center gap-4">
        {hasOrgMembership && (
          <>
            <Link href="/patient/session" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
              Track Session
            </Link>
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

  const hasOrgMembership = session.memberships.length > 0;

  let summary: PatientSummary | null = null;
  let fetchError: string | null = null;
  if (hasOrgMembership) {
    try {
      summary = await getPatientSummary(authUser.email!);
    } catch (err) {
      fetchError = err instanceof Error ? err.message : "Unable to load dashboard data";
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav email={authUser.email ?? ""} hasOrgMembership={hasOrgMembership} />

      <main className="max-w-6xl mx-auto px-4 py-8 lg:py-10">
        <div className="lg:grid lg:grid-cols-3 lg:gap-8 lg:items-start">
          {/* Primary column — Today's Rehab is the dominant hierarchy */}
          <div className="lg:col-span-2 space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {summary?.user.name ? `Welcome back, ${summary.user.name.split(" ")[0]}` : "Welcome back"}
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">
                {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </p>
            </div>

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

            {!hasOrgMembership && (
              <div className="bg-white rounded-xl shadow border border-gray-100 p-6 text-sm text-gray-600">
                Your account isn&apos;t connected to a clinic yet. Ask your clinician to send you an invitation.
              </div>
            )}

            {summary && (
              <TodaysRehabPanel
                currentPlan={summary.current_plan}
                sessionPlan={summary.session_plan}
                hasOnboarding={summary.has_onboarding}
                hasNoPlan={!summary.has_plan}
                todayLogged={summary.today_logged}
              />
            )}
          </div>

          {/* Secondary column — supporting information, visually subordinate */}
          {summary && (
            <div className="mt-6 lg:mt-0 space-y-6">
              <PreviousSessionSummary recentLogs={summary.recent_logs} />
              <SecondaryLinks />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
