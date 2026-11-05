// M3.1 — unit tests: operating-mode environment validation (fail closed, no
// implicit default) and the write-capable test-harness guard.
// M3.3 S3 — ported to the centralized contract (lib/config/parse.ts).
// Run from web/:  node --experimental-strip-types scripts/verifyM3EnvAndGuard.test.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { assertDevTestTarget, assertDevSqlTarget, TestTargetRefused } from "./lib/devProjectGuard.mjs";
import { fakeKeysFor } from "./lib/fakeSupabaseKeys.mjs";

// The contract's own module graph (extensionless TS imports + the JSON
// registry) loads through the existing test-only resolution hooks.
register(new URL("./lib/tsServerModuleHooks.mjs", import.meta.url));
const { validateConfig, ConfigError } = await import("../lib/config/parse.ts");
const validateServerEnv = (env) => validateConfig(env).config;

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
function throwsConfig(env, includes) {
  try {
    validateServerEnv(env);
    return false;
  } catch (e) {
    return e instanceof ConfigError && (!includes || e.message.includes(includes));
  }
}

// The registered production project (M3.4e N1: production requires a
// registered production project; synthetic keys only).
const PROD_REF = "wfaalpfobpmojohetjlr";
const PROD_BASE = {
  SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
  TENOTRAINER_SUPABASE_PROJECT_REF: PROD_REF,
  ...fakeKeysFor(PROD_REF),
  TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.example",
};
// M3.2 — safety email configuration production / maintenance now also
// require; its own rules are covered by verifyM32SafetyEnv.test.mjs.
const SAFETY_PROD = {
  TENOTRAINER_EMAIL_PROVIDER: "resend",
  SAFETY_DISPATCH_SECRET: "m32-test-dispatch-secret-0123456789abcdef",
  RESEND_API_KEY: "re_test",
  TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@notifications.tenotrainer-verify.org>",
};
// M3.3 S3 (plan §2) — development now requires the canonical origin and a
// registered development Supabase identity too (previously "nothing else").
const DEV_REF = "kpdxlzqtvueiytwjamiw";
const DEV_BASE = {
  TENOTRAINER_MODE: "development",
  TENOTRAINER_APP_ORIGIN: "http://localhost:3000",
  SUPABASE_URL: `https://${DEV_REF}.supabase.co`,
  ...fakeKeysFor(DEV_REF),
};

// ---- mode is required; no default from anything ----
check("missing TENOTRAINER_MODE fails closed", throwsConfig({}, "TENOTRAINER_MODE: is required"));
check("missing mode fails even with NODE_ENV=development (no inference)", throwsConfig({ NODE_ENV: "development" }, "required"));
check("missing mode fails even under next dev markers", throwsConfig({ NODE_ENV: "development", __NEXT_DEV_SERVER: "1" }, "required"));
check("empty mode fails", throwsConfig({ TENOTRAINER_MODE: "  " }, "required"));
for (const bad of ["prod", "Production", "dev", "staging", "true"]) {
  check(`invalid mode '${bad}' fails`, throwsConfig({ TENOTRAINER_MODE: bad }, "must be exactly"));
}
check("development needs only the canonical origin + Supabase identity", validateServerEnv(DEV_BASE).mode === "development");
for (const key of ["TENOTRAINER_APP_ORIGIN", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  const env = { ...DEV_BASE };
  delete env[key];
  check(`development: missing ${key} fails`, throwsConfig(env, key));
}
check("development allows bridge config + legacy gate", validateServerEnv({ ...DEV_BASE, FASTAPI_URL: "http://x", BRIDGE_SECRET: "s", C5_PATIENT_RUNTIME_ENABLED: "false" }).runtimeGate === false);

// ---- production / maintenance ----
for (const mode of ["production", "maintenance"]) {
  const base = { ...PROD_BASE, ...SAFETY_PROD, TENOTRAINER_MODE: mode, NODE_ENV: "production" };
  check(`${mode}: valid base config accepted`, validateServerEnv(base).mode === mode);
  for (const key of Object.keys(PROD_BASE)) {
    const env = { ...base };
    delete env[key];
    check(`${mode}: missing ${key} fails`, throwsConfig(env, key));
  }
  check(`${mode}: FASTAPI_URL forbidden`, throwsConfig({ ...base, FASTAPI_URL: "http://127.0.0.1:8000" }, "FASTAPI_URL"));
  check(`${mode}: BRIDGE_SECRET forbidden`, throwsConfig({ ...base, BRIDGE_SECRET: "x" }, "BRIDGE_SECRET"));
  check(`${mode}: runtime gate "false" rejected (cannot select legacy)`, throwsConfig({ ...base, C5_PATIENT_RUNTIME_ENABLED: "false" }, "C5_PATIENT_RUNTIME_ENABLED"));
  check(`${mode}: runtime gate "true" or unset accepted`, validateServerEnv({ ...base, C5_PATIENT_RUNTIME_ENABLED: "true" }).mode === mode && validateServerEnv(base).mode === mode);
  check(`${mode}: http app URL rejected`, throwsConfig({ ...base, TENOTRAINER_APP_ORIGIN: "http://app.tenotrainer.example" }, "https"));
  check(`${mode}: localhost app URL rejected`, throwsConfig({ ...base, TENOTRAINER_APP_ORIGIN: "https://localhost:3000" }, "non-loopback"));
  check(`${mode}: publish gate must be true/false`, throwsConfig({ ...base, C5_PRESCRIPTION_PUBLISH_ENABLED: "yes" }, "C5_PRESCRIPTION_PUBLISH_ENABLED"));
  check(`${mode}: publication freeze (gate false) accepted`, validateServerEnv({ ...base, C5_PRESCRIPTION_PUBLISH_ENABLED: "false" }).publishGate === false);
}
check("error messages never contain secret values", (() => {
  try {
    validateServerEnv({ ...PROD_BASE, TENOTRAINER_MODE: "production", NODE_ENV: "production", BRIDGE_SECRET: "TOPSECRET-VALUE" });
  } catch (e) {
    return !e.message.includes("TOPSECRET-VALUE");
  }
  return false;
})());

// ---- test-harness guard ----
const dir = mkdtempSync(join(tmpdir(), "m31-guard-"));
const allow = join(dir, "allow.json");
const empty = join(dir, "empty.json");
const linked = join(dir, "project-ref");
const linkedOther = join(dir, "project-ref-other");
writeFileSync(allow, JSON.stringify({ developmentSupabaseProjects: ["abcdefghijklmnopqrst"] }));
writeFileSync(empty, JSON.stringify({ developmentSupabaseProjects: [] }));
writeFileSync(linked, "abcdefghijklmnopqrst\n");
writeFileSync(linkedOther, "zzzzzzzzzzzzzzzzzzzz\n");
const DEV_ENV = { SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
const PROD_ENV = { SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" };
// The guards default `mode` to process.env.TENOTRAINER_MODE, so a "mode
// missing" case must really unset it for the call, whatever the invoking
// shell exported (test isolation only; the guard contract is unchanged).
function withoutParentMode(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "TENOTRAINER_MODE");
  const saved = process.env.TENOTRAINER_MODE;
  delete process.env.TENOTRAINER_MODE;
  try {
    return fn();
  } finally {
    if (had) process.env.TENOTRAINER_MODE = saved;
  }
}
function refused(fn, includes) {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof TestTargetRefused && (!includes || e.message.includes(includes));
  }
}
check("guard: allowed project + development passes", assertDevTestTarget(DEV_ENV, { mode: "development", allowListPath: allow, linkedRefPath: linked }) === "abcdefghijklmnopqrst");
check("guard: missing mode refuses", refused(() => withoutParentMode(() => assertDevTestTarget(DEV_ENV, { mode: undefined, allowListPath: allow, linkedRefPath: linked })), "not set"));
check("guard: production mode refuses", refused(() => assertDevTestTarget(DEV_ENV, { mode: "production", allowListPath: allow, linkedRefPath: linked }), "production"));
check("guard: maintenance mode refuses", refused(() => assertDevTestTarget(DEV_ENV, { mode: "maintenance", allowListPath: allow, linkedRefPath: linked }), "maintenance"));
check("guard: missing allow-list refuses", refused(() => assertDevTestTarget(DEV_ENV, { mode: "development", allowListPath: join(dir, "nope.json"), linkedRefPath: linked }), "missing"));
check("guard: empty allow-list refuses", refused(() => assertDevTestTarget(DEV_ENV, { mode: "development", allowListPath: empty, linkedRefPath: linked }), "empty"));
check("guard: unknown (e.g. production) project refuses even in development", refused(() => assertDevTestTarget(PROD_ENV, { mode: "development", allowListPath: allow, linkedRefPath: linked }), "not on the approved"));
check("guard: unparseable project URL refuses", refused(() => assertDevTestTarget({ SUPABASE_URL: "http://localhost:54321" }, { mode: "development", allowListPath: allow, linkedRefPath: linked }), "could not be determined"));
check("guard: linked CLI project not allow-listed refuses", refused(() => assertDevTestTarget(DEV_ENV, { mode: "development", allowListPath: allow, linkedRefPath: linkedOther }), "linked"));
check("SQL guard: allowed linked project + development passes", assertDevSqlTarget({ mode: "development", allowListPath: allow, linkedRefPath: linked }) === "abcdefghijklmnopqrst");
check("SQL guard: missing mode refuses", refused(() => withoutParentMode(() => assertDevSqlTarget({ mode: undefined, allowListPath: allow, linkedRefPath: linked })), "not set"));
check("SQL guard: other linked project refuses", refused(() => assertDevSqlTarget({ mode: "development", allowListPath: allow, linkedRefPath: linkedOther })));
check("SQL guard: no linked project refuses", refused(() => assertDevSqlTarget({ mode: "development", allowListPath: allow, linkedRefPath: join(dir, "none") })));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
