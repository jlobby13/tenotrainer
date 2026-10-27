"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { hashInvitationToken, validateInvitationToken } from "@/lib/invitations";
import { acceptPatientInvitation } from "@/lib/patientInvitationServer";
import { refuseActionInMaintenance, refuseActionOutsideDevelopment } from "@/lib/modeActions";

// M2 — every acceptance lands in native Next.js (never the FastAPI bridge).
const PATIENT_HOME = "/patient/dashboard";
const STAFF_HOME = "/dashboard";

function backToInvite(token: string, error: string): never {
  redirect(`/invite/accept?token=${encodeURIComponent(token)}&error=${encodeURIComponent(error)}`);
}

function readToken(formData: FormData): string {
  const token = formData.get("token");
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? token : "";
}

// ---------------------------------------------------------------------------
// Patient invitations (M2). The authoritative facts — patient membership,
// clinician–patient assignment, accepted state — are written together by
// accept_patient_invitation in ONE transaction. Account creation (Supabase
// auth) cannot join that transaction, so it happens first; if acceptance is
// then refused, the account exists, nothing else was written and the
// invitation stays retryable.
// ---------------------------------------------------------------------------

async function finishPatientAcceptance(token: string, userId: string): Promise<never> {
  const result = await acceptPatientInvitation(token, userId);
  if (result === "accepted" || result === "already_accepted") redirect(PATIENT_HOME);
  backToInvite(token, result);
}

export async function acceptPatientInvitationNewUserAction(formData: FormData) {
  refuseActionInMaintenance("/invite/accept");
  const token = readToken(formData);
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!token) redirect("/invite/accept");
  if (name.length < 2 || name.length > 120) backToInvite(token, "name_invalid");
  if (password.length < 8) backToInvite(token, "password_invalid");

  const validation = await validateInvitationToken(token);
  if (!validation.valid) backToInvite(token, validation.reason);
  const { invitation } = validation;
  if (invitation.invitation_type !== "PATIENT") backToInvite(token, "invalid");

  const service = createServiceRoleClient();
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: invitation.email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (createError || !created.user) {
    const exists = /already|exists|registered/i.test(createError?.message ?? "");
    backToInvite(token, exists ? "account_exists" : "account_failed");
  }

  // Establish the session first so a refused acceptance still leaves the
  // patient signed in to retry (the invitation is untouched on refusal).
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signInWithPassword({ email: invitation.email, password });
  await finishPatientAcceptance(token, created.user.id);
}

export async function acceptPatientInvitationExistingUserAction(formData: FormData) {
  refuseActionInMaintenance("/invite/accept");
  const token = readToken(formData);
  if (!token) redirect("/invite/accept");

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`);

  // Identity is the authenticated session's; the RPC re-validates the email
  // match, staff/organization rules and state under the invitation row lock.
  await finishPatientAcceptance(token, user.id);
}

// ---------------------------------------------------------------------------
// Tester / clinician-admin invitations (pre-M2 types, admin-issued). Same
// behaviour as before except: the token is matched by hash and success
// routes natively (/dashboard role router) instead of the FastAPI bridge.
// ---------------------------------------------------------------------------

async function claimInvitation(tokenHash: string, userId: string | null): Promise<boolean> {
  const service = createServiceRoleClient();
  const now = new Date().toISOString();
  const { data } = await service
    .from("invitations")
    .update({ status: "accepted", accepted_at: now, ...(userId ? { accepted_by: userId } : {}) })
    .eq("token_hash", tokenHash)
    .eq("status", "pending")
    .neq("invitation_type", "PATIENT")
    .gt("expires_at", now)
    .select("id");
  return Array.isArray(data) && data.length > 0;
}

async function ensureMembership(orgId: string, userId: string, role: string): Promise<boolean> {
  const service = createServiceRoleClient();
  const { error } = await service.from("organization_members").upsert(
    { organization_id: orgId, user_id: userId, role },
    { onConflict: "organization_id,user_id", ignoreDuplicates: true }
  );
  return !error;
}

export async function acceptInvitationNewUserAction(formData: FormData) {
  refuseActionOutsideDevelopment("/invite/accept"); // F9: tester/admin invitations are development-only
  const token = readToken(formData);
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!token) redirect("/invite/accept");
  if (name.length < 2) backToInvite(token, "name_invalid");
  if (password.length < 8) backToInvite(token, "password_invalid");

  const validation = await validateInvitationToken(token);
  if (!validation.valid) backToInvite(token, validation.reason);
  const { invitation } = validation;
  if (invitation.invitation_type === "PATIENT") backToInvite(token, "invalid");
  const tokenHash = hashInvitationToken(token);

  if (!(await claimInvitation(tokenHash, null))) backToInvite(token, "already_used");

  const service = createServiceRoleClient();
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: invitation.email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (createError || !created.user) {
    // Unclaim — restore to pending so the link can be retried.
    await service.from("invitations").update({ status: "pending", accepted_at: null }).eq("token_hash", tokenHash);
    const exists = /already|exists|registered/i.test(createError?.message ?? "");
    backToInvite(token, exists ? "account_exists" : "account_failed");
  }
  const userId = created.user.id;
  await service.from("invitations").update({ accepted_by: userId }).eq("token_hash", tokenHash);
  await ensureMembership(invitation.organization_id, userId, invitation.granted_role);

  const supabase = await createServerSupabaseClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email: invitation.email, password });
  if (signInError) redirect("/login?error=Account+created.+Please+log+in+to+continue.");
  redirect(STAFF_HOME);
}

export async function acceptInvitationExistingUserAction(formData: FormData) {
  refuseActionOutsideDevelopment("/invite/accept"); // F9
  const token = readToken(formData);
  if (!token) redirect("/invite/accept");

  const validation = await validateInvitationToken(token);
  if (!validation.valid) backToInvite(token, validation.reason);
  const { invitation } = validation;
  if (invitation.invitation_type === "PATIENT") backToInvite(token, "invalid");

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
  if (user.email?.toLowerCase() !== invitation.email.toLowerCase()) backToInvite(token, "wrong_account");

  if (!(await claimInvitation(hashInvitationToken(token), user.id))) backToInvite(token, "already_used");
  await ensureMembership(invitation.organization_id, user.id, invitation.granted_role);
  redirect(STAFF_HOME);
}
