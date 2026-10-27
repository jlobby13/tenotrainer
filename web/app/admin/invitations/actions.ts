"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { INVITATION_ROLE_MAP, generateInvitationToken, hashInvitationToken, invitationUrl } from "@/lib/invitations";
import { safeInternalPath, withQuery } from "@/lib/safeRedirect";
import { getSessionInfo, hasRole } from "@/lib/auth";
import { sendInvitationEmail } from "@/lib/email";
import { refuseActionOutsideDevelopment } from "@/lib/modeActions";

async function getAdminContext() {
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");
  if (!hasRole(session.memberships, "clinician_admin")) {
    redirect("/dashboard?error=Insufficient+permissions");
  }
  // The organization this user administers — never just memberships[0].
  const membership = session.memberships.find((m) => m.role === "clinician_admin" || m.role === "super_user")!;
  return {
    userId: session.user.id,
    orgId: membership.organization_id,
    orgName: membership.organizations?.name ?? "TenoTrainer",
  };
}

export async function sendInvitationAction(formData: FormData) {
  refuseActionOutsideDevelopment("/dashboard"); // F9: development-only workflow
  const { userId, orgId, orgName } = await getAdminContext();

  const email = (formData.get("email") as string).trim().toLowerCase();
  const invitationType = formData.get("invitation_type") as string;
  const base = safeInternalPath(formData.get("_redirect_base"), "/admin/invitations");

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect(withQuery(base, { error: "Invalid email address" }));
  }
  if (!(invitationType in INVITATION_ROLE_MAP)) {
    redirect(withQuery(base, { error: "Invalid invitation type" }));
  }

  const grantedRole = INVITATION_ROLE_MAP[invitationType as keyof typeof INVITATION_ROLE_MAP];
  const service = createServiceRoleClient();

  // Cancel any existing pending invitation for this email+org (allow resend)
  await service
    .from("invitations")
    .update({ status: "cancelled" })
    .eq("organization_id", orgId)
    .eq("email", email)
    .eq("status", "pending")
    .neq("invitation_type", "PATIENT"); // clinicians' patient invitations are theirs to manage

  const token = generateInvitationToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const inviteUrl = invitationUrl(token);

  // Send email before inserting — if email fails we surface it without creating a record
  const emailResult = await sendInvitationEmail({ to: email, inviteUrl, orgName, invitationType });

  const { error } = await service.from("invitations").insert({
    organization_id: orgId,
    invited_by: userId,
    email,
    invitation_type: invitationType,
    granted_role: grantedRole,
    token_hash: hashInvitationToken(token),
    expires_at: expiresAt,
    email_sent_at: emailResult.sent ? new Date().toISOString() : null,
  });

  if (error) {
    redirect(withQuery(base, { error: "Failed to create invitation: " + error.message }));
  }

  if (!emailResult.sent) {
    redirect(withQuery(base, { sent: "1", token, email, email_warn: emailResult.reason }));
  }

  redirect(withQuery(base, { sent: "1", token, email, emailed: "1" }));
}

export async function cancelInvitationAction(formData: FormData) {
  refuseActionOutsideDevelopment("/dashboard"); // F9: development-only workflow
  const { orgId } = await getAdminContext();

  const invitationId = formData.get("invitation_id") as string;
  const base = safeInternalPath(formData.get("_redirect_base"), "/admin/invitations");
  if (!invitationId) redirect(withQuery(base, { error: "Missing invitation ID" }));

  const service = createServiceRoleClient();

  const { data: inv } = await service
    .from("invitations")
    .select("id, organization_id, status")
    .eq("id", invitationId)
    .maybeSingle();

  if (!inv || inv.organization_id !== orgId) {
    redirect(withQuery(base, { error: "Invitation not found" }));
  }
  if (inv.status !== "pending") {
    redirect(withQuery(base, { error: "Only pending invitations can be cancelled" }));
  }

  const { error } = await service
    .from("invitations")
    .update({ status: "cancelled" })
    .eq("id", invitationId);

  if (error) {
    redirect(withQuery(base, { error: "Failed to cancel: " + error.message }));
  }

  revalidatePath("/admin/invitations");
  revalidatePath("/super/dashboard");
  redirect(withQuery(base, { cancelled: "1" }));
}
