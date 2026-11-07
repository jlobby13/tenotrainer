// M3.4a — the pre-promotion readiness gate and the forwarded-host
// deployment probe.
//
//   U. unit: origin rules; the gate's verdicts (exact body, no-store, HEAD,
//      redirect never followed, 503 retry, timeout, 401, malformed); the
//      probe's PASS / FAIL / OBSERVATION classification against modelled
//      platforms (forwarded host controlled by the platform; a platform
//      that puts an internal host first → redirect loop; a platform that
//      passes the client's X-Forwarded-Host through).
//   L. live: a REAL isolated production server (isolated test profile, the
//      development project, read-only): the probe and the gate exactly as
//      M3.4e will run them, with no platform in front (so the spoofed
//      forwarded-host checks are expected to be OBSERVATIONS — proving the
//      probe detects that condition).
//   C. CLIs: real network transport against an isolated development
//      server; usage refusals; the protection-bypass value is never printed.
//
// Run from web/ (after `next build`):  TENOTRAINER_MODE=development node scripts/verifyM34aDeploymentTools.mjs
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/harnessEnv.mjs";
import { IsolatedServers, listening, productionProfile } from "./lib/isolatedServers.mjs";
import { DeploymentToolError, deploymentProbe, loginRedirectLandsOnCanonical, parseOrigin, readinessGate, READY_BODY, STATUSES } from "./lib/deploymentChecks.mjs";

assertDevTestTarget(loadEnv(".env.local"));
const PORTS = { prod: 3181, dev: 3182, closed: 3183 };
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof DeploymentToolError; } };

// ---------------------------------------------------------------- U. unit
section("U. origin rules");
check("https origin accepted", parseOrigin("https://deploy.example.test") === "https://deploy.example.test");
check("path / trailing slash refused", throws(() => parseOrigin("https://a.test/")) && throws(() => parseOrigin("https://a.test/api")));
check("query / credentials refused", throws(() => parseOrigin("https://a.test?x=1")) && throws(() => parseOrigin("https://u:p@a.test")));
check("plain http refused (non-loopback, even when loopback http is allowed)", throws(() => parseOrigin("http://a.test")) && throws(() => parseOrigin("http://a.test", { allowLoopbackHttp: true })));
check("plain http loopback only when explicitly allowed", throws(() => parseOrigin("http://127.0.0.1:3000")) && parseOrigin("http://127.0.0.1:3000", { allowLoopbackHttp: true }) === "http://127.0.0.1:3000");

section("U. readiness gate verdicts");
const res = (status, text = "", headers = {}) => ({ status, text, headers: { "content-type": "application/json", "cache-control": "private, no-store, max-age=0", ...headers } });
const scripted = (responses) => {
  const calls = [];
  const t = async (url, opts = {}) => {
    calls.push(`${opts.method ?? "GET"} ${url}`);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return opts.method === "HEAD" && r.status === 200 && !r.keepBody ? { ...r, text: "" } : r;
  };
  t.calls = calls;
  return t;
};
const gate = (responses, opts = {}) => { const t = scripted(responses); return readinessGate("https://d.test", { transport: t, retryDelayMs: 1, ...opts }).then((r) => ({ ...r, calls: t.calls })); };
let g = await gate([res(200, READY_BODY), res(200, READY_BODY)]);
check("exact ready + HEAD → PASS", g.ok && g.calls.join() === "GET https://d.test/api/ready,HEAD https://d.test/api/ready", JSON.stringify(g));
g = await gate([res(308, "", { location: "https://canonical.test/api/ready" })]);
check("308 → FAIL immediately, never followed (one request, no retry)", !g.ok && g.calls.length === 1 && /redirect/.test(g.reason), JSON.stringify(g));
g = await gate([res(307, "", { location: "/api/ready" })]);
check("307 → FAIL", !g.ok && /redirect/.test(g.reason));
g = await gate([res(503, '{"status":"unavailable"}'), res(200, READY_BODY), res(200, READY_BODY)]);
check("503 then ready → PASS after a bounded retry", g.ok && g.attempts === 2);
g = await gate([res(503, '{"status":"unavailable"}'), res(503, '{"status":"unavailable"}'), res(503, '{"status":"unavailable"}')]);
check("503 throughout → FAIL", !g.ok && /503/.test(g.reason) && g.attempts === 3);
g = await gate([Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })], { attempts: 1 });
check("timeout → FAIL", !g.ok && g.reason === "timeout");
g = await gate([res(401, "Authentication Required", { "content-type": "text/html" })]);
check("401 (deployment protection) → FAIL, no retry", !g.ok && g.calls.length === 1);
for (const [label, r] of [
  ["extra field", res(200, '{"status":"ready","mode":"production"}')],
  ["other status value", res(200, '{"status":"ok"}')],
  ["not JSON", res(200, "ready")],
  ["wrong content-type", res(200, READY_BODY, { "content-type": "text/html" })],
  ["no no-store", res(200, READY_BODY, { "cache-control": "public, max-age=60" })],
]) {
  g = await gate([r]);
  check(`malformed (${label}) → FAIL`, !g.ok && /malformed/.test(g.reason), JSON.stringify(g));
}
g = await gate([res(200, READY_BODY), { status: 200, text: "body", keepBody: true, headers: { "cache-control": "no-store" } }]);
check("HEAD with a body → FAIL", !g.ok && /HEAD/.test(g.reason));

section("U. probe classification (modelled platforms)");
const CANON = "https://canonical.example.test";
const DEPLOY = "https://deploy-abc.example.test";
// The S3b proxy rules as deployed behind a platform. `platform`:
//   "controlled" — the platform sets X-Forwarded-Host to the requested host;
//   "internal"   — the platform puts an internal host first (S3b's risk);
//   "passthrough"— the client's X-Forwarded-Host reaches the app.
//   `loginLocation` — the unauthenticated redirect's Location (default: the
//   absolute canonical URL; the real Vercel shape is the relative form).
function modelled(platform, { breakMutationRefusal = false, loginLocation = `${CANON}/login?next=%2Fpatient%2Fdashboard` } = {}) {
  const canonHost = new URL(CANON).host;
  return async (url, { method = "GET", headers = {} } = {}) => {
    const u = new URL(url);
    const observed = platform === "internal" ? "internal.platform.test" : platform === "passthrough" ? (headers["x-forwarded-host"] ?? u.host) : u.host;
    const read = method === "GET" || method === "HEAD";
    const body = (t) => (method === "HEAD" ? "" : t);
    const base = { "strict-transport-security": "max-age=31536000", "cache-control": "private, no-store, max-age=0" };
    if (read && u.pathname === "/api/ready") return { status: 200, text: body(READY_BODY), headers: { ...base, "content-type": "application/json" } };
    if (observed !== canonHost) {
      if (read) return { status: 308, text: "", headers: { ...base, location: `${CANON}${u.pathname}${u.search}` } };
      if (!breakMutationRefusal) return { status: 403, text: '{"error":"NONCANONICAL_HOST_REFUSED"}', headers: base };
    }
    if (method === "POST" && headers.origin && headers.origin !== CANON) return { status: 403, text: '{"error":"CROSS_ORIGIN_REQUEST_REFUSED"}', headers: base };
    if (method === "POST") return { status: 405, text: "", headers: base };
    if (u.pathname === "/patient/dashboard") return { status: 307, text: "", headers: { ...base, location: loginLocation } };
    return { status: 200, text: body("<form>"), headers: base };
  };
}
const by = (rep, id) => rep.results.find((r) => String(r.id) === String(id));
let p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("controlled") });
check("platform-controlled forwarded host → verdict PASS (only MANUAL besides)", p.verdict === STATUSES.PASS && p.counts.FAIL === 0 && p.counts.OBSERVATION === 0 && !p.hostOnlyReview, JSON.stringify(p.counts));
check("…every automated check PASS, links MANUAL", p.results.filter((r) => r.status !== "PASS").map((r) => r.id).join() === "10b");
p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("internal") });
check("internal host first → canonical redirect loop is a FAIL with the Host-only review note", by(p, 1).status === "FAIL" && /loop/.test(by(p, 1).detail) && p.hostOnlyReview && p.verdict === "FAIL", JSON.stringify(by(p, 1)));
p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("passthrough") });
check("client X-Forwarded-Host honoured → OBSERVATION (checks 5 and 6), Host-only review flagged, no FAIL", by(p, 5).status === "OBSERVATION" && by(p, 6).status === "OBSERVATION" && p.verdict === "OBSERVATION" && p.hostOnlyReview && p.counts.FAIL === 0, JSON.stringify(p.counts));
p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("controlled", { breakMutationRefusal: true }) });
check("a deployment-host mutation not refused → FAIL", by(p, 4).status === "FAIL" && p.verdict === "FAIL");
check("identical canonical and deployment origins refused", await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: CANON, transport: modelled("controlled") }).then(() => false, (e) => e instanceof DeploymentToolError));

section("U. check 10: the unauthenticated redirect lands on the canonical /login");
// Next relativizes a proxy redirect to the request's own origin, so real
// HTTPS on the canonical host answers "/login?next=..." (M3.4e production).
const r307 = (location) => ({ status: 307, headers: location === undefined ? {} : { location }, text: "" });
const lands = (r) => loginRedirectLandsOnCanonical(r, CANON);
check("absolute canonical Location → lands", lands(r307(`${CANON}/login?next=%2Fpatient%2Fdashboard`)));
check("relative path-absolute Location (Vercel shape) → lands", lands(r307("/login?next=%2Fpatient%2Fdashboard")));
check("302, 303 and 308 also accepted", [302, 303, 308].every((status) => lands({ ...r307("/login?next=%2Fpatient%2Fdashboard"), status })));
check("missing Location → fails", !lands(r307(undefined)));
check("protocol-relative //evil.example → fails", !lands(r307("//evil.example/login?next=%2Fpatient%2Fdashboard")));
check("backslash form /\\evil.example (URL-parsed as protocol-relative) → fails", !lands(r307("/\\evil.example/login?next=%2Fpatient%2Fdashboard")));
check("absolute foreign origin → fails", !lands(r307("https://evil.example/login?next=%2Fpatient%2Fdashboard")));
check("canonical host on another scheme → fails", !lands(r307(`${CANON.replace("https:", "http:")}/login?next=%2Fpatient%2Fdashboard`)));
check("canonical-prefixed foreign host → fails", !lands(r307(`${CANON}.evil.example/login?next=%2Fpatient%2Fdashboard`)));
check("wrong path → fails", !lands(r307("/dashboard?next=%2Fpatient%2Fdashboard")));
check("missing or wrong next → fails", !lands(r307("/login")) && !lands(r307("/login?next=%2Fdashboard")));
check("relative path without a leading slash → fails", !lands(r307("login?next=%2Fpatient%2Fdashboard")));
check("non-redirect status (200) → fails", !lands({ ...r307("/login?next=%2Fpatient%2Fdashboard"), status: 200 }));
p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("controlled", { loginLocation: "/login?next=%2Fpatient%2Fdashboard" }) });
check("probe: relative Location (Vercel shape) → check 10 PASS, verdict PASS", by(p, 10).status === "PASS" && p.verdict === STATUSES.PASS, JSON.stringify(by(p, 10)));
p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("controlled", { loginLocation: "//evil.example/login?next=%2Fpatient%2Fdashboard" }) });
check("probe: protocol-relative foreign Location → check 10 FAIL, verdict FAIL", by(p, 10).status === "FAIL" && p.verdict === "FAIL", JSON.stringify(by(p, 10)));
p = await deploymentProbe({ canonicalOrigin: CANON, deploymentOrigin: DEPLOY, transport: modelled("controlled", { loginLocation: "https://evil.example/login?next=%2Fpatient%2Fdashboard" }) });
check("probe: absolute foreign-origin Location → check 10 FAIL", by(p, 10).status === "FAIL", JSON.stringify(by(p, 10)));

// ---------------------------------------------------------------- L. live
const servers = new IsolatedServers();
const xf = promisify(execFile);
try {
  section("L. live isolated production server");
  const LIVE_CANON = "https://app.tenotrainer.test";
  const LIVE_DEPLOY = "https://deploy-m34a.tenotrainer.test";
  await servers.start(PORTS.prod, productionProfile(LIVE_CANON));
  // No platform in front: plain HTTP to the isolated port, Host = the URL host.
  const local = (port) => (url, { method = "GET", headers = {} } = {}) => new Promise((done, failed) => {
    const u = new URL(url);
    const req = http.request({ host: "127.0.0.1", port, method, path: `${u.pathname}${u.search}`, headers: { host: u.host, ...headers }, timeout: 10000 }, (r) => {
      let text = "";
      r.setEncoding("utf8");
      r.on("data", (d) => (text += d));
      r.on("end", () => done({ status: r.statusCode, headers: r.headers, text }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", failed);
    req.end();
  });
  const live = await deploymentProbe({ canonicalOrigin: LIVE_CANON, deploymentOrigin: LIVE_DEPLOY, transport: local(PORTS.prod) });
  for (const r of live.results) console.log(`      ${r.status.padEnd(11)} [${r.id}] ${r.title} — ${r.detail}`);
  const want = { 1: "PASS", "1b": "PASS", 2: "PASS", "3-GET": "PASS", "3-HEAD": "PASS", 4: "PASS", 5: "OBSERVATION", 6: "OBSERVATION", 7: "PASS", 8: "PASS", 9: "PASS", "9b": "PASS", 10: "PASS", "10b": "MANUAL" };
  const mismatched = Object.entries(want).filter(([id, s]) => by(live, id)?.status !== s);
  check("live probe: every expected classification (no platform → spoofed forwarded host observed)", mismatched.length === 0, JSON.stringify(mismatched));
  check("live probe: no FAIL; Host-only review flagged only because nothing sits in front of the app", live.counts.FAIL === 0 && live.verdict === "OBSERVATION" && live.hostOnlyReview);
  const lg = await readinessGate(LIVE_DEPLOY, { transport: local(PORTS.prod), attempts: 1 });
  check("live gate on the deployment origin → PASS (answered directly, not redirected)", lg.ok, JSON.stringify(lg));
  const closed = await readinessGate("https://closed.tenotrainer.test", { transport: local(PORTS.closed), attempts: 2, retryDelayMs: 10 });
  check("live gate against nothing listening → FAIL (network)", !closed.ok && /network/.test(closed.reason), JSON.stringify(closed));

  section("C. CLIs (real network transport, isolated development server)");
  await servers.start(PORTS.dev, { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: `http://localhost:${PORTS.dev}`, TENOTRAINER_EMAIL_PROVIDER: "disabled", C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: "", BRIDGE_SECRET: "" });
  const cli = async (script, args, env = {}) => {
    try {
      const r = await xf(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 120000 });
      return { code: 0, out: r.stdout + r.stderr };
    } catch (e) {
      return { code: e.code, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  let c = await cli("scripts/readinessGate.mjs", ["--origin", `http://127.0.0.1:${PORTS.dev}`, "--allow-loopback-http", "--json"]);
  const cj = JSON.parse(c.out.trim().split("\n").pop());
  check("gate CLI: PASS (exit 0) against a real server", c.code === 0 && cj.ok === true, c.out);
  c = await cli("scripts/readinessGate.mjs", ["--origin", `http://127.0.0.1:${PORTS.closed}`, "--allow-loopback-http", "--attempts", "1", "--timeout-ms", "1000"]);
  check("gate CLI: FAIL (exit 1) when nothing answers", c.code === 1 && /READINESS GATE: FAIL/.test(c.out), c.out);
  c = await cli("scripts/readinessGate.mjs", ["--origin", "http://deploy.example.test"]);
  check("gate CLI: non-https origin is a usage error (exit 2)", c.code === 2, c.out);
  const SENTINEL = `bypass-sentinel-${randomUUID()}`;
  c = await cli("scripts/readinessGate.mjs", ["--origin", `http://127.0.0.1:${PORTS.dev}`, "--allow-loopback-http", "--bypass", SENTINEL]);
  check("gate CLI: a secret passed as an argument is refused and not echoed", c.code === 2 && !c.out.includes(SENTINEL), c.out);
  c = await cli("scripts/deploymentProbe.mjs", ["--canonical-origin", `http://localhost:${PORTS.dev}`, "--deployment-origin", `http://127.0.0.1:${PORTS.dev}`, "--allow-loopback-http", "--json"], { TENOTRAINER_PROBE_PROTECTION_BYPASS: SENTINEL });
  check("probe CLI: runs end to end (development server has no canonical rules → FAIL verdict, exit 1)", c.code === 1 && JSON.parse(c.out.trim().split("\n").pop()).verdict === "FAIL", c.out.slice(-300));
  check("probe CLI: the protection-bypass value never appears in output", !c.out.includes(SENTINEL));
  c = await cli("scripts/deploymentProbe.mjs", ["--canonical-origin", "https://same.example.test", "--deployment-origin", "https://same.example.test"]);
  check("probe CLI: identical origins → usage error (exit 3)", c.code === 3, c.out);
  c = await cli("scripts/deploymentProbe.mjs", ["--canonical-origin", "https://a.example.test/"]);
  check("probe CLI: missing / malformed origins → usage error (exit 3)", c.code === 3, c.out);
} finally {
  await servers.stopAll();
  for (const port of Object.values(PORTS)) check(`no listener left on :${port}`, !(await listening(port)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
