import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";

export const metadata = { title: "Dashboard — TenoTrainer" };

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-gray-100 last:border-0">
      <span className={`mt-0.5 text-base ${ok ? "text-green-500" : "text-red-500"}`}>
        {ok ? "✓" : "✗"}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${ok ? "text-gray-900" : "text-red-700"}`}>{label}</p>
        {detail && <p className="text-xs text-gray-400 font-mono truncate mt-0.5">{detail}</p>}
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) redirect("/login");

  const session = await getSessionInfo();

  const checks = {
    signedIn: !!session.user,
    sessionPersists: !!session.user, // reaching this page proves the session survived the request
    profileExists: !!session.profile,
    emailConfirmed: !!session.user?.emailConfirmedAt,
    hasOrgMembership: session.memberships.length > 0,
    noErrors: session.errors.length === 0,
  };

  const allGreen = Object.values(checks).every(Boolean);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Nav */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <span className="text-xl font-bold text-brand-600">TenoTrainer</span>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{session.user?.email}</span>
          <a href="/logout" className="text-sm text-gray-600 hover:text-brand-600 font-medium">
            Log out
          </a>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-4 py-10 space-y-6">
        {/* Status banner */}
        <div
          className={`rounded-xl border px-5 py-4 ${
            allGreen
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-yellow-50 border-yellow-200 text-yellow-800"
          }`}
        >
          <p className="font-semibold text-sm">
            {allGreen
              ? "All auth checks passing ✓"
              : "Some checks need attention — see details below"}
          </p>
        </div>

        {/* Auth checklist */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Authentication checks</h2>
          <Check ok={checks.signedIn} label="Authenticated session" detail={session.user?.id} />
          <Check
            ok={checks.sessionPersists}
            label="Session persists across request"
            detail="getUser() validated JWT server-side"
          />
          <Check
            ok={checks.emailConfirmed}
            label="Email confirmed"
            detail={session.user?.emailConfirmedAt ?? "not confirmed yet"}
          />
          <Check
            ok={checks.profileExists}
            label="Profile record exists"
            detail={
              session.profile
                ? `name: ${session.profile.name}, 2FA: ${session.profile.tfa_enabled}`
                : "profile row missing — trigger may not have fired"
            }
          />
          <Check
            ok={checks.hasOrgMembership}
            label="Organisation membership"
            detail={
              session.memberships.length > 0
                ? session.memberships
                    .map((m) => `${m.organizations?.name ?? m.organization_id} (${m.role})`)
                    .join(", ")
                : "no memberships — expected for new users without an invite"
            }
          />
          <Check
            ok={checks.noErrors}
            label="No RLS / query errors"
            detail={
              session.errors.length > 0
                ? session.errors.map((e) => `${e.source}: ${e.message}`).join(" | ")
                : undefined
            }
          />
        </div>

        {/* Raw session data */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3">Raw session data</h2>
          <pre className="text-xs bg-gray-50 rounded-lg p-4 overflow-auto text-gray-700 leading-5">
            {JSON.stringify(session, null, 2)}
          </pre>
        </div>

        {/* Logout test */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-2">Manual checks</h2>
          <ul className="text-sm text-gray-600 space-y-1.5 list-disc list-inside">
            <li>
              <strong>Session persistence:</strong> reload this page — session data should stay identical
            </li>
            <li>
              <strong>Protected route guard:</strong> open{" "}
              <a href="/dashboard" className="text-brand-600 underline">
                /dashboard
              </a>{" "}
              in a private window — should redirect to /login
            </li>
            <li>
              <strong>Logout:</strong>{" "}
              <a href="/logout" className="text-brand-600 underline font-medium">
                Click here to log out
              </a>
              , then try navigating back to /dashboard — should redirect to /login
            </li>
            <li>
              <strong>JSON debug endpoint:{" "}</strong>
              <a href="/api/auth/debug" className="text-brand-600 underline font-mono text-xs">
                /api/auth/debug
              </a>{" "}
              — returns session info as JSON
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}
