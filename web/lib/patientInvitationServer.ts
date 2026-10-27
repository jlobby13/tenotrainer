import "server-only";

// M2 — native patient invitation. A clinician invites a patient by email;
// accepting the invitation atomically creates the patient-role membership,
// the clinician–patient assignment and the accepted state
// (accept_patient_invitation, 20261025000001). Every write goes through a
// server-only RPC; the actor is always the authenticated session user
// resolved by the caller, never a browser-supplied id. Raw tokens exist only
// inside the invite link — the database stores their SHA-256 hash.

import { createServiceRoleClient } from "./supabase/server";
import { generateInvitationToken, hashInvitationToken, invitationUrl, validateInvitationToken, type InvitationValidation } from "./invitations";
import { sendPatientInvitationEmail } from "./email";
import { assertMutationAllowed } from "./operatingMode";

type Json = Record<string, unknown>;

export type CreatePatientInvitationResult =
  | { result: "created"; email: string; inviteUrl: string; emailed: boolean; emailWarning: string | null }
  | { result: "not_authorized" | "invalid_email" | "staff_account" | "already_assigned" | "error" };

// The organizations in which this user may invite patients (clinician or
// clinician_admin membership).
export async function clinicianInviteOrganizations(clinicianId: string): Promise<{ id: string; name: string }[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("organization_members")
    .select("organization_id, organizations(name)")
    .eq("user_id", clinicianId)
    .in("role", ["clinician", "clinician_admin"]);
  return (data ?? []).map((m) => ({
    id: m.organization_id as string,
    name: ((m.organizations as unknown as { name: string } | null)?.name ?? "Your clinic") as string,
  }));
}

async function displayName(admin: ReturnType<typeof createServiceRoleClient>, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data } = await admin.from("profiles").select("name").eq("id", userId).maybeSingle();
  return ((data?.name as string | null) ?? "").trim() || null;
}

export async function createPatientInvitation(params: {
  clinicianId: string;
  organizationId: string;
  email: string;
}): Promise<CreatePatientInvitationResult> {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  const admin = createServiceRoleClient();
  const token = generateInvitationToken();
  const { data, error } = await admin.rpc("create_patient_invitation", {
    p_clinician_id: params.clinicianId,
    p_organization_id: params.organizationId,
    p_email: params.email,
    p_token_hash: hashInvitationToken(token),
  });
  if (error) {
    console.error("create_patient_invitation failed:", error.message);
    return { result: "error" };
  }
  const r = (data ?? {}) as Json;
  if (r.result !== "created") return { result: r.result as "not_authorized" | "invalid_email" | "staff_account" | "already_assigned" };

  const invitationId = r.invitation_id as string;
  const { data: inv } = await admin.from("invitations").select("email, organizations(name)").eq("id", invitationId).maybeSingle();
  const email = (inv?.email as string) ?? params.email.trim().toLowerCase();
  const orgName = (inv?.organizations as unknown as { name: string } | null)?.name ?? "your clinic";
  const clinicianName = (await displayName(admin, params.clinicianId)) ?? "Your clinician";
  const inviteUrl = invitationUrl(token);

  const emailResult = await sendPatientInvitationEmail({ to: email, inviteUrl, orgName, clinicianName });
  if (emailResult.sent) {
    await admin.from("invitations").update({ email_sent_at: new Date().toISOString() }).eq("id", invitationId);
  }
  return {
    result: "created",
    email,
    inviteUrl,
    emailed: emailResult.sent,
    emailWarning: emailResult.sent ? null : emailResult.reason,
  };
}

export async function cancelPatientInvitation(actorId: string, invitationId: string): Promise<"cancelled" | "not_found" | "not_pending" | "error"> {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  if (!/^[0-9a-f-]{36}$/i.test(invitationId)) return "not_found";
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("cancel_patient_invitation", { p_actor_id: actorId, p_invitation_id: invitationId });
  if (error) return "error";
  return ((data as Json)?.result as "cancelled" | "not_found" | "not_pending") ?? "error";
}

export type ClinicianInvitationRow = {
  id: string;
  organizationId: string;
  email: string;
  status: "pending" | "accepted" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  emailed: boolean;
};

// This clinician's own patient invitations, newest first.
export async function listClinicianPatientInvitations(clinicianId: string): Promise<ClinicianInvitationRow[]> {
  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("invitations")
    .select("id, organization_id, email, status, created_at, expires_at, accepted_at, accepted_by, email_sent_at")
    .eq("invited_by", clinicianId)
    .eq("invitation_type", "PATIENT")
    .order("created_at", { ascending: false })
    .limit(50);
  const now = Date.now();
  return (data ?? []).map((r) => ({
    id: r.id as string,
    organizationId: r.organization_id as string,
    email: r.email as string,
    // "expired" is derived from expires_at; the row stays pending.
    status: r.status === "pending" && new Date(r.expires_at as string).getTime() <= now ? "expired" : (r.status as ClinicianInvitationRow["status"]),
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    acceptedAt: (r.accepted_at as string | null) ?? null,
    acceptedBy: (r.accepted_by as string | null) ?? null,
    emailed: r.email_sent_at != null,
  }));
}

// What the acceptance page shows: the invitation state plus the inviting
// clinician and the organization (founder D5 — the page must identify both).
export async function getInvitationPreview(token: string): Promise<
  InvitationValidation & { clinicianName: string | null; organizationName: string | null }
> {
  const validation = await validateInvitationToken(token);
  if (!validation.invitation) return { ...validation, clinicianName: null, organizationName: null };
  const admin = createServiceRoleClient();
  return {
    ...validation,
    clinicianName: await displayName(admin, validation.invitation.invited_by),
    organizationName: validation.invitation.organizations?.name ?? null,
  };
}

export type AcceptPatientInvitationResult =
  | "accepted"
  | "already_accepted"
  | "invalid"
  | "already_used"
  | "cancelled"
  | "expired"
  | "wrong_account"
  | "staff_account"
  | "other_organization"
  | "inviter_unavailable"
  | "error";

export async function acceptPatientInvitation(token: string, userId: string): Promise<AcceptPatientInvitationResult> {
  // M3.1 — clinical mutation: refused in maintenance mode (defense in depth).
  assertMutationAllowed();
  if (!/^[0-9a-f]{64}$/.test(token)) return "invalid";
  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc("accept_patient_invitation", {
    p_token_hash: hashInvitationToken(token),
    p_user_id: userId,
  });
  if (error) {
    console.error("accept_patient_invitation failed:", error.message);
    return "error";
  }
  return ((data as Json)?.result as AcceptPatientInvitationResult) ?? "error";
}
