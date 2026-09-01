import { redirect } from "next/navigation";
import { getSessionInfo, hasRole } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { INVITATION_ROLE_MAP } from "@/lib/invitations";
import { sendInvitationAction, cancelInvitationAction } from "./actions";

export const metadata = { title: "Invitations — TenoTrainer" };

type Props = {
  searchParams: Promise<{
    error?: string;
    sent?: string;
    token?: string;
    email?: string;
    cancelled?: string;
    emailed?: string;
    email_warn?: string;
  }>;
};

type InvitationRow = {
  id: string;
  email: string;
  invitation_type: string;
  granted_role: string;
  status: string;
  expires_at: string;
  created_at: string;
};

export default async function InvitationsPage({ searchParams }: Props) {
  const { error, sent, token, email: sentEmail, cancelled, emailed, email_warn } = await searchParams;

  const session = await getSessionInfo();
  if (!session.user) redirect("/login");
  if (!hasRole(session.memberships, "clinician_admin")) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="bg-white rounded-xl shadow border border-gray-100 p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Access denied</h1>
          <p className="text-sm text-gray-500">You need clinician-admin or super-user access to manage invitations.</p>
          <a href="/dashboard" className="mt-4 inline-block text-brand-600 text-sm font-medium hover:underline">
            Back to dashboard
          </a>
        </div>
      </div>
    );
  }

  const orgId = session.memberships[0].organization_id;
  const orgName = session.memberships[0].organizations?.name ?? "Your Organization";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const service = createServiceRoleClient();
  const { data: invitations } = await service
    .from("invitations")
    .select("id, email, invitation_type, granted_role, status, expires_at, created_at")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);

  const rows: InvitationRow[] = (invitations as InvitationRow[]) ?? [];

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      pending: "bg-yellow-100 text-yellow-800",
      accepted: "bg-green-100 text-green-800",
      expired: "bg-gray-100 text-gray-600",
      cancelled: "bg-red-100 text-red-700",
    };
    return (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? "bg-gray-100 text-gray-600"}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-bold text-brand-600">TenoTrainer</span>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          <span>{orgName}</span>
          <a href="/dashboard" className="hover:underline text-brand-600 font-medium">Dashboard</a>
          <a href="/logout" className="hover:underline text-gray-500">Log out</a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-10 space-y-8">
        <h1 className="text-2xl font-bold text-gray-900">Invitations</h1>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
            {error}
          </div>
        )}

        {cancelled && (
          <div className="bg-gray-50 border border-gray-200 text-gray-700 text-sm rounded-lg px-4 py-3">
            Invitation cancelled.
          </div>
        )}

        {sent && token && (
          <div className={`border text-sm rounded-lg px-4 py-4 space-y-2 ${email_warn ? "bg-yellow-50 border-yellow-200 text-yellow-800" : "bg-green-50 border-green-200 text-green-800"}`}>
            {emailed ? (
              <p className="font-medium">Invitation email sent to {sentEmail}.</p>
            ) : (
              <>
                <p className="font-medium">Invitation created but email could not be sent.</p>
                <p className="text-xs">{email_warn}</p>
                <p className="text-xs">Share this link manually (expires in 7 days):</p>
              </>
            )}
            {!emailed && (
              <div className="font-mono text-xs bg-white border border-yellow-200 rounded px-3 py-2 break-all select-all">
                {appUrl}/invite/accept?token={token}
              </div>
            )}
            {emailed && (
              <details className="text-xs">
                <summary className="cursor-pointer text-green-700 hover:underline">Copy invitation link</summary>
                <div className="font-mono mt-2 bg-white border border-green-200 rounded px-3 py-2 break-all select-all">
                  {appUrl}/invite/accept?token={token}
                </div>
              </details>
            )}
          </div>
        )}

        {/* Send invitation form */}
        <div className="bg-white rounded-xl shadow border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Send an invitation</h2>
          <form action={sendInvitationAction} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                placeholder="invitee@example.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="invitation_type" className="block text-sm font-medium text-gray-700 mb-1">
                Invitation type
              </label>
              <select
                id="invitation_type"
                name="invitation_type"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none bg-white"
              >
                {Object.entries(INVITATION_ROLE_MAP).map(([type, role]) => (
                  <option key={type} value={type}>
                    {type.replace(/_/g, " ")} → {role.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="py-2 px-6 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 active:bg-brand-800 transition-colors text-sm"
            >
              Create invitation link
            </button>
          </form>
        </div>

        {/* Invitations list */}
        {rows.length > 0 && (
          <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold text-gray-900">All invitations</h2>
            </div>
            <div className="divide-y divide-gray-100">
              {rows.map((inv) => (
                <div key={inv.id} className="px-6 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{inv.email}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {inv.invitation_type.replace(/_/g, " ")} · expires{" "}
                      {new Date(inv.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {statusBadge(inv.status)}
                    {inv.status === "pending" && (
                      <form action={cancelInvitationAction}>
                        <input type="hidden" name="invitation_id" value={inv.id} />
                        <button
                          type="submit"
                          className="text-xs text-red-600 hover:underline font-medium"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {rows.length === 0 && !sent && (
          <p className="text-sm text-gray-500 text-center py-6">No invitations yet.</p>
        )}
      </main>
    </div>
  );
}
