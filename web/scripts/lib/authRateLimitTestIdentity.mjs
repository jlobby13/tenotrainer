// M3.5 D3 — rate-limit isolation for verification suites (test
// infrastructure only; nothing here changes how the application decides a
// client's identity).
//
// With migration 67 on the development project every login, reset request,
// recovery-link check and password change is counted, so suites must not
// share counters with each other — or with the developer's own browser on
// :3000. Two mechanisms, chosen by where the suite's traffic goes:
//
//   1. A SHARED development server (:3000, or a :3001 started separately):
//      development trusts X-Forwarded-For, so each suite sends its own fixed
//      address from a documentation-only range (RFC 5737 / RFC 3849) on every
//      browser context — suiteHeaders(). Production never trusts that header
//      (lib/authRateLimitServer.ts), so this cannot work against a real
//      deployment.
//   2. Servers the suite SPAWNS itself (any mode): each suite starts them
//      with its own test-only AUTH_RATE_LIMIT_SECRET — suiteRateLimitEnv() —
//      i.e. its own HMAC key space, so even the production-mode "untrusted"
//      bucket is per suite. Production header trust stays untouched.
//
// Either way a suite clears ONLY its own identities (its address, or its
// own key space), at start (a crashed earlier run) and at the end —
// clearSuiteCounters(). Unrelated development counters are never touched.
import { hkdfSync } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { bucketKey, normalizeClientIp } from "../../lib/authRateLimit.ts";
import { assertDevTestTarget } from "./devProjectGuard.mjs";
import { loadEnv } from "./harnessEnv.mjs";

// Mechanism 1 — one fixed address per suite (TEST-NET-1, 192.0.2.0/24).
// TEST-NET-2 (198.51.100.0/24) and 2001:db8:d3::/48 belong to the D3
// integration suite, which needs many networks; TEST-NET-3 (203.0.113.0/24)
// is kept for manual Preview testing. Every entry must be distinct (checked
// below at import time).
export const SUITE_NETWORKS = Object.freeze({
  verifyS4PasswordRecovery: "192.0.2.41",
  verifyM2NativeOnboardingUi: "192.0.2.42",
});
export const D3_IPV4_NETWORK = "198.51.100."; // .1 – .254
export const D3_IPV6_PREFIX = "2001:db8:d3:"; // one /64 per test: 2001:db8:d3:<n>::

{
  const seen = new Set();
  for (const [suite, ip] of Object.entries(SUITE_NETWORKS)) {
    if (!/^192\.0\.2\.\d{1,3}$/.test(ip) || normalizeClientIp(ip) === null) throw new Error(`${suite}: not a TEST-NET-1 address`);
    if (seen.has(ip)) throw new Error(`${suite}: network ${ip} is already assigned to another suite`);
    seen.add(ip);
  }
}

export function suiteNetwork(suite) {
  const ip = SUITE_NETWORKS[suite];
  if (!ip) throw new Error(`no rate-limit test network registered for ${suite} (scripts/lib/authRateLimitTestIdentity.mjs)`);
  return ip;
}
export const suiteHeaders = (suite) => ({ "x-forwarded-for": suiteNetwork(suite) });

// Mechanism 2 — a fixed test-only secret per suite (never a real value:
// it is committed, and only ever given to servers the suite spawns).
export function suiteRateLimitSecret(suite) {
  if (!/^[A-Za-z0-9]+$/.test(suite)) throw new Error("suite name must be alphanumeric");
  return `test-only-${suite}-rate-limit-key-0123456789abcdef`;
}
export const suiteRateLimitEnv = (suite) => ({ AUTH_RATE_LIMIT_SECRET: suiteRateLimitSecret(suite) });
// Every client identity a spawned server can derive for local traffic:
// "untrusted" (production / maintenance), loopback (development), "unknown".
export const SPAWNED_SERVER_NETWORKS = Object.freeze(["untrusted", "unknown", "127.0.0.1", "::1"]);

// The server's HMAC key (same derivation as lib/config/secrets.ts
// getAuthRateLimitKey): from the secret, or the public development-only key.
export function rateLimitKey(secret) {
  return secret
    ? Buffer.from(hkdfSync("sha256", secret, "tenotrainer-auth-rate-limit", "tenotrainer/auth-rate-limit/v1", 32))
    : Buffer.from(hkdfSync("sha256", "tenotrainer-development-only-rate-limit-key-NOT-A-SECRET", "tenotrainer-auth-rate-limit", "tenotrainer/auth-rate-limit/v1/development-only", 32));
}

// The bucket keys of the given identities (networks are raw addresses or
// the special identities above; accounts are emails; users are user ids).
export function suiteBucketKeys({ secret = null, networks = [], accounts = [], users = [] }) {
  const key = rateLimitKey(secret);
  const keys = new Set();
  for (const n of networks) {
    const id = ["untrusted", "unknown"].includes(n) ? n : normalizeClientIp(n);
    if (!id) throw new Error(`not a client network: ${n}`);
    for (const scope of ["login_ip", "reset_ip", "verify_ip"]) keys.add(bucketKey(key, scope, id));
  }
  for (const a of accounts) for (const scope of ["login_account", "reset_account"]) keys.add(bucketKey(key, scope, String(a).trim().toLowerCase()));
  for (const u of users) keys.add(bucketKey(key, "password_user", u));
  return [...keys];
}

// Deletes exactly these suite-owned counters on the DEVELOPMENT project
// (service-role RPC, 8 keys per call). Returns how many rows were deleted.
// Without an explicit `secret` the key space is the shared development
// server's (.env.local AUTH_RATE_LIMIT_SECRET, else the development-only key).
export async function clearSuiteCounters(identities) {
  const env = loadEnv(".env.local");
  assertDevTestTarget(env);
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const keys = suiteBucketKeys({ ...identities, secret: identities.secret === undefined ? (env.AUTH_RATE_LIMIT_SECRET || null) : identities.secret });
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 8) {
    const { data, error } = await admin.rpc("auth_rate_limit_clear", { p_keys: keys.slice(i, i + 8) });
    if (error) throw new Error(`auth_rate_limit_clear failed: ${error.code ?? error.message}`);
    deleted += data ?? 0;
  }
  return deleted;
}
