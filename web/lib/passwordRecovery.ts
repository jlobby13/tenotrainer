// M3.5 S4 — pure password-recovery helpers (no I/O; unit-tested by
// scripts/verifyS4PasswordPolicy.test.mjs). Server logic lives in
// passwordRecoveryServer.ts.

export const RECOVERY_PATH = "/auth/confirm";

const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

export function normalizeRecoveryEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_SHAPE.test(email) ? email : null;
}

// Supabase token hashes are lowercase hex (optionally "pkce_"-prefixed).
const TOKEN_HASH_SHAPE = /^(pkce_)?[0-9a-f]{40,128}$/;

export function isRecoveryTokenShape(tokenHash: unknown, type: unknown): tokenHash is string {
  return type === "recovery" && typeof tokenHash === "string" && TOKEN_HASH_SHAPE.test(tokenHash);
}
