"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { validateInvitationToken } from "@/lib/invitations";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const BRIDGE_PATH = "/api/auth/launch-dashboard";

/**
 * Atomically claim the invitation — UPDATE WHERE status='pending'.
 * Returns false if the invite was already used, expired, or cancelled between
 * the page load and the form submit (prevents replay).
 */
async function claimInvitation(token: string, userId: string | null): Promise<boolean> {
  const service = createServiceRoleClient();
  const now = new Date().toISOString();
  const { data } = await service
    .from("invitations")
    .update({
      status: "accepted",
      accepted_at: now,
      ...(userId ? { accepted_by: userId } : {}),
    })
    .eq("token", token)
    .eq("status", "pending")
    .gt("expires_at", now)
    .select("id");

  return Array.isArray(data) && data.length > 0;
}

async function updateAcceptedBy(token: string, userId: string) {
  const service = createServiceRoleClient();
  await service
    .from("invitations")
    .update({ accepted_by: userId })
    .eq("token", token);
}

/** Ensure the user is not already a member — safe to call on every accept. */
async function ensureMembership(orgId: string, userId: string, role: string): Promise<boolean> {
  const service = createServiceRoleClient();
  const { error } = await service.from("organization_members").upsert(
    { organization_id: orgId, user_id: userId, role },
    { onConflict: "organization_id,user_id", ignoreDuplicates: true }
  );
  return !error;
}

// ---------------------------------------------------------------------------
// New-user acceptance (create Supabase account + join org)
// ---------------------------------------------------------------------------

export async function acceptInvitationNewUserAction(formData: FormData) {
  const token = formData.get("token") as string;
  const name = (formData.get("name") as string).trim();
  const password = formData.get("password") as string;

  if (!name || name.length < 2) {
    redirect(`/invite/accept?token=${token}&error=Name+must+be+at+least+2+characters`);
  }
  if (!password || password.length < 8) {
    redirect(`/invite/accept?token=${token}&error=Password+must+be+at+least+8+characters`);
  }

  // Validate the token (soft check — authoritative claim happens below)
  const validation = await validateInvitationToken(token);
  if (!validation.valid) {
    redirect(`/invite/accept?token=${token}&error=This+invitation+is+no+longer+valid`);
  }
  const { invitation } = validation;

  // Atomically claim the invitation before creating the user — if this succeeds, we own it
  const claimed = await claimInvitation(token, null);
  if (!claimed) {
    redirect(`/invite/accept?token=${token}&error=This+invitation+has+already+been+accepted+or+has+expired`);
  }

  const service = createServiceRoleClient();

  // Create auth user — trigger auto-creates profile using user_metadata.name
  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: invitation.email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (createError) {
    // Unclaim — restore to pending so the link can be retried
    await service.from("invitations").update({ status: "pending", accepted_at: null }).eq("token", token);

    const msg =
      createError.message.includes("already") || createError.message.includes("exists")
        ? "An account with that email already exists. Try logging in via the link in your email."
        : "Failed to create account. Please try again.";
    redirect(`/invite/accept?token=${token}&error=${encodeURIComponent(msg)}`);
  }

  const userId = created.user.id;

  // Set accepted_by now that we have the user ID
  await updateAcceptedBy(token, userId);

  // Add org membership with role from the DB record (not the browser)
  const memberOk = await ensureMembership(invitation.organization_id, userId, invitation.granted_role);
  if (!memberOk) {
    // Membership failed — don't leave the user stranded; they can still log in, membership can be fixed manually
  }

  // Sign in with anon+cookies client so the session cookie is established
  const supabase = await createServerSupabaseClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: invitation.email,
    password,
  });

  if (signInError) {
    redirect("/login?error=Account+created.+Please+log+in+to+continue.");
  }

  // Bridge to FastAPI dashboard
  redirect(BRIDGE_PATH);
}

// ---------------------------------------------------------------------------
// Existing-user acceptance (already logged in with matching email)
// ---------------------------------------------------------------------------

export async function acceptInvitationExistingUserAction(formData: FormData) {
  const token = formData.get("token") as string;

  const validation = await validateInvitationToken(token);
  if (!validation.valid) {
    redirect(`/invite/accept?token=${token}&error=This+invitation+is+no+longer+valid`);
  }
  const { invitation } = validation;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
  }

  if (user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
    redirect(
      `/invite/accept?token=${token}&error=${encodeURIComponent(
        `This invitation is for ${invitation.email}. You are signed in as ${user.email}.`
      )}`
    );
  }

  // Atomically claim
  const claimed = await claimInvitation(token, user.id);
  if (!claimed) {
    redirect(`/invite/accept?token=${token}&error=This+invitation+has+already+been+accepted+or+has+expired`);
  }

  await ensureMembership(invitation.organization_id, user.id, invitation.granted_role);

  // Bridge to FastAPI dashboard
  redirect(BRIDGE_PATH);
}
