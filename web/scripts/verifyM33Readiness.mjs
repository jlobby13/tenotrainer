// M3.3 S3d — public readiness (GET/HEAD /api/ready) on REAL spawned
// servers. Read-only: nothing is written to any database; no email.
//
//   A. development servers against a local stub "Supabase" (loopback, which
//      development permits) that records every request: ready / zero-row /
//      error with sentinel details / slow (> 1.5 s) / connection refused,
//      the 5 s instance cache, HEAD, exact bodies and headers.
//   B. production + maintenance (isolated test profile) against the REAL
//      development project: the real anonymous probe, maintenance reports
//      ready, canonical-host rules still apply, production headers.
//   C. a configuration-invalid process never answers ready (fails at start).
//   D. no Resend transport call; accepted L5 untouched.
//
// Run from web/ (after `next build`):  TENOTRAINER_MODE=development node scripts/verifyM33Readiness.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { withEmailContainment, withoutRetiredNames } from "./lib/harnessEnv.mjs";
import { rawRequest } from "./lib/canonicalGateway.mjs";
import { fakeSupabaseJwt } from "./lib/fakeSupabaseKeys.mjs";

const PORTS = { dev: 3192, prod: 3193, stub: 3194 };
const L5_OUTBOX = "f73aeb4d-6517-481b-ac6e-cc73fa0afc67";
const CANON_HOST = "app.tenotrainer.test";
const MAINT_HOST = "maint.tenotrainer.test";
const READY = '{"status":"ready"}';
const UNAVAILABLE = '{"status":"unavailable"}';
const SENTINELS = ["SENTINEL-relation-7f2c", "SENTINEL-https://sentinelxxxxxxxxxxxxx.supabase.co", "re_SENTINELKEY_91ab", "SENTINEL-stack-at-line"];

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = loadEnv(".env.local");
assertDevTestTarget(env);
const WORK = mkdtempSync(join(tmpdir(), "m33-s3d-"));

// ---------------------------------------------------------------- stub "Supabase"
const stub = { mode: "ok", requests: [] };
const stubServer = http.createServer((req, res) => {
  stub.requests.push({ method: req.method, url: req.url, apikey: req.headers.apikey ?? null, auth: req.headers.authorization ?? null });
  if (stub.mode === "ok") { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); return; }
  if (stub.mode === "error") { res.writeHead(500, { "content-type": "application/json", "x-sentinel": SENTINELS[0] }); res.end(JSON.stringify({ message: SENTINELS.join(" "), hint: SENTINELS[3] })); return; }
  if (stub.mode === "slow") { setTimeout(() => { if (!res.writableEnded) { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); } }, 4000); return; }
  if (stub.mode === "reset") { req.socket.destroy(); return; }
});
const probes = () => stub.requests.filter((r) => r.url.startsWith("/rest/v1/")).length;

// ---------------------------------------------------------------- servers
const started = [];
function serverEnv(overrides) {
  const base = withoutRetiredNames({ ...process.env });
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "TENOTRAINER_APP_ORIGIN", "VERCEL", "VERCEL_ENV", "NODE_OPTIONS"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED", "TENOTRAINER_EMAIL_PROVIDER", "SAFETY_DISPATCH_SECRET",
    "RESEND_API_KEY", "TENOTRAINER_NOTIFICATION_EMAIL_FROM", "TENOTRAINER_DEV_EMAIL_RECIPIENTS", "SAFETY_FAKE_PROVIDER_LOG", "SAFETY_FAKE_PROVIDER_SCRIPT", "RESEND_BASE_URL"]) base[k] = "";
  return { ...base, ...overrides };
}
async function listening(port) {
  try { await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" }); return true; } catch { return false; }
}
function spawnServer(port, overrides, interceptLog) {
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: withEmailContainment(serverEnv(overrides), { interceptLog }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const s = { port, proc, pid: proc.pid, log: "", exited: null };
  proc.stdout.on("data", (d) => (s.log += d));
  proc.stderr.on("data", (d) => (s.log += d));
  proc.on("exit", (code) => (s.exited = code ?? -1));
  started.push(s);
  return s;
}
async function startServer(port, overrides, interceptLog) {
  const s = spawnServer(port, overrides, interceptLog);
  for (let i = 0; i < 120; i++) {
    if (s.exited !== null) throw new Error(`server on ${port} exited (${s.exited}):\n${s.log.slice(-1500)}`);
    if (await listening(port)) return s;
    await sleep(500);
  }
  throw new Error(`server on ${port} did not become ready`);
}
async function stopServer(s) {
  if (s.exited !== null) return;
  try { process.kill(-s.pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 40 && s.exited === null; i++) await sleep(250);
  if (s.exited === null) { try { process.kill(-s.pid, "SIGKILL"); } catch { /* gone */ } }
  for (let i = 0; i < 40 && (await listening(s.port)); i++) await sleep(250);
}
const ready = (port, method = "GET", headers = {}) => rawRequest(port, { method, path: "/api/ready", headers: { host: `localhost:${port}`, ...headers } });
const noStore = (r) => /no-store/.test(r.headers["cache-control"] ?? "");
const s2Headers = (r) => r.headers["x-content-type-options"] === "nosniff" && r.headers["referrer-policy"] === "no-referrer" && r.headers["x-frame-options"] === "DENY"
  && !!r.headers["content-security-policy-report-only"];
const leaks = (r) => SENTINELS.some((s) => r.text.includes(s) || JSON.stringify(r.headers).includes(s));

async function partA() {
  section("A. Development server + stub Supabase: probe semantics, cache, failure handling");
  await new Promise((r) => stubServer.listen(PORTS.stub, "127.0.0.1", r));
  const D = PORTS.dev;
  const dev = await startServer(D, {
    TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: `http://localhost:${D}`, SUPABASE_URL: `http://127.0.0.1:${PORTS.stub}`, TENOTRAINER_SUPABASE_PROJECT_REF: "",
    SUPABASE_ANON_KEY: fakeSupabaseJwt({ role: "anon" }), SUPABASE_SERVICE_ROLE_KEY: fakeSupabaseJwt({ role: "service_role" }), FASTAPI_URL: "http://127.0.0.1:59999",
  });
  const anonKey = fakeSupabaseJwt({ role: "anon" });
  const serviceKey = fakeSupabaseJwt({ role: "service_role" });

  stub.mode = "ok";
  const g = await ready(D);
  check("ready: 200 with the body EXACTLY {\"status\":\"ready\"}", g.status === 200 && g.text === READY, `${g.status} ${g.text}`);
  check("ready: Cache-Control no-store + the S2 security headers", noStore(g) && s2Headers(g), JSON.stringify(g.headers));
  check("ready: zero-row probe (stub returns []) counts as ready", g.status === 200);
  const probe = stub.requests.find((r) => r.url.startsWith("/rest/v1/"));
  check("probe: ONE read-only GET of canonical_exercises filtered to the nil uuid", stub.requests.filter((r) => r.url.startsWith("/rest/v1/")).length === 1 && probe?.method === "GET"
    && probe.url === "/rest/v1/canonical_exercises?select=id&id=eq.00000000-0000-0000-0000-000000000000&limit=1", JSON.stringify(stub.requests));
  check("probe: anon credential only — the service-role key is never sent", probe?.apikey === anonKey && probe?.auth === `Bearer ${anonKey}` && !JSON.stringify(stub.requests).includes(serviceKey));
  check("probe: nothing but the readiness read reached the stub (no auth, RPC, mutation or storage call)", stub.requests.every((r) => r.method === "GET" && r.url.startsWith("/rest/v1/canonical_exercises?")), JSON.stringify(stub.requests));

  const before = probes();
  const g2 = await ready(D);
  const h = await ready(D, "HEAD");
  const g3 = await ready(D);
  check("cache: three more answers inside 5 s performed NO further probe", probes() === before && g2.status === 200 && g3.status === 200, String(probes() - before));
  check("HEAD ready: 200, same headers (no-store, S2), and NO body", h.status === 200 && h.text === "" && noStore(h) && s2Headers(h), `${h.status} ${JSON.stringify(h.text)}`);

  stub.mode = "error";
  await sleep(5200);
  const e = await ready(D);
  check("database error (500 carrying sentinel details) -> 503 EXACTLY {\"status\":\"unavailable\"}", e.status === 503 && e.text === UNAVAILABLE, `${e.status} ${e.text}`);
  check("cache expired after the 5 s window: a new probe was made", probes() === before + 1, String(probes() - before));
  check("error: no sentinel (URL, project ref, relation/error text, key-like text, stack marker) in body or headers", !leaks(e));
  check("error: no-store + S2 headers on the unavailable answer", noStore(e) && s2Headers(e));
  const eh = await ready(D, "HEAD");
  check("HEAD unavailable: 503, no body, no sentinel", eh.status === 503 && eh.text === "" && !leaks(eh), `${eh.status} ${JSON.stringify(eh.text)}`);
  check("server log carries no sentinel (only the fixed readiness event)", !SENTINELS.some((s) => dev.log.includes(s)) && dev.log.includes("tenotrainer.readiness.probe_failed"));

  stub.mode = "slow";
  await sleep(5200);
  const t0 = Date.now();
  const slow = await ready(D);
  const took = Date.now() - t0;
  check("probe slower than 1.5 s -> 503 unavailable, answered within the timeout bound", slow.status === 503 && slow.text === UNAVAILABLE && took < 2600, `${slow.status} ${took}ms`);

  stub.mode = "ok";
  await sleep(5200);
  const recovered = await ready(D);
  check("recovers to ready once the probe succeeds again (no long-lived failure signal)", recovered.status === 200 && recovered.text === READY);

  await new Promise((r) => stubServer.close(r));
  stubServer.closeAllConnections?.();
  await sleep(5200);
  const refused = await ready(D);
  check("database connection refused -> 503 unavailable", refused.status === 503 && refused.text === UNAVAILABLE, `${refused.status} ${refused.text}`);
  const post = await rawRequest(D, { method: "POST", path: "/api/ready", headers: { host: `localhost:${D}`, "content-length": "0" } });
  check("POST /api/ready: no readiness mutation path (framework 405)", post.status === 405, String(post.status));
  await stopServer(dev);
}

async function partB(interceptLog) {
  section("B. Production / maintenance (isolated test profile) against the REAL development project");
  const PROD = { TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: `https://${CANON_HOST}`, C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: "", BRIDGE_SECRET: "",
    TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_s3d_inert", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@tenotrainer.test>",
    SAFETY_DISPATCH_SECRET: `s3d-${randomUUID()}-${randomUUID()}` };
  const P = PORTS.prod;
  const prod = await startServer(P, PROD, interceptLog);
  const r = await rawRequest(P, { path: "/api/ready", headers: { host: CANON_HOST } });
  check("production: the real anonymous probe -> 200 {\"status\":\"ready\"}", r.status === 200 && r.text === READY, `${r.status} ${r.text}`);
  check("production: no-store, HSTS and the S2 headers", noStore(r) && s2Headers(r) && /max-age=/.test(r.headers["strict-transport-security"] ?? ""), JSON.stringify(r.headers));
  check("production: the body reveals nothing else (no mode, project, provider, version)", !/production|kpdx|resend|supabase|version|commit/i.test(r.text));
  const rh = await rawRequest(P, { method: "HEAD", path: "/api/ready", headers: { host: CANON_HOST } });
  check("production HEAD: 200, no body", rh.status === 200 && rh.text === "");
  const wrong = await rawRequest(P, { path: "/api/ready", headers: { host: "evil.example" } });
  check("canonical host still applies: wrong-host GET -> 308 to the configured origin (no readiness bypass)", wrong.status === 308 && wrong.headers.location === `https://${CANON_HOST}/api/ready`, `${wrong.status} ${wrong.headers.location}`);
  const wrongHead = await rawRequest(P, { method: "HEAD", path: "/api/ready", headers: { host: "evil.example" } });
  check("canonical host still applies: wrong-host HEAD -> 308", wrongHead.status === 308 && wrongHead.headers.location === `https://${CANON_HOST}/api/ready`);
  const xfh = await rawRequest(P, { path: "/api/ready", headers: { host: CANON_HOST, "x-forwarded-host": "evil.example" } });
  check("canonical host still applies: forged X-Forwarded-Host -> 308 to the configured origin", xfh.status === 308 && xfh.headers.location === `https://${CANON_HOST}/api/ready`);
  const wrongPost = await rawRequest(P, { method: "POST", path: "/api/ready", headers: { host: "evil.example", "content-length": "0" } });
  check("wrong-host POST -> 403 NONCANONICAL_HOST_REFUSED", wrongPost.status === 403 && JSON.parse(wrongPost.text).error === "NONCANONICAL_HOST_REFUSED");
  await stopServer(prod);

  const maint = await startServer(P, { ...PROD, TENOTRAINER_MODE: "maintenance", TENOTRAINER_APP_ORIGIN: `https://${MAINT_HOST}` }, interceptLog);
  const m = await rawRequest(P, { path: "/api/ready", headers: { host: MAINT_HOST } });
  check("maintenance + successful probe -> 200 ready (an intentional operating state, not a failure)", m.status === 200 && m.text === READY, `${m.status} ${m.text}`);
  const mPatient = await rawRequest(P, { method: "POST", path: "/api/patient/c5/start", headers: { host: MAINT_HOST, "content-length": "0" } });
  check("maintenance restrictions unchanged alongside readiness (patient API -> 503 MAINTENANCE)", mPatient.status === 503 && JSON.parse(mPatient.text).error === "MAINTENANCE", String(mPatient.status));
  const mWrong = await rawRequest(P, { path: "/api/ready", headers: { host: "evil.example" } });
  check("maintenance wrong-host GET -> 308 to the maintenance origin", mWrong.status === 308 && mWrong.headers.location === `https://${MAINT_HOST}/api/ready`);
  await stopServer(maint);
}

async function partC(interceptLog) {
  section("C. A configuration-invalid process never answers ready");
  const s = spawnServer(PORTS.prod, { TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: "http://localhost:3193", TENOTRAINER_EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_s3d_inert" }, interceptLog);
  let answered = false;
  for (let i = 0; i < 40 && s.exited === null; i++) {
    try { const r = await rawRequest(PORTS.prod, { path: "/api/ready", headers: { host: "localhost:3193" } }); if (r.status === 200) answered = true; } catch { /* not listening */ }
    await sleep(500);
  }
  if (s.exited === null) await stopServer(s);
  check("invalid configuration: the process refuses to start (fail closed) and never answers ready", s.exited !== null && s.exited !== 0 && !answered && s.log.includes("TenoTrainer refused to start"), `exit ${s.exited}`);
}

const l5 = () => guardedSql(env, `SELECT to_jsonb(o) AS row, (SELECT count(*) FROM safety_email_attempts a WHERE a.outbox_id = o.id) AS attempts FROM safety_email_outbox o WHERE o.id = ${q(L5_OUTBOX)}`)[0];
const totalAttempts = () => Number(guardedSql(env, "SELECT count(*) AS n FROM safety_email_attempts")[0].n);
const l5Before = l5();
const attemptsBefore = totalAttempts();
const interceptLog = join(WORK, "intercepted.jsonl");
try {
  await partA();
  await partB(interceptLog);
  await partC(interceptLog);
} catch (e) {
  check("suite ran without an unexpected error", false, e?.stack ?? String(e));
} finally {
  for (const s of started) await stopServer(s);
  if (stubServer.listening) await new Promise((r) => stubServer.close(r));
  const calls = existsSync(interceptLog) ? readFileSync(interceptLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
  check("ZERO Resend transport calls attributable to readiness (production servers ran under the interceptor)", calls === 0, String(calls));
  check("no safety email attempt created", totalAttempts() === attemptsBefore);
  const l5After = l5();
  check("accepted L5 baseline untouched (PRE == POST, 0 attempts)", JSON.stringify(l5After) === JSON.stringify(l5Before) && Number(l5After.attempts) === 0);
  let lingering = 0;
  for (const p of Object.values(PORTS)) if (await listening(p)) lingering++;
  check("no server this suite started is still listening", lingering === 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
