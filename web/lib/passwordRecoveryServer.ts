import "server-only";

// M3.5 S4 — password recovery (and the signed-in password change), on
// Supabase Auth's email/password accounts. Same flow for patients and staff;
// nothing here reads or changes roles, memberships or clinical data.
//
//   1. requestPasswordRecovery(email) -> resetPasswordForEmail with a
//      redirect built ONLY from configuration (<app origin>/auth/confirm).
//      Callers always show one generic message (no account enumeration).
//      In development the application email policy applies: only an
//      allow-listed recipient can cause a recovery email.
//   2. The recovery email template links to
//      {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery. GET of
//      /auth/confirm only renders a button (link scanners cannot spend the
//      one-time token); the POST calls verifyRecoveryToken, which mints a
//      recovery session (cookies) — no PKCE verifier, so the link works in a
//      mail app's browser or on another device.
//   3. updateAccountPassword() sets the new password (shared policy) and
//      then signs out every OTHER session. Supabase Auth already deletes the
//      user's other sessions when the password changes in a session
//      (models.User.UpdatePassword -> LogoutAllExceptMe); the explicit
//      signOut({ scope: "others" }) is a second, independent revocation.
//
// Logs carry outcome codes only — never an address, token or password.

import { createClient } from "@supabase/supabase-js";
import { getAppOrigin, getConfig, getSupabasePublic } from "./config";
import { emailDeliveryDecision } from "./emailPolicy";
import { checkPassword, type PasswordPolicyCode } from "./passwordPolicy";
import { isRecoveryTokenShape, normalizeRecoveryEmail, RECOVERY_PATH } from "./passwordRecovery";
import { createServerSupabaseClient } from "./supabase/server";
import { normalizeAccountIdentifier } from "./authRateLimit";
import { getAuthRateLimiter, requestClientNetwork } from "./authRateLimitServer";

export { isRecoveryTokenShape, normalizeRecoveryEmail, RECOVERY_PATH };

function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  console.info(JSON.stringify({ at: new Date().toISOString(), event: `tenotrainer.auth.${event}`, ...fields }));
}

// The only recovery redirect target: the configured application origin
// (canonical in production / maintenance; the explicit
// TENOTRAINER_APP_ORIGIN in development and Preview). Never request data.
export function recoveryRedirectUrl(): string {
  return new URL(RECOVERY_PATH, getAppOrigin()).toString();
}

// Fire-and-report: the caller ignores the outcome for the user-facing
// response (always the same generic confirmation).
export async function requestPasswordRecovery(rawEmail: unknown): Promise<"requested" | "invalid_email" | "suppressed" | "limited" | "error"> {
  const email = normalizeRecoveryEmail(rawEmail);
  // M3.5 D3 — reserve one request for this client network (and this
  // address, when it is one) before anything else. A refused or failed
  // reservation sends nothing; the caller's response is identical anyway.
  const reservation = await getAuthRateLimiter().reserve([
    { scope: "reset_ip", id: await requestClientNetwork() },
    ...(email ? [{ scope: "reset_account" as const, id: email }] : []),
  ]);
  if (!reservation.allowed) {
    log("recovery_request", { outcome: reservation.reason });
    return reservation.reason === "limited" ? "limited" : "error";
  }
  if (!email) {
    log("recovery_request", { outcome: "invalid_email" });
    return "invalid_email";
  }
  const decision = emailDeliveryDecision(getConfig(), email);
  if (!decision.deliver) {
    log("recovery_request", { outcome: "suppressed", code: decision.code });
    return "suppressed";
  }
  // A cookie-less anon client with the implicit flow: no PKCE verifier is
  // stored, so the emailed token hash is the whole credential.
  const { url, anonKey } = getSupabasePublic();
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
  });
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: recoveryRedirectUrl() });
  if (error) {
    // Includes Supabase's own per-address / hourly email limits.
    log("recovery_request", { outcome: "error", code: error.code ?? null, status: error.status ?? null });
    return "error";
  }
  log("recovery_request", { outcome: "requested" });
  return "requested";
}

// Expired, already used, unknown and malformed links are deliberately one
// outcome ("invalid"): the page never tells them apart.
export async function verifyRecoveryToken(tokenHash: unknown, type: unknown): Promise<"verified" | "invalid" | "rate_limited" | "error"> {
  // M3.5 D3 — one verification attempt per client network (tokens are
  // single-use and unguessable; this bounds abuse of the endpoint).
  const reservation = await getAuthRateLimiter().reserve([{ scope: "verify_ip", id: await requestClientNetwork() }]);
  if (!reservation.allowed) {
    log("recovery_verify", { outcome: reservation.reason });
    return reservation.reason === "limited" ? "rate_limited" : "error";
  }
  if (!isRecoveryTokenShape(tokenHash, type)) {
    log("recovery_verify", { outcome: "invalid", code: "shape" });
    return "invalid";
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
  if (!error) {
    log("recovery_verify", { outcome: "verified" });
    return "verified";
  }
  if (error.status === 429) {
    log("recovery_verify", { outcome: "rate_limited" });
    return "rate_limited";
  }
  if (error.status === 403 || error.status === 400 || error.status === 404 || error.status === 401) {
    log("recovery_verify", { outcome: "invalid", code: error.code ?? null });
    return "invalid";
  }
  log("recovery_verify", { outcome: "error", code: error.code ?? null, status: error.status ?? null });
  return "error";
}

export type PasswordUpdateOutcome =
  | { ok: true; othersSignedOut: boolean }
  | { ok: false; code: PasswordPolicyCode | "not_signed_in" | "same_password" | "weak_password" | "reauthentication_needed" | "rate_limited" | "error" };

export async function updateAccountPassword(password: unknown, confirmation: unknown): Promise<PasswordUpdateOutcome> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: "not_signed_in" };

  const policy = checkPassword(password, { confirmation, email: user.email ?? null });
  if (!policy.ok) return { ok: false, code: policy.code };

  // M3.5 D3 — password changes per signed-in user.
  const limiter = getAuthRateLimiter();
  const reservation = await limiter.reserve([{ scope: "password_user", id: user.id }]);
  if (!reservation.allowed) {
    log("password_update", { outcome: reservation.reason });
    return { ok: false, code: reservation.reason === "limited" ? "rate_limited" : "error" };
  }

  // Only the password field: memberships, roles and metadata are untouched.
  const { error } = await supabase.auth.updateUser({ password: password as string });
  if (error) {
    const code =
      error.code === "same_password" ? "same_password"
      : error.code === "weak_password" ? "weak_password"
      : error.code === "reauthentication_needed" ? "reauthentication_needed"
      : "error";
    log("password_update", { outcome: code, status: error.status ?? null });
    return { ok: false, code };
  }
  const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
  // The account's owner has just proven control (recovery link or live
  // session): lift a login lockout on this account. Network buckets stay.
  await limiter.clear([{ scope: "login_account", id: normalizeAccountIdentifier(user.email) }]);
  log("password_update", { outcome: "updated", others_signed_out: !signOutError });
  return { ok: true, othersSignedOut: !signOutError };
}
