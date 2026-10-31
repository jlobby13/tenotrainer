// M3.3 S2 — the security header builder (lib/securityHeaders.ts).
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  createNonce,
  createSecurityContext,
  CSP_HEADER,
  HSTS_VALUE,
  PERMISSIONS_POLICY,
  SENSITIVE_CACHE_CONTROL,
  STATIC_SECURITY_HEADERS,
} from "../securityHeaders";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.split(" ")[0] === name) ?? null;
// Next's own nonce parser (server/app-render/get-script-nonce-from-header).
const NEXT_NONCE = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/;

test("nonce: 128 bits of base64, accepted by Next's parser, unique per call", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const n = createNonce();
    assert(n.length === 24 && atob(n).length === 16, `bad nonce ${n}`);
    assert(NEXT_NONCE.test(`'nonce-${n}'`), `Next would ignore ${n}`);
    seen.add(n);
  }
  assert(seen.size === 2000, "nonce repeated");
});
test("production CSP: nonce + strict-dynamic, no eval / inline / wildcard / scheme sources", () => {
  for (const mode of ["production", "maintenance"] as const) {
    for (const devServer of [false, true]) {
      const csp = buildContentSecurityPolicy("abc", mode, devServer);
      assert(directive(csp, "script-src") === "script-src 'self' 'nonce-abc' 'strict-dynamic'", `${mode} script-src: ${csp}`);
      assert(directive(csp, "style-src") === "style-src 'self' 'nonce-abc'", `${mode} style-src`);
      for (const bad of ["unsafe-eval", "unsafe-inline", "*", "https:", "http:", "data:", "blob:", "ws:"]) {
        assert(!csp.split(/[ ;]+/).includes(bad) && !csp.includes(`'${bad}'`), `${mode}/${devServer} contains ${bad}`);
      }
    }
  }
});
test("CSP: framing, plugins, base and form targets locked down", () => {
  const csp = buildContentSecurityPolicy("abc", "production", false);
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-src 'none'", "media-src 'none'", "img-src 'self'", "font-src 'self'", "connect-src 'self'"]) {
    assert(csp.split("; ").includes(d), `missing ${d}`);
  }
  assert(!csp.includes("upgrade-insecure-requests"), "upgrade-insecure-requests is ignored in Report-Only; added at enforcement");
});
test("development allowances only under the dev server in development mode", () => {
  const dev = buildContentSecurityPolicy("abc", "development", true);
  assert(directive(dev, "script-src")!.includes("'unsafe-eval'"), "dev server needs eval");
  assert(directive(dev, "style-src") === "style-src 'self' 'unsafe-inline'", "dev overlay styles");
  const devModeBuilt = buildContentSecurityPolicy("abc", "development", false);
  assert(devModeBuilt === buildContentSecurityPolicy("abc", "production", false), "development mode on a production build = production policy");
});
test("Report-Only until founder enforcement", () => {
  assert(CSP_HEADER === "Content-Security-Policy-Report-Only", CSP_HEADER);
});
test("applied headers: production / maintenance get HSTS (no preload); development does not", () => {
  for (const [mode, hsts] of [["production", true], ["maintenance", true], ["development", false], [null, true]] as const) {
    const h = new Headers();
    applySecurityHeaders(h, createSecurityContext(mode, false));
    assert((h.get("strict-transport-security") === HSTS_VALUE) === hsts, `${mode} HSTS ${h.get("strict-transport-security")}`);
    assert(h.get("cache-control") === SENSITIVE_CACHE_CONTROL, "no-store");
    assert(h.get("content-security-policy") === null && h.get("content-security-policy-report-only") !== null, "report-only only");
    for (const { key, value } of STATIC_SECURITY_HEADERS) assert(h.get(key) === value, key);
  }
  assert(!HSTS_VALUE.includes("preload"), "no preload commitment");
  assert(SENSITIVE_CACHE_CONTROL.includes("no-store") && SENSITIVE_CACHE_CONTROL.includes("private"), "cache policy");
});
test("Permissions-Policy denies every listed feature to every origin", () => {
  const entries = PERMISSIONS_POLICY.split(", ");
  assert(entries.length >= 15 && entries.every((e) => /^[a-z-]+=\(\)$/.test(e)), PERMISSIONS_POLICY);
  for (const f of ["camera", "microphone", "geolocation", "payment", "usb"]) assert(entries.includes(`${f}=()`), f);
});
test("static headers: nosniff, frame denial, no referrer", () => {
  const m = new Map(STATIC_SECURITY_HEADERS.map((h) => [h.key, h.value]));
  assert(m.get("X-Content-Type-Options") === "nosniff", "nosniff");
  assert(m.get("X-Frame-Options") === "DENY", "XFO");
  assert(m.get("Referrer-Policy") === "no-referrer", "referrer");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
