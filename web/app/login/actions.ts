"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/safeRedirect";

// M3.5 S4 — login failures travel as fixed codes (rendered from fixed copy
// on /login), never as Supabase's message text: "Email not confirmed",
// "User banned" and the like would disclose account state, and a free-text
// URL parameter would let anyone put arbitrary wording on the login page.
function loginErrorCode(error: { status?: number; code?: string }): "rate_limited" | "invalid_credentials" | "unavailable" {
  if (error.status === 429 || (error.code ?? "").startsWith("over_")) return "rate_limited";
  if (error.status !== undefined && error.status >= 500) return "unavailable";
  // invalid_credentials, email_not_confirmed, user_banned, user_not_found, …
  return "invalid_credentials";
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(formData.get("next"), "/dashboard");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const params = new URLSearchParams({ error: loginErrorCode(error), email, next });
    redirect(`/login?${params}`);
  }

  redirect(next);
}
