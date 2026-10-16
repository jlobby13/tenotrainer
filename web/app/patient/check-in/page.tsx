import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getC5TrainingState, usesC5Runtime } from "@/lib/c5RuntimeServer";
import { getC5CheckIns } from "@/lib/c5ResponseServer";
import { C5CheckInFlow } from "./components/C5CheckInFlow";

export const metadata = { title: "Check-in — TenoTrainer" };

// C5.6E — C5 post-session + next-morning check-ins. Only for patients served
// by the gated C5 runtime; everyone else stays on the legacy flows.
export default async function CheckInPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const session = await getSessionInfo();
  const role = session.memberships[0]?.role ?? "member";
  if (role === "super_user") redirect("/super/dashboard");
  if (role === "clinician" || role === "clinician_admin") redirect("/clinician/dashboard");

  if (!(await usesC5Runtime(user.id))) redirect("/patient/dashboard");

  const [checkIns, state] = await Promise.all([getC5CheckIns(user.id), getC5TrainingState(user.id)]);
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto max-w-2xl px-4 pb-12 pt-6">
        <C5CheckInFlow initialCheckIns={checkIns} initialState={state} />
      </main>
    </div>
  );
}
