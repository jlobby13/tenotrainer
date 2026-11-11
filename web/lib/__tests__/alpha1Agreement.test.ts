// Alpha 1 — Participation Agreement: version / text / hash consistency, the
// server-side form check, and static guards that the patient acceptance path
// always goes through the agreement wrapper.
//
// Run: compile with tsc to a scratch directory (CommonJS) and run with node,
// from web/ (the static guards read source files relative to the cwd).
import crypto from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  ALPHA1_AGREEMENT_CHECKBOX_LABEL,
  ALPHA1_AGREEMENT_KEY,
  ALPHA1_AGREEMENT_TITLE,
  ALPHA1_AGREEMENT_VERSION,
  ALPHA1_CONTACT_EMAIL,
  alpha1AgreementCanonicalText,
} from "../alpha1Agreement";
import { alpha1AgreementSha256, checkAlpha1AgreementForm } from "../alpha1AgreementCore";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail}]` : ""}`);
}

// Changing the agreement wording changes this hash. That is intended: bump
// ALPHA1_AGREEMENT_VERSION and update both pins together, deliberately.
const PINNED_VERSION = "1.1";
const PINNED_SHA256 = "6898f1ac6e8cf59c6b508bff643b4b9c5b59590069337674bbabec2202dd486d";
// v1.0 (historical; acceptances recorded under it keep this hash): f58f56599a1e91e28fde7fbf11dddacb10593cfea9ff80cf0c4b77d43985a90d

const text = alpha1AgreementCanonicalText();
const sha = alpha1AgreementSha256();

// ------------------------------------------------------------ version / text / hash
check("version is the pinned version", ALPHA1_AGREEMENT_VERSION === PINNED_VERSION, ALPHA1_AGREEMENT_VERSION);
check("text hash is the pinned hash for this version (wording change => version bump)", sha === PINNED_SHA256, sha);
check("hash is SHA-256 (hex) of the canonical text", sha === crypto.createHash("sha256").update(text, "utf8").digest("hex") && /^[0-9a-f]{64}$/.test(sha));
check("canonical text is deterministic", alpha1AgreementCanonicalText() === text);
check("canonical text starts with the title and version", text.startsWith(`${ALPHA1_AGREEMENT_TITLE}\nVersion ${ALPHA1_AGREEMENT_VERSION}\n`));
check("canonical text ends with the exact checkbox wording", text.endsWith("\nI have read and agree to the TenoTrainer Alpha 1 Participation Agreement.") && ALPHA1_AGREEMENT_CHECKBOX_LABEL === "I have read and agree to the TenoTrainer Alpha 1 Participation Agreement.");
check("title is exact", ALPHA1_AGREEMENT_TITLE === "TenoTrainer Alpha 1 Participation Agreement");
check("contact address is the official one and appears in the text", ALPHA1_CONTACT_EMAIL === "tenotrainer@tenotrainer.com" && text.includes("tenotrainer@tenotrainer.com"));
check("emergency instruction present", text.includes("In a medical emergency, call 911."));
for (const required of ["not a medical service", "fictional", "Vercel", "Supabase", "Resend", "no automatic deletion schedule", "backups",
  // v1.1 — deletion vs closure (Stage 4 procedure)
  "delete your account and your testing information from TenoTrainer's active database", "we will close your account instead",
  "Closing blocks access to your account and removes identifying account details, including your name and email address",
  "stay linked to the closed account", "including any free text you entered, may still contain personal information",
  "Closing an account is not complete deletion and does not guarantee anonymity", "authentication logs", "Resend email records",
  "In a medical emergency, call 911.", "tenotrainer@tenotrainer.com"]) {
  check(`text covers: ${required}`, text.includes(required));
}
for (const forbidden of [/HIPAA/i, /encrypt/i, /guarantee(s)? (that )?(your|the) (data|information)/i, /\b\d+\s*(days?|months?|years?)\b/i]) {
  check(`text makes no unsupported claim: ${forbidden}`, !forbidden.test(text));
}

// ------------------------------------------------------------ the form check (server-side)
const form = (entries: Record<string, string>) => ({ get: (k: string) => (k in entries ? entries[k] : null) });
const code = (entries: Record<string, string>) => {
  const r = checkAlpha1AgreementForm(form(entries));
  return "code" in r ? r.code : "ok";
};
check("missing acknowledgment is refused", code({ agreement_version: "1.1" }) === "agreement_required");
check("any value other than 'accepted' is refused", code({ agreement: "on", agreement_version: "1.1" }) === "agreement_required" && code({ agreement: "true", agreement_version: "1.1" }) === "agreement_required" && code({ agreement: "", agreement_version: "1.1" }) === "agreement_required");
check("missing version is refused as an updated agreement", code({ agreement: "accepted" }) === "agreement_updated");
check("an older / different version (e.g. a page still showing v1.0) is refused", code({ agreement: "accepted", agreement_version: "1.0" }) === "agreement_updated" && code({ agreement: "accepted", agreement_version: "0.9" }) === "agreement_updated" && code({ agreement: "accepted", agreement_version: "1.1 " }) === "agreement_updated");
check("accepted + current version passes", code({ agreement: "accepted", agreement_version: "1.1" }) === "ok");
check("client-supplied hash / user / timestamp fields are ignored", code({ agreement: "accepted", agreement_version: "1.1", agreement_sha256: "0".repeat(64), user_id: "x", accepted_at: "2000-01-01" }) === "ok");

// ------------------------------------------------------------ static guards (run from web/)
const migration = readFileSync("../supabase/migrations/20261110000001_alpha1_participation_agreement.sql", "utf8");
check("migration accepts exactly the application's agreement key", migration.includes(`agreement_key = '${ALPHA1_AGREEMENT_KEY}'`) && migration.includes(`IS DISTINCT FROM '${ALPHA1_AGREEMENT_KEY}'`));
check("the current version satisfies the migration's version format", new RegExp("^[0-9]{1,3}\\.[0-9]{1,3}$").test(ALPHA1_AGREEMENT_VERSION) && migration.includes("'^[0-9]{1,3}\\.[0-9]{1,3}$'"));
check("migration records only when this call accepted (never on already_accepted: no retrospective acknowledgment)", /IF v_result->>'result' = 'accepted' THEN/.test(migration) && !/IN \('accepted', 'already_accepted'\)/.test(migration));
check("migration revokes the original acceptance function from service_role", /REVOKE EXECUTE ON FUNCTION public\.accept_patient_invitation\(TEXT, UUID\) FROM service_role;/.test(migration));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const appSources = [...sourceFiles("app"), ...sourceFiles("lib")].map((f) => [f, readFileSync(f, "utf8")] as const);
const originalCallers = appSources.filter(([, s]) => /["'`]accept_patient_invitation["'`]/.test(s)).map(([f]) => f);
check("no application code calls the original accept_patient_invitation RPC", originalCallers.length === 0, originalCallers.join(", "));
const wrapperCallers = appSources.filter(([, s]) => s.includes('"accept_patient_invitation_with_agreement"')).map(([f]) => f);
check("exactly one application caller of the wrapper (lib/patientInvitationServer.ts)", wrapperCallers.length === 1 && wrapperCallers[0].endsWith(join("lib", "patientInvitationServer.ts")), wrapperCallers.join(", "));
const server = readFileSync("lib/patientInvitationServer.ts", "utf8");
check("the wrapper receives server constants only (alpha1AgreementRecord)", /const agreement = alpha1AgreementRecord\(\);[\s\S]*p_agreement_key: agreement\.key,\s*p_agreement_version: agreement\.version,\s*p_agreement_sha256: agreement\.sha256,/.test(server));
const actions = readFileSync("app/invite/accept/actions.ts", "utf8");
const newUser = actions.match(/export async function acceptPatientInvitationNewUserAction[\s\S]*?\n}\n/)?.[0] ?? "";
const existingUser = actions.match(/export async function acceptPatientInvitationExistingUserAction[\s\S]*?\n}\n/)?.[0] ?? "";
check("new-user action checks the agreement before creating the account", newUser.includes("requireAgreement(token, formData);") && newUser.indexOf("requireAgreement(") < newUser.indexOf("createUser("));
check("existing-user action checks the agreement before accepting", existingUser.includes("requireAgreement(token, formData);") && existingUser.indexOf("requireAgreement(") < existingUser.indexOf("finishPatientAcceptance("));
const staffActions = actions.slice(actions.indexOf("// Tester / clinician-admin invitations"));
check("development-only staff/tester actions are unchanged (no agreement, still development-only)", !staffActions.includes("requireAgreement") && (staffActions.match(/refuseActionOutsideDevelopment\("\/invite\/accept"\)/g) ?? []).length === 2);
// Stage 3B — Supabase Auth's leaked-password refusal gets its own message.
const createBranch = newUser.match(/if \(createError \|\| !created\.user\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
check("weak_password from Supabase Auth maps to password_weak, before the duplicate / generic mapping",
  /if \(createError\?\.code === "weak_password"\) backToInvite\(token, "password_weak"\);/.test(createBranch)
    && createBranch.indexOf('"password_weak"') < createBranch.indexOf("const exists"), createBranch);
check("duplicate-account and generic account errors are mapped exactly as before",
  createBranch.includes('const exists = /already|exists|registered/i.test(createError?.message ?? "");')
    && createBranch.includes('backToInvite(token, exists ? "account_exists" : "account_failed");'));
check("no Supabase error text is ever passed to the page (fixed codes only)", !/backToInvite\([^)]*(message|createError)/.test(actions));
const page = readFileSync("app/invite/accept/page.tsx", "utf8");
check("the page shows the approved weak-password message",
  page.includes(`password_weak: "That password isn't strong enough. Please choose a longer or less common one.",`));
check("the page renders only fixed copy for an error code (never the URL value itself)",
  page.includes("const errorMessage = error ? (ERROR_COPY[error] ?? ERROR_COPY.error) : null;"));
check("password guidance keeps the requirement and adds the unique-password advice",
  page.includes("{PASSWORD_POLICY_HINT} Use a unique password. Avoid common or previously leaked passwords.") && page.includes('aria-describedby="password-hint"'));
const controls = readFileSync("app/invite/accept/AgreementAcceptControls.tsx", "utf8");
check("checkbox is native, unchecked by default and required", /type="checkbox"/.test(controls) && /name="agreement"/.test(controls) && /value="accepted"/.test(controls) && /\brequired\b/.test(controls) && /useState\(false\)/.test(controls) && !/defaultChecked/.test(controls));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
