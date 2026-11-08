import "server-only";

// M3.3 S3 — the server-only secret boundary. The only place a Secret is
// revealed. Importers are allow-listed by the static boundary test
// (scripts/verifyM33ConfigBoundary.test.mjs); the proxy, instrumentation,
// readiness, next.config and client components must never import it.
import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";
import { getConfig, readSecretStore } from "./index";

function digest(v: string): Buffer {
  return createHash("sha256").update(v, "utf8").digest();
}

// Constant-time equality for inputs of any length: both sides are hashed
// to fixed-length digests first, so neither the comparison nor an early
// length check reveals anything about the expected value.
function constantTimeEqual(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

function bearerToken(header: string | null | undefined): string | null {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

export function getServiceRoleKey(): string {
  const secret = readSecretStore().serviceRoleKey;
  if (!secret) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return secret.reveal();
}

export function getResendApiKey(): string | null {
  return readSecretStore().resendApiKey?.reveal() ?? null;
}

// The internal safety-dispatch credential (current, or its rotation
// partner while a rotation is in progress).
export function verifyDispatchAuthorization(header: string | null): boolean {
  const presented = bearerToken(header);
  const secrets = readSecretStore().dispatchSecrets;
  if (presented === null || secrets.length === 0) return false;
  let ok = false;
  for (const s of secrets) ok = constantTimeEqual(presented, s.reveal()) || ok;
  return ok;
}

// ---------------------------------------------------------------- legacy bridge
// TEMPORARY legacy debt (removed with the M6 legacy retirement): the
// development-only FastAPI bridge still needs its shared secret. Its four
// allow-listed consumers perform exactly these two operations and never
// receive the raw value. Outside development the bridge is unconfigured
// (production/maintenance refuse BRIDGE_SECRET at startup).

// The outbound Authorization header for a bridge request (Next.js -> FastAPI).
export function legacyBridgeAuthorizationHeader(): string {
  const secret = getConfig().mode === "development" ? readSecretStore().legacyBridgeSecret : null;
  return `Bearer ${secret ? secret.reveal() : ""}`;
}

// Verifies an inbound bridge request (FastAPI -> Next.js) in constant time.
// Missing, malformed or wrong credentials — and any non-development mode —
// are refused.
export function verifyLegacyBridgeAuthorization(header: string | null): boolean {
  if (getConfig().mode !== "development") return false;
  const secret = readSecretStore().legacyBridgeSecret;
  const presented = bearerToken(header);
  if (!secret || presented === null) return false;
  return constantTimeEqual(presented, secret.reveal());
}

// M3.5 D3 — the rate limiter's HMAC key: HKDF-SHA256 (purpose-bound) over
// the dedicated AUTH_RATE_LIMIT_SECRET. Configuration validation requires
// that secret in real production / maintenance, so only development and the
// isolated production-mode test profile can reach the public,
// development-only fallback below — never the service-role key. Any other
// case throws (the limiter then fails closed). The key never leaves this
// boundary unhashed; rotating the secret only resets counters.
const DEVELOPMENT_ONLY_RATE_LIMIT_KEY = "tenotrainer-development-only-rate-limit-key-NOT-A-SECRET";

export function getAuthRateLimitKey(): Buffer {
  const store = readSecretStore();
  if (store.authRateLimitSecret) {
    return Buffer.from(hkdfSync("sha256", store.authRateLimitSecret.reveal(), "tenotrainer-auth-rate-limit", "tenotrainer/auth-rate-limit/v1", 32));
  }
  const config = getConfig();
  if (config.mode === "development" || config.isolatedTestProfile) {
    return Buffer.from(hkdfSync("sha256", DEVELOPMENT_ONLY_RATE_LIMIT_KEY, "tenotrainer-auth-rate-limit", "tenotrainer/auth-rate-limit/v1/development-only", 32));
  }
  throw new Error("AUTH_RATE_LIMIT_SECRET is required");
}
