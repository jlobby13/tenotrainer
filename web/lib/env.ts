// M3.1 — validated server configuration, cached per server process. Every
// mode decision reads from here (never process.env directly). Throws a
// ConfigError (fail closed) when the configuration is invalid. Safe to
// import from the proxy and instrumentation (no "server-only" import); it
// never exposes a secret value.
import { validateServerEnv, type ServerConfig } from "./envValidation";

let cached: ServerConfig | null = null;

export function getServerConfig(): ServerConfig {
  if (!cached) cached = validateServerEnv(process.env);
  return cached;
}
