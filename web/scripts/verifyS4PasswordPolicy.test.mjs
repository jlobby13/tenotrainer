// M3.5 S4 — unit tests (no database, no network): the shared password
// policy, the recovery helpers, and the redirect validator the recovery and
// login pages rely on.
//
// Run from web/:  node --experimental-strip-types scripts/verifyS4PasswordPolicy.test.mjs
import { checkPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, PASSWORD_POLICY_COPY } from "../lib/passwordPolicy.ts";
import { isRecoveryTokenShape, normalizeRecoveryEmail, RECOVERY_PATH } from "../lib/passwordRecovery.ts";
import { safeInternalPath } from "../lib/safeRedirect.ts";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};
const code = (r) => (r.ok ? "ok" : r.code);

console.log("--- password policy ---");
check("minimum is 10 characters; maximum 72 bytes", PASSWORD_MIN_LENGTH === 10 && PASSWORD_MAX_BYTES === 72);
check("9 characters → too_short", code(checkPassword("a".repeat(9))) === "too_short");
check("10 characters → ok", code(checkPassword("abcdefghij")) === "ok");
check("non-string → too_short", code(checkPassword(undefined)) === "too_short" && code(checkPassword(12345678901)) === "too_short");
check("length counts code points (10 emoji = ok, 40 bytes)", code(checkPassword("😀".repeat(10))) === "ok");
check("72 ASCII bytes → ok; 73 → too_long", code(checkPassword("a".repeat(72))) === "ok" && code(checkPassword("a".repeat(73))) === "too_long");
check("19 four-byte emoji (76 bytes) → too_long", code(checkPassword("😀".repeat(19))) === "too_long");
check("only spaces → blank", code(checkPassword(" ".repeat(12))) === "blank");
check("the account email (any case / surrounding space) → same_as_email",
  code(checkPassword("Pat.Doe@Example.com ", { email: "pat.doe@example.com" })) === "same_as_email");
check("confirmation mismatch → mismatch", code(checkPassword("correct horse battery", { confirmation: "correct horse batterY" })) === "mismatch");
check("matching confirmation → ok", code(checkPassword("correct horse battery", { confirmation: "correct horse battery", email: "x@example.com" })) === "ok");
check("every code has fixed copy", ["too_short", "too_long", "blank", "same_as_email", "mismatch"].every((c) => typeof PASSWORD_POLICY_COPY[c] === "string"));
check("copy never echoes input", !Object.values(PASSWORD_POLICY_COPY).some((t) => t.includes("{")));

console.log("--- recovery helpers ---");
check("recovery path is the fixed /auth/confirm", RECOVERY_PATH === "/auth/confirm");
check("email normalized (trim, lowercase)", normalizeRecoveryEmail("  Pat@Example.COM ") === "pat@example.com");
check("not an email → null", [null, "", "pat", "pat@", "@example.com", "a b@example.com", `${"a".repeat(250)}@example.com`].every((e) => normalizeRecoveryEmail(e) === null));
const hash56 = "a".repeat(56);
check("56-hex token hash with type=recovery → valid", isRecoveryTokenShape(hash56, "recovery"));
check("pkce_-prefixed hash → valid", isRecoveryTokenShape(`pkce_${hash56}`, "recovery"));
check("wrong type (signup / magiclink / email_change / missing) → invalid",
  ["signup", "magiclink", "email_change", undefined, ""].every((t) => !isRecoveryTokenShape(hash56, t)));
check("non-hex / uppercase / short / long / injected → invalid",
  ["z".repeat(56), "A".repeat(56), "a".repeat(39), "a".repeat(129), `${hash56}&next=//evil`, `${hash56} `, "", null].every((h) => !isRecoveryTokenShape(h, "recovery")));

console.log("--- redirect validator (unchanged; used by login / callback) ---");
check("same-origin path kept", safeInternalPath("/account/password", "/dashboard") === "/account/password");
check("absolute / protocol-relative / backslash / encoded → fallback",
  ["https://evil.example/x", "//evil.example", "/\\evil.example", "/%2fevil.example", "javascript:alert(1)"].every((p) => safeInternalPath(p, "/dashboard") === "/dashboard"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
