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
const PREVIEW_ENV = {
  VERCEL: "1", VERCEL_ENV: "preview", TENOTRAINER_MODE: "development", TENOTRAINER_APP_ORIGIN: ORIGIN,
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
  const { ceId } = run.setup({ orgName: `M3.4a Preview ${RUN}`, members: [["fixture", clin.id, "clinician"], ["fixture", pat.id, "member"]], assignments: [["fixture", clin.id, pat.id]], names: { [pat.id]: "Preview Patient", [clin.id]: "Preview Clinician" } });
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
  const inv = guardedSql(env, `SELECT status, (email_sent_at IS NOT NULL) AS sent FROM invitations WHERE invited_by = ${q(clin.id)}`);
  check("invitation row pending with no email_sent_at", inv.length === 1 && inv[0].status === "pending" && inv[0].sent === false, JSON.stringify(inv));
  await c.ctx.close();
  check("ZERO FastAPI contact across patient, clinician and invitation flows", fastapiHits.length === 0, fastapiHits.join(", "));
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
