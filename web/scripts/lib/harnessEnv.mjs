// M3.3 S3 — the shared test-harness reader of web/.env.local (test
// infrastructure only; application code reads configuration exclusively
// through web/lib/config).
//
// Transition (until the founder's Phase 2 .env.local cleanup): the
// server-only names SUPABASE_URL / SUPABASE_ANON_KEY win; when one is
// absent, the retired NEXT_PUBLIC_* value is used instead so a developer
// environment that has not yet added the new names keeps working.
import { readFileSync } from "node:fs";

const TRANSITION_ALIASES = [
  ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"],
  ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
];

export function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const eq = t.indexOf("=");
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  for (const [name, retired] of TRANSITION_ALIASES) {
    if (!env[name] && env[retired]) env[name] = env[retired];
  }
  return env;
}

// Retired configuration names a developer .env.local may still carry until
// Phase 2. A spawned server loads .env.local itself, so every harness-spawned
// server blanks them explicitly (an empty value counts as unset and
// overrides .env.local): production/maintenance would refuse them, and no
// test may depend on them.
export const RETIRED_CONFIG_NAMES = ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "RESEND_FROM", "SAFETY_EMAIL_PROVIDER"];

export function withoutRetiredNames(env) {
  const out = { ...env };
  for (const k of RETIRED_CONFIG_NAMES) out[k] = "";
  return out;
}

// ---------------------------------------------------------------- M3.3 S3c — real-email kill switch
// Every harness-spawned server goes through withEmailContainment() and
// assertNoRealEmail(). A spawned server can never hold a real Resend
// credential or development recipient list from the developer environment,
// and any server whose provider is "resend" (production-mode servers must
// be) runs with the test-only Resend interceptor preloaded, so even an
// accidental delivery path cannot reach the network.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const INTERCEPTOR = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "resendInterceptor.mjs")).href;
const INTERCEPT_FLAG = `--import=${INTERCEPTOR}`;

export class RealEmailRefused extends Error {}

// A suite exercising INTERCEPTED delivery sets the provider to "resend"
// (with an inert key and, in development, fixture recipients) and may pass
// its own interceptLog path to count provider calls.
export function withEmailContainment(env, { interceptLog } = {}) {
  const out = { ...env };
  const provider = out.TENOTRAINER_EMAIL_PROVIDER ?? "";
  if (provider === "resend") {
    out.NODE_OPTIONS = [out.NODE_OPTIONS ?? "", INTERCEPT_FLAG].filter(Boolean).join(" ").trim();
    out.RESEND_INTERCEPT_LOG = interceptLog ?? out.RESEND_INTERCEPT_LOG ?? join(mkdtempSync(join(tmpdir(), "m33-resend-")), "intercepted.jsonl");
  } else {
    out.RESEND_API_KEY = "";
    out.TENOTRAINER_DEV_EMAIL_RECIPIENTS = "";
  }
  out.RESEND_BASE_URL = "";
  return assertNoRealEmail(out);
}

export function assertNoRealEmail(env) {
  const provider = env.TENOTRAINER_EMAIL_PROVIDER ?? "";
  const intercepted = String(env.NODE_OPTIONS ?? "").includes(INTERCEPT_FLAG) && !!env.RESEND_INTERCEPT_LOG;
  if (provider === "resend" && !intercepted) throw new RealEmailRefused("Refusing to spawn a server with the resend provider without the Resend interceptor");
  if (provider !== "resend" && (env.RESEND_API_KEY ?? "").trim() !== "") throw new RealEmailRefused("Refusing to pass a Resend API key to a server whose provider is not intercepted resend");
  if (provider !== "resend" && (env.TENOTRAINER_DEV_EMAIL_RECIPIENTS ?? "").trim() !== "") throw new RealEmailRefused("Refusing to pass development email recipients to a non-resend server");
  if ((env.RESEND_BASE_URL ?? "").trim() !== "") throw new RealEmailRefused("Refusing RESEND_BASE_URL in a test server");
  return env;
}

export const RESEND_INTERCEPTOR_IMPORT = INTERCEPT_FLAG;
