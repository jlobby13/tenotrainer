// M2 — unit test for the one shared internal-redirect validator.
// Run from web/:  node --experimental-strip-types scripts/verifyM2SafeRedirect.test.mjs
import { safeInternalPath, withQuery } from "../lib/safeRedirect.ts";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const FALLBACK = "/dashboard";
const rejected = [
  "//evil.com", "///evil.com", "/\\evil.com", "\\\\evil.com", "/\\/evil.com",
  "https://evil.com", "http://evil.com/x", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.c",
  "evil.com", "dashboard", " /dashboard", "",
  "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\u0000/evil.com", "/\u007f",
  "/%2F/evil.com", "/%2f%2fevil.com", "/%5Cevil.com", "/%5c/evil.com",
  "/" + "a".repeat(3000),
  null, undefined, 42, {},
];
for (const r of rejected) {
  const out = safeInternalPath(r, FALLBACK);
  check(`rejects ${JSON.stringify(r)?.slice(0, 40)}`, out === FALLBACK, out);
}

const accepted = [
  ["/dashboard", "/dashboard"],
  ["/invite/accept?token=abc123", "/invite/accept?token=abc123"],
  ["/clinician/patients/1/prescription?notice=paused#top", "/clinician/patients/1/prescription?notice=paused#top"],
  ["/super/dashboard?tab=invitations", "/super/dashboard?tab=invitations"],
  ["/a/../b", "/b"],
  ["/path%20with%20space", "/path%20with%20space"],
];
for (const [input, expected] of accepted) {
  const out = safeInternalPath(input, FALLBACK);
  check(`accepts ${input}`, out === expected, out);
}

for (let i = 0; i < 2000; i++) {
  // Fuzz: random mixes of the characters bypasses are built from must never
  // yield a path that resolves off-origin or starts with "//".
  const alphabet = ["/", "\\", "%2f", "%5c", ":", "@", ".", "e", "v", "l", "\t", "?", "#", " "];
  let s = "/";
  for (let j = 0; j < 8; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  const out = safeInternalPath(s, FALLBACK);
  const ok = out === FALLBACK || (out.startsWith("/") && !out.startsWith("//") && new URL(out, "https://app.test").origin === "https://app.test");
  if (!ok) check(`fuzz ${JSON.stringify(s)}`, false, out);
}
check("fuzz: 2000 random bypass-alphabet inputs never escape the origin", true);

check("withQuery appends to a path without a query", withQuery("/admin/invitations", { error: "x y" }) === "/admin/invitations?error=x+y");
check("withQuery appends to a path with a query", withQuery("/super/dashboard?tab=invitations", { sent: "1" }) === "/super/dashboard?tab=invitations&sent=1");
check("withQuery skips null values", withQuery("/a", { b: null, c: "1" }) === "/a?c=1");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
