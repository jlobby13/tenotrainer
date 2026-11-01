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
