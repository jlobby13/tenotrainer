import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getPatientSummary } from "@/lib/fastapi";
import { SessionPlayer } from "./components/SessionPlayer";

export const metadata = { title: "Rehab Session — TenoTrainer" };

// Milestone 2 — the real guided Active Rehab Session. Reads today's session_plan
// and hands it to the client-side SessionPlayer, which owns all set-by-set state
// locally. This route makes no clinical submission of its own: no daily_logs
// write, no rule-engine call, no tolerance/safety logic. That begins in
// Milestone 3, once the guided portion below is complete.
export default async function PatientSessionPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) redirect("/login");

  const session = await getSessionInfo();
  const role = session.memberships[0]?.role ?? "member";

  if (role === "super_user") redirect("/super/dashboard");
  if (role === "clinician" || role === "clinician_admin") redirect("/clinician/dashboard");

  let summary;
  try {
    summary = await getPatientSummary(authUser.email!);
  } catch {
    redirect("/patient/dashboard");
  }

  if (!summary.has_onboarding || !summary.has_plan || summary.session_plan.length === 0) {
    redirect("/patient/dashboard");
  }
  if (summary.today_logged) {
    redirect("/patient/dashboard");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <SessionPlayer
        initialSessionPlan={summary.session_plan}
        previousPerformance={summary.previous_performance}
        patientId={String(summary.user.id)}
        planId={summary.current_plan ? String(summary.current_plan.id) : null}
      />
    </div>
  );
}
