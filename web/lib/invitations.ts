import "server-only";

import crypto from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";

// Server-side mapping — browser never submits a role directly. The database
// enforces the same mapping (invitations_role_matches_type, M2), so a
// granted_role can never be chosen freely by any writer.
export const INVITATION_ROLE_MAP = {
  USER_TESTER: "tester",
  CLINICIAN_ADMIN_TESTER: "clinician_admin",
} as const satisfies Record<string, string>;

export type InvitationType = keyof typeof INVITATION_ROLE_MAP | "PATIENT";

export type Invitation = {
  id: string;
  organization_id: string;
  invited_by: string | null;
  email: string;
  invitation_type: InvitationType;
  granted_role: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  created_at: string;
  organizations: { name: string; slug: string } | null;
};

export type InvitationValidation =
  | { valid: true; invitation: Invitation }
  | { valid: false; reason: "not_found" | "expired" | "already_used" | "cancelled"; invitation: Invitation | null };

// M2 — invitation tokens: 256 random bits, handed out once inside the invite
// link; only the SHA-256 hash is ever stored or compared.
export function generateInvitationToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashInvitationToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function invitationUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${appUrl}/invite/accept?token=${token}`;
}

/**
 * Look an invitation up by its token (hashed) using the service-role client.
 * Invitations are not readable by clients at all — only the server may look
 * them up. Display check only: acceptance re-validates under a row lock.
 */
export async function validateInvitationToken(token: string): Promise<InvitationValidation> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return { valid: false, reason: "not_found", invitation: null };

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("invitations")
    .select("id, organization_id, invited_by, email, invitation_type, granted_role, status, expires_at, accepted_at, accepted_by, created_at, organizations(name, slug)")
    .eq("token_hash", hashInvitationToken(token))
    .maybeSingle();

  if (error || !data) return { valid: false, reason: "not_found", invitation: null };
  const invitation = data as unknown as Invitation;

  if (invitation.status === "cancelled") return { valid: false, reason: "cancelled", invitation };
  if (invitation.status === "accepted") return { valid: false, reason: "already_used", invitation };
  if (new Date(invitation.expires_at) <= new Date()) return { valid: false, reason: "expired", invitation };

  return { valid: true, invitation };
}
