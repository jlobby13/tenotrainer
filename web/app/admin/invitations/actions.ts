"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import crypto from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { INVITATION_ROLE_MAP, type InvitationType } from "@/lib/invitations";
import { getSessionInfo, hasRole } from "@/lib/auth";
import { sendInvitationEmail } from "@/lib/email";

async function getAdminContext() {
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");
  if (!hasRole(session.memberships, "clinician_admin")) {
    redirect("/dashboard?error=Insufficient+permissions");
  }
  const membership = session.memberships[0];
  return {
    userId: session.user.id,
    orgId: membership.organization_id,
    orgName: membership.organizations?.name ?? "TenoTrainer",
  };
}

export async function sendInvitationAction(formData: FormData) {
  const { userId, orgId, orgName } = await getAdminContext();

  const email = (formData.get("email") as string).trim().toLowerCase();
  const invitationType = formData.get("invitation_type") as string;
  const base = (formData.get("_redirect_base") as string | null) ?? "/admin/invitations";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect(`${base}&error=Invalid+email+address`);
  }
  if (!(invitationType in INVITATION_ROLE_MAP)) {
    redirect(`${base}&error=Invalid+invitation+type`);
  }

  const grantedRole = INVITATION_ROLE_MAP[invitationType as InvitationType];
  const service = createServiceRoleClient();

  // Cancel any existing pending invitation for this email+org (allow resend)
  await service
    .from("invitations")
    .update({ status: "cancelled" })
    .eq("organization_id", orgId)
    .eq("email", email)
    .eq("status", "pending");

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const inviteUrl = `${appUrl}/invite/accept?token=${token}`;

  // Send email before inserting — if email fails we surface it without creating a record
  const emailResult = await sendInvitationEmail({ to: email, inviteUrl, orgName, invitationType });

  const { error } = await service.from("invitations").insert({
    organization_id: orgId,
    invited_by: userId,
    email,
    invitation_type: invitationType,
    granted_role: grantedRole,
    token,
    expires_at: expiresAt,
    email_sent_at: emailResult.sent ? new Date().toISOString() : null,
  });

  if (error) {
    redirect(`${base}&error=${encodeURIComponent("Failed to create invitation: " + error.message)}`);
  }

  if (!emailResult.sent) {
    redirect(
      `${base}&sent=1&token=${token}&email=${encodeURIComponent(email)}&email_warn=${encodeURIComponent(emailResult.reason)}`
    );
  }

  redirect(`${base}&sent=1&token=${token}&email=${encodeURIComponent(email)}&emailed=1`);
}

export async function cancelInvitationAction(formData: FormData) {
  const { orgId } = await getAdminContext();

  const invitationId = formData.get("invitation_id") as string;
  const base = (formData.get("_redirect_base") as string | null) ?? "/admin/invitations";
  if (!invitationId) redirect(`${base}?error=Missing+invitation+ID`);

  const service = createServiceRoleClient();

  const { data: inv } = await service
    .from("invitations")
    .select("id, organization_id, status")
    .eq("id", invitationId)
    .maybeSingle();

  if (!inv || inv.organization_id !== orgId) {
    redirect(`${base}?error=Invitation+not+found`);
  }
  if (inv.status !== "pending") {
    redirect(`${base}?error=Only+pending+invitations+can+be+cancelled`);
  }

  const { error } = await service
    .from("invitations")
    .update({ status: "cancelled" })
    .eq("id", invitationId);

  if (error) {
    redirect(`${base}?error=${encodeURIComponent("Failed to cancel: " + error.message)}`);
  }

  revalidatePath("/admin/invitations");
  revalidatePath("/super/dashboard");
  redirect(`${base}?cancelled=1`);
}
