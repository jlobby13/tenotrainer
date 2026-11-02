// M3.4a — deployment verification core (operator / CI tooling; never
// imported by application code). Two tools share it:
//
//   readinessGate()   — the pre-promotion gate: exact GET (and HEAD) of
//                       /api/ready on ONE explicit origin; 200 with exactly
//                       {"status":"ready"} and no-store, or fail. Redirects
//                       are never followed (a 3xx could validate a
//                       different deployment) and are a failure.
//   deploymentProbe() — the post-deployment canonical-origin /
//                       forwarded-host probe (M3.4e): operator-supplied
//                       canonical and deployment origins, no domain is
//                       hard-coded. Results are PASS, FAIL, OBSERVATION
//                       (requires founder review) or MANUAL (verified
//                       separately). It never rewrites any behaviour.
//
// Every request is read-only or refused before any handler: GETs and
// HEADs of public pages / readiness, and POSTs to /api/ready, which has no
// POST handler (405 when a request passes the proxy; 403 when the proxy
// refuses it). No credential is needed; an optional Vercel Deployment
// Protection bypass value is read from the environment only and redacted.
import http from "node:http";
import https from "node:https";

export const READY_BODY = '{"status":"ready"}';
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class DeploymentToolError extends Error {}

// An exact origin: scheme://host[:port], nothing else. https only, except
// plain-http loopback when explicitly allowed (local verification).
export function parseOrigin(raw, { allowLoopbackHttp = false, label = "origin" } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new DeploymentToolError(`${label} must be an absolute URL`);
  }
  if (u.origin !== raw) throw new DeploymentToolError(`${label} must be exactly scheme://host[:port] (no path, trailing slash, query or credentials)`);
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(u.hostname)) return u.origin;
  throw new DeploymentToolError(`${label} must use https${allowLoopbackHttp ? " (plain http only for loopback)" : ""}`);
}

// The real transport: one request, no redirect following, bounded time.
// `resolve` optionally maps a hostname to "ip:port" (curl --resolve) while
// keeping the Host header and TLS server name.
export function networkTransport({ timeoutMs = 10000, extraHeaders = {}, resolve = {} } = {}) {
  return (url, { method = "GET", headers = {} } = {}) => new Promise((done, fail) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const target = resolve[u.hostname];
    const [ip, port] = target ? [target.slice(0, target.lastIndexOf(":")), target.slice(target.lastIndexOf(":") + 1)] : [u.hostname, u.port];
    const req = lib.request({
      host: ip, port: port || (u.protocol === "https:" ? 443 : 80), servername: u.hostname, method,
      path: `${u.pathname}${u.search}`, headers: { host: u.host, "user-agent": "tenotrainer-deployment-check/1", ...extraHeaders, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (text.length < 65536) text += d; });
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", fail);
    req.end();
  });
}

const noStore = (r) => /\bno-store\b/.test(String(r.headers["cache-control"] ?? ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- readiness gate
function judgeReady(r) {
  if (r.status >= 300 && r.status < 400) return { ok: false, terminal: true, reason: `redirect ${r.status} (never followed: it could validate a different deployment)` };
  if (r.status === 401 || r.status === 403) return { ok: false, terminal: true, reason: `HTTP ${r.status} (deployment protection or host refusal)` };
  if (r.status === 503) return { ok: false, terminal: false, reason: "HTTP 503 (not ready)" };
  if (r.status !== 200) return { ok: false, terminal: r.status < 500, reason: `HTTP ${r.status}` };
  if (!/^application\/json\b/.test(String(r.headers["content-type"] ?? ""))) return { ok: false, terminal: true, reason: "malformed: content-type is not application/json" };
  let body;
  try {
    body = JSON.parse(r.text);
  } catch {
    return { ok: false, terminal: true, reason: "malformed: body is not JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || body.status !== "ready") {
    return { ok: false, terminal: true, reason: "malformed: body is not exactly {\"status\":\"ready\"}" };
  }
  if (!noStore(r)) return { ok: false, terminal: true, reason: "malformed: Cache-Control lacks no-store" };
  return { ok: true };
}

export async function readinessGate(origin, { transport, attempts = 3, retryDelayMs = 2000 } = {}) {
  const url = `${origin}/api/ready`;
  const log = [];
  for (let i = 1; i <= attempts; i++) {
    let verdict;
    try {
      verdict = judgeReady(await transport(url, { method: "GET" }));
    } catch (e) {
      verdict = { ok: false, terminal: false, reason: e?.code === "ETIMEDOUT" || e?.name === "TimeoutError" ? "timeout" : `network error (${e?.code ?? "unknown"})` };
    }
    log.push({ attempt: i, method: "GET", ...verdict });
    if (verdict.ok) {
      let head;
      try {
        const r = await transport(url, { method: "HEAD" });
        head = r.status === 200 && r.text === "" && noStore(r) ? { ok: true } : { ok: false, reason: `HEAD: HTTP ${r.status}${r.text ? " with a body" : ""}${noStore(r) ? "" : ", no no-store"}` };
      } catch (e) {
        head = { ok: false, reason: `HEAD: network error (${e?.code ?? "unknown"})` };
      }
      log.push({ attempt: i, method: "HEAD", ...head });
      return { ok: head.ok, origin, url, attempts: i, reason: head.ok ? "ready" : head.reason, log };
    }
    if (verdict.terminal || i === attempts) return { ok: false, origin, url, attempts: i, reason: verdict.reason, log };
    await sleep(retryDelayMs);
  }
}

// ---------------------------------------------------------------- forwarded-host probe
const PASS = "PASS";
const FAIL = "FAIL";
const OBSERVATION = "OBSERVATION";
const MANUAL = "MANUAL";
export const STATUSES = Object.freeze({ PASS, FAIL, OBSERVATION, MANUAL });
export const HOST_ONLY_NOTE = "the platform's first X-Forwarded-Host (or Host) is not the public canonical host as the S3b rule assumes — founder review: a separately reviewed Host-only comparison change (docs/m3-deployment-readiness.md)";
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

export async function deploymentProbe({ canonicalOrigin, deploymentOrigin, transport, gateOptions = {} }) {
  if (canonicalOrigin === deploymentOrigin) throw new DeploymentToolError("the deployment origin must differ from the canonical origin");
  const canonHost = new URL(canonicalOrigin).host;
  const results = [];
  const add = (id, title, status, detail, note) => results.push({ id, title, status, detail, ...(note ? { note } : {}) });
  const req = async (origin, path, opts = {}) => {
    try {
      return await transport(`${origin}${path}`, opts);
    } catch (e) {
      return { status: 0, headers: {}, text: "", error: e?.code ?? "network error" };
    }
  };
  const loc = (r) => String(r.headers.location ?? "");

  // 1-2. Canonical origin serves directly, with HSTS; no redirect loop.
  const c1 = await req(canonicalOrigin, "/login");
  if (c1.status === 200) add(1, "canonical GET /login serves directly", PASS, "200");
  else if ([301, 302, 307, 308].includes(c1.status) && loc(c1).startsWith(canonicalOrigin)) add(1, "canonical GET /login serves directly", FAIL, `${c1.status} → ${loc(c1)} (redirect loop)`, HOST_ONLY_NOTE);
  else add(1, "canonical GET /login serves directly", FAIL, `${c1.status || c1.error} ${loc(c1)}`);
  const hsts = /max-age=\d+/.test(String(c1.headers["strict-transport-security"] ?? ""));
  add("1b", "canonical responses carry HSTS", hsts ? PASS : FAIL, hsts ? "present" : "missing");
  const c2 = await req(canonicalOrigin, "/login", { method: "HEAD" });
  add(2, "canonical HEAD /login", c2.status === 200 && c2.text === "" ? PASS : FAIL, `${c2.status || c2.error}`);

  // 3. Deployment host: application routes redirect 308 to the canonical
  //    origin, path and query preserved.
  const PROBE_PATH = "/login?m34a_probe=1";
  for (const method of ["GET", "HEAD"]) {
    const r = await req(deploymentOrigin, PROBE_PATH, { method });
    const ok = r.status === 308 && loc(r) === `${canonicalOrigin}${PROBE_PATH}`;
    add(`3-${method}`, `deployment ${method} ${PROBE_PATH} → 308 to the canonical origin`, ok ? PASS : FAIL, `${r.status || r.error} ${loc(r)}`);
  }

  // 4. Deployment host: a mutation is refused before any handler.
  const r4 = await req(deploymentOrigin, "/api/ready", { method: "POST", headers: { "content-length": "0" } });
  add(4, "deployment POST → 403 NONCANONICAL_HOST_REFUSED", r4.status === 403 && json(r4)?.error === "NONCANONICAL_HOST_REFUSED" ? PASS : FAIL, `${r4.status || r4.error} ${r4.text.slice(0, 80)}`);

  // 5. A client-supplied X-Forwarded-Host naming the canonical host, sent to
  //    the deployment host: the platform must not let the client choose.
  const r5 = await req(deploymentOrigin, "/login", { headers: { "x-forwarded-host": canonHost } });
  if (r5.status === 308 && loc(r5).startsWith(canonicalOrigin)) add(5, "spoofed X-Forwarded-Host (canonical) on the deployment host is not honoured", PASS, "308 (platform-controlled forwarded host)");
  else if (r5.status === 200) add(5, "spoofed X-Forwarded-Host (canonical) on the deployment host is not honoured", OBSERVATION, "200: the client-supplied X-Forwarded-Host was honoured (a deployment URL can be made to serve as canonical)", HOST_ONLY_NOTE);
  else add(5, "spoofed X-Forwarded-Host (canonical) on the deployment host is not honoured", FAIL, `${r5.status || r5.error} ${loc(r5)}`);

  // 6. A client-supplied wrong X-Forwarded-Host sent to the canonical host.
  const r6 = await req(canonicalOrigin, "/login", { headers: { "x-forwarded-host": "m34a-probe-wrong-host.invalid" } });
  if (r6.status === 200) add(6, "spoofed wrong X-Forwarded-Host on the canonical host is ignored", PASS, "200 (platform overwrote or ignored it)");
  else if (r6.status === 308 && loc(r6).startsWith(canonicalOrigin)) add(6, "spoofed wrong X-Forwarded-Host on the canonical host is ignored", OBSERVATION, "308: the client-supplied X-Forwarded-Host was honoured (the client only redirects itself)", HOST_ONLY_NOTE);
  else add(6, "spoofed wrong X-Forwarded-Host on the canonical host is ignored", FAIL, `${r6.status || r6.error} ${loc(r6)}`);

  // 7-8. Mutation Origin rule on the canonical host (POST /api/ready has no
  //      handler: 405 means the proxy let it through; nothing is written).
  const r7 = await req(canonicalOrigin, "/api/ready", { method: "POST", headers: { origin: canonicalOrigin, "content-length": "0" } });
  add(7, "same-origin mutation Origin accepted by the proxy (handler 405)", r7.status === 405 ? PASS : FAIL, `${r7.status || r7.error}`);
  const r8 = await req(canonicalOrigin, "/api/ready", { method: "POST", headers: { origin: "https://m34a-probe-foreign.invalid", "content-length": "0" } });
  add(8, "foreign Origin refused (403 CROSS_ORIGIN_REQUEST_REFUSED)", r8.status === 403 && json(r8)?.error === "CROSS_ORIGIN_REQUEST_REFUSED" ? PASS : FAIL, `${r8.status || r8.error}`);

  // 9. Readiness answers directly on the deployment host (pre-promotion gate).
  const g = await readinessGate(deploymentOrigin, { transport, attempts: 1, ...gateOptions });
  add(9, "readiness gate on the deployment origin (direct, no redirect)", g.ok ? PASS : FAIL, g.reason);
  const gc = await readinessGate(canonicalOrigin, { transport, attempts: 1, ...gateOptions });
  add("9b", "readiness gate on the canonical origin", gc.ok ? PASS : FAIL, gc.reason);

  // 10. Trusted redirects use the configured canonical origin.
  const r10 = await req(canonicalOrigin, "/patient/dashboard");
  let ok10 = false;
  try {
    const l = new URL(loc(r10));
    ok10 = [302, 303, 307, 308].includes(r10.status) && l.origin === canonicalOrigin && l.pathname === "/login";
  } catch { /* relative or absent */ }
  add(10, "unauthenticated redirect goes to the canonical /login", ok10 ? PASS : FAIL, `${r10.status || r10.error} ${loc(r10)}`);
  add("10b", "generated links (invitation, safety email) use the canonical origin", MANUAL, "needs an authenticated founder fixture: verify in the M3.4e smoke (create an invitation as a founder-provisioned clinician; inspect the one-time link origin)");

  const counts = Object.fromEntries([PASS, FAIL, OBSERVATION, MANUAL].map((s) => [s, results.filter((r) => r.status === s).length]));
  const verdict = counts.FAIL > 0 ? FAIL : counts.OBSERVATION > 0 ? OBSERVATION : PASS;
  const hostOnlyReview = results.some((r) => r.note === HOST_ONLY_NOTE && r.status !== PASS);
  return { canonicalOrigin, deploymentOrigin, verdict, counts, hostOnlyReview, results };
}
