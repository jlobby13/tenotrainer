// M3.2 — safety-email configuration validation, the fake provider's
// development-only construction, and the PHI-free email template (unit; no
// database, no network). Deterministic under any parent-shell
// TENOTRAINER_MODE.
//
// Run from web/:  node --experimental-strip-types scripts/verifyM32SafetyEnv.test.mjs
import { validateServerEnv, ConfigError } from "../lib/envValidation.ts";
import { FakeSafetyEmailProvider } from "../lib/safetyEmail/fakeProvider.ts";
import { buildSafetyEmail, notificationLink, SAFETY_EMAIL_SUBJECTS } from "../lib/safetyEmail/template.ts";

let pass = 0;
let fail = 0;
const check = (label, ok) => { if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}`); } };
const throwsConfig = (env, includes) => {
  try { validateServerEnv(env); return false; } catch (e) { return e instanceof ConfigError && (!includes || e.message.includes(includes)); }
};
const SECRET = "m32-dispatch-secret-0123456789abcdef-xyz";
const PROD = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.example",
  SAFETY_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: SECRET, RESEND_API_KEY: "re_test", RESEND_FROM: "TenoTrainer <s@tenotrainer.example>",
};

for (const mode of ["production", "maintenance"]) {
  const base = { ...PROD, TENOTRAINER_MODE: mode };
  const c = validateServerEnv(base);
  check(`${mode}: complete safety configuration accepted (resend, dispatch configured)`, c.safetyEmailProvider === "resend" && c.safetyDispatchConfigured === true);
  check(`${mode}: FakeProvider refused`, throwsConfig({ ...base, SAFETY_EMAIL_PROVIDER: "fake" }, "forbidden"));
  check(`${mode}: missing provider refused (no silent 'email disabled')`, throwsConfig({ ...base, SAFETY_EMAIL_PROVIDER: "" }, "SAFETY_EMAIL_PROVIDER"));
  check(`${mode}: unknown provider refused`, throwsConfig({ ...base, SAFETY_EMAIL_PROVIDER: "smtp" }, "SAFETY_EMAIL_PROVIDER"));
  check(`${mode}: missing dispatch secret refused`, throwsConfig({ ...base, SAFETY_DISPATCH_SECRET: "" }, "SAFETY_DISPATCH_SECRET"));
  check(`${mode}: short dispatch secret refused`, throwsConfig({ ...base, SAFETY_DISPATCH_SECRET: "short" }, "at least 32"));
  check(`${mode}: missing RESEND_API_KEY refused`, throwsConfig({ ...base, RESEND_API_KEY: "" }, "RESEND_API_KEY"));
  check(`${mode}: missing RESEND_FROM refused`, throwsConfig({ ...base, RESEND_FROM: "" }, "RESEND_FROM"));
  let msg = "";
  try { validateServerEnv({ ...base, SAFETY_DISPATCH_SECRET: "tiny-secret-value" }); } catch (e) { msg = e.message; }
  check(`${mode}: errors never contain the secret value`, msg.length > 0 && !msg.includes("tiny-secret-value"));
}
const dev = validateServerEnv({ TENOTRAINER_MODE: "development" });
check("development: no provider configured -> dispatch disabled (null), never an implicit real provider", dev.safetyEmailProvider === null && dev.safetyDispatchConfigured === false);
check("development: fake allowed explicitly", validateServerEnv({ TENOTRAINER_MODE: "development", SAFETY_EMAIL_PROVIDER: "fake" }).safetyEmailProvider === "fake");
check("development: resend only with its key and sender", throwsConfig({ TENOTRAINER_MODE: "development", SAFETY_EMAIL_PROVIDER: "resend" }, "RESEND_API_KEY"));
check("development: a present-but-short dispatch secret is refused", throwsConfig({ TENOTRAINER_MODE: "development", SAFETY_DISPATCH_SECRET: "short" }, "at least 32"));
check("development: the existing RESEND_API_KEY alone never selects a provider",
  validateServerEnv({ TENOTRAINER_MODE: "development", RESEND_API_KEY: "re_real_looking" }).safetyEmailProvider === null);

let refused = false;
try { new FakeSafetyEmailProvider({ mode: "production" }); } catch { refused = true; }
check("FakeSafetyEmailProvider refuses to construct outside development", refused);
let refusedM = false;
try { new FakeSafetyEmailProvider({ mode: "maintenance" }); } catch { refusedM = true; }
check("FakeSafetyEmailProvider refuses maintenance too", refusedM);

check("subjects are exactly the approved wording",
  SAFETY_EMAIL_SUBJECTS.clinician_review === "TenoTrainer: clinician review required"
  && SAFETY_EMAIL_SUBJECTS.urgent_clinician_review === "TenoTrainer: urgent clinician review required");
const link = notificationLink("https://app.tenotrainer.example/", "22222222-2222-2222-2222-222222222222");
check("link: opaque recipient id behind the authenticated notification route only", link === "https://app.tenotrainer.example/clinician/notifications/22222222-2222-2222-2222-222222222222");
const m = buildSafetyEmail({ to: "clin@example.invalid", tier: "clinician_review", organizationName: "Org <b>&</b>", link });
check("template: organization name is HTML-escaped", m.html.includes("Org &lt;b&gt;&amp;&lt;/b&gt;") && !m.html.includes("<b>&</b>"));
check("template: no tracking pixel, no images, no external resources beyond the link", !/<img|<script|https?:\/\/(?!app\.tenotrainer\.example)/i.test(m.html));
check("template: no numeric level, no symptom, no date in subject/body",
  !/level\s*\d|pain|pop|sharp|swelling|\b20\d\d-\d\d-\d\d\b/i.test(`${m.subject} ${m.text} ${m.html}`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
