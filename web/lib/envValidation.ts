// M3.1 — the ONE operating-mode / environment validation boundary.
//
// TENOTRAINER_MODE is required and has NO default (not from NODE_ENV, not
// from `next dev`): development | production | maintenance. Validation
// fails closed — an invalid configuration throws a ConfigError naming the
// problem (never a secret value). Pure: no I/O, no "server-only" import, so
// the proxy, instrumentation and unit tests can all use it. It only ever
// reports booleans about secrets, never their values.

export type OperatingMode = "development" | "production" | "maintenance";
export const OPERATING_MODES: readonly OperatingMode[] = ["development", "production", "maintenance"];

export type ServerConfig = {
  mode: OperatingMode;
  // Raw gate intent (interpreted per mode by operatingMode.ts).
  runtimeGate: boolean;
  publishGate: boolean;
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid TenoTrainer server configuration: ${problems.join("; ")}`);
    this.problems = problems;
    this.name = "ConfigError";
  }
}

// Configuration whose only purpose is the legacy FastAPI bridge. Forbidden
// in production and maintenance (FastAPI is not deployed — founder F7).
export const LEGACY_BRIDGE_VARS = ["FASTAPI_URL", "BRIDGE_SECRET"] as const;

type Env = Record<string, string | undefined>;

const present = (v: string | undefined) => typeof v === "string" && v.trim() !== "";

export function validateServerEnv(env: Env): ServerConfig {
  const problems: string[] = [];
  const rawMode = env.TENOTRAINER_MODE;
  const mode = OPERATING_MODES.find((m) => m === rawMode);
  if (!present(rawMode)) problems.push("TENOTRAINER_MODE is required (development | production | maintenance)");
  else if (!mode) problems.push("TENOTRAINER_MODE must be exactly development, production or maintenance");

  const runtimeRaw = env.C5_PATIENT_RUNTIME_ENABLED;
  const publishRaw = env.C5_PRESCRIPTION_PUBLISH_ENABLED;

  if (mode === "production" || mode === "maintenance") {
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_APP_URL"]) {
      if (!present(env[key])) problems.push(`${key} is required in ${mode} mode`);
    }
    const appUrl = env.NEXT_PUBLIC_APP_URL;
    if (present(appUrl)) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(appUrl!);
      } catch {
        problems.push("NEXT_PUBLIC_APP_URL must be an absolute URL");
      }
      if (parsed && (parsed.protocol !== "https:" || ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname))) {
        problems.push(`NEXT_PUBLIC_APP_URL must be a non-local https origin in ${mode} mode`);
      }
    }
    for (const key of LEGACY_BRIDGE_VARS) {
      if (present(env[key])) problems.push(`${key} is legacy bridge configuration and is forbidden in ${mode} mode`);
    }
    // The runtime gate can never select legacy outside development: "false"
    // (or any other value) is rejected so it cannot look like a rollback switch.
    if (present(runtimeRaw) && runtimeRaw !== "true") {
      problems.push(`C5_PATIENT_RUNTIME_ENABLED must be unset or "true" in ${mode} mode (C5 is always the patient runtime)`);
    }
    if (present(publishRaw) && publishRaw !== "true" && publishRaw !== "false") {
      problems.push('C5_PRESCRIPTION_PUBLISH_ENABLED must be "true" or "false"');
    }
  }

  if (problems.length > 0 || !mode) throw new ConfigError(problems);
  return { mode, runtimeGate: runtimeRaw === "true", publishGate: publishRaw === "true" };
}
