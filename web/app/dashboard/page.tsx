import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const metadata = { title: "Dashboard — TenoTrainer" };

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user.email}</span>
          <a
            href="/logout"
            className="text-sm text-gray-600 hover:text-brand-600 font-medium"
          >
            Log out
          </a>
        </div>
      </nav>

      {/* Body */}
      <main className="max-w-2xl mx-auto px-4 py-16 text-center">
        <div className="bg-white rounded-xl shadow border border-gray-100 p-10">
          <div className="text-4xl mb-4">🏗️</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Dashboard coming soon
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            You&apos;re logged in as <strong>{user.email}</strong>.
            The full dashboard is being migrated from the existing app to Next.js.
          </p>
          <p className="text-xs text-gray-400">
            In the meantime, the existing app is still running at{" "}
            <a href="http://localhost:8000" className="text-brand-600 hover:underline">
              localhost:8000
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
