// M3.5 D3 — unit tests (no database, no network): client-network
// normalization (IPv4 / IPv6 /64 / IPv4-mapped / zones / garbage), header
// trust, HMAC bucket keys, thresholds and overrides, limiter failure policy.
//
// Run from web/:  node --experimental-strip-types scripts/verifyD3RateLimit.test.mjs
import {
  bucketKey, clientNetworkIdentity, createAuthRateLimiter, DEFAULT_AUTH_RATE_LIMITS, normalizeAccountIdentifier, normalizeClientIp, rateLimitFailsClosed,
} from "../lib/authRateLimit.ts";
import { readFileSync } from "node:fs";
import {
  D3_IPV4_NETWORK, D3_IPV6_PREFIX, rateLimitKey, SUITE_NETWORKS, suiteBucketKeys, suiteHeaders, suiteRateLimitSecret,
} from "./lib/authRateLimitTestIdentity.mjs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};

console.log("--- IP normalization ---");
const cases = [
  ["203.0.113.9", "v4:203.0.113.9"],
  [" 203.0.113.9 , 10.0.0.1", "v4:203.0.113.9"],
  ["2001:db8:85a3::8a2e:370:7334", "v6:2001:db8:85a3:0::/64"],
  ["2001:DB8:85A3:0:1:2:3:4", "v6:2001:db8:85a3:0::/64"],
  ["::1", "v6:0:0:0:0::/64"],
  ["::ffff:192.0.2.1", "v4:192.0.2.1"],
  ["::ffff:c000:201", "v4:192.0.2.1"],
  ["fe80::1%eth0", "v6:fe80:0:0:0::/64"],
  ["[2001:db8::1]", "v6:2001:db8:0:0::/64"],
  ["64:ff9b::192.0.2.33", "v6:64:ff9b:0:0::/64"],
];
for (const [raw, expected] of cases) {
  const got = normalizeClientIp(raw);
  check(`${JSON.stringify(raw)} → ${expected}`, got === expected, got);
}
for (const bad of [null, undefined, "", "not-an-ip", "256.1.1.1", "1.2.3", "01.2.3.4.5", "2001:db8::1::2", "2001:db8:::1", "gggg::1", "1:2:3:4:5:6:7:8:9", "x".repeat(80)]) {
  check(`invalid ${JSON.stringify(bad)?.slice(0, 20)} → null`, normalizeClientIp(bad) === null, normalizeClientIp(bad));
}
check("IPv4 octets are canonicalized (no leading zeros)", normalizeClientIp("203.0.113.9") === normalizeClientIp("203.000.113.009") || normalizeClientIp("203.000.113.009") === null);

console.log("--- header trust ---");
check("untrusted platform: any header value → 'untrusted' (one shared bucket)", ["1.1.1.1", "", null, "::1", "evil"].every((h) => clientNetworkIdentity(h, false) === "untrusted"));
check("trusted platform: the first forwarded address", clientNetworkIdentity("198.51.100.7, 70.41.3.18", true) === "v4:198.51.100.7");
check("trusted platform without a usable header → 'unknown'", clientNetworkIdentity(undefined, true) === "unknown" && clientNetworkIdentity("bogus", true) === "unknown");

console.log("--- keys ---");
const k1 = new Uint8Array(32).fill(1);
const k2 = new Uint8Array(32).fill(2);
const key = bucketKey(k1, "login_account", "pat@example.invalid");
check("bucket keys are 64 lowercase hex", /^[0-9a-f]{64}$/.test(key));
check("deterministic for the same key, scope and identifier", key === bucketKey(k1, "login_account", "pat@example.invalid"));
check("different scope → different key", key !== bucketKey(k1, "reset_account", "pat@example.invalid"));
check("different environment key → different key", key !== bucketKey(k2, "login_account", "pat@example.invalid"));
check("the key never contains the identifier", !key.includes("pat"));
check("account identifiers are trimmed and lower-cased", normalizeAccountIdentifier("  Pat@Example.INVALID ") === "pat@example.invalid" && normalizeAccountIdentifier(undefined) === "");

console.log("--- thresholds and failure policy ---");
check("defaults are frozen", Object.isFrozen(DEFAULT_AUTH_RATE_LIMITS));
const seen = [];
const limiter = createAuthRateLimiter({
  key: k1, failClosed: true, rules: { login_account: { limit: 2, windowSeconds: 60 } },
  reserve: async (keys, limits, windows) => { seen.push({ keys, limits, windows }); return { allowed: true, retryAfterS: 0 }; },
  clear: async () => {},
});
await limiter.reserve([{ scope: "login_account", id: "a" }, { scope: "login_ip", id: "v4:1.2.3.4" }]);
check("rules are configurable (override login_account) and the rest keep their defaults",
  JSON.stringify(seen[0].limits) === JSON.stringify([2, 30]) && JSON.stringify(seen[0].windows) === JSON.stringify([60, 900]), JSON.stringify(seen[0]));
const down = { reserve: async () => { throw new Error("x"); }, clear: async () => { throw new Error("x"); } };
check("fail closed → unavailable", (await createAuthRateLimiter({ ...down, key: k1, failClosed: true }).reserve([{ scope: "verify_ip", id: "x" }])).reason === "unavailable");
check("fail open → allowed (degraded)", (await createAuthRateLimiter({ ...down, key: k1, failClosed: false }).reserve([{ scope: "verify_ip", id: "x" }])).allowed === true);
let threw = false;
try { await createAuthRateLimiter({ ...down, key: k1, failClosed: true }).clear([{ scope: "login_account", id: "x" }]); } catch { threw = true; }
check("a failed clear never throws into the login flow", !threw);

console.log("--- failure policy by deployment ---");
const cfg = (mode, isolatedTestProfile, onVercel) => ({ mode, isolatedTestProfile, platform: { onVercel } });
check("real production fails closed (on Vercel)", rateLimitFailsClosed(cfg("production", false, true)) === true);
check("real maintenance fails closed", rateLimitFailsClosed(cfg("maintenance", false, true)) === true);
check("production off Vercel and not the test profile fails closed", rateLimitFailsClosed(cfg("production", false, false)) === true);
check("a test-profile flag on Vercel can never fail open", rateLimitFailsClosed(cfg("production", true, true)) === true && rateLimitFailsClosed(cfg("maintenance", true, true)) === true);
check("only the isolated test profile (off Vercel) and development fail open", rateLimitFailsClosed(cfg("production", true, false)) === false && rateLimitFailsClosed(cfg("development", false, false)) === false && rateLimitFailsClosed(cfg("development", false, true)) === false);
for (const [label, broken] of [
  ["limiter database unavailable", async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }],
  ["limiter RPC missing (PGRST202)", async () => { throw new Error("auth_rate_limit_reserve failed"); }],
  ["limiter RPC error (malformed result)", async () => { throw new Error("auth_rate_limit_reserve failed"); }],
  ["no usable key", async () => { throw new Error("no rate-limit key"); }],
]) {
  const l = createAuthRateLimiter({ key: k1, failClosed: rateLimitFailsClosed(cfg("production", false, true)), reserve: broken, clear: async () => {} });
  check(`production: ${label} → refused as unavailable (fail closed)`, (await l.reserve([{ scope: "login_account", id: "x" }])).reason === "unavailable");
}

console.log("--- test-suite isolation (scripts/lib/authRateLimitTestIdentity.mjs) ---");
{
  const addrs = Object.values(SUITE_NETWORKS);
  check("suite networks: distinct, TEST-NET-1 (192.0.2.0/24) only", new Set(addrs).size === addrs.length && addrs.every((a) => /^192\.0\.2\.\d+$/.test(a)));
  check("D3 networks: TEST-NET-2 and the 2001:db8::/32 documentation prefix", D3_IPV4_NETWORK === "198.51.100." && D3_IPV6_PREFIX.startsWith("2001:db8:"));
  check("suite headers carry only the suite's own address", suiteHeaders("verifyS4PasswordRecovery")["x-forwarded-for"] === SUITE_NETWORKS.verifyS4PasswordRecovery);
  let unknownRefused = false;
  try { suiteHeaders("someUnregisteredSuite"); } catch { unknownRefused = true; }
  check("an unregistered suite has no network (no silent sharing)", unknownRefused);
  const sec = suiteRateLimitSecret("verifyM33WebSecurity");
  check("suite secrets meet the configuration rules (>= 32 chars, >= 12 distinct) and say test-only",
    sec.length >= 32 && new Set(sec).size >= 12 && sec.startsWith("test-only-") && sec !== suiteRateLimitSecret("verifyM3OperatingModes"));
  const ks = (suite) => suiteBucketKeys({ secret: suiteRateLimitSecret(suite), networks: ["untrusted"] });
  check("each spawning suite has its own key space (its 'untrusted' bucket differs)", ks("verifyM33WebSecurity").every((k) => !ks("verifyM3OperatingModes").includes(k)));
  check("suite bucket keys are deterministic (repeatable cleanup)", JSON.stringify(ks("verifyM33WebSecurity")) === JSON.stringify(ks("verifyM33WebSecurity")));
  check("networks expand to the three network scopes, accounts to two, users to one",
    suiteBucketKeys({ networks: ["192.0.2.41"], accounts: ["X@Example.invalid"], users: ["u"] }).length === 6);
  const src = readFileSync("lib/config/secrets.ts", "utf8");
  check("the helper's key derivation matches lib/config/secrets.ts (salt, info strings, development-only key)",
    ["\"tenotrainer-auth-rate-limit\"", "\"tenotrainer/auth-rate-limit/v1\"", "\"tenotrainer/auth-rate-limit/v1/development-only\"", "\"tenotrainer-development-only-rate-limit-key-NOT-A-SECRET\""].every((x) => src.includes(x))
    && rateLimitKey(null).length === 32 && !rateLimitKey(null).equals(rateLimitKey(sec)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
