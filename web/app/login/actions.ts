"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/safeRedirect";
import { AUTH_RESPONSE_FLOOR_MS, guardedLoginAttempt, normalizeAccountIdentifier } from "@/lib/authRateLimit";
import { getAuthRateLimiter, requestClientNetwork } from "@/lib/authRateLimitServer";

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
  const started = Date.now();
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");
  const next = safeInternalPath(formData.get("next"), "/dashboard");

  // M3.5 D3 — rate-limited login (lib/authRateLimit.ts guardedLoginAttempt).
  const outcome = await guardedLoginAttempt(
    getAuthRateLimiter(),
    { account: normalizeAccountIdentifier(email), network: await requestClientNetwork() },
    async () => {
      const supabase = await createServerSupabaseClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? { ok: false, code: loginErrorCode(error) } : { ok: true };
    },
  );
  if (outcome.kind === "signed_in") redirect(next);

  // Every failure takes at least the same minimum time.
  const left = AUTH_RESPONSE_FLOOR_MS - (Date.now() - started);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  const code = outcome.kind === "refused" ? outcome.code : outcome.kind === "limited" ? "rate_limited" : "unavailable";
  redirect(`/login?${new URLSearchParams({ error: code, email, next })}`);
}
