// M3.5 S4 — the ONE password policy for every password a user chooses in the
// application: invitation acceptance (new accounts), password recovery and
// the signed-in password change. Existing passwords are never re-checked.
//
//   - at least PASSWORD_MIN_LENGTH characters (Unicode code points);
//   - at most PASSWORD_MAX_BYTES UTF-8 bytes (bcrypt, which Supabase Auth
//     uses, silently ignores everything after byte 72);
//   - not only whitespace;
//   - not the account's own email address;
//   - the confirmation must match, when one is asked for.
//
// Supabase Auth applies its own project minimum as well (a second,
// independent check). Pure: no I/O, safe on server and client.

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

export type PasswordPolicyCode = "too_short" | "too_long" | "blank" | "same_as_email" | "mismatch";

export type PasswordPolicyResult = { ok: true } | { ok: false; code: PasswordPolicyCode };

export const PASSWORD_POLICY_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`;

export const PASSWORD_POLICY_COPY: Record<PasswordPolicyCode, string> = {
  too_short: `Your password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: "Your password is too long. Please use a shorter one.",
  blank: "Your password can't be only spaces.",
  same_as_email: "Your password can't be your email address.",
  mismatch: "The two passwords don't match.",
};

export function checkPassword(
  password: unknown,
  options: { confirmation?: unknown; email?: string | null } = {},
): PasswordPolicyResult {
  if (typeof password !== "string") return { ok: false, code: "too_short" };
  if ([...password].length < PASSWORD_MIN_LENGTH) return { ok: false, code: "too_short" };
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return { ok: false, code: "too_long" };
  if (password.trim().length === 0) return { ok: false, code: "blank" };
  if (options.email && password.trim().toLowerCase() === options.email.trim().toLowerCase()) {
    return { ok: false, code: "same_as_email" };
  }
  if (options.confirmation !== undefined && options.confirmation !== password) return { ok: false, code: "mismatch" };
  return { ok: true };
}
