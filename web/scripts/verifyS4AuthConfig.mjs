// M3.5 S4 — READ-ONLY Supabase Auth configuration check for password
// recovery. GETs /v1/projects/<ref>/config/auth with the operator's
// Management API token (~/.supabase/access-token) and reports ONLY
// non-secret settings. SMTP credentials and template bodies are never
// printed (presence / variable usage only). Never writes anything.
//
//   node scripts/verifyS4AuthConfig.mjs                     # production (registry), canonical origin
//   node scripts/verifyS4AuthConfig.mjs --project <ref> --origin <https://origin> [--report-only]
//
// Exit 1 when any requirement fails (unless --report-only).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const registry = JSON.parse(readFileSync(new URL("../config/resourceIdentity.json", import.meta.url), "utf8"));
const productionRefs = registry.productionSupabaseProjects ?? [];
const ref = arg("--project") ?? productionRefs[0];
const origin = arg("--origin") ?? "https://tenotrainer.vercel.app";
const reportOnly = args.includes("--report-only");
if (!/^[a-z0-9]{20}$/.test(ref ?? "")) { console.error("a 20-character project ref is required"); process.exit(2); }
if (!/^https?:\/\/[^/]+$/.test(origin)) { console.error("--origin must be scheme://host[:port]"); process.exit(2); }
const isProduction = productionRefs.includes(ref);
const RECOVERY_URL = `${origin}/auth/confirm`;
const MIN_LENGTH = 8; // Supabase floor; the application itself enforces 10 (lib/passwordPolicy.ts)

const token = readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  headers: { Authorization: `Bearer ${token}`, "User-Agent": "tenotrainer-s4-config-check" },
});
if (!res.ok) { console.error(`Management API GET failed: HTTP ${res.status}`); process.exit(2); }
const c = await res.json();

const template = String(c.mailer_templates_recovery_content ?? "");
const allow = String(c.uri_allow_list ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const report = {
  project: ref,
  production: isProduction,
  site_url: c.site_url,
  uri_allow_list: allow,
  disable_signup: c.disable_signup,
  external_email_enabled: c.external_email_enabled,
  password_min_length: c.password_min_length,
  password_hibp_enabled: c.password_hibp_enabled,
  security_update_password_require_reauthentication: c.security_update_password_require_reauthentication,
  mailer_notifications_password_changed_enabled: c.mailer_notifications_password_changed_enabled,
  mailer_otp_exp_seconds: c.mailer_otp_exp,
  rate_limit_email_sent_per_hour: c.rate_limit_email_sent,
  smtp: { host: c.smtp_host ?? null, sender: c.smtp_admin_email ?? null, user_set: !!c.smtp_user, password_set: !!c.smtp_pass },
  recovery_template: {
    custom: template.length > 0,
    uses_TokenHash: template.includes("{{ .TokenHash }}"),
    uses_RedirectTo: template.includes("{{ .RedirectTo }}"),
    uses_ConfirmationURL: template.includes("{{ .ConfirmationURL }}"),
    type_recovery: /type=recovery/.test(template),
  },
  recovery_subject: c.mailer_subjects_recovery ?? null,
};

const checks = [
  ["Site URL is the canonical origin", c.site_url === origin],
  [`redirect allowlist contains exactly ${RECOVERY_URL}`, allow.includes(RECOVERY_URL)],
  ["redirect allowlist has no wildcard entries", !allow.some((u) => u.includes("*"))],
  ...(isProduction ? [["redirect allowlist has no localhost / http entries", !allow.some((u) => /localhost|127\.0\.0\.1|^http:/.test(u))]] : []),
  ["public sign-up disabled", c.disable_signup === true],
  ["email/password sign-in enabled", c.external_email_enabled === true],
  [`Supabase minimum password length >= ${MIN_LENGTH}`, Number(c.password_min_length) >= MIN_LENGTH],
  ["custom SMTP configured (host, sender and credentials present)", !!c.smtp_host && !!c.smtp_admin_email && !!c.smtp_user && !!c.smtp_pass],
  ["recovery template uses {{ .TokenHash }} and {{ .RedirectTo }} with type=recovery", report.recovery_template.uses_TokenHash && report.recovery_template.uses_RedirectTo && report.recovery_template.type_recovery],
  ["recovery template does not use {{ .ConfirmationURL }} (PKCE / implicit link)", !report.recovery_template.uses_ConfirmationURL],
  ["reauthentication required for password change", c.security_update_password_require_reauthentication === true],
  ["'password changed' notification email on", c.mailer_notifications_password_changed_enabled === true],
  ["leaked-password (HIBP) check on", c.password_hibp_enabled === true],
  ["recovery links expire within 1 hour", Number(c.mailer_otp_exp) > 0 && Number(c.mailer_otp_exp) <= 3600],
];

console.log(JSON.stringify(report, null, 1));
let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(`\n${checks.length - failed} passed, ${failed} failed${reportOnly ? " (report only)" : ""}`);
if (failed > 0 && !reportOnly) process.exit(1);
