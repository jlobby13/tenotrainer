import { createServiceRoleClient } from "@/lib/supabase/server";

// Server-side mapping — browser never submits a role directly.
export const INVITATION_ROLE_MAP = {
  USER_TESTER: "tester",
  CLINICIAN_ADMIN_TESTER: "clinician_admin",
} as const satisfies Record<string, string>;

export type InvitationType = keyof typeof INVITATION_ROLE_MAP;

export type Invitation = {
  id: string;
  organization_id: string;
  invited_by: string;
  email: string;
  invitation_type: InvitationType;
  granted_role: string;
  token: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  organizations: { name: string; slug: string } | null;
};

export type InvitationValidation =
  | { valid: true; invitation: Invitation }
  | { valid: false; reason: "not_found" | "expired" | "already_used" | "cancelled" };

/**
 * Validate an invitation token using the service-role client.
 * Tokens are never exposed via RLS — only the server may look them up.
 */
export async function validateInvitationToken(
  token: string
): Promise<InvitationValidation> {
  if (!token || token.length < 10) return { valid: false, reason: "not_found" };

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("invitations")
    .select("*, organizations(name, slug)")
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return { valid: false, reason: "not_found" };

  if (data.status === "cancelled") return { valid: false, reason: "cancelled" };
  if (data.status === "accepted") return { valid: false, reason: "already_used" };
  if (new Date(data.expires_at) < new Date()) return { valid: false, reason: "expired" };

  return { valid: true, invitation: data as Invitation };
}
