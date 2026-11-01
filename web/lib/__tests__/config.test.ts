// M3.3 S3 — the centralized configuration contract (lib/config/parse.ts):
// Supabase identity, the isolated test profile, platform consistency,
// retired / refused names, origin exactness, strict values and redaction.
import { inspect } from "node:util";
import { ConfigError, validateConfig } from "../config/parse";
import { Secret } from "../config/secret";
import { absoluteUrl, isLoopbackHost, observedRequestHost, originHost, parseOrigin, redirectBase } from "../config/origin";
import { classifySupabaseKey, parseSupabaseUrl, RESOURCE_IDENTITY } from "../config/identity";
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
const PROD_REF = "abcdefghijklmnopqrst"; // unregistered hosted project
const UNKNOWN_REF = "zyxwvutsrqponmlkjihg";
const SECRET32 = "s3-dispatch-secret-0123456789abcdef-xyz";

const supabase = (ref: string) => ({ SUPABASE_URL: `https://${ref}.supabase.co`, TENOTRAINER_SUPABASE_PROJECT_REF: ref, ...keys(ref) });
const email = (from: string) => ({ TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_inert_test", TENOTRAINER_NOTIFICATION_EMAIL_FROM: from, SAFETY_DISPATCH_SECRET: SECRET32 });
const PROD: Env = { TENOTRAINER_MODE: "production", NODE_ENV: "production", TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.example", ...supabase(PROD_REF), ...email("TenoTrainer <safety@notifications.tenotrainer-verify.org>") };
// The existing spawned production-server profile: reserved .test origin + the registered development project.
const ISOLATED: Env = { ...PROD, TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.test", ...supabase(DEV_REF), ...email("TenoTrainer <safety@tenotrainer.test>") };
const DEV: Env = { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: "http://localhost:3000", SUPABASE_URL: `https://${DEV_REF}.supabase.co`, ...keys(DEV_REF) };

function ok(env: Env, registry?: ResourceIdentityRegistry) {
  return validateConfig(env, registry ? { registry } : {}).config;
}
function problems(env: Env, registry?: ResourceIdentityRegistry): string[] {
  try {
    validateConfig(env, registry ? { registry } : {});
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
}
function refused(env: Env, includes: string, registry?: ResourceIdentityRegistry) {
  const p = problems(env, registry);
  assert(p.some((x) => x.includes(includes)), `expected a problem containing "${includes}", got ${JSON.stringify(p)}`);
}

// ---------------------------------------------------------------- registry
test("committed registry: the development project is registered; production lists are empty until M3.4", () => {
  assert(RESOURCE_IDENTITY.developmentSupabaseProjects.includes(DEV_REF), "dev ref");
  assert(RESOURCE_IDENTITY.productionSupabaseProjects.length === 0 && RESOURCE_IDENTITY.productionEmailDomains.length === 0, "no invented production identity");
});

// ---------------------------------------------------------------- isolated test profile (founder Decision 1)
test("profile: .test origin + no Vercel markers -> eligible", () => {
  for (const mode of ["production", "maintenance"]) assert(ok({ ...ISOLATED, TENOTRAINER_MODE: mode }).isolatedTestProfile === true, mode);
});
test("profile: .test origin + VERCEL present -> NOT eligible (ordinary rules: dev project refused)", () => {
  refused({ ...ISOLATED, VERCEL: "1" }, "registered development project and is refused");
  refused({ ...ISOLATED, VERCEL: "" }, "registered development project and is refused"); // set at all, even empty
});
test("profile: .test origin + VERCEL_ENV present -> NOT eligible", () => {
  refused({ ...ISOLATED, VERCEL_ENV: "production" }, "registered development project and is refused");
  refused({ ...ISOLATED, VERCEL_ENV: "production" }, "reserved sender domain");
});
test("profile: normal production origin + no Vercel markers -> NOT eligible", () => {
  assert(ok(PROD).isolatedTestProfile === false, "ordinary production");
  refused({ ...PROD, ...supabase(DEV_REF) }, "registered development project and is refused");
});
test("profile: a .test-looking label that is not the TLD does not qualify", () => {
  refused({ ...ISOLATED, TENOTRAINER_APP_ORIGIN: "https://app.test.example.com" }, "registered development project and is refused");
});
test("profile + registered development ref -> allowed", () => {
  const c = ok(ISOLATED);
  assert(c.mode === "production" && c.supabase.ref === DEV_REF, "isolated accepted");
});
test("profile + unknown ref -> refused", () => {
  refused({ ...ISOLATED, ...supabase(UNKNOWN_REF) }, "must be a registered development project");
});
test("profile + ref also registered as production -> refused", () => {
  const reg = { ...RESOURCE_IDENTITY, productionSupabaseProjects: [DEV_REF] };
  refused(ISOLATED, "registered production project is refused", reg);
});
test("profile + expected-ref missing or mismatched -> refused", () => {
  refused({ ...ISOLATED, TENOTRAINER_SUPABASE_PROJECT_REF: undefined }, "TENOTRAINER_SUPABASE_PROJECT_REF: is required");
  refused({ ...ISOLATED, TENOTRAINER_SUPABASE_PROJECT_REF: UNKNOWN_REF }, "must equal the project ref");
});
test("profile + malformed / wrong-role / swapped / foreign / identical credentials -> refused", () => {
  refused({ ...ISOLATED, SUPABASE_ANON_KEY: "anon" }, "SUPABASE_ANON_KEY: is not a recognised");
  refused({ ...ISOLATED, SUPABASE_ANON_KEY: ISOLATED.SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY: ISOLATED.SUPABASE_ANON_KEY }, "wrong key role");
  refused({ ...ISOLATED, SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "anon", ref: DEV_REF }) }, "SUPABASE_SERVICE_ROLE_KEY: has the wrong key role");
  refused({ ...ISOLATED, ...keys(UNKNOWN_REF) }, "belongs to a different project");
  refused({ ...ISOLATED, SUPABASE_SERVICE_ROLE_KEY: ISOLATED.SUPABASE_ANON_KEY }, "must differ");
});
test("profile + .test / .invalid sender -> allowed; other reserved or sandbox senders still refused", () => {
  assert(ok({ ...ISOLATED, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "safety@tenotrainer.test" }).mode === "production", ".test");
  assert(ok({ ...ISOLATED, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <x@mail.invalid>" }).mode === "production", ".invalid");
  refused({ ...ISOLATED, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@example.com" }, "reserved sender domain");
  refused({ ...ISOLATED, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@onboarding.resend.dev" }, "sandbox sender domain");
});
test("ordinary production + .test / .invalid sender -> refused", () => {
  refused({ ...PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "safety@tenotrainer.test" }, "reserved sender domain");
  refused({ ...PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "safety@mail.invalid" }, "reserved sender domain");
  refused({ ...PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <onboarding@resend.dev>" }, "sandbox sender domain");
});
test("profile relaxes nothing else (NODE_ENV, https, fake provider, bridge, Anthropic, NEXT_PUBLIC, dispatch secret, gates)", () => {
  refused({ ...ISOLATED, NODE_ENV: "development" }, "NODE_ENV: must be production");
  refused({ ...ISOLATED, TENOTRAINER_APP_ORIGIN: "http://app.tenotrainer.test" }, "non-loopback https origin");
  refused({ ...ISOLATED, TENOTRAINER_EMAIL_PROVIDER: "fake" }, '"fake" is forbidden');
  refused({ ...ISOLATED, BRIDGE_SECRET: "x" }, "BRIDGE_SECRET: is legacy bridge configuration");
  refused({ ...ISOLATED, FASTAPI_URL: "http://127.0.0.1:8000" }, "FASTAPI_URL: is legacy bridge configuration");
  refused({ ...ISOLATED, ANTHROPIC_API_KEY: "sk-ant-x" }, "ANTHROPIC_API_KEY: is not a declared credential");
  refused({ ...ISOLATED, NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }, "NEXT_PUBLIC_SUPABASE_URL: NEXT_PUBLIC_* configuration is refused");
  refused({ ...ISOLATED, SAFETY_DISPATCH_SECRET: undefined }, "SAFETY_DISPATCH_SECRET: is required");
  refused({ ...ISOLATED, C5_PATIENT_RUNTIME_ENABLED: "false" }, "C5_PATIENT_RUNTIME_ENABLED");
  refused({ ...ISOLATED, SUPABASE_URL: "http://127.0.0.1:54321", TENOTRAINER_SUPABASE_PROJECT_REF: undefined }, "a local Supabase is refused");
});
test("no generic test override: unknown TEST/BYPASS-style variables have no effect", () => {
  for (const k of ["TENOTRAINER_TEST", "TENOTRAINER_TEST_PROFILE", "TENOTRAINER_ISOLATED_TEST", "ALLOW_DEV_PROJECT", "CI"]) {
    refused({ ...PROD, ...supabase(DEV_REF), [k]: "1" }, "registered development project and is refused");
  }
});

// ---------------------------------------------------------------- ordinary production / maintenance identity
test("production: hosted https://<ref>.supabase.co with matching expected ref accepted", () => {
  for (const mode of ["production", "maintenance"]) assert(ok({ ...PROD, TENOTRAINER_MODE: mode }).supabase.ref === PROD_REF, mode);
});
test("production: local Supabase, custom domains, http and non-bare URLs refused", () => {
  refused({ ...PROD, SUPABASE_URL: "http://127.0.0.1:54321" }, "a local Supabase is refused");
  refused({ ...PROD, SUPABASE_URL: "https://db.tenotrainer.example" }, "must be https://<project-ref>.supabase.co");
  refused({ ...PROD, SUPABASE_URL: `http://${PROD_REF}.supabase.co` }, "must be https://<project-ref>.supabase.co");
  refused({ ...PROD, SUPABASE_URL: `https://${PROD_REF}.supabase.co/` }, "bare project URL");
  refused({ ...PROD, SUPABASE_URL: `https://${PROD_REF}.supabase.co/rest/v1` }, "bare project URL");
});
test("production: expected ref required, well-formed and equal", () => {
  refused({ ...PROD, TENOTRAINER_SUPABASE_PROJECT_REF: undefined }, "TENOTRAINER_SUPABASE_PROJECT_REF: is required");
  refused({ ...PROD, TENOTRAINER_SUPABASE_PROJECT_REF: "ABC" }, "20 lowercase letters");
  refused({ ...PROD, TENOTRAINER_SUPABASE_PROJECT_REF: UNKNOWN_REF }, "must equal the project ref");
});
test("production: new-format keys accepted by slot (no project-ref verification possible); wrong slot refused", () => {
  const nf = { ...PROD, SUPABASE_ANON_KEY: "sb_publishable_abc123", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_def456" };
  assert(ok(nf).mode === "production", "new format");
  refused({ ...nf, SUPABASE_ANON_KEY: "sb_secret_abc123" }, "SUPABASE_ANON_KEY: has the wrong key type");
  refused({ ...nf, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_def456" }, "SUPABASE_SERVICE_ROLE_KEY: has the wrong key type");
  assert(classifySupabaseKey("sb_secret_x").format === "secret" && classifySupabaseKey("sb_publishable_x").format === "publishable", "prefix classification");
});
test("production: a legacy JWT without a ref claim is refused on a hosted project", () => {
  refused({ ...PROD, SUPABASE_ANON_KEY: jwt({ role: "anon" }) }, "belongs to a different project");
});

// ---------------------------------------------------------------- development identity
test("development: registered hosted project or local Supabase accepted", () => {
  assert(ok(DEV).supabase.kind === "hosted", "hosted dev");
  const local = ok({ ...DEV, SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_ANON_KEY: jwt({ role: "anon" }), SUPABASE_SERVICE_ROLE_KEY: jwt({ role: "service_role" }) });
  assert(local.supabase.kind === "local" && local.supabase.ref === null, "local dev");
});
test("development: unregistered hosted project (e.g. future production) refused", () => {
  refused({ ...DEV, SUPABASE_URL: `https://${PROD_REF}.supabase.co`, ...keys(PROD_REF) }, "must be a registered development project in development mode");
  refused(DEV, "registered production project is refused in development", { ...RESOURCE_IDENTITY, productionSupabaseProjects: [DEV_REF] });
});
test("development: expected ref optional, but must match when set; never set for local", () => {
  assert(ok({ ...DEV, TENOTRAINER_SUPABASE_PROJECT_REF: DEV_REF }).mode === "development", "match");
  refused({ ...DEV, TENOTRAINER_SUPABASE_PROJECT_REF: UNKNOWN_REF }, "must equal the project ref");
});

// ---------------------------------------------------------------- platform consistency (never mode inference)
test("NODE_ENV: production/maintenance require production; development accepts any", () => {
  refused({ ...PROD, NODE_ENV: undefined }, "NODE_ENV: must be production");
  refused({ ...PROD, TENOTRAINER_MODE: "maintenance", NODE_ENV: "development" }, "NODE_ENV: must be production in maintenance");
  assert(ok({ ...DEV, NODE_ENV: "production" }).mode === "development", "dev under next start");
  assert(ok({ ...DEV, NODE_ENV: "development" }).platform.isDevServer === true && ok(DEV).platform.isDevServer === false, "dev-server flag");
});
test("NODE_ENV never supplies a mode", () => {
  refused({ ...DEV, TENOTRAINER_MODE: undefined, NODE_ENV: "development" }, "TENOTRAINER_MODE: is required");
  refused({ ...PROD, TENOTRAINER_MODE: undefined }, "TENOTRAINER_MODE: is required");
});
test("VERCEL_ENV: production/maintenance require production; development must not be production", () => {
  assert(ok({ ...PROD, VERCEL_ENV: "production", VERCEL: "1" }).mode === "production", "prod on vercel");
  refused({ ...PROD, VERCEL_ENV: "preview" }, "VERCEL_ENV: must be production");
  refused({ ...DEV, VERCEL_ENV: "production" }, "VERCEL_ENV: a production deployment must not run in development");
  assert(ok({ ...DEV, VERCEL_ENV: "preview", VERCEL: "1" }).mode === "development", "preview = development");
});

// ---------------------------------------------------------------- canonical origin primitives
test("origin: exact origin only", () => {
  assert(parseOrigin("https://app.example.com").ok && parseOrigin("http://localhost:3101").ok, "valid");
  for (const bad of ["https://app.example.com/", "https://app.example.com/x", "https://app.example.com?q", "https://app.example.com#f",
    "https://u:p@app.example.com", "https://APP.example.com", "https://app.example.com:443", "ftp://app.example.com", "app.example.com", ""]) {
    assert(!parseOrigin(bad).ok, `accepted ${bad}`);
  }
  refused({ ...PROD, TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.example/" }, "TENOTRAINER_APP_ORIGIN: must be an exact origin");
});
test("origin: production/maintenance need non-loopback https; development allows loopback http", () => {
  for (const o of ["http://app.tenotrainer.example", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://0.0.0.0", "https://x.localhost"]) {
    refused({ ...PROD, TENOTRAINER_APP_ORIGIN: o }, "non-loopback https origin");
  }
  assert(ok({ ...DEV, TENOTRAINER_APP_ORIGIN: "http://127.0.0.1:3183" }).appOrigin === "http://127.0.0.1:3183", "dev loopback");
  assert(isLoopbackHost("localhost") && !isLoopbackHost("app.example.com"), "loopback classification");
});
test("absoluteUrl: configured origin + internal path only", () => {
  assert(absoluteUrl("https://a.example", "/invite/accept?token=t") === "https://a.example/invite/accept?token=t", "join");
  for (const bad of ["//evil.example/x", "https://evil.example", "invite"]) {
    let threw = false;
    try { absoluteUrl("https://a.example", bad); } catch { threw = true; }
    assert(threw, `accepted ${bad}`);
  }
});
test("S3b: observed host = first X-Forwarded-Host value, else Host (lower-cased; comparison only)", () => {
  assert(observedRequestHost("App.Example.com, proxy.internal", "internal:3000") === "app.example.com", "first XFH");
  assert(observedRequestHost(null, "LOCALHOST:3181") === "localhost:3181", "host");
  assert(observedRequestHost("  ", "h") === "h" && observedRequestHost(null, null) === null, "fallback / none");
});
test("S3b: originHost carries a non-default port only", () => {
  assert(originHost("https://app.example.com") === "app.example.com" && originHost("https://app.example.com:8443") === "app.example.com:8443", "host");
});
test("S3b: redirect base is the configured origin in production/maintenance, request-local in development", () => {
  for (const mode of ["production", "maintenance"]) {
    assert(redirectBase({ mode, appOrigin: "https://app.example.com" }, "http://evil.example:1234/x") === "https://app.example.com", mode);
  }
  assert(redirectBase({ mode: "development", appOrigin: "http://localhost:3000" }, "http://localhost:3183/logout") === "http://localhost:3183", "dev");
});
test("Supabase URL parsing", () => {
  const h = parseSupabaseUrl(`https://${PROD_REF}.supabase.co`);
  assert(h.ok && h.kind === "hosted" && h.ref === PROD_REF, "hosted");
  assert(!parseSupabaseUrl(`https://${PROD_REF}.supabase.co:8443`).ok, "port refused");
  assert(!parseSupabaseUrl("https://abc.supabase.co").ok, "short ref refused");
});

// ---------------------------------------------------------------- retired and refused names
test("NEXT_PUBLIC_*: any present name refused in production/maintenance; ignored with a warning in development", () => {
  for (const [k, repl] of [["NEXT_PUBLIC_APP_URL", "TENOTRAINER_APP_ORIGIN"], ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"], ["NEXT_PUBLIC_ANYTHING", ""]]) {
    refused({ ...PROD, [k]: "value" }, `${k}: NEXT_PUBLIC_* configuration is refused`);
    const w = ok({ ...DEV, [k]: "value" }).warnings;
    assert(w.some((x) => x.startsWith(`${k} is ignored`) && (!repl || x.includes(repl))), `${k} warning: ${JSON.stringify(w)}`);
  }
  assert(ok({ ...PROD, NEXT_PUBLIC_APP_URL: "" }).mode === "production", "empty (blanked) names are absent");
});
test("retired RESEND_FROM refused in production/maintenance, ignored in development", () => {
  refused({ ...PROD, RESEND_FROM: "x@y.org" }, "RESEND_FROM: has been renamed");
  assert(ok({ ...DEV, RESEND_FROM: "x@y.org" }).warnings.some((w) => w.startsWith("RESEND_FROM is ignored")), "dev warning");
  assert(ok({ ...DEV, RESEND_FROM: "x@y.org" }).email.from === null, "never used as the sender");
});
test("retired SAFETY_EMAIL_PROVIDER refused in every mode (renamed)", () => {
  refused({ ...DEV, SAFETY_EMAIL_PROVIDER: "fake" }, "SAFETY_EMAIL_PROVIDER: has been renamed");
  refused({ ...PROD, SAFETY_EMAIL_PROVIDER: "resend" }, "SAFETY_EMAIL_PROVIDER: has been renamed");
});
test("ANTHROPIC_API_KEY refused in production/maintenance; not read in development", () => {
  refused({ ...PROD, TENOTRAINER_MODE: "maintenance", ANTHROPIC_API_KEY: "sk-ant-x" }, "ANTHROPIC_API_KEY");
  assert(ok({ ...DEV, ANTHROPIC_API_KEY: "sk-ant-x" }).mode === "development", "dev ignores");
});

// ---------------------------------------------------------------- strict values
test("malformed booleans refused", () => {
  for (const v of ["1", "yes", "TRUE", "on"]) {
    refused({ ...DEV, C5_PATIENT_RUNTIME_ENABLED: v }, "C5_PATIENT_RUNTIME_ENABLED");
    refused({ ...DEV, C5_PRESCRIPTION_PUBLISH_ENABLED: v }, "C5_PRESCRIPTION_PUBLISH_ENABLED");
  }
  assert(ok({ ...DEV, C5_PATIENT_RUNTIME_ENABLED: " true " }).runtimeGate === true, "trimmed");
});
test("empty / whitespace-only secrets are absent", () => {
  refused({ ...PROD, SAFETY_DISPATCH_SECRET: "   " }, "SAFETY_DISPATCH_SECRET: is required");
  refused({ ...PROD, RESEND_API_KEY: "\t " }, "RESEND_API_KEY: is required");
  refused({ ...DEV, SUPABASE_SERVICE_ROLE_KEY: "  " }, "SUPABASE_SERVICE_ROLE_KEY: is required");
});
test("dispatch secret rotation partner: optional, long, distinct, needs the current secret", () => {
  assert(validateConfig({ ...PROD, SAFETY_DISPATCH_SECRET_NEXT: `${SECRET32}-next` }).secrets.dispatchSecrets.length === 2, "pair");
  refused({ ...PROD, SAFETY_DISPATCH_SECRET_NEXT: "short" }, "SAFETY_DISPATCH_SECRET_NEXT: must be at least 32");
  refused({ ...PROD, SAFETY_DISPATCH_SECRET_NEXT: SECRET32 }, "must differ");
  refused({ ...DEV, SAFETY_DISPATCH_SECRET_NEXT: `${SECRET32}-next` }, "requires SAFETY_DISPATCH_SECRET");
});
test("notification sender must be an email address", () => {
  refused({ ...PROD, TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer" }, "must be an email address");
});

// ---------------------------------------------------------------- redaction
test("Secret never stringifies, serializes or inspects to its value", () => {
  const s = new Secret("SENTINEL-SECRET-VALUE");
  for (const out of [String(s), `${s}`, JSON.stringify({ s }), inspect(s), inspect({ nested: s })]) {
    assert(!out.includes("SENTINEL") && out.includes("[redacted]"), out);
  }
  assert(s.reveal() === "SENTINEL-SECRET-VALUE", "reveal");
});
test("config object carries no secret value; secrets are Secret instances", () => {
  const sentinel = "SENTINEL-DISPATCH-0123456789abcdef0123456789";
  const v = validateConfig({ ...PROD, SAFETY_DISPATCH_SECRET: sentinel, RESEND_API_KEY: "re_SENTINELKEY" });
  const dump = JSON.stringify(v) + inspect(v, { depth: 10 });
  assert(!dump.includes("SENTINEL") && !dump.includes(PROD.SUPABASE_SERVICE_ROLE_KEY!), "leaked into config");
  assert(v.secrets.dispatchSecrets.every((x) => x instanceof Secret) && v.secrets.serviceRoleKey instanceof Secret, "wrapped");
});
test("every refusal names variables and rules, never supplied values", () => {
  const S = "SENTINEL-7f3e";
  const env: Env = {
    TENOTRAINER_MODE: "production", NODE_ENV: `dev${S}`, TENOTRAINER_APP_ORIGIN: `http://${S}.example/`, SUPABASE_URL: `https://${S}.example`,
    TENOTRAINER_SUPABASE_PROJECT_REF: S, SUPABASE_ANON_KEY: S, SUPABASE_SERVICE_ROLE_KEY: S, TENOTRAINER_EMAIL_PROVIDER: S,
    RESEND_API_KEY: S, TENOTRAINER_NOTIFICATION_EMAIL_FROM: S, SAFETY_DISPATCH_SECRET: S, SAFETY_DISPATCH_SECRET_NEXT: S,
    BRIDGE_SECRET: S, FASTAPI_URL: S, ANTHROPIC_API_KEY: S, NEXT_PUBLIC_X: S, RESEND_FROM: S, SAFETY_EMAIL_PROVIDER: S,
    C5_PATIENT_RUNTIME_ENABLED: S, C5_PRESCRIPTION_PUBLISH_ENABLED: S, VERCEL_ENV: S,
  };
  let message = "";
  try { validateConfig(env); } catch (e) { message = e instanceof Error ? `${e.message} ${inspect(e)}` : ""; }
  assert(message.length > 200, "expected many problems");
  assert(!message.includes(S) && !message.toLowerCase().includes(S.toLowerCase()), "a supplied value was echoed");
});

// ---------------------------------------------------------------- M3.3 S3c — email contract
const DEV_SENDER = "TenoTrainer <notifications@dev-mail.tenotrainer.test>";
const devResend = (recipients: string | undefined, extra: Env = {}): Env => ({ ...DEV, TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_inert_s3c",
  TENOTRAINER_NOTIFICATION_EMAIL_FROM: DEV_SENDER, ...(recipients === undefined ? {} : { TENOTRAINER_DEV_EMAIL_RECIPIENTS: recipients }), ...extra });
const recipientsOf = (env: Env) => {
  const c = ok(env);
  return c.mode === "development" ? c.devEmailRecipients : null;
};
test("S3c: development default is disabled; a Resend key alone selects nothing", () => {
  assert(ok(DEV).email.provider === "disabled" && ok({ ...DEV, RESEND_API_KEY: "re_real_looking" }).email.provider === "disabled", "default");
  assert(recipientsOf({ ...DEV, RESEND_API_KEY: "re_x" }) === null, "no allow-list without resend");
});
test("S3c: development resend requires the allow-list, a registered development sender domain and a Resend-shaped key", () => {
  refused(devResend(undefined), 'TENOTRAINER_DEV_EMAIL_RECIPIENTS: is required when TENOTRAINER_EMAIL_PROVIDER is "resend"');
  refused(devResend("a@example.invalid", { TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@tenotrainer-verify.org" }), "requires a registered development sending domain");
  refused(devResend("a@example.invalid", { TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <onboarding@resend.dev>" }), "sandbox sender domain");
  refused(devResend("a@example.invalid", { RESEND_API_KEY: "sk_live_x" }), "RESEND_API_KEY: is not a Resend API key");
  refused(devResend("a@example.invalid", { RESEND_API_KEY: undefined }), "RESEND_API_KEY: is required");
  refused(devResend("a@example.invalid", { TENOTRAINER_NOTIFICATION_EMAIL_FROM: undefined }), "TENOTRAINER_NOTIFICATION_EMAIL_FROM: is required");
  const prodDomain = { ...RESOURCE_IDENTITY, productionEmailDomains: ["dev-mail.tenotrainer.test"] };
  refused(devResend("a@example.invalid"), "registered production sender domain is refused in development", prodDomain);
  assert(JSON.stringify(recipientsOf(devResend("a@example.invalid"))) === '["a@example.invalid"]', "accepted");
});
test("S3c: allow-list outside resend is refused (no dormant recipient lists)", () => {
  for (const provider of ["disabled", "fake", undefined]) refused({ ...DEV, TENOTRAINER_EMAIL_PROVIDER: provider, TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@example.invalid" }, 'only valid with TENOTRAINER_EMAIL_PROVIDER "resend"');
});
test("S3c allow-list: exact addresses, case normalized, whitespace trimmed", () => {
  assert(JSON.stringify(recipientsOf(devResend("  Clin.One@Example.Invalid , b+tag@example.invalid "))) === '["clin.one@example.invalid","b+tag@example.invalid"]', JSON.stringify(recipientsOf(devResend("  Clin.One@Example.Invalid , b+tag@example.invalid "))));
});
test("S3c allow-list: empty entries, duplicates (after normalization) and malformed addresses refused", () => {
  refused(devResend("a@example.invalid,,b@example.invalid"), "contains an empty entry");
  refused(devResend("a@example.invalid,"), "contains an empty entry");
  refused(devResend(" , "), "contains an empty entry");
  refused(devResend("a@example.invalid,A@EXAMPLE.INVALID"), "contains a duplicate entry");
  for (const bad of ["not-an-address", "@example.invalid", "a@", "a@localhost", "a b@example.invalid", "a@exa mple.invalid", '"a"@example.invalid', "a@[127.0.0.1]", "a@example.invalid>", "Name <a@example.invalid>"]) {
    refused(devResend(bad), "every entry must be one exact email address");
  }
});
test("S3c allow-list: no wildcard, pattern, domain-only or Unicode/confusable entries", () => {
  for (const bad of ["*@example.invalid", "a*@example.invalid", "a@*.example.invalid", "*", "@dev-mail.tenotrainer.test", "/.+@example\\.invalid/", "ａ@example.invalid", "a@exаmple.invalid", "clin\u200b@example.invalid"]) {
    refused(devResend(bad), "every entry must be one exact email address");
  }
});
test("S3c allow-list: 20 entries accepted, 21 refused", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@example.invalid`).join(",");
  assert(recipientsOf(devResend(list(20)))?.length === 20, "20");
  refused(devResend(list(21)), "at most 20 entries");
});
test("S3c allow-list: sandbox and registered production domains refused; reserved fixture domains accepted", () => {
  refused(devResend("x@resend.dev"), "sandbox provider domain is refused");
  refused(devResend("x@onboarding.resend.dev"), "sandbox provider domain is refused");
  refused(devResend("ops@prod-mail.example"), "registered production email domain is refused", { ...RESOURCE_IDENTITY, productionEmailDomains: ["prod-mail.example"] });
  assert(recipientsOf(devResend("fixture@example.invalid"))?.[0] === "fixture@example.invalid", ".invalid fixtures allowed (undeliverable)");
});
test("S3c: production / maintenance refuse every development / test email control", () => {
  for (const mode of ["production", "maintenance"]) {
    const base = { ...PROD, TENOTRAINER_MODE: mode };
    refused({ ...base, TENOTRAINER_EMAIL_PROVIDER: "disabled" }, 'must be "resend"');
    refused({ ...base, TENOTRAINER_EMAIL_PROVIDER: undefined }, 'must be "resend"');
    refused({ ...base, TENOTRAINER_EMAIL_PROVIDER: "fake" }, '"fake" is forbidden');
    refused({ ...base, TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@example.invalid" }, "is a development-only control and is refused");
    refused({ ...base, SAFETY_FAKE_PROVIDER_LOG: "/tmp/x" }, "SAFETY_FAKE_PROVIDER_LOG: is a test-only fake-provider control");
    refused({ ...base, SAFETY_FAKE_PROVIDER_SCRIPT: "/tmp/x" }, "SAFETY_FAKE_PROVIDER_SCRIPT: is a test-only fake-provider control");
    refused({ ...base, RESEND_API_KEY: "not-a-resend-key" }, "RESEND_API_KEY: is not a Resend API key");
    refused({ ...base, SAFETY_EMAIL_PROVIDER: "resend" }, "SAFETY_EMAIL_PROVIDER: has been renamed");
    refused({ ...base, RESEND_FROM: "x@y.org" }, "RESEND_FROM: has been renamed");
  }
});
test("S3c: the isolated test profile relaxes no email control beyond the .test/.invalid sender", () => {
  refused({ ...ISOLATED, TENOTRAINER_EMAIL_PROVIDER: "fake" }, '"fake" is forbidden');
  refused({ ...ISOLATED, TENOTRAINER_EMAIL_PROVIDER: "disabled" }, 'must be "resend"');
  refused({ ...ISOLATED, TENOTRAINER_DEV_EMAIL_RECIPIENTS: "a@example.invalid" }, "development-only control");
  refused({ ...ISOLATED, SAFETY_FAKE_PROVIDER_LOG: "/tmp/x" }, "test-only fake-provider control");
  refused({ ...ISOLATED, RESEND_BASE_URL: "http://127.0.0.1:9" }, "RESEND_BASE_URL");
});
test("S3c: RESEND_BASE_URL (SDK traffic redirection) refused in every mode", () => {
  refused({ ...DEV, RESEND_BASE_URL: "https://elsewhere.example" }, "RESEND_BASE_URL: would redirect email provider traffic");
  refused({ ...PROD, RESEND_BASE_URL: "https://elsewhere.example" }, "RESEND_BASE_URL");
});
test("S3c: allow-list values never appear in refusal messages", () => {
  const S = "sentinel-7c1e";
  let msg = "";
  try { validateConfig(devResend(`${S}@x,${S},*@${S}.invalid`)); } catch (e) { msg = e instanceof Error ? e.message : ""; }
  assert(msg.length > 0 && !msg.includes(S), msg);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
