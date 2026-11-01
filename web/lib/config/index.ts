// M3.3 S3 — the SINGLE application-level reader of process.env.
//
// Reads the environment once per server process (lazily, at first use —
// never at import, so `next build` needs no configuration), validates it
// with the pure contract in parse.ts, and caches the result. Throws a
// ConfigError (fail closed) when the configuration is invalid.
//
// No "server-only" import: the proxy and instrumentation use it. It never
// returns a secret value; secrets are reachable only via ./secrets.ts.
// The environment is read through a variable (never `process.env.NAME`),
// so no value can be inlined into a build.
import { validateConfig, type SecretStore } from "./parse";
import { absoluteUrl, redirectBase } from "./origin";
import type { AppConfig, OperatingMode, SupabasePublicConfig } from "./types";

export { ConfigError } from "./parse";
export type { AppConfig, OperatingMode } from "./types";

let cached: { config: AppConfig; secrets: SecretStore } | null = null;

function load(): { config: AppConfig; secrets: SecretStore } {
  if (!cached) {
    const env: Record<string, string | undefined> = process.env;
    cached = validateConfig(env);
  }
  return cached;
}

export function getConfig(): AppConfig {
  return load().config;
}

export function getMode(): OperatingMode {
  return getConfig().mode;
}

// The canonical application origin: the only base for generated absolute
// application URLs.
export function getAppOrigin(): string {
  return getConfig().appOrigin;
}

// M3.3 S3b — a trusted redirect target: `safePath` (an already-validated
// internal path, e.g. from safeInternalPath) on the configured canonical
// origin in production/maintenance, or on the request's own origin in
// development. Request metadata never chooses a production origin.
export function trustedRedirectUrl(requestUrl: string, safePath: string): URL {
  return new URL(absoluteUrl(redirectBase(getConfig(), requestUrl), safePath));
}

export function getSupabasePublic(): SupabasePublicConfig {
  return getConfig().supabase;
}

// Legacy FastAPI base URL (development-only bridge; outside development
// the bridge is unreachable and this is only the historical default).
export function getLegacyFastapiUrl(): string {
  const config = getConfig();
  return config.mode === "development" ? config.legacyBridge.fastapiUrl : "http://localhost:8000";
}

// For ./secrets.ts ONLY (enforced by the static boundary test).
export function readSecretStore(): SecretStore {
  return load().secrets;
}
