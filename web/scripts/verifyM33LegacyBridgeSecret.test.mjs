// M3.3 S3 — the legacy bridge credential inside the server-only secret
// boundary (lib/config/secrets.ts): constant-time verification, outbound
// header, production/maintenance refusal and redaction. Each scenario runs
// in its own child process because configuration is read once per process.
// No database, no network.
//
// Run from web/:  node scripts/verifyM33LegacyBridgeSecret.test.mjs
import { execFileSync } from "node:child_process";
import { fakeKeysFor } from "./lib/fakeSupabaseKeys.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

const DEV_REF = "kpdxlzqtvueiytwjamiw";
const SECRET = "SENTINEL-bridge-secret-value-0123456789";
const DEV = {
  TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: "http://localhost:3000",
  SUPABASE_URL: `https://${DEV_REF}.supabase.co`, ...fakeKeysFor(DEV_REF),
};
const PROD = {
  TENOTRAINER_MODE: "production", NODE_ENV: "production", TENOTRAINER_APP_ORIGIN: "https://app.tenotrainer.test",
  SUPABASE_URL: `https://${DEV_REF}.supabase.co`, TENOTRAINER_SUPABASE_PROJECT_REF: DEV_REF, ...fakeKeysFor(DEV_REF),
  TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_inert_bridge_test", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "x@tenotrainer.test",
  SAFETY_DISPATCH_SECRET: "bridge-test-dispatch-secret-0123456789",
};

// The child imports the REAL secrets module (react-server condition makes
// "server-only" a no-op, exactly as inside Next's server runtime).
const CHILD = `
import { register } from "node:module";
register(new URL("./scripts/lib/tsServerModuleHooks.mjs", "file://" + process.cwd() + "/"));
const s = await import("./lib/config/secrets.ts");
const headers = JSON.parse(process.env.__HEADERS);
const out = { verify: {}, outbound: null, error: null };
try {
  for (const [k, h] of Object.entries(headers)) out.verify[k] = s.verifyLegacyBridgeAuthorization(h);
  out.outbound = s.legacyBridgeAuthorizationHeader();
} catch (e) { out.error = String(e && e.message || e); }
process.stdout.write(JSON.stringify(out));
`;
function run(env, headers) {
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...env, __HEADERS: JSON.stringify(headers) };
  const raw = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "--input-type=module", "-e", CHILD],
    { cwd: process.cwd(), env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { raw, out: JSON.parse(raw) };
}

const H = {
  correct: `Bearer ${SECRET}`,
  sameLengthWrong: `Bearer ${SECRET.replace(/.$/, (c) => (c === "9" ? "8" : "9"))}`,
  shorter: `Bearer ${SECRET.slice(0, 10)}`,
  longer: `Bearer ${SECRET}EXTRA`,
  missing: null,
  emptyBearer: "Bearer ",
  noScheme: SECRET,
  wrongScheme: `Basic ${SECRET}`,
  lowercaseScheme: `bearer ${SECRET}`,
  doubleSpace: `Bearer  ${SECRET}`,
};

// ---------------------------------------------------------------- development, secret configured
{
  const { raw, out } = run({ ...DEV, BRIDGE_SECRET: SECRET }, H);
  check("development: correct secret accepted", out.verify.correct === true, raw);
  check("development: incorrect same-length secret refused", out.verify.sameLengthWrong === false);
  check("development: incorrect shorter secret refused", out.verify.shorter === false);
  check("development: incorrect longer secret refused", out.verify.longer === false);
  check("development: missing Authorization refused", out.verify.missing === false);
  check("development: malformed Authorization refused (empty bearer, no scheme, other scheme, case, extra space)",
    [out.verify.emptyBearer, out.verify.noScheme, out.verify.wrongScheme, out.verify.lowercaseScheme, out.verify.doubleSpace].every((v) => v === false));
  check("development: no comparison raised an exception for any input length", out.error === null, out.error);
  check("development: outbound bridge header is exactly the bearer credential", out.outbound === `Bearer ${SECRET}`);
  // The result object is the only thing the child prints: apart from the
  // intentional outbound header, the value must not appear anywhere.
  check("redaction: the secret appears only in the intentional outbound header", raw.split(SECRET).length - 1 === 1, raw);
}
// ---------------------------------------------------------------- development, no secret configured
{
  const { out } = run(DEV, H);
  check("development without BRIDGE_SECRET: every credential refused (never an empty-secret match)",
    Object.values(out.verify).every((v) => v === false) && out.error === null);
  check("development without BRIDGE_SECRET: outbound header carries no credential (unchanged behaviour)", out.outbound === "Bearer ");
}
// ---------------------------------------------------------------- production / maintenance
for (const mode of ["production", "maintenance"]) {
  const { out } = run({ ...PROD, TENOTRAINER_MODE: mode }, H);
  check(`${mode}: bridge verification refuses everything (bridge unconfigured)`, Object.values(out.verify).every((v) => v === false) && out.error === null, out.error);
  check(`${mode}: outbound bridge header carries no credential`, out.outbound === "Bearer ");
  const withSecret = run({ ...PROD, TENOTRAINER_MODE: mode, BRIDGE_SECRET: SECRET }, H);
  check(`${mode}: BRIDGE_SECRET present -> configuration refused (fail closed), error names the variable only`,
    withSecret.out.error !== null && withSecret.out.error.includes("BRIDGE_SECRET: is legacy bridge configuration") && !withSecret.raw.includes(SECRET), withSecret.out.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
