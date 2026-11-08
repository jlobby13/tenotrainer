// M3.5 D3 — the authentication rate limiter's core (no Next.js / Supabase
// imports, so the unit and scratch-database suites load it directly).
//
// Buckets are identified only by HMAC-SHA256(key, "<scope>|<identifier>")
// as 64 lowercase hex: no email address, IP address or user id is stored or
// logged. Counting happens atomically in Postgres
// (public.auth_rate_limit_reserve, migration 20261109000001): an attempt is
// RESERVED before the protected operation runs, so concurrent requests can
// never exceed a limit, and a refused request never extends a lockout.
//
// Server wiring (request headers, the server-only key, the service-role
// RPC, the failure policy) lives in authRateLimitServer.ts.
import { createHmac } from "node:crypto";

export type RateLimitScope =
  | "login_account" // failed-or-not login attempts per normalized email
  | "login_ip" //      login attempts per client network
  | "reset_account" // password-reset requests per normalized email
  | "reset_ip" //      password-reset requests per client network
  | "verify_ip" //     recovery-link verifications per client network
  | "password_user"; // password changes per signed-in user

export type RateLimitRule = { limit: number; windowSeconds: number };
export type RateLimitRules = Record<RateLimitScope, RateLimitRule>;

// Initial alpha thresholds (founder-reviewed design). A successful login
// clears login_account; a completed password change clears login_account;
// IP buckets are never cleared early.
export const DEFAULT_AUTH_RATE_LIMITS: RateLimitRules = Object.freeze({
  login_account: { limit: 5, windowSeconds: 15 * 60 },
  login_ip: { limit: 30, windowSeconds: 15 * 60 },
  reset_account: { limit: 3, windowSeconds: 60 * 60 },
  reset_ip: { limit: 10, windowSeconds: 60 * 60 },
  verify_ip: { limit: 20, windowSeconds: 15 * 60 },
  password_user: { limit: 10, windowSeconds: 60 * 60 },
});

// Minimum duration of a failed login / any reset request response, so
// response timing says less about whether an account exists.
export const AUTH_RESPONSE_FLOOR_MS = 500;

// ------------------------------------------------------------------ identifiers

export function normalizeAccountIdentifier(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function parseIpv6(raw: string): number[] | null {
  let s = raw;
  let tail: number[] = [];
  // Embedded IPv4 in the last 32 bits (e.g. ::ffff:192.0.2.1).
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!IPV4.test(maybeV4)) return null;
    const o = maybeV4.split(".").map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (parts.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  if (groups.length !== 8) return null;
  if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups;
}

// The client NETWORK an IP limit applies to: an IPv4 address, or an IPv6
// address's /64 (one subscriber's prefix — rotating addresses inside it
// does not escape the limit). IPv4-mapped IPv6 is treated as IPv4. Returns
// null for anything that is not an IP address.
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.split(",")[0].trim();
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.length === 0 || s.length > 64) return null;
  if (IPV4.test(s)) return `v4:${s.split(".").map(Number).join(".")}`;
  const g = parseIpv6(s.toLowerCase());
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `v4:${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `v6:${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

// The identity an IP limit is keyed on. `trusted` must be true only where
// the platform sets the client address itself (Vercel overwrites
// X-Forwarded-For) or in development; anything else shares ONE bucket, so
// no request header can choose an arbitrary identity.
export function clientNetworkIdentity(forwardedFor: string | null | undefined, trusted: boolean): string {
  if (!trusted) return "untrusted";
  return normalizeClientIp(forwardedFor) ?? "unknown";
}

export function bucketKey(key: Uint8Array, scope: RateLimitScope, identifier: string): string {
  return createHmac("sha256", key).update(`${scope}|${identifier}`, "utf8").digest("hex");
}

// ------------------------------------------------------------------ failure policy

// Whether an unavailable limiter must REFUSE (fail closed). Only development
// and the isolated production-mode test profile — a reserved .test origin on
// a registered development project, never on Vercel — may fail open; every
// real production / maintenance deployment fails closed. A deployment on
// Vercel is never treated as the test profile, whatever else is configured.
export function rateLimitFailsClosed(config: { mode: string; isolatedTestProfile: boolean; platform: { onVercel: boolean } }): boolean {
  if (config.mode === "development") return false;
  return !(config.isolatedTestProfile && !config.platform.onVercel);
}

// ------------------------------------------------------------------ limiter

export type ReserveRpc = (keys: string[], limits: number[], windowSeconds: number[]) => Promise<{ allowed: boolean; retryAfterS: number }>;
export type ClearRpc = (keys: string[]) => Promise<void>;
export type RateLimitItem = { scope: RateLimitScope; id: string };
export type RateLimitOutcome =
  | { allowed: true; degraded?: true }
  | { allowed: false; reason: "limited"; retryAfterS: number }
  | { allowed: false; reason: "unavailable" };
export type RateLimitLog = (event: string, fields: Record<string, string | number | boolean | null>) => void;

export type AuthRateLimiterDeps = {
  reserve: ReserveRpc;
  clear: ClearRpc;
  key: Uint8Array;
  // Production / maintenance: an unavailable limiter refuses (fail closed).
  failClosed: boolean;
  rules?: Partial<RateLimitRules>;
  log?: RateLimitLog;
};

export function createAuthRateLimiter(deps: AuthRateLimiterDeps) {
  const rules: RateLimitRules = { ...DEFAULT_AUTH_RATE_LIMITS, ...(deps.rules ?? {}) };
  const log: RateLimitLog = deps.log ?? (() => {});
  const keysOf = (items: RateLimitItem[]) => items.map((i) => bucketKey(deps.key, i.scope, i.id));
  const scopesOf = (items: RateLimitItem[]) => items.map((i) => i.scope).join(",");

  return {
    rules,
    async reserve(items: RateLimitItem[]): Promise<RateLimitOutcome> {
      try {
        const r = await deps.reserve(keysOf(items), items.map((i) => rules[i.scope].limit), items.map((i) => rules[i.scope].windowSeconds));
        if (r.allowed) return { allowed: true };
        log("rate_limited", { scopes: scopesOf(items), retry_after_s: r.retryAfterS });
        return { allowed: false, reason: "limited", retryAfterS: r.retryAfterS };
      } catch {
        log("rate_limiter_unavailable", { scopes: scopesOf(items), fail_closed: deps.failClosed });
        return deps.failClosed ? { allowed: false, reason: "unavailable" } : { allowed: true, degraded: true };
      }
    },
    async clear(items: RateLimitItem[]): Promise<void> {
      try {
        await deps.clear(keysOf(items));
      } catch {
        log("rate_limiter_clear_failed", { scopes: scopesOf(items) });
      }
    },
  };
}

export type AuthRateLimiter = ReturnType<typeof createAuthRateLimiter>;

// Runs fn and makes the whole call take at least `ms` (timing floor).
export async function withMinimumDuration<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const left = ms - (Date.now() - started);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  }
}

// ------------------------------------------------------------------ login

export type LoginAttemptOutcome =
  | { kind: "signed_in" }
  | { kind: "refused"; code: string }
  | { kind: "limited" }
  | { kind: "unavailable" };

// The login sequence (loginAction uses exactly this): reserve one attempt
// for the account (existing or not — identical handling) and the client
// network BEFORE the credential check; on success clear the account's
// counter (never the network's).
export async function guardedLoginAttempt(
  limiter: AuthRateLimiter,
  who: { account: string; network: string },
  signIn: () => Promise<{ ok: true } | { ok: false; code: string }>,
): Promise<LoginAttemptOutcome> {
  const reservation = await limiter.reserve([
    { scope: "login_account", id: who.account },
    { scope: "login_ip", id: who.network },
  ]);
  if (!reservation.allowed) return reservation.reason === "limited" ? { kind: "limited" } : { kind: "unavailable" };
  const result = await signIn();
  if (!result.ok) return { kind: "refused", code: result.code };
  await limiter.clear([{ scope: "login_account", id: who.account }]);
  return { kind: "signed_in" };
}
