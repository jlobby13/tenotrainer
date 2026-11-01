// M3.3 S2 — the cross-origin mutation boundary (lib/mutationOrigin.ts).
import { checkMutationOrigin, type MutationOriginInput } from "../mutationOrigin";

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
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const HOST = "app.tenotrainer.test";
function req(over: Partial<MutationOriginInput>): MutationOriginInput {
  return { method: "POST", origin: null, secFetchSite: null, host: HOST, forwardedHost: null, ...over };
}
const allowed = (over: Partial<MutationOriginInput>) => checkMutationOrigin(req(over)).allowed;

test("safe methods are never mutations, even cross-site", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assertEqual(allowed({ method, origin: "https://evil.example", secFetchSite: "cross-site" }), true, method);
  }
});
test("same-origin browser mutation is allowed", () => {
  assertEqual(allowed({ origin: `https://${HOST}`, secFetchSite: "same-origin" }), true, "same-origin");
});
test("every non-safe method is checked", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "TRACE", "PROPFIND"]) {
    assertEqual(allowed({ method, origin: "https://evil.example", secFetchSite: "cross-site" }), false, method);
  }
});
test("Sec-Fetch-Site cross-site / same-site are refused even with a matching Origin", () => {
  assertEqual(allowed({ origin: `https://${HOST}`, secFetchSite: "cross-site" }), false, "cross-site");
  assertEqual(allowed({ origin: `https://${HOST}`, secFetchSite: "same-site" }), false, "same-site");
  assertEqual(allowed({ secFetchSite: "cross-site" }), false, "cross-site, no Origin");
});
test("unknown Sec-Fetch-Site values fail closed", () => {
  for (const v of ["bogus", "same-origin, cross-site", "", "cross_site"]) {
    assertEqual(allowed({ secFetchSite: v, origin: `https://${HOST}` }), false, JSON.stringify(v));
  }
});
test("a foreign Origin is refused without Sec-Fetch-Site (older browsers)", () => {
  assertEqual(allowed({ origin: "https://evil.example" }), false, "evil");
  assertEqual(allowed({ origin: `https://${HOST}.evil.example` }), false, "suffix");
  assertEqual(allowed({ origin: `https://evil.${HOST}` }), false, "subdomain");
  assertEqual(allowed({ origin: `https://${HOST}:8443` }), false, "other port");
});
test("malformed / opaque Origin values fail closed", () => {
  for (const origin of ["null", "", " ", "not a url", `https://${HOST}/path`, `https://${HOST}, https://evil.example`, `ftp://${HOST}`, `javascript:alert(1)`, `https://user@${HOST}`]) {
    assertEqual(allowed({ origin, secFetchSite: "same-origin" }), false, JSON.stringify(origin));
  }
});
test("the forwarded host (platform proxy) is the expected host when present", () => {
  assertEqual(allowed({ origin: `https://${HOST}`, host: "internal:3000", forwardedHost: HOST }), true, "forwarded match");
  assertEqual(allowed({ origin: "https://internal:3000", host: "internal:3000", forwardedHost: HOST }), false, "raw host ignored");
  assertEqual(allowed({ origin: `https://${HOST}`, host: "internal:3000", forwardedHost: `${HOST}, proxy.internal` }), true, "first forwarded value");
});
test("an Origin with no host to compare against is refused", () => {
  assertEqual(allowed({ origin: `https://${HOST}`, host: null, forwardedHost: null }), false, "no host");
});
test("host comparison is case-insensitive and includes the port", () => {
  assertEqual(allowed({ origin: "http://localhost:3181", host: "LOCALHOST:3181" }), true, "case");
  assertEqual(allowed({ origin: "http://localhost:3181", host: "localhost:3182" }), false, "port");
});
test("non-browser callers (no Origin, no Sec-Fetch-Site) continue to the route's own authentication", () => {
  assertEqual(allowed({}), true, "server-to-server");
});
test("user-initiated (Sec-Fetch-Site none) without Origin continues", () => {
  assertEqual(allowed({ secFetchSite: "none" }), true, "none");
});
test("a refusal names its reason", () => {
  const v = checkMutationOrigin(req({ origin: "https://evil.example" }));
  assertEqual(v.allowed === false && v.reason, "Origin does not match host", "reason");
});

// ---------------------------------------------------------------- M3.3 S3b — exact canonical Origin (production / maintenance)
const CANON = "https://app.tenotrainer.example";
const prod = (over: Partial<MutationOriginInput>) => checkMutationOrigin(req({ canonicalOrigin: CANON, host: "app.tenotrainer.example", ...over }));
test("canonical: exact canonical Origin is allowed", () => {
  assertEqual(prod({ origin: CANON, secFetchSite: "same-origin" }).allowed, true, "exact");
});
test("canonical: wrong scheme, port, host or sub/super-domain refused", () => {
  for (const origin of ["http://app.tenotrainer.example", "https://app.tenotrainer.example:8443", "https://evil.example",
    "https://evil.app.tenotrainer.example", "https://app.tenotrainer.example.evil.example", "https://tenotrainer.example"]) {
    assertEqual(prod({ origin, secFetchSite: "same-origin" }).allowed, false, origin);
  }
});
test("canonical: comparison is exact serialization (no case / trailing-slash tolerance)", () => {
  for (const origin of ["https://APP.tenotrainer.example", "https://app.tenotrainer.example/", "https://app.tenotrainer.example:443"]) {
    assertEqual(prod({ origin }).allowed, false, origin);
  }
});
test("canonical: Host / X-Forwarded-Host cannot substitute for the canonical origin", () => {
  assertEqual(prod({ origin: "https://evil.example", host: "evil.example", forwardedHost: "evil.example" }).allowed, false, "forged host headers");
});
test("canonical: malformed, multiple and null Origin still refused", () => {
  for (const origin of ["null", "", "not a url", `${CANON}, https://evil.example`, `${CANON}/path`]) {
    assertEqual(prod({ origin }).allowed, false, JSON.stringify(origin));
  }
});
test("canonical: Sec-Fetch-Site protections unchanged", () => {
  assertEqual(prod({ origin: CANON, secFetchSite: "cross-site" }).allowed, false, "cross-site");
  assertEqual(prod({ origin: CANON, secFetchSite: "same-site" }).allowed, false, "same-site");
  assertEqual(prod({ origin: CANON, secFetchSite: "bogus" }).allowed, false, "bogus");
});
test("canonical: non-browser callers (no Origin, no Sec-Fetch-Site) continue to route authentication", () => {
  assertEqual(prod({}).allowed, true, "server-to-server");
});
test("canonical: a refusal names its reason", () => {
  const v = prod({ origin: "https://evil.example" });
  assertEqual(v.allowed === false && v.reason, "Origin is not the canonical origin", "reason");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
