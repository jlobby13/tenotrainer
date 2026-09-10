import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getPatientSummary, type PatientSummary } from "@/lib/fastapi";
import { getTodaysRehabFeedback } from "@/lib/todaysRehabFeedbackServer";
import { getTodaysRehabDayEligibility } from "@/lib/rehabScheduleServer";
import type { DashboardFeedback } from "@/lib/dashboardFeedback";
import { TodaysRehabPanel } from "./components/TodaysRehabPanel";
import { NoRehabScheduledNotice } from "./components/NoRehabScheduledNotice";
import { MorningResponsePendingNotice } from "./components/MorningResponsePendingNotice";
import { RecentResponseFeedback } from "./components/RecentResponseFeedback";
import { DashboardTimeline } from "./components/DashboardTimeline";
import { TimezoneInitializer } from "./components/TimezoneInitializer";
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

  // Milestone 5, Stage 2 (+ Acute Safety Gate) — derived from immutable
  // Stage 1 facts, and now the acute brake, first. Fetched once here so the
  // feedback card, the acute-brake CTA/lockout, and TodaysRehabPanel's CTA
  // label all share a single source of truth.
  const feedback: DashboardFeedback = summary
    ? await getTodaysRehabFeedback(authUser.id)
    : { kind: "stage2", feedback: { kind: "none" } };
  const ctaLabel = feedback.kind === "stage2" && feedback.feedback.kind === "response" ? feedback.feedback.ctaLabelOverride : null;
  // Stage 4 closure patch — orthogonal to `feedback`: schedule eligibility
  // controls ONLY whether a loading opportunity exists today, independent
  // of which response-context card (if any) is showing. Computed once here
  // so the panel-suppression logic and the "No rehab scheduled" notice
  // share one source of truth. "unknown" (every prescription today — see
  // the migration's header note) behaves identically to "scheduled": it
  // never suppresses the CTA. Only an explicit "not_scheduled" does.
  const scheduleEligibility = summary ? await getTodaysRehabDayEligibility(authUser.id) : "unknown";
  const isRehabDayNotScheduled = scheduleEligibility === "not_scheduled";
  // Acute Safety Gate, Section 31: brake states must never expose the
  // normal Start Rehab prescription/CTA — the RPC would reject it anyway,
  // but it must not be visually offered either. Stage 4 founder-acceptance
  // fix: an outstanding M4 morning-response obligation is the same kind of
  // hard, authoritative gate (MORNING_RESPONSE_REQUIRED) — the CTA must not
  // be offered then either, matching the precedence already established
  // for acute brakes. Stage 4 closure patch: an explicitly non-rehab day is
  // the same kind of hard gate (REHAB_NOT_SCHEDULED_TODAY).
  const showTodaysRehabPanel =
    feedback.kind !== "acute_brake" && feedback.kind !== "morning_response_pending" && !isRehabDayNotScheduled;

  return (
    <div className="min-h-screen bg-gray-50">
      <TimezoneInitializer />
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
              <>
                {/* Date-independent: checked regardless of today's own
                    agenda/prescription state, so a prior unresolved session
                    is never hidden by today's rehab moving forward. */}
                <MorningResponsePendingNotice />
                <DashboardTimeline />
                <RecentResponseFeedback feedback={feedback} />
                {showTodaysRehabPanel && (
                  <TodaysRehabPanel
                    currentPlan={summary.current_plan}
                    sessionPlan={summary.session_plan}
                    hasOnboarding={summary.has_onboarding}
                    hasNoPlan={!summary.has_plan}
                    todayLogged={summary.today_logged}
                    patientId={String(summary.user.id)}
                    ctaLabel={ctaLabel}
                  />
                )}
                {/* Stage 4 closure patch: only in place of the normal
                    prescribed-rehab CTA — never instead of the onboarding/
                    no-plan states above, and never alongside the acute-brake
                    or morning-response-pending notices (those already
                    explain what to do next; see showTodaysRehabPanel). */}
                {!showTodaysRehabPanel &&
                  isRehabDayNotScheduled &&
                  feedback.kind !== "acute_brake" &&
                  feedback.kind !== "morning_response_pending" &&
                  summary.has_onboarding &&
                  summary.has_plan && <NoRehabScheduledNotice />}
              </>
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
