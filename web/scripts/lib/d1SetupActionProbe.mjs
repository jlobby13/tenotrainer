// D1 — /setup server-action probe (test infrastructure). Imports the REAL
// createOrgAction in-process and calls it directly — bypassing the page,
// the proxy and HTTP entirely — under the isolated test profile with
// TENOTRAINER_MODE=argv[2]. Production and maintenance must refuse
// (redirect to /dashboard?error=UNAVAILABLE) before any Supabase client is
// constructed; development is the control (the action proceeds past the
// mode check). Supabase is the inert stub (m3ProbeStubHooks.mjs): nothing
// can reach the network. Spawned by verifyD1SetupRetirement.mjs; prints
// one JSON line.
import "./resendInterceptor.mjs";
import { register } from "node:module";
import { fakeKeysFor } from "./fakeSupabaseKeys.mjs";
import { RETIRED_CONFIG_NAMES } from "./harnessEnv.mjs";

register("./tsServerModuleHooks.mjs", import.meta.url);
register("./m3ProbeStubHooks.mjs", import.meta.url);

const PROBE_REF = "kpdxlzqtvueiytwjamiw"; // the registered development project (identity only — no client can connect)
const mode = process.argv[2] ?? "production";
process.env.TENOTRAINER_MODE = mode;
process.env.NODE_ENV = "production";
process.env.SUPABASE_URL = `https://${PROBE_REF}.supabase.co`;
process.env.TENOTRAINER_SUPABASE_PROJECT_REF = PROBE_REF;
Object.assign(process.env, fakeKeysFor(PROBE_REF));
process.env.TENOTRAINER_APP_ORIGIN = "https://app.tenotrainer.test";
for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "VERCEL", "VERCEL_ENV", "ANTHROPIC_API_KEY", ...RETIRED_CONFIG_NAMES]) delete process.env[k];
if (mode === "development") {
  process.env.TENOTRAINER_EMAIL_PROVIDER = "disabled";
} else {
  process.env.TENOTRAINER_EMAIL_PROVIDER = "resend";
  process.env.SAFETY_DISPATCH_SECRET = "d1-probe-dispatch-secret-0123456789abcdef";
  process.env.RESEND_API_KEY = "re_probe_never_called";
  process.env.TENOTRAINER_NOTIFICATION_EMAIL_FROM = "TenoTrainer <safety@tenotrainer.test>";
}

const { createOrgAction } = await import("@/app/setup/actions");
const fd = new FormData();
fd.set("name", "D1 Probe Organization");
fd.set("slug", "d1-probe-organization");
let outcome;
try {
  await createOrgAction(fd);
  outcome = "returned";
} catch (e) {
  outcome = String(e?.message ?? e).slice(0, 200);
}
console.log(JSON.stringify({ mode, outcome, supabaseClients: globalThis.__probeSupabaseClients ?? 0 }));
