import "server-only";

// M3.5 D3 — server wiring for the authentication rate limiter
// (core: authRateLimit.ts; storage: migration 20261109000001).
//
//   * Client network: X-Forwarded-For is trusted ONLY on Vercel (which
//     overwrites it with the real client address — it "does not forward
//     external IPs" to prevent spoofing) or in development. Anywhere else
//     every request shares one "untrusted" bucket, so no request header can
//     select an arbitrary identity in production.
//   * Failure policy (rateLimitFailsClosed): real production / maintenance
//     FAIL CLOSED — an unavailable database, a missing RPC, an RPC error or
//     a missing key all refuse the attempt; development and the isolated
//     production-mode test profile (shared development database, never on
//     Vercel) fail open. Either way the event is logged without identifiers.
//   * Counting runs through service-role-only RPCs; nothing is stored or
//     logged in plaintext.
import { headers } from "next/headers";
import { getConfig } from "./config";
import { getAuthRateLimitKey } from "./config/secrets";
import { clientNetworkIdentity, createAuthRateLimiter, rateLimitFailsClosed, type AuthRateLimiter } from "./authRateLimit";
import { createServiceRoleClient } from "./supabase/server";

function log(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.info(JSON.stringify({ at: new Date().toISOString(), event: `tenotrainer.auth.${event}`, ...fields }));
}

export function authRateLimitFailsClosed(): boolean {
  return rateLimitFailsClosed(getConfig());
}

export function getAuthRateLimiter(): AuthRateLimiter {
  const failClosed = authRateLimitFailsClosed();
  let key: Buffer;
  try {
    key = getAuthRateLimitKey();
  } catch {
    // No usable key (only possible if configuration validation was bypassed):
    // every reservation fails, so production refuses (fail closed).
    log("rate_limiter_key_unavailable", { fail_closed: failClosed });
    return createAuthRateLimiter({
      key: Buffer.alloc(32),
      failClosed,
      log,
      reserve: async () => { throw new Error("no rate-limit key"); },
      clear: async () => { throw new Error("no rate-limit key"); },
    });
  }
  const admin = createServiceRoleClient();
  return createAuthRateLimiter({
    key,
    failClosed,
    log,
    async reserve(keys, limits, windowSeconds) {
      const { data, error } = await admin.rpc("auth_rate_limit_reserve", { p_keys: keys, p_limits: limits, p_window_seconds: windowSeconds });
      const result = data as { allowed?: unknown; retry_after_s?: unknown } | null;
      if (error || !result || typeof result.allowed !== "boolean") throw new Error("auth_rate_limit_reserve failed");
      return { allowed: result.allowed, retryAfterS: Number(result.retry_after_s ?? 0) };
    },
    async clear(keys) {
      const { error } = await admin.rpc("auth_rate_limit_clear", { p_keys: keys });
      if (error) throw new Error("auth_rate_limit_clear failed");
    },
  });
}

// The rate-limit identity of the requesting client network (never logged).
export async function requestClientNetwork(): Promise<string> {
  const config = getConfig();
  const trusted = config.mode === "development" || config.platform.onVercel;
  const h = await headers();
  return clientNetworkIdentity(h.get("x-forwarded-for"), trusted);
}
