import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEFAULT_MORNING_REMINDER_TIME } from "@/lib/morningEligibility";
import { ReminderTimeSetting } from "./components/ReminderTimeSetting";

export const metadata = { title: "Settings — TenoTrainer" };

// Minimal, native Next.js settings surface — the smallest clean addition
// needed for the M4 reminder preference, not a full settings redesign. The
// legacy FastAPI "/profile" page (still linked from SecondaryLinks) is a
// different stack entirely and isn't the right place to bolt on a
// Postgres-backed preference.
export default async function PatientSettingsPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("morning_reminder_time, timezone")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <Link href="/patient/dashboard" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
          Back to Dashboard
        </Link>
      </nav>

      <main className="max-w-md mx-auto px-4 py-10">
        <h1 className="text-xl font-bold text-gray-900 mb-6">Settings</h1>

        <ReminderTimeSetting
          initialTime={profile?.morning_reminder_time ?? DEFAULT_MORNING_REMINDER_TIME}
        />

        {profile?.timezone && (
          <div className="mt-6 bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">Timezone</p>
            <p className="text-sm text-gray-700">{profile.timezone}</p>
            <p className="text-xs text-gray-400 mt-1">
              Detected automatically. Changing timezones (e.g. travel) isn&apos;t supported yet.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
