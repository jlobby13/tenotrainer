// M3.4a — production-mode CSP verification harness (prepares M3.4g; the
// application header stays Report-Only). Against a REAL isolated
// production server (isolated test profile, development project) reached
// at its real canonical origin through the TLS gateway, with exact-id
// fixtures (clinician, patient with a published program, a pending patient
// invitation):
//
//   Pass 1 "report-only": the policy exactly as served
//          (Content-Security-Policy-Report-Only).
//   Pass 2 "enforced":    an enforcement rehearsal — the browser rewrites
//          only the header NAME of each document response to the enforcing
//          Content-Security-Policy (same policy value); the app is unchanged.
//
// On every surface: securitypolicyviolation events and CSP console reports
// (none allowed; browser-extension noise classified separately), page
// errors, any request to another origin, and positive proof that the
// required resources work: React hydrated (nonce'd inline flight scripts
// and strict-dynamic chunks ran), every stylesheet same-origin and applied,
// the self-hosted fonts loaded. In pass 2 the logins themselves (Server
// Action + client navigation) run under enforcement.
//
// Run from web/ (after `next build`):  TENOTRAINER_MODE=development node scripts/verifyM34aCspProduction.mjs
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { launchCanonicalBrowser, startCanonicalGateway } from "./lib/canonicalGateway.mjs";
import { IsolatedServers, listening, productionProfile } from "./lib/isolatedServers.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const RUN = randomUUID().slice(0, 8);
const PORTS = { prod: 3185, gateway: 3186 };
const HOST = "csp.tenotrainer.test";
const ORIGIN = `https://${HOST}`;

let pass = 0;
let fail = 0;
const findings = [];
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 500)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

const NOISE = (v) => /^(chrome|moz)-extension:/.test(v.sourceFile ?? "") || /^(chrome|moz)-extension/.test(v.blockedURI ?? "");

// Installed before any page script: records violations for this document.
const CAPTURE = () => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__csp.push({ directive: e.effectiveDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, line: e.lineNumber, disposition: e.disposition, sample: e.sample });
  });
};

async function newContext(browser, enforced) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(CAPTURE);
  if (enforced) {
    await ctx.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const resp = await route.fetch({ maxRedirects: 0 });
      const headers = { ...resp.headers() };
      const ro = headers["content-security-policy-report-only"];
      if (ro) {
        delete headers["content-security-policy-report-only"];
        headers["content-security-policy"] = ro;
      }
      return route.fulfill({ response: resp, headers });
    });
  }
  return ctx;
}

// Visit a surface and evaluate it. `expect` is "app" (hydrated React page)
// or "plain" (a non-React response such as the proxy's text 404).
async function visit(page, pass, label, path, { expect = "app", status } = {}) {
  const consoleCsp = [];
  const pageErrors = [];
  const foreign = [];
  const onConsole = (m) => { if (/Content[- ]Security[- ]Policy|Refused to (load|execute|apply|connect)/i.test(m.text())) consoleCsp.push(m.text().slice(0, 300)); };
  const onError = (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300));
  const onRequest = (r) => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob|about):/.test(u)) foreign.push(u.slice(0, 200)); };
  page.on("console", onConsole);
  page.on("pageerror", onError);
  page.on("request", onRequest);
  const resp = await page.goto(`${ORIGIN}${path}`, { timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const state = await page.evaluate(async () => {
    try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]); } catch { /* no fonts api */ }
    const sheets = [...document.styleSheets];
    return {
      violations: window.__csp ?? [],
      hydrated: Object.keys(document).some((k) => k.startsWith("__reactContainer$")),
      flight: Array.isArray(self.__next_f),
      nonceScripts: document.querySelectorAll("script[nonce]").length,
      inlineWithoutNonce: [...document.querySelectorAll("script:not([src])")].filter((s) => !s.nonce && !s.getAttribute("nonce") && s.type !== "application/json").length,
      sheets: sheets.length,
      foreignSheets: sheets.filter((s) => s.href && new URL(s.href).origin !== location.origin).length,
      rulesApplied: sheets.reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0),
      fontVar: getComputedStyle(document.documentElement).getPropertyValue("--font-geist-sans").trim(),
      fontsLoaded: [...(document.fonts ?? [])].filter((f) => f.status === "loaded").length,
      url: location.pathname,
    };
  });
  page.off("console", onConsole);
  page.off("pageerror", onError);
  page.off("request", onRequest);
  const real = state.violations.filter((v) => !NOISE(v));
  const noise = state.violations.length - real.length;
  const where = `[${pass}] ${label} (${path})`;
  if (status !== undefined) check(`${where}: HTTP ${status}`, resp?.status() === status, resp?.status());
  check(`${where}: zero CSP violations${noise ? ` (${noise} extension-noise ignored)` : ""}`, real.length === 0 && consoleCsp.length === 0, JSON.stringify(real.slice(0, 3)) + consoleCsp.slice(0, 2).join(" | "));
  if (real.length) findings.push({ pass, label, violations: real });
  check(`${where}: no page errors`, pageErrors.length === 0, pageErrors.join(" | "));
  check(`${where}: no request to another origin`, foreign.length === 0, foreign.join(" "));
  if (expect === "app") {
    check(`${where}: scripts ran under the policy (nonce'd flight data + React hydrated; no un-nonced inline script)`, state.hydrated && state.flight && state.nonceScripts > 0 && state.inlineWithoutNonce === 0, JSON.stringify(state));
    check(`${where}: styles applied from same-origin sheets; self-hosted font loaded`, state.sheets > 0 && state.foreignSheets === 0 && state.rulesApplied > 50 && state.fontVar !== "" && state.fontsLoaded > 0, JSON.stringify(state));
  }
  return state;
}

async function login(page, email, passLabel) {
  await page.goto(`${ORIGIN}/login`, { timeout: 120000 });
  await page.fill("#email", email);
  await page.fill("#password", FIXTURE_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const v = (await page.evaluate(() => window.__csp ?? [])).filter((x) => !NOISE_IN_PAGE(x));
  check(`[${passLabel}] login (Server Action + client navigation) succeeded with zero violations on arrival`, !new URL(page.url()).pathname.startsWith("/login") && v.length === 0, JSON.stringify(v.slice(0, 3)));
}
// Evaluated in the page: extension noise filter.
const NOISE_IN_PAGE = (v) => /^(chrome|moz)-extension/.test(v.sourceFile ?? "") || /^(chrome|moz)-extension/.test(v.blockedURI ?? "");

const run = new FixtureRun(env, admin, `csp-${RUN}`);
const servers = new IsolatedServers();
let gateway;
let browser;
try {
  // ------------------------------------------------------------- fixtures
  const clin = await run.user("clin");
  const pat = await run.user("patient");
  const { orgId, ceId } = run.setup({
    orgName: `M3.4a CSP ${RUN}`,
    members: [["fixture", clin.id, "clinician"], ["fixture", pat.id, "member"]],
    assignments: [["fixture", clin.id, pat.id]],
    names: { [pat.id]: "CSP Patient", [clin.id]: "CSP Clinician" },
  });
  guardedSql(env, `
DO $fx$
DECLARE v_pp UUID; v_v UUID; v_w UUID; v_e UUID;
BEGIN
  INSERT INTO patient_prescriptions (patient_id) VALUES (${q(pat.id)}) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (${q(pat.id)}, 'clinician_change', v_pp, 1, now() - interval '3 days', ${q(clin.id)}, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, ${q(ceId)}, 0, 'active') RETURNING id INTO v_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_e, 'repetition', 3, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;
END
$fx$;
SELECT 1 AS ok;`);
  const inviteToken = `m34a-csp-${randomUUID()}-${randomUUID()}`;
  guardedSql(env, `INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at)
    VALUES (${q(orgId)}, ${q(clin.id)}, 'm34a-csp-invitee-${RUN}@example.invalid', 'PATIENT', 'member', '${createHash("sha256").update(inviteToken, "utf8").digest("hex")}', now() + interval '7 days');
    SELECT 1 AS ok;`);

  // ------------------------------------------------------------- server + browser
  await servers.start(PORTS.prod, productionProfile(ORIGIN));
  gateway = await startCanonicalGateway({ port: PORTS.gateway, routes: { [HOST]: PORTS.prod } });
  browser = await launchCanonicalBrowser(gateway);

  section("served policy");
  {
    const ctx = await browser.newContext();
    const r = await ctx.request.get(`${ORIGIN}/login`);
    const h = r.headers();
    const policy = h["content-security-policy-report-only"] ?? "";
    check("production serves the policy as Report-Only (enforcement deferred to M3.4g)", !!policy && !h["content-security-policy"]);
    const d = Object.fromEntries(policy.split(";").map((p) => p.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    check("script-src: 'self', a per-request nonce, 'strict-dynamic' — no unsafe-inline / unsafe-eval / hosts",
      d["script-src"]?.includes("'self'") && d["script-src"]?.some((x) => /^'nonce-/.test(x)) && d["script-src"]?.includes("'strict-dynamic'") && !d["script-src"]?.some((x) => /unsafe|\*|https?:/.test(x)), policy);
    check("style-src: 'self' + nonce only (no unsafe-inline in production)", d["style-src"]?.includes("'self'") && d["style-src"]?.some((x) => /^'nonce-/.test(x)) && !d["style-src"]?.some((x) => /unsafe|\*|https?:/.test(x)), policy);
    check("img/font/connect-src are 'self' only; frame-ancestors/object-src/base-uri locked", ["img-src", "font-src", "connect-src"].every((k) => d[k]?.join(" ") === "'self'") && d["frame-ancestors"]?.join() === "'none'" && d["object-src"]?.join() === "'none'" && d["base-uri"]?.join() === "'none'", policy);
    await ctx.close();
  }

  for (const [passLabel, enforced] of [["report-only", false], ["enforced", true]]) {
    section(`pass: ${passLabel}`);
    const anon = await newContext(browser, enforced);
    const p0 = await anon.newPage();
    await visit(p0, passLabel, "login", "/login", { status: 200 });
    await visit(p0, passLabel, "invitation acceptance (pending fixture invitation)", `/invite/accept?token=${encodeURIComponent(inviteToken)}`, { status: 200 });
    await visit(p0, passLabel, "invitation acceptance (invalid token)", "/invite/accept?token=not-a-real-token", { status: 200 });
    await visit(p0, passLabel, "unknown path while signed out (redirected to login)", `/m34a-no-such-page-${RUN}`, { status: 200 });
    await visit(p0, passLabel, "development-only /setup (proxy 404)", "/setup", { status: 404, expect: "plain" });
    await anon.close();

    const pctx = await newContext(browser, enforced);
    const pp = await pctx.newPage();
    await login(pp, pat.email, passLabel);
    await visit(pp, passLabel, "patient dashboard", "/patient/dashboard", { status: 200 });
    await visit(pp, passLabel, "patient session (rehab experience, workout preview)", "/patient/session", { status: 200 });
    await visit(pp, passLabel, "patient progress", "/patient/progress", { status: 200 });
    await visit(pp, passLabel, "patient settings", "/patient/settings", { status: 200 });
    await visit(pp, passLabel, "application not-found page (signed in)", `/m34a-no-such-page-${RUN}`, { status: 404 });
    await pctx.close();

    const cctx = await newContext(browser, enforced);
    const cp = await cctx.newPage();
    await login(cp, clin.email, passLabel);
    await visit(cp, passLabel, "clinician dashboard", "/clinician/dashboard", { status: 200 });
    await visit(cp, passLabel, "clinician patient page", `/clinician/patients/${pat.id}`, { status: 200 });
    await visit(cp, passLabel, "clinician invitations", "/clinician/invitations", { status: 200 });
    await visit(cp, passLabel, "clinician notifications", "/clinician/notifications", { status: 200 });
    await cctx.close();
  }

  section("server");
  const s = servers.started[0];
  check("the production server logged no unexpected error", !/⨯|Unhandled|TypeError/.test(s.log), s.log.match(/.*(⨯|Unhandled|TypeError).*/)?.[0]);
} finally {
  await browser?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await servers.stopAll();
  section("teardown");
  try {
    const res = run.teardown();
    check("fixtures purged by exact id, zero residue (users, org, program, invitation, exercise)", !!res, JSON.stringify(res.residue));
    const inv = guardedSql(env, `SELECT count(*) AS n FROM invitations WHERE email = 'm34a-csp-invitee-${RUN}@example.invalid'`)[0];
    check("fixture invitation removed", Number(inv.n) === 0);
  } catch (e) {
    check("fixtures purged by exact id, zero residue", false, e.message);
  }
  for (const port of Object.values(PORTS)) check(`no listener left on :${port}`, !(await listening(port)));
}

if (findings.length) console.log(`\nCSP findings:\n${JSON.stringify(findings, null, 2)}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
