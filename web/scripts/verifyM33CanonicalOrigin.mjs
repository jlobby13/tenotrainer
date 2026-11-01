// M3.3 S3b — canonical-origin enforcement, adversarially, against REAL
// spawned servers (`next start` on isolated ports; nothing is written to
// any database; no email; the dispatch endpoint is only ever called with a
// WRONG secret).
//
//   A. production: canonical host proceeds; wrong host GET/HEAD -> 308 to
//      the configured origin (path + query kept); unsafe methods -> 403
//      before any handler; forged Host / X-Forwarded-Host / -Proto can never
//      choose a redirect destination (explicit open-redirect attempts).
//   B. production: exact canonical mutation Origin; Sec-Fetch-Site intact.
//   C. production: auth callback and logout stay canonical under forgery.
//   D. maintenance: the same host rules and canonical redirects.
//   E. development: no canonicalization; redirects stay on the request's
//      own origin (spawned test port), generated links use the configured one.
//   F. generated links (invitation, safety notification) come from the
//      configured origin only (the real modules, in-process).
//   G. the browser at the canonical origin through the test gateway.
//
// Run from web/ (after `next build`):  TENOTRAINER_MODE=development node scripts/verifyM33CanonicalOrigin.mjs
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { withEmailContainment, withoutRetiredNames } from "./lib/harnessEnv.mjs";
import { launchCanonicalBrowser, rawRequest, startCanonicalGateway } from "./lib/canonicalGateway.mjs";

const PORTS = { prod: 3186, maintenance: 3187, dev: 3188, gateway: 3189 };
const CANON = "https://app.tenotrainer.test";
const CANON_HOST = "app.tenotrainer.test";
const MAINT = "https://maint.tenotrainer.test";
const MAINT_HOST = "maint.tenotrainer.test";
const DEV_CONFIGURED = `http://127.0.0.1:${PORTS.dev}`; // configured origin != the localhost origin the requests use
const DISPATCH = "/api/internal/safety-notifications/dispatch";
const WRONG_SECRET = "Bearer wrong-secret-wrong-secret-wrong-secret!";
const EVIL = "evil.example";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.TENOTRAINER_MODE !== "development") { console.error("Run with TENOTRAINER_MODE=development (harness convention)."); process.exit(1); }

// ---------------------------------------------------------------- servers
const PROD_ENV = { FASTAPI_URL: "", BRIDGE_SECRET: "", TENOTRAINER_APP_ORIGIN: CANON, C5_PATIENT_RUNTIME_ENABLED: "true", C5_PRESCRIPTION_PUBLISH_ENABLED: "false",
  TENOTRAINER_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: `m33-s3b-${randomUUID()}-${randomUUID()}`,
  RESEND_API_KEY: "re_isolated_never_called", TENOTRAINER_NOTIFICATION_EMAIL_FROM: "TenoTrainer <safety@tenotrainer.test>" };
function serverEnv(overrides) {
  const base = withoutRetiredNames({ ...process.env });
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "TENOTRAINER_APP_ORIGIN", "VERCEL", "VERCEL_ENV"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED", "TENOTRAINER_EMAIL_PROVIDER", "SAFETY_DISPATCH_SECRET",
    "RESEND_API_KEY", "TENOTRAINER_NOTIFICATION_EMAIL_FROM", "SAFETY_FAKE_PROVIDER_LOG", "SAFETY_FAKE_PROVIDER_SCRIPT"]) base[k] = "";
  return { ...base, ...overrides };
}
const started = [];
async function listening(port) {
  try { await globalThis.fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" }); return true; } catch { return false; }
}
async function startServer(port, overrides) {
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { env: withEmailContainment(serverEnv(overrides)), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const s = { port, proc, pid: proc.pid, log: "", exited: null };
  proc.stdout.on("data", (d) => (s.log += d));
  proc.stderr.on("data", (d) => (s.log += d));
  proc.on("exit", (code) => (s.exited = code ?? -1));
  started.push(s);
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

const req = (port, method, path, headers = {}, body) => rawRequest(port, { method, path, headers, body });
const loc = (r) => r.headers.location ?? null;
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };
function securedProd(r) {
  const h = r.headers;
  return h["strict-transport-security"]?.includes("max-age=") && h["content-security-policy-report-only"]?.includes("nonce-")
    && h["cache-control"] === "private, no-store, max-age=0" && h["x-content-type-options"] === "nosniff" && h["referrer-policy"] === "no-referrer";
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
// Next.js facts the assertions account for (never a weaker security claim):
//  * Next re-serializes the query of the request URL (e.g. %20 -> +): the
//    query is preserved PARAMETER-FOR-PARAMETER, not byte-for-byte.
//  * Next answers repeated-slash paths itself with a relative, path-only
//    308; a path-only Location cannot leave the host the client already
//    addressed (the follow-up request then gets the canonical redirect).
//  * Next relativizes a Location on the request's own origin, and a route
//    handler's request.url is the server's own listen URL.
const sameQuery = (a, b) => JSON.stringify([...new URL(a, "https://x.invalid").searchParams]) === JSON.stringify([...new URL(b, "https://x.invalid").searchParams]);
const pathOnly = (l) => typeof l === "string" && l.startsWith("/") && !l.startsWith("//") && !l.includes("\\");
function canonicalTarget(r, origin) {
  const l = loc(r);
  if (!l) return null;
  try { const u = new URL(l); return u.origin === origin ? u : null; } catch { return null; }
}

async function main() {
  // ================================================================ A
  section("A. Production: canonical host, wrong-host redirects / refusals, open-redirect attempts");
  const prod = await startServer(PORTS.prod, { ...PROD_ENV, TENOTRAINER_MODE: "production" });
  check("production server (isolated test profile) started", prod.log.includes("TenoTrainer operating mode: production") && prod.log.includes("isolated test"));
  const P = PORTS.prod;

  const ok = await req(P, "GET", "/login", { host: CANON_HOST });
  check("correct canonical-host GET proceeds normally (200)", ok.status === 200 && ok.text.includes("<form"), String(ok.status));
  const okDispatch = await req(P, "POST", DISPATCH, { host: CANON_HOST, authorization: WRONG_SECRET });
  check("canonical-host POST reaches the handler (wrong dispatch secret -> the handler's own 401)", okDispatch.status === 401 && json(okDispatch)?.error === "UNAUTHORIZED", String(okDispatch.status));

  const path = "/patient/dashboard?x=1&y=two%20words&z=%2F%2Fevil.example";
  const g = await req(P, "GET", path, { host: EVIL });
  check("wrong-host GET -> 308", g.status === 308, String(g.status));
  const gt = canonicalTarget(g, CANON);
  check("wrong-host GET: destination is the configured origin with pathname and query preserved", !!gt && gt.pathname === "/patient/dashboard" && sameQuery(gt.href, path), loc(g));
  check("wrong-host GET: redirect carries the production security headers (HSTS, CSP-RO nonce, no-store, nosniff, no-referrer)", securedProd(g), JSON.stringify(g.headers));
  const h = await req(P, "HEAD", path, { host: EVIL });
  check("wrong-host HEAD -> 308 to the same canonical destination", h.status === 308 && loc(h) === loc(g), `${h.status} ${loc(h)}`);
  const xfh = await req(P, "GET", "/login", { host: CANON_HOST, "x-forwarded-host": EVIL });
  check("malicious X-Forwarded-Host (observed host) -> 308 to the configured origin, never to the attacker", xfh.status === 308 && loc(xfh) === `${CANON}/login`, `${xfh.status} ${loc(xfh)}`);
  const xfhMulti = await req(P, "GET", "/login", { host: CANON_HOST, "x-forwarded-host": `${EVIL}, ${CANON_HOST}` });
  check("only the FIRST X-Forwarded-Host is observed (attacker-first list -> canonical redirect)", xfhMulti.status === 308 && hostOf(loc(xfhMulti)) === CANON_HOST, `${xfhMulti.status} ${loc(xfhMulti)}`);
  const xfp = await req(P, "GET", "/login?a=1", { host: EVIL, "x-forwarded-proto": "http" });
  check("X-Forwarded-Proto cannot choose the redirect scheme (https from configuration)", loc(xfp) === `${CANON}/login?a=1`, loc(xfp));
  const xfpPort = await req(P, "GET", "/login", { host: `${CANON_HOST}:8443`, "x-forwarded-port": "8443" });
  check("a canonical name on another port is a different host -> 308 to the exact configured origin", xfpPort.status === 308 && loc(xfpPort) === `${CANON}/login`, `${xfpPort.status} ${loc(xfpPort)}`);

  // Explicit open-redirect attempts: the destination host is ALWAYS the configured one.
  const attempts = ["//evil.example/x", "/%2F%2Fevil.example", "/\\evil.example", "/.evil.example", "/@evil.example", "/https://evil.example", "/login?next=https://evil.example", "/login?next=//evil.example"];
  let pinned = 0;
  let nextNormalized = 0;
  const leaked = [];
  for (const a of attempts) {
    for (const headers of [{ host: EVIL }, { host: CANON_HOST, "x-forwarded-host": EVIL }, { host: `${EVIL}:443`, "x-forwarded-proto": "http" }]) {
      const r = await req(P, "GET", a, headers);
      const target = loc(r);
      let origin = null;
      try { origin = new URL(target).origin; } catch { origin = null; }
      if (r.status === 308 && origin === CANON) pinned++;
      else if (r.status === 308 && pathOnly(target)) { pinned++; nextNormalized++; }
      else leaked.push(`${a} ${JSON.stringify(headers)} -> ${r.status} ${target}`);
    }
  }
  check(`open redirect: ${attempts.length} hostile paths x 3 forged-header shapes never redirect to another origin (canonical absolute, or Next's path-only slash normalization: ${nextNormalized})`,
    leaked.length === 0 && pinned === attempts.length * 3, leaked.slice(0, 3).join(" | "));
  const followUp = await req(P, "GET", "/evil.example/x", { host: EVIL });
  check("open redirect: the follow-up of Next's slash normalization lands on the configured origin", canonicalTarget(followUp, CANON)?.pathname === "/evil.example/x", loc(followUp));

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const r = await req(P, method, DISPATCH, { host: EVIL, authorization: WRONG_SECRET, "content-length": "0" });
    check(`wrong-host ${method} -> 403 NONCANONICAL_HOST_REFUSED before any handler (never redirected), secured`,
      r.status === 403 && json(r)?.error === "NONCANONICAL_HOST_REFUSED" && !loc(r) && securedProd(r), `${r.status} ${r.text.slice(0, 80)}`);
  }
  const fxh = await req(P, "POST", DISPATCH, { host: CANON_HOST, "x-forwarded-host": EVIL, authorization: WRONG_SECRET, "content-length": "0" });
  check("forged X-Forwarded-Host on a POST -> 403 before the handler", fxh.status === 403 && json(fxh)?.error === "NONCANONICAL_HOST_REFUSED", String(fxh.status));

  // ================================================================ B
  section("B. Production: exact canonical mutation Origin");
  const mut = (headers) => req(P, "POST", DISPATCH, { host: CANON_HOST, authorization: WRONG_SECRET, "content-length": "0", ...headers });
  const exact = await mut({ origin: CANON, "sec-fetch-site": "same-origin" });
  check("exact canonical Origin passes the boundary (reaches the handler: 401 wrong secret)", exact.status === 401, String(exact.status));
  const refusedOrigins = [
    ["wrong scheme", "http://app.tenotrainer.test"],
    ["wrong port", "https://app.tenotrainer.test:8443"],
    ["explicit default port", "https://app.tenotrainer.test:443"],
    ["trailing slash", "https://app.tenotrainer.test/"],
    ["upper case", "https://APP.tenotrainer.test"],
    ["other host", `https://${EVIL}`],
    ["suffix host", "https://app.tenotrainer.test.evil.example"],
    ["malformed", "not a url"],
    ["multiple values", `${CANON}, https://${EVIL}`],
    ["null", "null"],
  ];
  for (const [label, origin] of refusedOrigins) {
    const r = await mut({ origin, "sec-fetch-site": "same-origin" });
    check(`Origin refused (${label})`, r.status === 403 && json(r)?.error === "CROSS_ORIGIN_REQUEST_REFUSED", `${r.status} ${r.text.slice(0, 60)}`);
  }
  for (const sfs of ["cross-site", "same-site", "bogus"]) {
    const r = await mut({ origin: CANON, "sec-fetch-site": sfs });
    check(`Sec-Fetch-Site ${sfs} still refused even with the canonical Origin`, r.status === 403 && json(r)?.error === "CROSS_ORIGIN_REQUEST_REFUSED", String(r.status));
  }
  const nonBrowser = await mut({});
  check("non-browser caller (no Origin, no Sec-Fetch-Site) continues to the route's own authentication (401)", nonBrowser.status === 401, String(nonBrowser.status));

  // ================================================================ C
  section("C. Production: auth callback and logout stay canonical under forged metadata");
  // Host forged while the observed host (X-Forwarded-Host) is canonical:
  // the request reaches the handler, which must still use the configuration.
  const forgedHost = { host: EVIL, "x-forwarded-host": CANON_HOST, "x-forwarded-proto": "http" };
  const cbErr = await req(P, "GET", "/auth/callback?error=access_denied&next=https://evil.example", forgedHost);
  check("callback (error) under forged Host + X-Forwarded-Proto -> canonical /login", [302, 303, 307, 308].includes(cbErr.status) && new URL(loc(cbErr)).origin === CANON && new URL(loc(cbErr)).pathname === "/login", `${cbErr.status} ${loc(cbErr)}`);
  const cbCode = await req(P, "GET", "/auth/callback?code=not-a-real-code&next=//evil.example/steal", forgedHost);
  check("callback (bad code, hostile next) under forged Host -> canonical /login", new URL(loc(cbCode) ?? "x:").origin === CANON && new URL(loc(cbCode)).pathname === "/login", `${cbCode.status} ${loc(cbCode)}`);
  const cbNone = await req(P, "GET", "/auth/callback", forgedHost);
  check("callback (no code) under forged Host -> canonical /login", new URL(loc(cbNone) ?? "x:").origin === CANON, `${cbNone.status} ${loc(cbNone)}`);
  const cbXfh = await req(P, "GET", "/auth/callback?error=x", { host: CANON_HOST, "x-forwarded-host": EVIL });
  check("callback under forged X-Forwarded-Host -> 308 to the canonical callback (never the attacker)", cbXfh.status === 308 && loc(cbXfh) === `${CANON}/auth/callback?error=x`, `${cbXfh.status} ${loc(cbXfh)}`);
  // Without a session the proxy's auth redirect answers /logout (the logout
  // handler's own redirect, with a session, is verified by the S2 suite).
  const lo = await req(P, "GET", "/logout", forgedHost);
  check("logout (no session) under forged Host + X-Forwarded-Proto -> canonical /login", canonicalTarget(lo, CANON)?.pathname === "/login", `${lo.status} ${loc(lo)}`);
  const loXfh = await req(P, "GET", "/logout", { host: CANON_HOST, "x-forwarded-host": EVIL });
  check("logout under forged X-Forwarded-Host -> 308 to canonical /logout (never the attacker)", loXfh.status === 308 && loc(loXfh) === `${CANON}/logout`, `${loXfh.status} ${loc(loXfh)}`);
  const unauth = await req(P, "GET", "/patient/dashboard?tab=1", forgedHost);
  check("auth redirect (unauthenticated page) under forged Host -> canonical /login with next", new URL(loc(unauth) ?? "x:").origin === CANON
    && new URL(loc(unauth)).pathname === "/login" && new URL(loc(unauth)).searchParams.get("next") === "/patient/dashboard", `${unauth.status} ${loc(unauth)}`);
  await stopServer(prod);

  // ================================================================ D
  section("D. Maintenance: the same host rules and canonical redirects");
  const maint = await startServer(PORTS.maintenance, { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", TENOTRAINER_APP_ORIGIN: MAINT });
  const M = PORTS.maintenance;
  const mOk = await req(M, "GET", "/login", { host: MAINT_HOST });
  check("maintenance canonical-host GET proceeds (200)", mOk.status === 200, String(mOk.status));
  const mG = await req(M, "GET", "/clinician/dashboard?q=1", { host: EVIL });
  check("maintenance wrong-host GET -> 308 to the configured maintenance origin, secured", mG.status === 308 && loc(mG) === `${MAINT}/clinician/dashboard?q=1` && securedProd(mG), `${mG.status} ${loc(mG)}`);
  const mP = await req(M, "POST", DISPATCH, { host: EVIL, authorization: WRONG_SECRET, "content-length": "0" });
  check("maintenance wrong-host POST (even the operational dispatch path) -> 403 before the handler", mP.status === 403 && json(mP)?.error === "NONCANONICAL_HOST_REFUSED", String(mP.status));
  const mDispatch = await req(M, "POST", DISPATCH, { host: MAINT_HOST, authorization: WRONG_SECRET, "content-length": "0" });
  check("maintenance canonical-host dispatch still reaches its handler (operational exception; wrong secret -> 401)", mDispatch.status === 401, String(mDispatch.status));
  const mMut = await req(M, "POST", "/api/clinician/patients/00000000-0000-0000-0000-000000000000/prescription/pause", { host: MAINT_HOST, origin: MAINT, "sec-fetch-site": "same-origin", "content-length": "0" });
  check("maintenance canonical same-origin clinical mutation still refused 503 MAINTENANCE", mMut.status === 503 && json(mMut)?.error === "MAINTENANCE", String(mMut.status));
  const mLo = await req(M, "GET", "/logout", { host: EVIL, "x-forwarded-host": MAINT_HOST });
  check("maintenance logout under forged Host -> canonical maintenance /login", canonicalTarget(mLo, MAINT)?.pathname === "/login", `${mLo.status} ${loc(mLo)}`);
  await stopServer(maint);

  // ================================================================ E
  section("E. Development: request-local redirects, configured links, no canonicalization");
  const dev = await startServer(PORTS.dev, { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: DEV_CONFIGURED, C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: "http://127.0.0.1:59999" });
  const D = PORTS.dev;
  const dLogin = await req(D, "GET", "/login", { host: EVIL });
  check("development does not canonicalize hosts (any Host is served)", dLogin.status === 200, String(dLogin.status));
  const here = `http://localhost:${D}`;
  const devTarget = (r) => { try { return new URL(loc(r), here); } catch { return null; } };
  const dLo = await req(D, "GET", "/logout", { host: `localhost:${D}` });
  check("development logout redirect stays on the spawned test port (not the configured origin, not :3000)", devTarget(dLo)?.port === String(D) && devTarget(dLo)?.pathname === "/login" && !String(loc(dLo)).startsWith(DEV_CONFIGURED), loc(dLo));
  const dUnauth = await req(D, "GET", "/patient/dashboard", { host: `localhost:${D}` });
  check("development auth redirect stays on the spawned test port", devTarget(dUnauth)?.port === String(D) && devTarget(dUnauth)?.pathname === "/login", loc(dUnauth));
  const dCb = await req(D, "GET", "/auth/callback?error=x", { host: `127.0.0.1:${D}` });
  check("development callback redirect stays on the spawned test port (the server's own origin)", devTarget(dCb)?.port === String(D) && devTarget(dCb)?.pathname === "/login" && !String(loc(dCb)).startsWith(DEV_CONFIGURED), loc(dCb));
  const dMut = await req(D, "POST", DISPATCH, { host: `localhost:${D}`, origin: `http://localhost:${D}`, "sec-fetch-site": "same-origin", authorization: WRONG_SECRET, "content-length": "0" });
  check("development keeps its host-based mutation comparison (matching localhost Origin passes)", dMut.status === 401, String(dMut.status));
  const dCross = await req(D, "POST", DISPATCH, { host: `localhost:${D}`, origin: `https://${EVIL}`, authorization: WRONG_SECRET, "content-length": "0" });
  check("development still refuses a foreign Origin", dCross.status === 403 && json(dCross)?.error === "CROSS_ORIGIN_REQUEST_REFUSED", String(dCross.status));
  await stopServer(dev);

  // ================================================================ F
  section("F. Generated links come from the configured origin only (real modules, in-process)");
  const CHILD = `
import { register } from "node:module";
register(new URL("./scripts/lib/tsServerModuleHooks.mjs", "file://" + process.cwd() + "/"));
const { invitationUrl } = await import("./lib/invitations.ts");
const { getAppOrigin } = await import("./lib/config/index.ts");
const { notificationLink } = await import("./lib/safetyEmail/template.ts");
process.stdout.write(JSON.stringify({ invite: invitationUrl("a".repeat(64)), safety: notificationLink(getAppOrigin(), "11111111-1111-1111-1111-111111111111") }));
`;
  const { fakeKeysFor } = await import("./lib/fakeSupabaseKeys.mjs");
  const REF = "kpdxlzqtvueiytwjamiw";
  const linkEnv = (extra) => ({ PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_URL: `https://${REF}.supabase.co`, ...fakeKeysFor(REF), ...extra,
    // request-shaped noise that must have no effect on generated links
    HOST: EVIL, X_FORWARDED_HOST: EVIL });
  const run = (env) => JSON.parse(execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "--input-type=module", "-e", CHILD],
    { cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const prodLinks = run(linkEnv({ TENOTRAINER_MODE: "production", NODE_ENV: "production", TENOTRAINER_APP_ORIGIN: CANON, TENOTRAINER_SUPABASE_PROJECT_REF: REF, ...PROD_ENV, FASTAPI_URL: undefined, BRIDGE_SECRET: undefined }));
  check("production invitation link uses the configured canonical origin", prodLinks.invite === `${CANON}/invite/accept?token=${"a".repeat(64)}`, prodLinks.invite);
  check("production safety notification link uses the configured canonical origin", prodLinks.safety === `${CANON}/clinician/notifications/11111111-1111-1111-1111-111111111111`, prodLinks.safety);
  const devLinks = run(linkEnv({ TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: DEV_CONFIGURED }));
  check("development generated links use the configured origin (not a request origin)", devLinks.invite.startsWith(`${DEV_CONFIGURED}/invite/accept?token=`) && devLinks.safety.startsWith(`${DEV_CONFIGURED}/clinician/`), JSON.stringify(devLinks));

  // ================================================================ G
  section("G. Browser at the canonical origin (test gateway, real TLS, no application bypass)");
  const prod2 = await startServer(PORTS.prod, { ...PROD_ENV, TENOTRAINER_MODE: "production" });
  const gateway = await startCanonicalGateway({ port: PORTS.gateway, routes: { [CANON_HOST]: PORTS.prod } });
  const browser = await launchCanonicalBrowser(gateway);
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await page.goto(`${CANON}/patient/dashboard?from=test`);
    check("browser: unauthenticated page lands on the canonical /login (one canonical redirect chain)", new URL(page.url()).origin === CANON && new URL(page.url()).pathname === "/login" && res?.status() === 200, page.url());
    check("browser: canonical page carries HSTS over real TLS", (res?.headers()["strict-transport-security"] ?? "").includes("max-age="));
    const post = await page.evaluate(async (p) => { const r = await fetch(p, { method: "POST", headers: { authorization: "Bearer wrong-secret-wrong-secret-wrong-secret!" } }); return r.status; }, DISPATCH);
    check("browser: same-origin POST from the canonical origin passes the exact-Origin boundary (handler 401)", post === 401, String(post));
    await ctx.close();
  } finally {
    await browser.close();
    await gateway.close();
    await stopServer(prod2);
  }
}

try {
  await main();
} catch (e) {
  check("suite ran without an unexpected error", false, e?.stack ?? String(e));
} finally {
  for (const s of started) await stopServer(s);
  let lingering = 0;
  for (const p of Object.values(PORTS)) if (await listening(p)) lingering++;
  check("no server or gateway this suite started is still listening", lingering === 0, String(lingering));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
