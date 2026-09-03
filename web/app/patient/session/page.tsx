import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";

export const metadata = { title: "Rehab Session — TenoTrainer" };

// Milestone 1 placeholder — intentionally not the Active Rehab experience.
// No FastAPI call, no rule-engine invocation, no data written. Milestone 2
// replaces this route's contents with the real guided session flow.
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

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow border border-gray-100 p-8 text-center">
        <h1 className="text-lg font-semibold text-gray-900 mb-2">Active Rehab is coming soon</h1>
        <p className="text-sm text-gray-500 mb-6">
          Guided session tracking is the next part of TenoTrainer we&apos;re building.
        </p>
        <Link
          href="/patient/dashboard"
          className="inline-block px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          Back to Today&apos;s Rehab
        </Link>
      </div>
    </div>
  );
}
