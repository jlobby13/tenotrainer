import { redirect } from "next/navigation";
import { getSessionInfo, hasRole } from "@/lib/auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { INVITATION_ROLE_MAP } from "@/lib/invitations";
import { sendInvitationAction, cancelInvitationAction } from "@/app/admin/invitations/actions";

export const metadata = { title: "Admin Overview — TenoTrainer" };

type InvitationRow = {
  id: string;
  email: string;
  invitation_type: string;
  granted_role: string;
  status: string;
  expires_at: string;
  created_at: string;
};

type OrgMember = {
  user_id: string;
  role: string;
  joined_at: string;
  email?: string;
  name?: string;
  active_patients: number;
  total_patients: number;
};

type Props = {
  searchParams: Promise<{
    error?: string;
    sent?: string;
    token?: string;
    email?: string;
    cancelled?: string;
    emailed?: string;
    email_warn?: string;
    tab?: string;
  }>;
};

async function fetchClinicianData(members: { user_id: string; role: string; joined_at: string }[]): Promise<OrgMember[]> {
  const fastApiUrl = process.env.FASTAPI_URL ?? "http://localhost:8000";
  const bridgeSecret = process.env.BRIDGE_SECRET ?? "";

  // Fetch SQLite patient counts
  let sqliteSupervisors: Record<string, { active_patients: number; total_patients: number }> = {};
  try {
    const resp = await fetch(`${fastApiUrl}/api/super/overview`, {
      headers: { Authorization: `Bearer ${bridgeSecret}` },
      cache: "no-store",
    });
    if (resp.ok) {
      const data = await resp.json();
      for (const s of data.supervisors ?? []) {
        if (s.supabase_id) {
          sqliteSupervisors[s.supabase_id] = {
            active_patients: s.active_patients ?? 0,
            total_patients: s.total_patients ?? 0,
          };
        }
      }
    }
  } catch {
    // FastAPI may be down — patient counts will show 0
  }

  // Fetch Supabase user emails/names via service role
  const service = createServiceRoleClient();
  return members.map((m) => {
    const counts = sqliteSupervisors[m.user_id] ?? { active_patients: 0, total_patients: 0 };
    return { ...m, ...counts };
  });
}

const ROLE_LABELS: Record<string, string> = {
  super_user: "Super User",
  clinician_admin: "Clinician Admin",
  clinician: "Clinician",
  tester: "Patient / Tester",
  member: "Member",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  accepted: "bg-green-100 text-green-800",
  expired: "bg-gray-100 text-gray-600",
  cancelled: "bg-red-100 text-red-700",
};

export default async function SuperDashboardPage({ searchParams }: Props) {
  const { error, sent, token, email: sentEmail, cancelled, emailed, email_warn, tab = "overview" } = await searchParams;

  const session = await getSessionInfo();
  if (!session.user) redirect("/login");
  if (!hasRole(session.memberships, "super_user")) {
    redirect("/dashboard");
  }

  const orgId = session.memberships[0].organization_id;
  const orgName = session.memberships[0].organizations?.name ?? "TenoTrainer";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const service = createServiceRoleClient();

  // Fetch org members (clinicians + admins — exclude testers/members from caseload view)
  const { data: allMembers } = await service
    .from("organization_members")
    .select("user_id, role, joined_at")
    .eq("organization_id", orgId)
    .in("role", ["clinician", "clinician_admin", "super_user"])
    .order("joined_at", { ascending: true });

  // Fetch Supabase user emails for those members
  const memberUserIds = (allMembers ?? []).map((m) => m.user_id);
  const { data: authUsersResp } = await service.auth.admin.listUsers({ perPage: 200 });
  const authUserMap: Record<string, { email: string; name?: string }> = {};
  for (const u of authUsersResp?.users ?? []) {
    authUserMap[u.id] = {
      email: u.email ?? "",
      name: u.user_metadata?.name ?? u.email?.split("@")[0] ?? "",
    };
  }

  const clinicians: OrgMember[] = await fetchClinicianData(
    (allMembers ?? []).map((m) => ({
      user_id: m.user_id,
      role: m.role,
      joined_at: m.joined_at,
    }))
  );
  // Attach email/name from Supabase auth
  for (const c of clinicians) {
    const auth = authUserMap[c.user_id];
    if (auth) { c.email = auth.email; c.name = auth.name; }
  }

  // Fetch invitations
  const { data: invitations } = await service
    .from("invitations")
    .select("id, email, invitation_type, granted_role, status, expires_at, created_at")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  const invRows: InvitationRow[] = (invitations as InvitationRow[]) ?? [];

  // Counts for summary tiles
  const clinicianCount = clinicians.filter((c) => ["clinician", "clinician_admin"].includes(c.role)).length;
  const totalActive = clinicians.reduce((sum, c) => sum + c.active_patients, 0);
  const pendingInvites = invRows.filter((i) => i.status === "pending").length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-brand-600">TenoTrainer</span>
          <span className="text-xs bg-brand-100 text-brand-700 font-semibold px-2 py-0.5 rounded">Admin</span>
        </div>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          <span className="text-gray-400">{session.user?.email}</span>
          <span className="text-gray-300">|</span>
          <span className="font-medium text-gray-700">{orgName}</span>
          <a href="/logout" className="hover:underline text-gray-500 ml-2">Log out</a>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-gray-900">Admin Overview</h1>

        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "Clinicians", value: clinicianCount },
            { label: "Active patients", value: totalActive },
            { label: "Pending invitations", value: pendingInvites },
          ].map(({ label, value }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-100 shadow px-6 py-5">
              <p className="text-sm text-gray-500">{label}</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">{value}</p>
            </div>
          ))}
        </div>

        {/* Tab nav */}
        <div className="flex gap-1 border-b border-gray-200">
          {[
            { id: "overview", label: "Clinicians" },
            { id: "invitations", label: `Invitations${pendingInvites > 0 ? ` (${pendingInvites})` : ""}` },
          ].map(({ id, label }) => (
            <a
              key={id}
              href={`/super/dashboard?tab=${id}`}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === id
                  ? "border-brand-600 text-brand-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </a>
          ))}
        </div>

        {/* ── Clinicians tab ── */}
        {tab === "overview" && (
          <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Clinical team</h2>
            </div>
            {clinicians.length === 0 ? (
              <p className="px-6 py-8 text-sm text-gray-500 text-center">No clinicians yet. Invite one using the Invitations tab.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                    <th className="px-6 py-3 text-left font-medium">Name / Email</th>
                    <th className="px-6 py-3 text-left font-medium">Role</th>
                    <th className="px-6 py-3 text-right font-medium">Active patients</th>
                    <th className="px-6 py-3 text-right font-medium">Total assigned</th>
                    <th className="px-6 py-3 text-left font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {clinicians.map((c) => (
                    <tr key={c.user_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4">
                        <p className="font-medium text-gray-900">{c.name ?? "—"}</p>
                        <p className="text-xs text-gray-400">{c.email}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                          {ROLE_LABELS[c.role] ?? c.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right font-semibold text-gray-900">{c.active_patients}</td>
                      <td className="px-6 py-4 text-right text-gray-500">{c.total_patients}</td>
                      <td className="px-6 py-4 text-gray-500">
                        {new Date(c.joined_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Invitations tab ── */}
        {tab === "invitations" && (
          <div className="space-y-6">
            {/* Alerts */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>
            )}
            {cancelled && (
              <div className="bg-gray-50 border border-gray-200 text-gray-700 text-sm rounded-lg px-4 py-3">Invitation cancelled.</div>
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
              <h2 className="text-base font-semibold text-gray-900 mb-4">Send an invitation</h2>
              <form action={sendInvitationAction} className="space-y-4">
                <input type="hidden" name="_redirect_base" value="/super/dashboard?tab=invitations" />
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
                  <input
                    id="email" name="email" type="email" required
                    placeholder="invitee@example.com"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-400 focus:border-brand-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="invitation_type" className="block text-sm font-medium text-gray-700 mb-1">Invitation type</label>
                  <select
                    id="invitation_type" name="invitation_type" required
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

            {/* Invitation list */}
            {invRows.length > 0 && (
              <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-base font-semibold text-gray-900">All invitations</h2>
                </div>
                <div className="divide-y divide-gray-100">
                  {invRows.map((inv) => (
                    <div key={inv.id} className="px-6 py-4 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{inv.email}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {inv.invitation_type.replace(/_/g, " ")} · expires{" "}
                          {new Date(inv.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[inv.status] ?? "bg-gray-100 text-gray-600"}`}>
                          {inv.status}
                        </span>
                        {inv.status === "pending" && (
                          <form action={cancelInvitationAction}>
                            <input type="hidden" name="invitation_id" value={inv.id} />
                            <input type="hidden" name="_redirect_base" value="/super/dashboard?tab=invitations" />
                            <button type="submit" className="text-xs text-red-600 hover:underline font-medium">
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
            {invRows.length === 0 && !sent && (
              <p className="text-sm text-gray-500 text-center py-6">No invitations yet.</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
