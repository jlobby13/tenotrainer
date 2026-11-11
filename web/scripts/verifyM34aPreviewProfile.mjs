// M3.4a — Vercel Preview readiness (no Vercel resource). A REAL isolated
// `next start` server configured exactly as M3.4b's Preview will be
// (founder C2): VERCEL=1, VERCEL_ENV=preview, NODE_ENV=production,
// TENOTRAINER_MODE=development, the development project, a stable https
// preview alias as TENOTRAINER_APP_ORIGIN (reached through the TLS gateway),
// C5_PATIENT_RUNTIME_ENABLED=true, email disabled, no BRIDGE_SECRET, no
// production credential. FASTAPI_URL points at a RECORDING listener on an
// isolated port: any FastAPI attempt is counted (on Vercel nothing listens).
//
//   A. Preview profile: starts; /api/ready ready; patient login, dashboard,
//      session, progress; clinician dashboard, patient page; invitation
//      created with email disabled and the link on the preview alias;
//      generated redirects stay on the alias; ZERO FastAPI contact.
//  A2. Staff logout (M3.4b): the shared staff bar's Log out on clinician,
//      admin and super pages (375px, 44px target, no overflow), session
//      ended, protected routes redirect; patient logout unchanged; /logout
//      without a session redirects to /login with no next.
//   B. Contrast: the same profile WITHOUT C5_PATIENT_RUNTIME_ENABLED selects
//      the legacy runtime and contacts FastAPI — why Preview must set it.
//
// Run from web/ (after `next build`):  TENOTRAINER_MODE=development node scripts/verifyM34aPreviewProfile.mjs
import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { launchCanonicalBrowser, startCanonicalGateway } from "./lib/canonicalGateway.mjs";
import { IsolatedServers, listening } from "./lib/isolatedServers.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const RUN = randomUUID().slice(0, 8);
const PORTS = { preview: 3187, gateway: 3188, fastapi: 3189 };
const HOST = "preview.tenotrainer.test";
const ORIGIN = `https://${HOST}`;
// Alpha 1 — the Preview-scope TENOTRAINER_APP_ORIGIN is shared by every branch's
// Preview, so it names ANOTHER branch's alias. Links must still use THIS
// Preview's own alias (VERCEL_BRANCH_URL = HOST); the stale host must never appear.
const STALE_ORIGIN = "https://stale-other-branch.tenotrainer.test";
const PREVIEW_ENV = {
  // Alpha 1 — on a Preview the link origin is the deployment's own branch alias (VERCEL_BRANCH_URL, a Vercel system variable).
  VERCEL: "1", VERCEL_ENV: "preview", VERCEL_BRANCH_URL: HOST, TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: STALE_ORIGIN,
  C5_PATIENT_RUNTIME_ENABLED: "true", C5_PRESCRIPTION_PUBLISH_ENABLED: "false", TENOTRAINER_EMAIL_PROVIDER: "disabled",
  BRIDGE_SECRET: "", FASTAPI_URL: `http://127.0.0.1:${PORTS.fastapi}`,
};

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

// The recording "FastAPI": answers 503 and counts every request.
const fastapiHits = [];
const fastapi = http.createServer((req, res) => { fastapiHits.push(`${req.method} ${req.url}`); res.writeHead(503); res.end(); });

async function login(browser, email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/login`, { timeout: 120000 });
  await page.fill("#email", email);
  await page.fill("#password", FIXTURE_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  return { ctx, page };
}

const run = new FixtureRun(env, admin, `prev-${RUN}`);
const servers = new IsolatedServers();
let gateway;
let browser;
try {
  if (await listening(PORTS.fastapi)) throw new Error(`port ${PORTS.fastapi} in use`);
  await new Promise((r) => fastapi.listen(PORTS.fastapi, "127.0.0.1", r));
  const clin = await run.user("clin");
  const pat = await run.user("patient");
  const adminUser = await run.user("cadmin");
  const superUser = await run.user("super");
  const { ceId } = run.setup({ orgName: `M3.4a Preview ${RUN}`, members: [["fixture", clin.id, "clinician"], ["fixture", pat.id, "member"], ["fixture", adminUser.id, "clinician_admin"], ["fixture", superUser.id, "super_user"]], assignments: [["fixture", clin.id, pat.id]], names: { [pat.id]: "Preview Patient", [clin.id]: "Preview Clinician" } });
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

  section("A. Preview profile (VERCEL_ENV=preview, development mode)");
  const srv = await servers.start(PORTS.preview, PREVIEW_ENV);
  check("the Preview configuration starts (development mode on a Vercel Preview)", /operating mode: development/.test(srv.log) && !/configuration (error|refused)/i.test(srv.log), srv.log.slice(-400));
  gateway = await startCanonicalGateway({ port: PORTS.gateway, routes: { [HOST]: PORTS.preview } });
  browser = await launchCanonicalBrowser(gateway);
  const anon = await browser.newContext();
  const ready = await anon.request.get(`${ORIGIN}/api/ready`, { maxRedirects: 0 });
  check("/api/ready → 200 ready (development project)", ready.status() === 200 && (await ready.text()) === '{"status":"ready"}');
  const red = await anon.request.get(`${ORIGIN}/patient/dashboard`, { maxRedirects: 0 });
  check("unauthenticated redirect stays on the preview alias", [302, 303, 307].includes(red.status()) && new URL(red.headers().location, ORIGIN).origin === ORIGIN, `${red.status()} ${red.headers().location}`);
  await anon.close();

  const p = await login(browser, pat.email);
  check("patient login works", new URL(p.page.url()).origin === ORIGIN);
  for (const [path, re] of [["/patient/dashboard", /Today|program|rehab/i], ["/patient/session", /workout|exercise|begin|start/i], ["/patient/progress", /progress/i]]) {
    const r = await p.page.goto(`${ORIGIN}${path}`, { timeout: 120000 });
    await p.page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    check(`patient ${path} → 200 (C5 runtime)`, r?.status() === 200 && re.test(await p.page.content()), r?.status());
  }
  await p.ctx.close();

  const c = await login(browser, clin.email);
  let r = await c.page.goto(`${ORIGIN}/clinician/dashboard`, { timeout: 120000 });
  check("clinician dashboard → 200, lists the assigned patient", r?.status() === 200 && (await c.page.content()).includes("Preview Patient"), r?.status());
  r = await c.page.goto(`${ORIGIN}/clinician/patients/${pat.id}`, { timeout: 120000 });
  check("clinician patient page → 200", r?.status() === 200, r?.status());
  const invitee = `m34a-preview-invitee-${RUN}@example.invalid`;
  await c.page.goto(`${ORIGIN}/clinician/invitations`, { timeout: 120000 });
  await c.page.getByTestId("invite-email").fill(invitee);
  await c.page.getByTestId("send-invitation").click();
  const box = c.page.getByTestId("invite-result").first();
  await box.waitFor({ timeout: 60000 });
  const text = await box.innerText();
  const link = (await c.page.getByTestId("invite-link").first().innerText().catch(() => "")).trim();
  check("invitation created; email NOT sent (disabled); one-time link on the preview alias", text.includes("could not be sent") && link.startsWith(`${ORIGIN}/invite/accept?token=`), text.slice(0, 120));
  check("Alpha 1: the link uses this Preview's own branch alias, never the shared (stale) TENOTRAINER_APP_ORIGIN", new URL(link).origin === ORIGIN && !text.includes("stale-other-branch"), link);
  const inv = guardedSql(env, `SELECT status, (email_sent_at IS NOT NULL) AS sent FROM invitations WHERE invited_by = ${q(clin.id)}`);
  check("invitation row pending with no email_sent_at", inv.length === 1 && inv[0].status === "pending" && inv[0].sent === false, JSON.stringify(inv));
  await c.ctx.close();
  check("ZERO FastAPI contact across patient, clinician and invitation flows", fastapiHits.length === 0, fastapiHits.join(", "));

  section("A2. staff logout (M3.4b)");
  // The shared staff bar's Log out: visible with a 44px target and no
  // horizontal overflow at 375px on every clinician page; it ends the
  // session (protected routes then redirect to /login).
  const narrow = { viewport: { width: 375, height: 812 } };
  const cl = await login(browser, clin.email);
  await cl.page.setViewportSize(narrow.viewport);
  for (const path of ["/clinician/dashboard", `/clinician/patients/${pat.id}`, "/clinician/invitations", "/clinician/notifications"]) {
    await cl.page.goto(`${ORIGIN}${path}`, { timeout: 120000 });
    const m = await cl.page.evaluate(() => {
      const a = document.querySelector('[data-testid="staff-logout-link"]');
      const bar = document.querySelector('[data-testid="staff-bar"]');
      const r = a?.getBoundingClientRect();
      return a && bar && r ? { href: a.getAttribute("href"), tag: a.tagName, h: r.height, left: r.left, right: r.right, vw: innerWidth, barOverflow: bar.scrollWidth > bar.clientWidth, safety: !!document.querySelector('[data-testid="safety-notifications-link"]') } : null;
    });
    check(`clinician ${path}: Log out (plain <a href="/logout">) visible at 375px, ≥44px, inside the viewport, bar not overflowing; Safety notifications kept`,
      m && m.tag === "A" && m.href === "/logout" && m.h >= 44 && m.left >= 0 && m.right <= m.vw && !m.barOverflow && m.safety, JSON.stringify(m));
  }
  await cl.page.goto(`${ORIGIN}/clinician/dashboard`, { timeout: 120000 });
  await cl.page.click('[data-testid="staff-logout-link"]');
  await cl.page.waitForURL((u) => u.pathname === "/login", { timeout: 60000 });
  // In development mode the logout route redirects to the request's own
  // origin; under a local `next start` a route handler's request.url carries
  // the server's bound address (localhost:<port>), not the Host header, so
  // only the path is asserted here. The hosted M3.4b check confirms the
  // Preview alias. Session termination is asserted strictly below.
  check("clicking Log out lands on /login", new URL(cl.page.url()).pathname === "/login", cl.page.url());
  console.log(`      (observed post-logout URL locally: ${new URL(cl.page.url()).origin}/login)`);
  const authCookies = (await cl.ctx.cookies(ORIGIN)).filter((c) => /^sb-.*-auth-token/.test(c.name) && c.value);
  check("the Supabase session cookies are cleared", authCookies.length === 0, authCookies.map((c) => c.name).join(","));
  const after = await cl.ctx.request.get(`${ORIGIN}/clinician/dashboard`, { maxRedirects: 0 });
  const afterLoc = new URL(after.headers().location ?? "x:", ORIGIN);
  check("after logout a protected clinician route redirects to /login", [302, 303, 307].includes(after.status()) && afterLoc.pathname === "/login", `${after.status()} ${after.headers().location}`);
  await cl.ctx.close();

  const ad = await login(browser, adminUser.email);
  await ad.page.setViewportSize(narrow.viewport);
  await ad.page.goto(`${ORIGIN}/admin/assignments`, { timeout: 120000 });
  check("clinician_admin on /admin/assignments: Log out available (shared staff bar)", await ad.page.locator('[data-testid="staff-logout-link"]').isVisible());
  await ad.ctx.close();
  // A super_user's home (/super/dashboard) calls the legacy FastAPI overview
  // in development mode (known; fails harmlessly on Vercel). Only that call
  // may appear while signing the super_user in.
  const hitsBeforeSuper = fastapiHits.length;
  const su = await login(browser, superUser.email);
  await su.page.goto(`${ORIGIN}/super/safety-notifications`, { timeout: 120000 });
  check("super_user on /super/safety-notifications: Log out available, no clinician Safety link", await su.page.locator('[data-testid="staff-logout-link"]').isVisible() && (await su.page.locator('[data-testid="safety-notifications-link"]').count()) === 0);
  await su.ctx.close();

  const pt = await login(browser, pat.email);
  await pt.page.goto(`${ORIGIN}/patient/dashboard`, { timeout: 120000 });
  await pt.page.getByRole("link", { name: "Log out" }).click();
  await pt.page.waitForURL((u) => u.pathname === "/login", { timeout: 60000 });
  const pAfter = await pt.ctx.request.get(`${ORIGIN}/patient/dashboard`, { maxRedirects: 0 });
  const pCookies = (await pt.ctx.cookies(ORIGIN)).filter((c) => /^sb-.*-auth-token/.test(c.name) && c.value);
  check("patient logout unchanged: dashboard Log out ends the session (cookies cleared, dashboard redirects to /login)", new URL(pt.page.url()).pathname === "/login" && pCookies.length === 0 && new URL(pAfter.headers().location ?? "x:", ORIGIN).pathname === "/login", `${pt.page.url()} ${pAfter.status()}`);
  await pt.ctx.close();

  const anonLo = await browser.newContext();
  const lo = await anonLo.request.get(`${ORIGIN}/logout`, { maxRedirects: 0 });
  const loUrl = new URL(lo.headers().location ?? "x:", ORIGIN);
  check("GET /logout without a session → the route's 307 to /login, no next=/logout", lo.status() === 307 && loUrl.pathname === "/login" && !loUrl.searchParams.has("next"), `${lo.status()} ${lo.headers().location}`);
  await anonLo.close();
  const superHits = fastapiHits.slice(hitsBeforeSuper);
  check("FastAPI contact only from the super_user's legacy home (/api/super/overview); none from logout, clinician, admin or patient flows",
    fastapiHits.slice(0, hitsBeforeSuper).length === 0 && superHits.every((h) => h === "GET /api/super/overview"), fastapiHits.join(", "));

  check("the Preview server logged no unexpected error", !/⨯|Unhandled|TypeError/.test(srv.log), srv.log.match(/.*(⨯|Unhandled|TypeError).*/)?.[0]);
  await servers.stop(srv);

  section("B. contrast: Preview WITHOUT C5_PATIENT_RUNTIME_ENABLED");
  const legacy = await servers.start(PORTS.preview, { ...PREVIEW_ENV, C5_PATIENT_RUNTIME_ENABLED: "" });
  const p2 = await login(browser, pat.email);
  await p2.page.goto(`${ORIGIN}/patient/dashboard`, { timeout: 120000 }).catch(() => {});
  check("the unset gate selects the legacy runtime, which contacts FastAPI — Preview must set C5_PATIENT_RUNTIME_ENABLED=true", fastapiHits.length > 0, `hits: ${fastapiHits.length}`);
  await p2.ctx.close();
  await servers.stop(legacy);
} catch (e) {
  check("preview profile suite ran without an unexpected error", false, e?.stack ?? String(e));
} finally {
  await browser?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  await servers.stopAll();
  await new Promise((r) => fastapi.close(() => r()));
  section("teardown");
  try {
    const res = run.teardown();
    check("fixtures purged by exact id, zero residue (users, org, program, invitation, exercise)", !!res, JSON.stringify(res.residue));
  } catch (e) {
    check("fixtures purged by exact id, zero residue", false, e.message);
  }
  for (const port of Object.values(PORTS)) check(`no listener left on :${port}`, !(await listening(port)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
