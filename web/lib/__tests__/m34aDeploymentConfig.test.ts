// M3.4a — deployment configuration dry validation (synthetic values only;
// no real credentials). Re-proves, on the unchanged S3 parser, that a
// Vercel Production configuration refuses every invalid combination the
// founder listed, that a correct one is accepted, and that the intended
// M3.4b Preview configuration (development mode on Vercel Preview) is
// accepted while its unsafe variants are refused.
//
//   npx tsx lib/__tests__/m34aDeploymentConfig.test.ts
import { ConfigError, validateConfig } from "../config/parse";
import type { ResourceIdentityRegistry } from "../config/types";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

type Env = Record<string, string | undefined>;
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ iss: "supabase", ...claims })}.unsignedtestsignature`;
const keys = (ref: string) => ({ SUPABASE_ANON_KEY: jwt({ role: "anon", ref }), SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role", ref }) });

const DEV_REF = "kpdxlzqtvueiytwjamiw"; // the committed development registry entry
const PROD_REF = "abcdefghijklmnopqrst"; // synthetic future production project
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const SECRET32 = "m34a-dispatch-secret-0123456789abcdef-xyz";
const supabase = (ref: string) => ({ SUPABASE_URL: `https://${ref}.supabase.co`, TENOTRAINER_SUPABASE_PROJECT_REF: ref, ...keys(ref) });

// Vercel Production as M3.4e will configure it (placeholders only).
const VERCEL_PROD: Env = {
  VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production",
  TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer-verify.org",
  ...supabase(PROD_REF),
  TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder_not_a_key",
  TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@notify.tenotrainer-verify.org>",
  SAFETY_DISPATCH_SECRET: SECRET32, C5_PRESCRIPTION_PUBLISH_ENABLED: "false",
};
// Vercel Preview as M3.4b will configure it (founder C2).
const VERCEL_PREVIEW: Env = {
  VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production",
  TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: "https://tenotrainer-git-preview-team.vercel.app",
  ...supabase(DEV_REF), C5_PATIENT_RUNTIME_ENABLED: "true", TENOTRAINER_EMAIL_PROVIDER: "disabled",
};
const REGISTRY_WITH_PROD: ResourceIdentityRegistry = {
  developmentSupabaseProjects: [DEV_REF], productionSupabaseProjects: [PROD_REF],
  developmentEmailDomains: ["dev-mail.tenotrainer.test"], productionEmailDomains: ["notify.tenotrainer-verify.org"],
};

function problems(env: Env, registry?: ResourceIdentityRegistry): string[] {
  try {
    validateConfig(env, registry ? { registry } : {});
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
}
function refused(env: Env, includes: string | RegExp, registry?: ResourceIdentityRegistry) {
  const p = problems(env, registry);
  const hit = p.some((x) => (typeof includes === "string" ? x.includes(includes) : includes.test(x)));
  assert(hit, `expected a problem matching ${includes}, got ${JSON.stringify(p)}`);
}
const without = (env: Env, ...names: string[]) => Object.fromEntries(Object.entries(env).filter(([k]) => !names.includes(k)));

// ---------------------------------------------------------------- production: accepted
// M3.4e (N1) — an unregistered production project is refused; the intended
// configuration validates only once its project is registered (next test).
test("Vercel Production: the intended configuration is refused while its project is unregistered", () => {
  refused(VERCEL_PROD, "must be a registered production project in production mode");
});
test("Vercel Production: also valid once the production ref and sender domain are registered", () => {
  assert(problems(VERCEL_PROD, REGISTRY_WITH_PROD).length === 0, JSON.stringify(problems(VERCEL_PROD, REGISTRY_WITH_PROD)));
});

// ---------------------------------------------------------------- production: refused
const PROD_REFUSALS: [string, Env, string | RegExp][] = [
  ["loopback origin", { ...VERCEL_PROD, TENOTRAINER_APP_ORIGIN: "https://localhost" }, "TENOTRAINER_APP_ORIGIN"],
  ["http origin", { ...VERCEL_PROD, TENOTRAINER_APP_ORIGIN: "http://app.tenotrainer-verify.org" }, "TENOTRAINER_APP_ORIGIN"],
  ["origin with a path", { ...VERCEL_PROD, TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer-verify.org/app" }, "TENOTRAINER_APP_ORIGIN"],
  ["the registered development Supabase project", { ...VERCEL_PROD, ...supabase(DEV_REF) }, "registered development project"],
  ["no project-identity pin", without(VERCEL_PROD, "TENOTRAINER_SUPABASE_PROJECT_REF"), "TENOTRAINER_SUPABASE_PROJECT_REF"],
  ["a pin naming another project", { ...VERCEL_PROD, TENOTRAINER_SUPABASE_PROJECT_REF: OTHER_REF }, "TENOTRAINER_SUPABASE_PROJECT_REF"],
  ["a service key of another project", { ...VERCEL_PROD, SUPABASE_SERVICE_ROLE_KEY: keys(OTHER_REF).SUPABASE_SERVICE_ROLE_KEY }, "SUPABASE_SERVICE_ROLE_KEY"],
  ["email provider fake", { ...VERCEL_PROD, TENOTRAINER_EMAIL_PROVIDER: "fake" }, "TENOTRAINER_EMAIL_PROVIDER"],
  ["email provider disabled", { ...VERCEL_PROD, TENOTRAINER_EMAIL_PROVIDER: "disabled" }, "TENOTRAINER_EMAIL_PROVIDER"],
  ["email provider unset", without(VERCEL_PROD, "TENOTRAINER_EMAIL_PROVIDER"), "TENOTRAINER_EMAIL_PROVIDER"],
  ["no Resend key", without(VERCEL_PROD, "RESEND_API_KEY"), "RESEND_API_KEY"],
  ["a reserved sender domain", { ...VERCEL_PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <x@notify.example>" }, "reserved sender domain"],
  ["a development sending domain", { ...VERCEL_PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <x@dev-mail.tenotrainer.test>" }, "TENOTRAINER_NOTIFICATION_EMAIL_FROM"],
  ["development email recipients", { ...VERCEL_PROD, TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@example.com" }, "TENOTRAINER_DEV_EMAIL_RECIPIENTS"],
  ["fake-provider log control", { ...VERCEL_PROD, SAFETY_FAKE_PROVIDER_LOG: "/tmp/x" }, "SAFETY_FAKE_PROVIDER"],
  ["fake-provider script control", { ...VERCEL_PROD, SAFETY_FAKE_PROVIDER_SCRIPT: "/tmp/x" }, "SAFETY_FAKE_PROVIDER"],
  ["FASTAPI_URL", { ...VERCEL_PROD, FASTAPI_URL: "https://legacy.example" }, "FASTAPI_URL"],
  ["BRIDGE_SECRET", { ...VERCEL_PROD, BRIDGE_SECRET: "x".repeat(40) }, "BRIDGE_SECRET"],
  ["ANTHROPIC_API_KEY", { ...VERCEL_PROD, ANTHROPIC_API_KEY: "sk-ant-placeholder" }, "ANTHROPIC_API_KEY"],
  ["NEXT_PUBLIC_APP_URL", { ...VERCEL_PROD, NEXT_PUBLIC_APP_URL: "https://app.tenotrainer-verify.org" }, "NEXT_PUBLIC_APP_URL"],
  ["NEXT_PUBLIC_SUPABASE_URL", { ...VERCEL_PROD, NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co` }, "NEXT_PUBLIC_SUPABASE_URL"],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", { ...VERCEL_PROD, NEXT_PUBLIC_SUPABASE_ANON_KEY: keys(PROD_REF).SUPABASE_ANON_KEY }, "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
  ["RESEND_FROM (retired)", { ...VERCEL_PROD, RESEND_FROM: "x@notify.tenotrainer-verify.org" }, "RESEND_FROM"],
  ["SAFETY_EMAIL_PROVIDER (retired)", { ...VERCEL_PROD, SAFETY_EMAIL_PROVIDER: "resend" }, "SAFETY_EMAIL_PROVIDER"],
  ["RESEND_BASE_URL", { ...VERCEL_PROD, RESEND_BASE_URL: "https://intercept.example" }, "RESEND_BASE_URL"],
  ["a short dispatch secret", { ...VERCEL_PROD, SAFETY_DISPATCH_SECRET: "short" }, "SAFETY_DISPATCH_SECRET"],
  ["no dispatch secret", without(VERCEL_PROD, "SAFETY_DISPATCH_SECRET"), "SAFETY_DISPATCH_SECRET"],
  ["the legacy patient runtime", { ...VERCEL_PROD, C5_PATIENT_RUNTIME_ENABLED: "false" }, "C5_PATIENT_RUNTIME_ENABLED"],
  ["production mode on a Preview deployment", { ...VERCEL_PROD, VERCEL_ENV: "preview" }, "VERCEL_ENV"],
  ["a reserved .test origin on Vercel (no isolated test profile on Vercel)", { ...VERCEL_PROD, TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.test", ...supabase(DEV_REF) }, "registered development project"],
];
for (const [label, env, match] of PROD_REFUSALS) test(`Vercel Production refuses: ${label}`, () => refused(env, match));
test("maintenance on Vercel Production follows the same rules (dev project refused)", () => refused({ ...VERCEL_PROD, TENOTRAINER_MODE: "maintenance", ...supabase(DEV_REF) }, "registered development project"));

// ---------------------------------------------------------------- Preview (M3.4b model)
test("Vercel Preview: development mode, development project, email disabled, no FastAPI → valid", () => {
  const c = validateConfig(VERCEL_PREVIEW).config;
  assert(c.mode === "development" && c.email.provider === "disabled" && c.runtimeGate === true && c.supabase.ref === DEV_REF, JSON.stringify(c));
  assert(c.mode === "development" && c.platform.isDevServer === false && c.safetyDispatchConfigured === false, "no dev server, no dispatch credential");
});
test("Vercel Preview: without C5_PATIENT_RUNTIME_ENABLED=true development selects the LEGACY runtime (Preview must set it)", () => {
  const c = validateConfig(without(VERCEL_PREVIEW, "C5_PATIENT_RUNTIME_ENABLED")).config;
  assert(c.runtimeGate === false, "unset gate means legacy in development");
});
test("Vercel Preview refuses a registered production project", () => refused({ ...VERCEL_PREVIEW, ...supabase(PROD_REF) }, /production/i, REGISTRY_WITH_PROD));
test("Vercel Preview refuses a production sending domain", () => refused({ ...VERCEL_PREVIEW, TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@notify.tenotrainer-verify.org", TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@example.com" }, "TENOTRAINER_NOTIFICATION_EMAIL_FROM", REGISTRY_WITH_PROD));
test("Vercel Preview refuses a non-development sending domain for Resend", () => refused({ ...VERCEL_PREVIEW, TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_placeholder", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@notify.tenotrainer-verify.org", TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@example.com" }, "TENOTRAINER_NOTIFICATION_EMAIL_FROM"));
test("development mode on a Vercel Production deployment is refused", () => refused({ ...VERCEL_PREVIEW, VERCEL_ENV: "production" }, "VERCEL_ENV"));
test("Vercel Preview refuses the retired NEXT_PUBLIC_ names (on Vercel)", () => {
  const p = problems({ ...VERCEL_PREVIEW, NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_REF}.supabase.co` });
  const w = p.length === 0 ? validateConfig({ ...VERCEL_PREVIEW, NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_REF}.supabase.co` }).config.warnings : [];
  assert(p.some((x) => x.includes("NEXT_PUBLIC_SUPABASE_URL")) || w.some((x) => x.includes("NEXT_PUBLIC_SUPABASE_URL")), `neither refused nor warned: ${JSON.stringify({ p, w })}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
