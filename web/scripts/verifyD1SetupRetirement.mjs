// D1 — /setup is development-only. Proves against REAL isolated
// `next start` servers this script starts itself (own process groups; only
// those are ever stopped; never :3000 / :8000), production and maintenance
// reached at their real canonical origins through the local TLS gateway:
//
//   A. production + maintenance: GET /setup → 404 (unauthenticated AND
//      signed in as an account with no membership); the 404 reveals nothing.
//   B. production + maintenance: a raw form POST that invokes the real
//      createOrgAction (by its build action id) at /setup → refused by the
//      proxy; the same POST aimed at another page the proxy lets through
//      (/dashboard, where Next itself resolves the action id) → does not
//      provision.
//   C. the action itself refuses outside development, in-process, before
//      any Supabase client exists (scripts/lib/d1SetupActionProbe.mjs).
//   D. development: /setup still serves the first-run page, and the action
//      still runs its own guards (this shared dev project already has
//      organizations, so it redirects with the first-run-only error).
//   E. nothing was provisioned: no organization with the test slug, and the
//      fixture account still has zero memberships. Fixtures purged by id.
//
// Requires a production build (`npx next build`).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyD1SetupRetirement.mjs
import { createClient } from "@supabase/supabase-js";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { withEmailContainment, withoutRetiredNames } from "./lib/harnessEnv.mjs";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { gatewayFetch, launchCanonicalBrowser, startCanonicalGateway } from "./lib/canonicalGateway.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const RUN = randomUUID().slice(0, 8);
const SLUG = `d1-setup-${RUN}`;
const PORTS = { prod: 3171, maint: 3172, dev: 3173, gateway: 3176 };
const CANONICAL = { prod: "app.tenotrainer.test", maint: "maint.tenotrainer.test" };
const ORIGIN = { prod: `https://${CANONICAL.prod}`, maint: `https://${CANONICAL.maint}`, dev: `http://localhost:${PORTS.dev}` };

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real action id of createOrgAction in this build.
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const ACTION_ID = Object.entries(manifest.node ?? {}).find(([, v]) => v.exportedName === "createOrgAction" && Object.keys(v.workers ?? {}).includes("app/setup/page"))?.[0];
if (!ACTION_ID) { console.error("createOrgAction not found in the build manifest — run `npx next build` first"); process.exit(1); }

// ---------------------------------------------------------------- servers
const PROD_ENV = { FASTAPI_URL: "", BRIDGE_SECRET: "", C5_PATIENT_RUNTIME_ENABLED: "true", C5_PRESCRIPTION_PUBLISH_ENABLED: "false",
  TENOTRAINER_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: `d1-setup-${randomUUID()}-${randomUUID()}`,
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
  if (await listening(port)) throw new Error(`port ${port} is already in use — refusing to touch a server this script did not start`);
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

// ---------------------------------------------------------------- helpers
async function signedIn(browser, origin, email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${origin}/login`, { timeout: 120000 });
  await page.fill("#email", email);
  await page.fill("#password", FIXTURE_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return ctx;
}
// A plain HTML form submission of the real server action (no JavaScript).
function postAction(ctx, origin, path) {
  return ctx.request.post(`${origin}${path}`, {
    headers: { Origin: origin },
    multipart: { [`$ACTION_ID_${ACTION_ID}`]: "", name: `D1 Setup ${RUN}`, slug: SLUG },
    maxRedirects: 0, failOnStatusCode: false, timeout: 60000,
  });
}
const provisioned = (userId) => guardedSql(env, `SELECT
  (SELECT count(*) FROM organizations WHERE slug = '${SLUG}') AS orgs,
  (SELECT count(*) FROM organization_members WHERE user_id = ${q(userId)}) AS memberships`)[0];

const run = new FixtureRun(env, admin, `d1s-${RUN}`);
let gateway;
let browser;
try {
  const user = await run.user("nomember");
  const orgsBefore = guardedSql(env, "SELECT count(*) AS n FROM organizations")[0].n;

  section("C. the action refuses in-process (bypassing page, proxy and HTTP)");
  for (const mode of ["production", "maintenance", "development"]) {
    const out = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "scripts/lib/d1SetupActionProbe.mjs", mode], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const r = JSON.parse(out.trim().split("\n").pop());
    if (mode === "development") check("development control: the action proceeds past the mode check", r.outcome !== "redirect:/dashboard?error=UNAVAILABLE", JSON.stringify(r));
    else check(`${mode}: createOrgAction refused (redirect UNAVAILABLE) before any Supabase client`, r.outcome === "redirect:/dashboard?error=UNAVAILABLE" && r.supabaseClients === 0, JSON.stringify(r));
  }

  const prod = await startServer(PORTS.prod, { ...PROD_ENV, TENOTRAINER_MODE: "production", TENOTRAINER_APP_ORIGIN: ORIGIN.prod });
  const maint = await startServer(PORTS.maint, { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", TENOTRAINER_APP_ORIGIN: ORIGIN.maint });
  const dev = await startServer(PORTS.dev, { TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: ORIGIN.dev, TENOTRAINER_EMAIL_PROVIDER: "disabled", FASTAPI_URL: "", BRIDGE_SECRET: "" });
  gateway = await startCanonicalGateway({ port: PORTS.gateway, routes: { [CANONICAL.prod]: PORTS.prod, [CANONICAL.maint]: PORTS.maint } });
  const gfetch = gatewayFetch(gateway);
  browser = await launchCanonicalBrowser(gateway);

  for (const mode of ["prod", "maint"]) {
    const label = mode === "prod" ? "production" : "maintenance";
    section(`A/B. ${label}`);
    const origin = ORIGIN[mode];
    const anon = await gfetch(`${origin}/setup`, { redirect: "manual" });
    const anonBody = await anon.text();
    check(`${label}: unauthenticated GET /setup → 404`, anon.status === 404, anon.status);
    check(`${label}: the 404 reveals no bootstrap state`, !/organization|setup|super|first-time/i.test(anonBody), anonBody.slice(0, 120));
    const head = await gfetch(`${origin}/setup/anything`, { redirect: "manual" });
    check(`${label}: /setup subpaths → 404`, head.status === 404, head.status);
    const ctx = await signedIn(browser, origin, user.email);
    const authed = await ctx.request.get(`${origin}/setup`, { maxRedirects: 0, failOnStatusCode: false });
    check(`${label}: signed in with no membership, GET /setup → 404`, authed.status() === 404 && !/Create your organization/.test(await authed.text()), authed.status());
    const direct = await postAction(ctx, origin, "/setup");
    check(`${label}: form POST of the real action at /setup → refused by the proxy (404)`, direct.status() === 404, direct.status());
    const bypass = await postAction(ctx, origin, "/dashboard");
    const loc = bypass.headers()["location"] ?? "";
    const p = provisioned(user.id);
    check(`${label}: the same action aimed at /dashboard (proxy bypass attempt) provisions nothing`, Number(p.orgs) === 0 && Number(p.memberships) === 0, `${bypass.status()} ${loc} ${JSON.stringify(p)}`);
    console.log(`      (observed: HTTP ${bypass.status()}${loc ? ` → ${loc}` : ""})`);
    await ctx.close();
  }

  section("D. development keeps the first-run page");
  const devAnon = await globalThis.fetch(`${ORIGIN.dev}/setup`, { redirect: "manual" });
  check("development: unauthenticated GET /setup → login redirect", [302, 303, 307, 308].includes(devAnon.status) && /\/login/.test(devAnon.headers.get("location") ?? ""), devAnon.status);
  const dctx = await signedIn(browser, ORIGIN.dev, user.email);
  const dpage = await dctx.request.get(`${ORIGIN.dev}/setup`, { maxRedirects: 0, failOnStatusCode: false });
  check("development: signed in with no membership, GET /setup → the first-run page (200)", dpage.status() === 200 && /Create your organization/.test(await dpage.text()), dpage.status());
  const dpost = await postAction(dctx, ORIGIN.dev, "/setup");
  const dloc = dpost.headers()["location"] ?? "";
  check("development: the action runs its own first-run guard (organizations exist → refused)", [303, 307].includes(dpost.status()) && /Setup\+is\+only\+available|Setup%20is%20only/.test(dloc), `${dpost.status()} ${dloc}`);
  await dctx.close();

  section("E. nothing provisioned");
  const p = provisioned(user.id);
  const orgsAfter = guardedSql(env, "SELECT count(*) AS n FROM organizations")[0].n;
  check("no organization created with the test slug, total organizations unchanged", Number(p.orgs) === 0 && Number(orgsAfter) === Number(orgsBefore), `${orgsBefore} → ${orgsAfter}`);
  check("the fixture account still has zero memberships (no super_user)", Number(p.memberships) === 0);
  for (const s of [prod, maint, dev]) check(`server on :${s.port} logged no unexpected error`, !/⨯|Unhandled|TypeError/.test(s.log), s.log.match(/.*(⨯|Unhandled|TypeError).*/)?.[0]);
} finally {
  await browser?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  for (const s of started) await stopServer(s);
  section("teardown");
  try {
    const res = run.teardown();
    check("fixtures purged by exact id, zero residue", !!res, JSON.stringify(res.residue));
  } catch (e) {
    check("fixtures purged by exact id, zero residue", false, e.message);
  }
  for (const port of Object.values(PORTS)) check(`no listener left on :${port}`, !(await listening(port)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
