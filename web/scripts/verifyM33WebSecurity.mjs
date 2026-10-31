// M3.3 S2 — web security boundary suite. Proves, against REAL isolated
// `next start` servers this script starts itself (own process groups; only
// those are ever stopped; never :3000 / :8000), the actual HTTP behaviour:
//
//   A. build: authenticated pages are not statically generated.
//   B. production: baseline headers, no-store on patient / clinician /
//      super / admin pages and authenticated APIs (reads and mutation
//      responses), static assets keep immutable public caching, HSTS (no
//      preload), CSP Report-Only (not enforced) with a fresh per-request
//      nonce, no eval / inline / wildcard sources.
//   C. production pages render and hydrate with ZERO CSP violations, and
//      still do when the same policy is ENFORCED (simulated by promoting the
//      Report-Only header in the browser); an injected inline script is
//      reported (Report-Only) and blocked (enforced) — the detector works.
//   D. Referrer-Policy no-referrer: an invitation-token URL is never sent
//      as a Referer, to another origin or to this one.
//   E. cross-origin mutation boundary: hostile / malformed browser
//      mutations refused before any handler (raw HTTP matrix with a valid
//      session, and a real cross-site form post); same-origin browser
//      mutations and Server Actions work; nothing changed by a refusal.
//   F. internal safety dispatcher: still reachable with its secret
//      (provider disabled -> never claims; the preserved L5 is untouched),
//      browser-shaped cross-origin calls refused.
//   G. legacy production refusal and maintenance behaviour intact, with
//      the same headers; development mode: no HSTS, no eval (production
//      build).
//
// Requires a production build of this worktree (`npx next build`).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM33WebSecurity.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";

const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PRESERVED_L5_OUTBOX = "f73aeb4d-6517-481b-ac6e-cc73fa0afc67";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const RUN = randomUUID().slice(0, 8);
const PORTS = { prod: 3181, maintenance: 3182, dev: 3183, external: 3184 };
const P = `http://localhost:${PORTS.prod}`;
const M = `http://localhost:${PORTS.maintenance}`;
const D = `http://localhost:${PORTS.dev}`;
const EXT = `http://127.0.0.1:${PORTS.external}`;
const DISPATCH = "/api/internal/safety-notifications/dispatch";
const SECRET = `m33-s2-${randomUUID()}-${randomUUID()}`;

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const eq = t.indexOf("=");
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`\n--- ${t} ---`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- servers
// Same environment discipline as the M3.1 / M3.2 mode suites: every
// mode-relevant key is explicit (blank overrides .env.local).
function serverEnv(overrides) {
  const base = { ...process.env };
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "NEXT_PUBLIC_APP_URL"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED"]) base[k] = "";
  return { ...base, RESEND_API_KEY: "", ...overrides };
}
// Production / maintenance require the safety email configuration; the
// dummy key is never used — this suite never presents the real secret to
// a server whose provider is configured.
const PROD_ENV = { FASTAPI_URL: "", BRIDGE_SECRET: "", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.test", C5_PATIENT_RUNTIME_ENABLED: "true",
  C5_PRESCRIPTION_PUBLISH_ENABLED: "false", SAFETY_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: `m33-s2-prod-${randomUUID()}-${randomUUID()}`,
  RESEND_API_KEY: "re_isolated_never_called", RESEND_FROM: "TenoTrainer <safety@tenotrainer.test>" };
// Development mode on the production build; provider disabled so the
// dispatcher refuses before claiming anything.
const DEV_ENV = { TENOTRAINER_MODE: "development", FASTAPI_URL: "http://127.0.0.1:59999", NEXT_PUBLIC_APP_URL: D, C5_PATIENT_RUNTIME_ENABLED: "true",
  C5_PRESCRIPTION_PUBLISH_ENABLED: "false", SAFETY_EMAIL_PROVIDER: "", SAFETY_DISPATCH_SECRET: SECRET };
const started = [];

function spawnServer(port, overrides) {
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: serverEnv(overrides), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { port, proc, pid: proc.pid, log: "", exited: null };
  proc.stdout.on("data", (d) => (s.log += d));
  proc.stderr.on("data", (d) => (s.log += d));
  proc.on("exit", (code) => (s.exited = code ?? -1));
  started.push(s);
  return s;
}
async function listening(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}
async function startServer(port, overrides) {
  if (await listening(port)) throw new Error(`port ${port} is already in use — refusing to touch a server this script did not start`);
  const s = spawnServer(port, overrides);
  for (let i = 0; i < 120; i++) {
    if (s.exited !== null) throw new Error(`server on ${port} exited (${s.exited}):\n${s.log.slice(-1500)}`);
    if (await listening(port)) return s;
    await sleep(500);
  }
  throw new Error(`server on ${port} did not become ready`);
}
async function stopServer(s) {
  if (s.exited !== null) return;
  try {
    process.kill(-s.pid, "SIGTERM"); // only the process group this script created
  } catch {
    // already gone
  }
  for (let i = 0; i < 40 && s.exited === null; i++) await sleep(250);
  if (s.exited === null) {
    try {
      process.kill(-s.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (let i = 0; i < 40 && (await listening(s.port)); i++) await sleep(250);
}

// A separate origin (different host AND port): records every request's
// Referer, and serves a hostile auto-submitting cross-site form.
const externalHits = [];
let externalServer = null;
function startExternal() {
  if (externalServer) return Promise.resolve();
  externalServer = createServer((req, res) => {
    const url = new URL(req.url, EXT);
    externalHits.push({ path: url.pathname, referer: req.headers.referer ?? null });
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/evil-form") {
      const target = url.searchParams.get("target");
      res.end(`<!doctype html><form method="POST" action="${target}" enctype="text/plain"><input name='{"morningReminderTime":"08:15","x":"' value='"}'></form><script>document.forms[0].submit()</script>`);
      return;
    }
    res.end("<!doctype html><title>external</title><p>external origin</p>");
  });
  return new Promise((resolve, reject) => {
    externalServer.once("error", reject);
    externalServer.listen(PORTS.external, "127.0.0.1", resolve);
  });
}

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
let throwawayOrgId = null;
let patientRx = null;

async function makeUser(label, membership = null) {
  const email = `m33-${label}-${RUN}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  const { error: pe } = await admin.from("profiles").upsert({ id: data.user.id, name: `M3.3 ${label}`, timezone: TZ, morning_reminder_time: "07:00" });
  if (pe) throw pe;
  if (membership) {
    const { error: me } = await admin.from("organization_members").insert({ organization_id: membership.org, user_id: data.user.id, role: membership.role });
    if (me) throw me;
  }
  return { userId: data.user.id, email };
}

// A patient with a published program, assigned to the clinician. Uses an
// existing global canonical exercise (read-only reference; none created).
async function makeProgramPatient(clinician) {
  const { data: ex, error: xe } = await admin.from("canonical_exercises").select("id").eq("active", true).eq("visibility", "global").order("id").limit(1).single();
  if (xe) throw xe;
  const p = await makeUser("patient");
  const { error: ae } = await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: p.userId, status: "active" });
  if (ae) throw ae;
  const { data: pp, error: ppe } = await admin.from("patient_prescriptions").insert({ patient_id: p.userId }).select("id").single();
  if (ppe) throw ppe;
  patientRx = pp.id;
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({
      user_id: p.userId, source: "clinician_change", patient_prescription_id: pp.id, version_number: 1,
      published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: clinician.userId,
      scheduling_mode: "sequence", target_sessions_per_week: 3, recovery_days: 0,
    })
    .select("id")
    .single();
  if (error) throw error;
  const { data: w } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: "A", order_index: 0 }).select("id").single();
  const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: ex.id, order_index: 0, status: "active" }).select("id").single();
  const { error: de } = await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
  if (de) throw de;
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return { ...p, ppId: pp.id, versionId: v.id };
}

async function patientState(userId) {
  const { data } = await admin.from("profiles").select("timezone, morning_reminder_time").eq("id", userId).single();
  const { data: sessions } = await admin.from("rehab_sessions").select("id").eq("user_id", userId);
  const { data: drafts } = await admin.from("prescription_drafts").select("id").eq("patient_prescription_id", patientRx ?? randomUUID());
  return JSON.stringify({ profile: data, sessions: sessions?.length ?? -1, drafts: drafts?.length ?? -1 });
}

async function l5Outbox() {
  const { data } = await admin.from("safety_email_outbox").select("*").eq("id", PRESERVED_L5_OUTBOX).single();
  const { count } = await admin.from("safety_email_attempts").select("id", { count: "exact", head: true });
  return JSON.stringify({ row: data, attempts: count });
}

async function teardown() {
  const ids = createdUsers.length ? createdUsers : [randomUUID()];
  for (const userId of createdUsers) {
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
  }
  await admin.from("supervisor_patients").delete().in("patient_id", ids);
  await admin.from("supervisor_patients").delete().in("supervisor_id", ids);
  await admin.from("organization_members").delete().in("user_id", ids);
  await admin.from("profiles").delete().in("id", ids);
  let failed = 0;
  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) {
      failed++;
      console.log(`teardown: could not delete user ${id}: ${error.message}`);
    }
  }
  if (throwawayOrgId) await admin.from("organizations").delete().eq("id", throwawayOrgId);
  const residue = {
    users: (await Promise.all(createdUsers.map((id) => admin.auth.admin.getUserById(id)))).filter((r) => r.data?.user).length,
    profiles: (await admin.from("profiles").select("id").in("id", ids)).data?.length ?? -1,
    assignments: (await admin.from("supervisor_patients").select("id").in("patient_id", ids)).data?.length ?? -1,
    memberships: (await admin.from("organization_members").select("user_id").in("user_id", ids)).data?.length ?? -1,
    prescriptions: (await admin.from("patient_prescriptions").select("id").in("patient_id", ids)).data?.length ?? -1,
    org: throwawayOrgId ? (await admin.from("organizations").select("id").eq("id", throwawayOrgId)).data?.length ?? -1 : 0,
  };
  console.log(`\nteardown: ${createdUsers.length} users, org ${throwawayOrgId ? 1 : 0}; residue ${JSON.stringify(residue)}`);
  return failed === 0 && Object.values(residue).every((n) => n === 0);
}

// ---------------------------------------------------------------- browser helpers
// Records every CSP violation (Report-Only and enforced alike) and every
// console complaint about CSP / Permissions-Policy, before any page script.
// inject: a non-nonced inline <script> is written into the server HTML of
// any document whose URL carries ?__xss=1 — a parser-level stored-XSS
// stand-in (DevTools-injected scripts are exempt from CSP, so they cannot
// prove anything).
const XSS = "<script>window.__injected = 1</script>";
async function watchedContext(browser, { enforce = false, inject = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.__cspv = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspv.push({ directive: e.violatedDirective, blocked: e.blockedURI, disposition: e.disposition, sample: e.sample });
    });
  });
  context.__console = [];
  context.on("console", (m) => {
    if (/content security policy|permissions[- ]policy|unrecognized feature|refused to/i.test(m.text())) context.__console.push(m.text());
  });
  context.on("page", (pg) => pg.on("console", (m) => {
    if (/content security policy|permissions[- ]policy|unrecognized feature|refused to/i.test(m.text())) context.__console.push(m.text());
  }));
  if (enforce || inject) {
    // enforce: promote the Report-Only policy to an enforced one on document
    // responses — exactly what flipping CSP_HEADER will do.
    await context.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch({ maxRedirects: 0 });
      const headers = response.headers();
      const ro = headers["content-security-policy-report-only"];
      if (enforce && ro) {
        headers["content-security-policy"] = ro;
        delete headers["content-security-policy-report-only"];
      }
      if (inject && new URL(route.request().url()).searchParams.get("__xss") === "1") {
        const body = (await response.text()).replace("</body>", `${XSS}</body>`);
        delete headers["content-length"];
        delete headers["content-encoding"];
        await route.fulfill({ response, headers, body });
        return;
      }
      await route.fulfill({ response, headers });
    });
  }
  return context;
}
async function login(context, base, email) {
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  return page;
}
const violations = (page) => page.evaluate(() => window.__cspv ?? []);
const hydrated = (page) => page.evaluate(() => [...document.querySelectorAll("body *")].some((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber"))));

function headerProblems(h, { mode, sensitive = true }) {
  const problems = [];
  const want = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
  for (const [k, v] of Object.entries(want)) if (h[k] !== v) problems.push(`${k}=${h[k]}`);
  if (!/^accelerometer=\(\).*camera=\(\).*geolocation=\(\).*microphone=\(\).*payment=\(\)/.test(h["permissions-policy"] ?? "")) problems.push(`permissions-policy=${h["permissions-policy"]}`);
  if (sensitive) {
    if (h["cache-control"] !== "private, no-store, max-age=0") problems.push(`cache-control=${h["cache-control"]}`);
    if (!h["content-security-policy-report-only"]) problems.push("no CSP Report-Only");
    if (h["content-security-policy"]) problems.push("CSP is ENFORCED");
    const hsts = h["strict-transport-security"];
    if (mode === "development" ? hsts !== undefined : hsts !== "max-age=31536000; includeSubDomains") problems.push(`hsts=${hsts}`);
  }
  return problems;
}
function cspProblems(csp, { allowDevEval = false } = {}) {
  const problems = [];
  if (!csp) return ["missing"];
  const tokens = csp.split(/[;\s]+/);
  if (!allowDevEval && tokens.includes("'unsafe-eval'")) problems.push("unsafe-eval");
  for (const bad of ["*", "'unsafe-inline'", "https:", "http:", "data:", "blob:", "ws:", "wss:", "'unsafe-hashes'"]) if (tokens.includes(bad)) problems.push(bad);
  if (tokens.some((t) => t.includes("*"))) problems.push("wildcard host");
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) if (!csp.includes(d)) problems.push(`missing ${d}`);
  if (!/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/.test(csp)) problems.push("script-src not nonce + strict-dynamic");
  return problems;
}
const nonceOf = (csp) => /'nonce-([^']+)'/.exec(csp ?? "")?.[1] ?? null;

// Authenticated request with explicit browser-shaped headers.
async function call(ctx, base, method, path, { data, headers = {} } = {}) {
  const res = await ctx.request.fetch(`${base}${path}`, { method, data, headers, failOnStatusCode: false, maxRedirects: 0 });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  return { status: res.status(), headers: res.headers(), body };
}

const LEGACY_ROUTES = [
  ["POST", "/api/patient/rehab-session"],
  ["GET", "/api/patient/rehab-session/current"],
  ["POST", `/api/patient/morning-response/${randomUUID()}`],
  ["GET", "/api/auth/launch-dashboard"],
  ["POST", "/api/auth/validate-bridge"],
  ["POST", "/api/internal/prescription-versions"],
  ["POST", "/api/internal/supervisor-patients-sync"],
];

async function main() {
  // ================================================================ A
  section("A. Build: authenticated content is never statically generated");
  const manifest = JSON.parse(readFileSync(".next/prerender-manifest.json", "utf8"));
  const prerendered = Object.keys(manifest.routes);
  check("prerender manifest holds only the framework error page and favicon", prerendered.every((r) => ["/_global-error", "/favicon.ico"].includes(r)), JSON.stringify(prerendered));
  check("no dynamic prerender (ISR) routes", Object.keys(manifest.dynamicRoutes ?? {}).length === 0);

  const l5Before = await l5Outbox();
  const { data: org, error: oe } = await admin.from("organizations").insert({ name: `M3.3 S2 super org ${RUN}`, slug: `m33-s2-${RUN}` }).select("id").single();
  if (oe) throw oe;
  throwawayOrgId = org.id;
  const clinician = await makeUser("clinician", { org: REAL_ORG_ID, role: "clinician" });
  const superUser = await makeUser("super", { org: throwawayOrgId, role: "super_user" });
  const patient = await makeProgramPatient(clinician);

  await startExternal();
  const browser = await chromium.launch();
  try {
    // ================================================================ B
    section("B. Production: headers, no-store, HSTS, CSP Report-Only");
    const prod = await startServer(PORTS.prod, { ...PROD_ENV, TENOTRAINER_MODE: "production" });
    check("production server started and logged its mode", prod.log.includes("TenoTrainer operating mode: production"));

    const pCtx = await watchedContext(browser);
    const pPage = await login(pCtx, P, patient.email);
    const cCtx = await watchedContext(browser);
    const cPage = await login(cCtx, P, clinician.email);
    const sCtx = await watchedContext(browser);
    const sPage = await login(sCtx, P, superUser.email);
    check("production: patient, clinician and super user signed in (Server Action login under the policy)", true);

    const pagesByRole = [
      ["patient", pPage, ["/patient/dashboard", "/patient/progress", "/patient/settings", "/patient/check-in"]],
      ["clinician", cPage, ["/clinician/dashboard", `/clinician/patients/${patient.userId}`, `/clinician/patients/${patient.userId}/safety`,
        `/clinician/patients/${patient.userId}/sessions`, `/clinician/patients/${patient.userId}/progress`, `/clinician/patients/${patient.userId}/review`,
        `/clinician/patients/${patient.userId}/prescription`, "/clinician/notifications", "/clinician/invitations"]],
      ["super", sPage, ["/super/dashboard", "/super/safety-notifications", "/admin/assignments"]],
    ];
    const nonces = new Set();
    for (const [role, page, paths] of pagesByRole) {
      for (const path of paths) {
        const res = await page.goto(`${P}${path}`, { waitUntil: "networkidle" });
        const h = res.headers();
        const label = path.replace(patient.userId, ":patient");
        check(`production ${role} ${label}: 200, not redirected`, res.status() === 200 && new URL(page.url()).pathname === path, `${res.status()} ${page.url()}`);
        const hp = headerProblems(h, { mode: "production" });
        check(`production ${role} ${label}: no-store + baseline headers + HSTS + Report-Only`, hp.length === 0, hp.join("; "));
        const cp = cspProblems(h["content-security-policy-report-only"]);
        check(`production ${role} ${label}: CSP has nonce + strict-dynamic, no eval / inline / wildcard`, cp.length === 0, cp.join("; "));
        const n = nonceOf(h["content-security-policy-report-only"]);
        nonces.add(n);
        const scripts = await page.evaluate(() => [...document.scripts].map((s) => ({ nonce: s.nonce, src: s.src })));
        check(`production ${role} ${label}: every server-rendered script carries this response's nonce`, scripts.length > 0 && scripts.every((s) => s.nonce === n), JSON.stringify(scripts.filter((s) => s.nonce !== n)).slice(0, 300));
        check(`production ${role} ${label}: hydrated`, await hydrated(page));
        const v = await violations(page);
        check(`production ${role} ${label}: zero CSP violations`, v.length === 0, JSON.stringify(v).slice(0, 400));
      }
    }
    check("production: a fresh nonce on every response (never reused)", nonces.size === pagesByRole.reduce((n, [, , p]) => n + p.length, 0), `${nonces.size} distinct`);

    // Client-side navigation (RSC fetch) and a same-origin Server Action.
    await cPage.goto(`${P}/clinician/dashboard`, { waitUntil: "networkidle" });
    const link = cPage.locator(`a[href="/clinician/patients/${patient.userId}"]`).first();
    if (await link.count()) {
      await link.click();
      await cPage.waitForURL((u) => u.pathname === `/clinician/patients/${patient.userId}`, { timeout: 20000 });
      await cPage.waitForLoadState("networkidle");
      check("production: client-side navigation (RSC) works with zero violations", (await violations(cPage)).length === 0, JSON.stringify(await violations(cPage)));
    } else {
      check("production: clinician dashboard links the assigned patient (client-side navigation)", false, "no patient link on the dashboard");
    }

    // Authenticated API reads and a clinical mutation response.
    const apiReads = [
      [pCtx, "patient", "/api/patient/c5/state"],
      [pCtx, "patient", "/api/patient/c5/check-ins"],
      [cCtx, "clinician", "/api/clinician/library/exercises"],
      [cCtx, "clinician", `/api/clinician/prescription-drafts/${randomUUID()}`],
    ];
    for (const [ctx, role, path] of apiReads) {
      const r = await call(ctx, P, "GET", path);
      const hp = headerProblems(r.headers, { mode: "production" });
      check(`production ${role} API GET ${path.replace(/[0-9a-f-]{36}/, ":id")} (${r.status}): no-store + baseline headers`, r.status < 500 && r.status !== 401 && hp.length === 0, `${r.status} ${hp.join("; ")}`);
    }
    const sameOrigin = { origin: P, "sec-fetch-site": "same-origin" };
    const mut = await call(pCtx, P, "PATCH", "/api/patient/reminder-time", { data: { morningReminderTime: "07:00" }, headers: sameOrigin });
    check("production clinical mutation response (same-origin PATCH reminder-time): 200 + no-store", mut.status === 200 && headerProblems(mut.headers, { mode: "production" }).length === 0, `${mut.status} ${headerProblems(mut.headers, { mode: "production" })}`);
    const anon = await call(await browser.newContext(), P, "GET", "/api/patient/c5/state");
    check("production unauthenticated API refusal (401) carries no-store + headers", anon.status === 401 && headerProblems(anon.headers, { mode: "production" }).length === 0);
    const redirect = await fetch(`${P}/patient/dashboard`, { redirect: "manual" });
    check("production auth redirect (307 -> /login) carries no-store + headers", redirect.status === 307 && headerProblems(Object.fromEntries(redirect.headers), { mode: "production" }).length === 0);

    // Public / static content keeps normal caching.
    const loginHtml = await (await fetch(`${P}/login`)).text();
    const assets = [...new Set([...loginHtml.matchAll(/\/_next\/static\/[^"'\s]+\.(?:js|css|woff2)/g)].map((m) => m[0]))];
    check("production: login page references static assets", assets.length >= 2, String(assets.length));
    let staticOk = 0;
    for (const a of assets.slice(0, 6)) {
      const r = await fetch(`${P}${a}`);
      const h = Object.fromEntries(r.headers);
      if (r.status === 200 && h["cache-control"] === "public, max-age=31536000, immutable" && h["x-content-type-options"] === "nosniff" && !h["content-security-policy-report-only"]) staticOk++;
      else console.log(`      static ${a}: ${r.status} ${h["cache-control"]}`);
    }
    check("production static assets: immutable public caching (NOT no-store) + nosniff", staticOk === Math.min(6, assets.length));
    const fav = await fetch(`${P}/favicon.ico`);
    check("production favicon: not forced to no-store, nosniff present", fav.status === 200 && !(fav.headers.get("cache-control") ?? "").includes("no-store") && fav.headers.get("x-content-type-options") === "nosniff", fav.headers.get("cache-control"));
    const reg = await fetch(`${P}/register`, { redirect: "manual" });
    check("production /register (closed: redirects to invitation-required login) carries no-store + headers", reg.status === 307 && (reg.headers.get("location") ?? "").includes("/login") && headerProblems(Object.fromEntries(reg.headers), { mode: "production" }).length === 0, `${reg.status} ${reg.headers.get("location")}`);
    for (const path of ["/login", "/invite/accept?token=x"]) {
      const r = await fetch(`${P}${path}`, { redirect: "manual" });
      const hp = headerProblems(Object.fromEntries(r.headers), { mode: "production" });
      check(`production public page ${path}: per-request nonce page, no-store, baseline headers`, r.status === 200 && hp.length === 0, `${r.status} ${hp.join("; ")}`);
    }
    check("production: no X-Powered-By (S1)", !(await fetch(`${P}/login`)).headers.has("x-powered-by"));

    // ================================================================ C
    section("C. CSP: detector works; the policy holds when ENFORCED");
    const xCtx = await watchedContext(browser, { inject: true });
    const xPage = await login(xCtx, P, patient.email);
    // Request interception slows <Link> prefetching enough that the network
    // rarely idles: wait for load, then let hydration settle.
    await xPage.goto(`${P}/patient/dashboard?__xss=1`, { waitUntil: "load" });
    await sleep(2000);
    check("the stand-in XSS really is in the delivered document", await xPage.evaluate(() => document.documentElement.outerHTML.includes("window.__injected = 1")));
    const roV = await violations(xPage);
    check("Report-Only: an injected (non-nonced) inline script is REPORTED (script-src)", roV.some((v) => v.directive.startsWith("script-src") && v.disposition === "report"), JSON.stringify(roV));
    check("Report-Only: ...and NOT blocked (the policy is not enforced yet)", (await xPage.evaluate(() => window.__injected)) === 1);
    check("Report-Only: the injected script is the ONLY violation on the page", roV.length === 1, JSON.stringify(roV));
    await xCtx.close();

    const eCtx = await watchedContext(browser, { enforce: true, inject: true });
    const ePage = await login(eCtx, P, clinician.email);
    const enforcedPaths = ["/clinician/dashboard", `/clinician/patients/${patient.userId}`, `/clinician/patients/${patient.userId}/safety`, "/clinician/notifications"];
    for (const path of enforcedPaths) {
      const res = await ePage.goto(`${P}${path}`, { waitUntil: "load" });
      await sleep(2000);
      const enforcedHeader = (await res.allHeaders())["content-security-policy"];
      const v = await violations(ePage);
      check(`ENFORCED ${path.replace(patient.userId, ":patient")}: renders, hydrates, zero violations`, res.status() === 200 && !!enforcedHeader && (await hydrated(ePage)) && v.length === 0, `${res.status()} enforced=${!!enforcedHeader} ${JSON.stringify(v).slice(0, 300)}`);
    }
    const loginV = await violations(ePage);
    check("ENFORCED: Server Action login + redirect completed under the enforced policy", loginV.length === 0);
    await ePage.goto(`${P}/clinician/dashboard?__xss=1`, { waitUntil: "load" });
    await sleep(2000);
    const eV = await violations(ePage);
    check("ENFORCED: an injected (non-nonced) inline script is BLOCKED and reported", (await ePage.evaluate(() => window.__injected)) === undefined && eV.length === 1 && eV[0].disposition === "enforce", JSON.stringify(eV));
    check("ENFORCED: the page still hydrates around the blocked injection", await hydrated(ePage));
    const pE = await watchedContext(browser, { enforce: true });
    const pEPage = await login(pE, P, patient.email);
    for (const path of ["/patient/dashboard", "/patient/progress", "/patient/settings"]) {
      const res = await pEPage.goto(`${P}${path}`, { waitUntil: "load" });
      await sleep(2000);
      const v = await violations(pEPage);
      check(`ENFORCED patient ${path}: renders, hydrates, zero violations`, res.status() === 200 && (await hydrated(pEPage)) && v.length === 0, JSON.stringify(v).slice(0, 300));
    }
    await eCtx.close();
    await pE.close();
    const consoleNoise = [...pCtx.__console, ...cCtx.__console, ...sCtx.__console].filter((m) => !m.includes("window.__injected"));
    check("no CSP / Permissions-Policy console complaints on production pages (unrecognized features etc.)", consoleNoise.filter((m) => !/inline script/i.test(m)).length === 0, consoleNoise.slice(0, 5).join(" | "));

    // ================================================================ D
    section("D. Referrer-Policy: invitation tokens never leave the origin");
    const token = `tok_${randomUUID().replace(/-/g, "")}`;
    const rCtx = await browser.newContext();
    const rPage = await rCtx.newPage();
    const inviteRes = await rPage.goto(`${P}/invite/accept?token=${token}`);
    check("invitation page served with Referrer-Policy: no-referrer", inviteRes.headers()["referrer-policy"] === "no-referrer");
    externalHits.length = 0;
    await rPage.evaluate((u) => { location.href = u; }, `${EXT}/landing`);
    await rPage.waitForURL(`${EXT}/landing`);
    const hit = externalHits.find((h) => h.path === "/landing");
    check("navigation from the token URL to another origin sends NO Referer", hit && hit.referer === null, JSON.stringify(hit));
    await rPage.goto(`${P}/invite/accept?token=${token}`);
    await rPage.evaluate(() => {
      const a = document.createElement("a");
      a.href = "http://127.0.0.1:3184/clicked";
      document.body.appendChild(a);
      a.click();
    });
    await rPage.waitForURL(`${EXT}/clicked`);
    const clicked = externalHits.find((h) => h.path === "/clicked");
    check("link click from the token URL to another origin sends NO Referer", clicked && clicked.referer === null, JSON.stringify(clicked));
    await rPage.goto(`${P}/invite/accept?token=${token}`);
    const sameReq = rPage.waitForRequest((r) => r.url() === `${P}/login`);
    await rPage.evaluate(() => { location.href = "/login"; });
    const sentReferer = (await (await sameReq).allHeaders()).referer;
    check("same-origin navigation from the token URL sends NO Referer either", sentReferer === undefined, sentReferer);
    await rPage.waitForURL(`${P}/login`);
    await rPage.goto(`${P}/invite/accept?token=${token}`);
    const subReq = rPage.waitForRequest((r) => r.url() === `${P}/api/patient/c5/state`);
    await rPage.evaluate(() => { fetch("/api/patient/c5/state").catch(() => {}); });
    const subReferer = (await (await subReq).allHeaders()).referer;
    check("same-origin fetch from the token URL sends NO Referer", subReferer === undefined, subReferer);
    await rCtx.close();

    // ================================================================ E
    section("E. Cross-origin mutation boundary");
    const before = await patientState(patient.userId);
    const hostile = [
      ["foreign Origin + cross-site", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
      ["foreign Origin only (older browser)", { origin: "https://evil.example" }],
      ["Sec-Fetch-Site cross-site only", { "sec-fetch-site": "cross-site" }],
      ["Sec-Fetch-Site same-site (sibling subdomain)", { origin: P, "sec-fetch-site": "same-site" }],
      ["opaque Origin null", { origin: "null" }],
      ["malformed Origin (path)", { origin: `${P}/x` }],
      ["two Origins", { origin: `${P}, https://evil.example` }],
      ["unknown Sec-Fetch-Site", { origin: P, "sec-fetch-site": "bogus" }],
      ["port-mismatched Origin", { origin: "http://localhost:3999", "sec-fetch-site": "same-site" }],
      ["matching Origin but cross-site fetch metadata", { origin: P, "sec-fetch-site": "cross-site" }],
    ];
    for (const [label, headers] of hostile) {
      const r = await call(pCtx, P, "PATCH", "/api/patient/reminder-time", { data: { morningReminderTime: "08:15" }, headers });
      check(`refused (403, before the handler) with a valid patient session: ${label}`, r.status === 403 && r.body?.error === "CROSS_ORIGIN_REQUEST_REFUSED" && headerProblems(r.headers, { mode: "production" }).length === 0, `${r.status} ${JSON.stringify(r.body)}`);
    }
    const crossMethods = [
      [pCtx, "POST", "/api/patient/c5/start", {}],
      [pCtx, "POST", "/api/patient/timezone", { timezone: "Europe/London" }],
      [pCtx, "POST", `/api/patient/c5/session/${randomUUID()}/stop`, {}],
      [pCtx, "POST", "/api/patient/acute-safety/reassessment", {}],
      [cCtx, "POST", `/api/clinician/patients/${patient.userId}/prescription/pause`, {}],
      [cCtx, "POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, {}],
      [cCtx, "PATCH", `/api/clinician/prescription-drafts/${randomUUID()}`, {}],
      [cCtx, "DELETE", `/api/clinician/prescription-drafts/${randomUUID()}`, undefined],
      [cCtx, "PUT", `/api/clinician/prescription-exercises/${randomUUID()}/dosage`, {}],
      [cCtx, "POST", `/api/clinician/library/exercises/${randomUUID()}/favorite`, {}],
      [cCtx, "POST", `/api/clinician/patients/${patient.userId}/acute-safety/${randomUUID()}/release`, {}],
    ];
    let crossRefused = 0;
    for (const [ctx, method, path, data] of crossMethods) {
      const r = await call(ctx, P, method, path, { data, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
      if (r.status === 403 && r.body?.error === "CROSS_ORIGIN_REQUEST_REFUSED") crossRefused++;
      else console.log(`      not refused: ${method} ${path} -> ${r.status}`);
    }
    check(`every audited patient / clinician mutation route refuses a cross-origin call (${crossMethods.length} routes, POST/PATCH/PUT/DELETE)`, crossRefused === crossMethods.length);
    const saForged = await call(sCtx, P, "POST", "/admin/assignments", { data: "[]", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "next-action": "0".repeat(42), "content-type": "text/plain;charset=UTF-8" } });
    check("cross-origin Server Action (next-action) refused by the boundary (403)", saForged.status === 403, String(saForged.status));
    check("nothing the refused requests targeted changed (profile, sessions, drafts)", (await patientState(patient.userId)) === before, `${before} -> ${await patientState(patient.userId)}`);

    // Real browser, real cross-site page.
    const evilPage = await pCtx.newPage();
    const evilResponse = evilPage.waitForResponse((r) => r.url() === `${P}/api/patient/reminder-time`, { timeout: 20000 });
    await evilPage.goto(`${EXT}/evil-form?target=${encodeURIComponent(`${P}/api/patient/reminder-time`)}`);
    const er = await evilResponse;
    const sent = await er.request().allHeaders();
    check("real browser cross-site form POST: browser sent Origin + Sec-Fetch-Site cross-site", sent.origin === EXT && sent["sec-fetch-site"] === "cross-site", JSON.stringify({ origin: sent.origin, sfs: sent["sec-fetch-site"] }));
    check("real browser cross-site form POST: refused by the boundary (403), not merely unauthenticated", er.status() === 403, String(er.status()));
    await evilPage.close();
    check("cross-site form changed nothing", (await patientState(patient.userId)) === before);

    // Same-origin browser mutations work.
    await pPage.goto(`${P}/patient/settings`, { waitUntil: "networkidle" });
    const sameReqP = pPage.waitForRequest((r) => r.url() === `${P}/api/patient/reminder-time` && r.method() === "PATCH");
    const same = await pPage.evaluate(async () => {
      const r = await fetch("/api/patient/reminder-time", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ morningReminderTime: "07:30" }) });
      return { status: r.status, cache: r.headers.get("cache-control") };
    });
    const sameSent = await (await sameReqP).allHeaders();
    check("real browser same-origin fetch PATCH under no-referrer: browser still sent its own Origin + same-origin, and no Referer", sameSent.origin === P && sameSent["sec-fetch-site"] === "same-origin" && sameSent.referer === undefined, JSON.stringify({ origin: sameSent.origin, sfs: sameSent["sec-fetch-site"], referer: sameSent.referer }));
    const { data: prof } = await admin.from("profiles").select("morning_reminder_time").eq("id", patient.userId).single();
    check("real browser same-origin mutation allowed and applied (07:30), response no-store", same.status === 200 && String(prof.morning_reminder_time).startsWith("07:30") && same.cache === "private, no-store, max-age=0", JSON.stringify({ same, prof }));
    const raw = await call(pCtx, P, "PATCH", "/api/patient/reminder-time", { data: { morningReminderTime: "07:00" } });
    check("non-browser caller (no Origin, no Sec-Fetch-Site) continues to the route's own auth (200 with session)", raw.status === 200);
    const rawAnon = await fetch(`${P}/api/patient/reminder-time`, { method: "PATCH", body: "{}" });
    check("non-browser caller without a session: route auth still refuses (401)", rawAnon.status === 401);
    const sameSiteOk = await call(pCtx, P, "PATCH", "/api/patient/reminder-time", { data: { morningReminderTime: "07:00" }, headers: { "sec-fetch-site": "same-origin", origin: P } });
    check("explicit same-origin metadata allowed through (200)", sameSiteOk.status === 200);

    // Server Actions under no-referrer: the hydrated client submits them with
    // fetch, which keeps the real Origin (Fetch: CORS-mode requests always
    // carry it), so both this boundary and Next's own action check pass.
    const saCtx = await browser.newContext();
    const saPage = await saCtx.newPage();
    await saPage.goto(`${P}/login`, { waitUntil: "networkidle" });
    check("login page hydrated before the Server Action submit", await hydrated(saPage));
    await saPage.fill("#email", patient.email);
    await saPage.fill("#password", PASSWORD);
    const saReq = saPage.waitForRequest((r) => r.method() === "POST" && r.url().startsWith(`${P}/login`));
    await saPage.click('button[type="submit"]');
    const saSent = await (await saReq).allHeaders();
    await saPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
    check("real browser Server Action (login) under no-referrer: next-action fetch sent its own Origin + same-origin, no Referer", saSent.origin === P && saSent["sec-fetch-site"] === "same-origin" && saSent.referer === undefined && !!saSent["next-action"], JSON.stringify({ origin: saSent.origin, sfs: saSent["sec-fetch-site"], referer: saSent.referer, action: !!saSent["next-action"] }));
    check("real browser Server Action (login) succeeded: signed in and left /login", !new URL(saPage.url()).pathname.startsWith("/login"), saPage.url());
    await saCtx.close();

    // Known no-referrer consequence: a NATIVE form navigation (JavaScript
    // disabled) is sent with Origin: null. Next's own Server Action check
    // refuses "null" as well, so this boundary refusing it first changes
    // nothing: it fails closed, before any handler, and signs nobody in.
    const njCtx = await browser.newContext({ javaScriptEnabled: false });
    const njPage = await njCtx.newPage();
    await njPage.goto(`${P}/login`);
    await njPage.fill("#email", patient.email);
    await njPage.fill("#password", PASSWORD);
    const njResP = njPage.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(`${P}/login`));
    await njPage.click('button[type="submit"]');
    const njRes = await njResP;
    const njSent = await njRes.request().allHeaders();
    check("no-JS native form POST under no-referrer: browser sent Origin null + same-origin, no Referer", njSent.origin === "null" && njSent["sec-fetch-site"] === "same-origin" && njSent.referer === undefined, JSON.stringify({ origin: njSent.origin, sfs: njSent["sec-fetch-site"], referer: njSent.referer }));
    const njCookies = (await njCtx.cookies()).filter((c) => c.name.startsWith("sb-"));
    check("no-JS native form POST: refused before any handler (403), no session created", njRes.status() === 403 && njCookies.length === 0, `${njRes.status()} cookies=${njCookies.length}`);
    await njCtx.close();

    // ================================================================ F
    section("F. Internal safety dispatcher");
    const wrongProd = await fetch(`${P}${DISPATCH}`, { method: "POST", headers: { authorization: "Bearer wrong-secret-wrong-secret-wrong-secret!" } });
    check("production: server-to-server dispatch call passes the boundary and reaches its own secret check (401 on a wrong secret)", wrongProd.status === 401 && (await wrongProd.json()).error === "UNAUTHORIZED");
    const crossProd = await fetch(`${P}${DISPATCH}`, { method: "POST", headers: { authorization: "Bearer wrong", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    check("production: a browser-shaped cross-origin dispatch call is refused (403)", crossProd.status === 403);
    await stopServer(prod);

    // ================================================================ G
    section("G. Development mode (production build): no HSTS, no eval; dispatcher with its secret");
    const dev = await startServer(PORTS.dev, DEV_ENV);
    const devLogin = await fetch(`${D}/login`);
    const dh = Object.fromEntries(devLogin.headers);
    check("development: baseline headers + no-store + Report-Only, HSTS absent (local http never pinned)", headerProblems(dh, { mode: "development" }).length === 0, headerProblems(dh, { mode: "development" }).join("; "));
    check("development mode on a production build: no unsafe-eval (that is `next dev` only)", cspProblems(dh["content-security-policy-report-only"]).length === 0, cspProblems(dh["content-security-policy-report-only"]).join("; "));
    const ok = await fetch(`${D}${DISPATCH}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });
    const okBody = await ok.json();
    check("dispatch with the correct secret (no Origin) reaches the dispatcher: provider disabled -> 503, nothing claimed", ok.status === 503 && okBody.error === "SAFETY_EMAIL_DISABLED", `${ok.status} ${JSON.stringify(okBody)}`);
    check("dispatch response: no-store + baseline headers", headerProblems(Object.fromEntries(ok.headers), { mode: "development" }).length === 0);
    const bad = await fetch(`${D}${DISPATCH}`, { method: "POST", headers: { authorization: "Bearer not-the-secret-not-the-secret-not-the" } });
    check("dispatch with a wrong secret: 401 (authentication unchanged)", bad.status === 401);
    const browserShaped = await fetch(`${D}${DISPATCH}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    check("dispatch with the correct secret but browser-shaped cross-origin metadata: refused (403)", browserShaped.status === 403);
    check("the preserved development L5 outbox row and all attempts are byte-for-byte unchanged", (await l5Outbox()) === l5Before);
    await stopServer(dev);

    // ================================================================ G2
    section("G. Production legacy refusal and maintenance behaviour intact");
    const prod2 = await startServer(PORTS.prod, { ...PROD_ENV, TENOTRAINER_MODE: "production" });
    for (const [m, path] of LEGACY_ROUTES) {
      const r = await fetch(`${P}${path}`, { method: m, body: m === "GET" ? undefined : "{}", redirect: "manual" });
      check(`production legacy ${m} ${path.replace(/[0-9a-f-]{36}/, ":id")}: 410 with headers`, r.status === 410 && headerProblems(Object.fromEntries(r.headers), { mode: "production" }).length === 0, String(r.status));
    }
    const devOnly = await fetch(`${P}/admin/invitations`, { redirect: "manual" });
    check("production development-only page: 404 with headers", devOnly.status === 404 && headerProblems(Object.fromEntries(devOnly.headers), { mode: "production" }).length === 0);
    await stopServer(prod2);

    const maint = await startServer(PORTS.maintenance, { ...PROD_ENV, TENOTRAINER_MODE: "maintenance" });
    check("maintenance server started and logged its mode", maint.log.includes("TenoTrainer operating mode: maintenance"));
    const mpCtx = await watchedContext(browser);
    const mpPage = await login(mpCtx, M, patient.email);
    const mres = await mpPage.goto(`${M}/patient/dashboard`, { waitUntil: "networkidle" });
    const mh = mres.headers();
    check("maintenance patient page: unavailable experience (rewrite), 200", mres.status() === 200 && /unavailable|maintenance/i.test(await mpPage.textContent("body")), String(mres.status()));
    check("maintenance patient page: no-store + headers + HSTS + Report-Only", headerProblems(mh, { mode: "maintenance" }).length === 0, headerProblems(mh, { mode: "maintenance" }).join("; "));
    const mScripts = await mpPage.evaluate(() => [...document.scripts].map((s) => s.nonce));
    check("maintenance rewrite renders with this response's nonce, zero violations", mScripts.length > 0 && mScripts.every((n) => n === nonceOf(mh["content-security-policy-report-only"])) && (await violations(mpPage)).length === 0);
    const mApi = await call(mpCtx, M, "GET", "/api/patient/c5/state");
    check("maintenance patient API read: 503 MAINTENANCE with no-store + headers", mApi.status === 503 && mApi.body?.error === "MAINTENANCE" && headerProblems(mApi.headers, { mode: "maintenance" }).length === 0, String(mApi.status));
    const mcCtx = await watchedContext(browser);
    const mcPage = await login(mcCtx, M, clinician.email);
    const mcRes = await mcPage.goto(`${M}/clinician/dashboard`, { waitUntil: "networkidle" });
    check("maintenance clinician read: 200, no-store, zero violations", mcRes.status() === 200 && headerProblems(mcRes.headers(), { mode: "maintenance" }).length === 0 && (await violations(mcPage)).length === 0);
    const mMut = await call(mcCtx, M, "POST", `/api/clinician/patients/${patient.userId}/prescription/pause`, { data: {}, headers: { origin: M, "sec-fetch-site": "same-origin" } });
    check("maintenance same-origin clinician mutation: still refused 503 MAINTENANCE", mMut.status === 503 && mMut.body?.error === "MAINTENANCE", String(mMut.status));
    const mDispatch = await fetch(`${M}${DISPATCH}`, { method: "POST", headers: { authorization: "Bearer wrong-secret-wrong-secret-wrong-secret!" } });
    check("maintenance: the dispatch operational exception still reaches its own auth (401)", mDispatch.status === 401);
    const mDispatchCross = await fetch(`${M}${DISPATCH}`, { method: "POST", headers: { authorization: "Bearer wrong", origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    check("maintenance: browser-shaped cross-origin dispatch refused (403)", mDispatchCross.status === 403);
    await mpCtx.close();
    await mcCtx.close();
    await stopServer(maint);
    check("the preserved development L5 is still unchanged at the end", (await l5Outbox()) === l5Before);
  } finally {
    await browser.close().catch(() => {});
    for (const s of started) await stopServer(s);
    if (externalServer) await new Promise((r) => externalServer.close(r));
    const clean = await teardown();
    check("teardown: exact-id fixtures removed, zero residue", clean);
    const still = [];
    for (const port of Object.values(PORTS)) if (await listening(port)) still.push(port);
    check("no server this suite started is still listening", still.length === 0, still.join(","));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  for (const s of started) await stopServer(s);
  if (externalServer) externalServer.close();
  await teardown().catch(() => {});
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
