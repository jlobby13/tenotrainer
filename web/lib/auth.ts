import { createServerSupabaseClient } from "@/lib/supabase/server";

export type OrgMembership = {
  organization_id: string;
  role: string;
  joined_at: string;
  organizations: { name: string; slug: string } | null;
};

export type SessionInfo = {
  user: {
    id: string;
    email: string;
    emailConfirmedAt: string | null;
    createdAt: string;
  } | null;
  profile: {
    name: string;
    tfa_enabled: boolean;
    organization_id: string | null;
  } | null;
  memberships: OrgMembership[];
  errors: { source: string; message: string }[];
};

/**
 * Load the full session picture for a server-rendered page.
 * Returns structured data for all auth checks — never throws.
 * Uses the anon-key client so all results are RLS-filtered.
 */
export async function getSessionInfo(): Promise<SessionInfo> {
  const errors: { source: string; message: string }[] = [];

  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) errors.push({ source: "auth.getUser", message: authError.message });
    if (!user) return { user: null, profile: null, memberships: [], errors };

    const sessionUser = {
      id: user.id,
      email: user.email ?? "(no email)",
      emailConfirmedAt: user.email_confirmed_at ?? null,
      createdAt: user.created_at,
    };

    // Profile row
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("name, tfa_enabled, organization_id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) errors.push({ source: "profiles", message: profileError.message });

    // Org memberships (may be empty — handled gracefully)
    const { data: memberships, error: memberError } = await supabase
      .from("organization_members")
      .select("organization_id, role, joined_at, organizations(name, slug)")
      .eq("user_id", user.id);

    if (memberError) errors.push({ source: "organization_members", message: memberError.message });

    return {
      user: sessionUser,
      profile: profile ?? null,
      memberships: (memberships as unknown as OrgMembership[]) ?? [],
      errors,
    };
  } catch (e) {
    errors.push({ source: "getSessionInfo", message: String(e) });
    return { user: null, profile: null, memberships: [], errors };
  }
}

/** True if the session user has at least one org membership with the given role. */
export function hasRole(memberships: OrgMembership[], role: string): boolean {
  const hierarchy: Record<string, number> = {
    member: 0,
    tester: 0,
    clinician: 1,
    clinician_admin: 2,
    super_user: 3,
  };
  const required = hierarchy[role] ?? 0;
  return memberships.some((m) => (hierarchy[m.role] ?? -1) >= required);
}
