// M3.4a / M3.4g — production-mode CSP verification harness. Against a REAL isolated
// production server (isolated test profile, development project) reached
// at its real canonical origin through the TLS gateway, with exact-id
// fixtures (clinician, patient with a published program, a pending patient
// invitation):
//
//   The served header must be exactly lib/securityHeaders.ts CSP_HEADER.
//   While that is Report-Only: pass "report-only" (as served) + pass
//   "enforced" (rehearsal — the browser rewrites only the header NAME of
//   each document response to Content-Security-Policy). Once enforced: one
//   pass, "enforced", with the policy exactly as served. The interactive
//   workflows run once, in the last (enforced) pass:
//     - S4 recovery: reset request (malformed address: refused before any
//       Supabase call, no email), unknown / valid recovery links (the valid
//       token from auth.admin.generateLink — nothing is sent), the
//       password page with a policy-refused submission (no password is
//       changed, so no "password changed" email);
//     - patient: Begin → record a set → Finish → immediate check-in →
//       morning check-in (made due by its persisted timestamp);
//     - acute safety: a real episode (FixtureRun.safetyFlow "l3"), the
//       reassessment answered and submitted;
//     - clinician: patient detail / progress / sessions / session / safety /
//       prescription / version pages, and the prescription builder with a
//       real pointer drag-and-drop (dnd-kit), persisted and re-rendered;
//     - the application's global-error component (build artifact); Next's
//       built-in 500 document is reported as an observation.
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
import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { FixtureRun, FIXTURE_PASSWORD, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { launchCanonicalBrowser, startCanonicalGateway } from "./lib/canonicalGateway.mjs";
import { IsolatedServers, listening, productionProfile } from "./lib/isolatedServers.mjs";
import { CSP_HEADER } from "../lib/securityHeaders.ts";

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
    console.error(`[csp-violation] ${JSON.stringify({ directive: e.effectiveDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, disposition: e.disposition })}`);
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

// A whole-page watcher for multi-step flows (survives navigations): CSP
// violations (events forwarded by CAPTURE + the browser's own console
// reports), page errors, and requests to another origin.
function watch(page) {
  const w = { csp: [], errors: [], foreign: [] };
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[csp-violation] ")) { const v = JSON.parse(t.slice(16)); if (!NOISE(v)) w.csp.push(v); } else if (/Content[- ]Security[- ]Policy|Refused to (load|execute|apply|connect)/i.test(t) && !/extension/.test(t)) w.csp.push({ console: t.slice(0, 300) });
  });
  page.on("pageerror", (e) => w.errors.push(String(e?.message ?? e).slice(0, 300)));
  page.on("request", (r) => { const u = r.url(); if (!u.startsWith(ORIGIN) && !/^(data|blob|about):/.test(u)) w.foreign.push(u.slice(0, 200)); });
  return w;
}
function flowCheck(w, where) {
  check(`${where}: zero CSP violations, no page errors, no request to another origin`, w.csp.length === 0 && w.errors.length === 0 && w.foreign.length === 0, JSON.stringify(w).slice(0, 600));
  if (w.csp.length) findings.push({ pass: where, violations: w.csp });
}
async function hydrated(page) {
  return page.evaluate(() => Object.keys(document).some((k) => k.startsWith("__reactContainer$")));
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

// ------------------------------------------------------------ workflows (last pass only)
async function s4Flows(passLabel, enforced) {
  const ctx = await newContext(browser, enforced);
  const page = await ctx.newPage();
  const w = watch(page);
  // Reset request with a malformed address: refused before any Supabase call (no email).
  await page.goto(`${ORIGIN}/login/forgot`, { timeout: 120000 });
  await page.fill("#email", "not-an-email");
  await page.locator("form").first().evaluate((f) => { f.noValidate = true; });
  await page.getByTestId("request-recovery").click();
  await page.getByTestId("recovery-requested").waitFor({ timeout: 60000 });
  check(`[${passLabel}] S4 reset request (Server Action) completes → generic confirmation`, page.url().endsWith("/login/forgot?sent=1"), page.url());
  // Unknown recovery token: the confirm button posts, the neutral problem page renders.
  await page.goto(`${ORIGIN}/auth/confirm?token_hash=${"cd".repeat(28)}&type=recovery`, { timeout: 120000 });
  await page.getByTestId("confirm-recovery").click();
  await page.waitForURL((u) => u.searchParams.get("error") === "invalid", { timeout: 60000 });
  check(`[${passLabel}] S4 unknown recovery link → POST verify → neutral invalid page`, new URL(page.url()).pathname === "/auth/confirm", page.url());
  // Signed out, the password page redirects to login.
  await page.goto(`${ORIGIN}/account/password`, { timeout: 120000 });
  check(`[${passLabel}] S4 /account/password while signed out → login`, new URL(page.url()).pathname === "/login", page.url());
  // A valid recovery token (generateLink: created, never sent).
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email: recoverUser.email });
  if (error) throw error;
  await page.goto(`${ORIGIN}/auth/confirm?token_hash=${data.properties.hashed_token}&type=recovery`, { timeout: 120000 });
  check(`[${passLabel}] S4 recovery link GET renders only the confirmation button (hydrated)`, (await page.getByTestId("confirm-recovery").count()) === 1 && (await hydrated(page)));
  await page.getByTestId("confirm-recovery").click();
  await page.waitForURL((u) => u.pathname === "/account/password" || u.searchParams.has("error"), { timeout: 60000 });
  check(`[${passLabel}] S4 valid recovery link → /account/password?recovery=1`, new URL(page.url()).pathname === "/account/password" && new URL(page.url()).searchParams.get("recovery") === "1", page.url());
  // A policy-refused submission (too short): exercises the Server Action; no password changes.
  await page.fill("#password", "short");
  await page.fill("#confirm_password", "short");
  await page.locator("form").first().evaluate((f) => { f.noValidate = true; });
  await page.getByTestId("save-password").click();
  await page.waitForURL((u) => u.searchParams.has("error") || u.searchParams.has("updated"), { timeout: 60000 });
  check(`[${passLabel}] S4 password form (Server Action) → policy refusal shown; nothing changed`, new URL(page.url()).searchParams.get("error") === "too_short", page.url());
  flowCheck(w, `[${passLabel}] S4 recovery flows`);
  await ctx.close();
}

async function patientWorkflow(page, passLabel) {
  const w = watch(page);
  await page.goto(`${ORIGIN}/patient/session`, { timeout: 120000 });
  await page.locator("[data-c5-begin]").click();
  await page.getByRole("button", { name: "Done" }).first().click();
  const started = await waitFor(async () => (await admin.from("rehab_sessions").select("id, training_status").eq("user_id", pat.id)).data?.[0]?.training_status === "started");
  check(`[${passLabel}] patient: Begin + record a set (client fetch to the same origin) → session started`, started);
  await page.getByRole("button", { name: "Finish workout" }).click();
  await page.locator("[data-c5-closed]").waitFor({ timeout: 30000 });
  check(`[${passLabel}] patient: Finish workout → session closed`, (await page.locator("[data-c5-closed]").getAttribute("data-c5-closed")) === "finished");
  await page.getByRole("link", { name: "Continue to check-in" }).click();
  await page.waitForSelector("[data-c5-immediate-form]", { timeout: 30000 });
  await page.locator('[data-score-scale="peak-pain"] button').nth(2).click();
  await page.locator('[data-score-scale="rpe"] button').nth(5).click();
  for (const qn of ["sudden_or_sharp_pain", "pop_felt_or_heard", "new_functional_difficulty"]) {
    await page.locator(`[data-safety-question="${qn}"]`).getByRole("radio", { name: "No" }).click();
  }
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await page.locator("[data-c5-checkin-saved]").waitFor({ timeout: 30000 });
  check(`[${passLabel}] patient: immediate check-in submitted`, true);
  const session = (await admin.from("rehab_sessions").select("id").eq("user_id", pat.id)).data[0];
  patientSessionId = session.id;
  await admin.from("morning_responses").update({ scheduled_eligible_at: new Date(Date.now() - 60000).toISOString() }).eq("rehab_session_id", session.id);
  await page.goto(`${ORIGIN}/patient/dashboard`, { timeout: 120000 });
  await page.getByRole("link", { name: "Start check-in" }).click();
  await page.waitForSelector("[data-c5-morning-form]", { timeout: 30000 });
  await page.locator('[data-score-scale="morning-pain"] button').nth(1).click();
  await page.locator('[data-score-scale="morning-stiffness"] button').nth(0).click();
  await page.getByRole("button", { name: "Submit check-in" }).click();
  await page.locator("[data-c5-checkin-saved]").waitFor({ timeout: 30000 });
  const { data: mr } = await admin.from("morning_responses").select("resolution").eq("rehab_session_id", session.id).single();
  check(`[${passLabel}] patient: morning check-in submitted`, mr?.resolution === "answered", JSON.stringify(mr));
  flowCheck(w, `[${passLabel}] patient workflow (session → immediate check-in → morning check-in)`);
}

async function acuteWorkflow(page, passLabel) {
  const w = watch(page);
  await page.goto(`${ORIGIN}/patient/acute-safety`, { timeout: 120000 });
  // "l3" episode: sudden pain only. Conservative answers: the pain has NOT
  // resolved, NOT evaluated by a professional (the hold stays in place).
  const no = page.getByRole("button", { name: "No", exact: true });
  await no.nth(0).click();
  await no.nth(1).click();
  const cont = page.getByRole("button", { name: "Continue" });
  let submitted = false;
  if (await cont.isEnabled()) {
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/patient/acute-safety/reassessment"), { timeout: 30000 }), cont.click()]);
    submitted = resp.status() === 200;
  }
  const { data: rs } = await admin.from("acute_safety_reassessments").select("id").eq("acute_safety_episode_id", acuteFlow.episode_id);
  check(`[${passLabel}] acute safety: reassessment answered and submitted (same-origin fetch) — recorded`, submitted && (rs ?? []).length >= 1, `submitted=${submitted} rows=${(rs ?? []).length}`);
  flowCheck(w, `[${passLabel}] acute-safety workflow`);
}

async function clinicianWorkflow(page, passLabel) {
  const w = watch(page);
  if (patientSessionId) await visit(page, passLabel, "clinician session detail", `/clinician/patients/${pat.id}/sessions/${patientSessionId}`, { status: 200 });
  await page.goto(`${ORIGIN}/clinician/patients/${built.id}/prescription/builder`, { timeout: 120000 });
  await page.waitForSelector("text=Exercise Library", { timeout: 60000 });
  const cards = page.locator('[data-testid="library-panel"] [data-testid="exercise-card"]');
  const rows = page.locator('[data-testid="draft-exercise-row"]');
  for (const i of [0, 1]) {
    await cards.nth(i).getByRole("button", { name: "Add", exact: true }).click();
    await waitFor(async () => (await rows.count()) === i + 1 && (await page.locator('[data-testid="pending-add-indicator"]').count()) === 0, 10000);
  }
  const names = async () => { const n = []; for (let i = 0; i < (await rows.count()); i++) n.push((await rows.nth(i).locator('[data-testid="draft-exercise-name"]').innerText()).trim()); return n; };
  const before = await names();
  check(`[${passLabel}] builder: two exercises added from the library`, before.length === 2, JSON.stringify(before));
  // Pointer drag (dnd-kit PointerSensor): first row's handle onto the second
  // row — both measured in the viewport (events off-screen do nothing).
  await rows.nth(1).scrollIntoViewIfNeeded();
  await rows.nth(0).locator('[data-testid="drag-handle"]').scrollIntoViewIfNeeded();
  const from = await rows.nth(0).locator('[data-testid="drag-handle"]').boundingBox();
  const to = await rows.nth(1).boundingBox();
  const viewport = page.viewportSize();
  check(`[${passLabel}] builder: drag handle and drop target are both on screen`, !!from && !!to && from.y >= 0 && to.y + to.height <= viewport.height, JSON.stringify({ from, to, viewport }));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 15, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 10, { steps: 12 });
  await page.waitForTimeout(50);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 11, { steps: 2 });
  await page.mouse.up();
  const moved = await waitFor(async () => JSON.stringify(await names()) === JSON.stringify([before[1], before[0]]), 6000);
  check(`[${passLabel}] builder: pointer drag-and-drop reorders the draft`, moved, JSON.stringify(await names()));
  await page.waitForTimeout(1500); // the reorder save
  await page.reload();
  await page.waitForSelector("text=Exercise Library", { timeout: 60000 });
  check(`[${passLabel}] builder: the reorder persisted (server-rendered after reload)`, JSON.stringify(await names()) === JSON.stringify([before[1], before[0]]), JSON.stringify(await names()));
  check(`[${passLabel}] builder: server-rendered rows carry no style attribute (nothing for the policy to block)`,
    (await page.locator('[data-testid="draft-exercise-row"][style]').count()) === 0);
  check(`[${passLabel}] builder: rows are positioned by class (drag stacking works without inline styles)`,
    await rows.nth(0).evaluate((el) => getComputedStyle(el).position === "relative"));
  flowCheck(w, `[${passLabel}] clinician session detail + prescription builder drag-and-drop`);
}

async function waitFor(fn, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

let patientSessionId = null;
let recoverUser;
let pat;
let acute;
let built;
let acuteFlow;

const run = new FixtureRun(env, admin, `csp-${RUN}`);
const servers = new IsolatedServers();
let gateway;
let browser;
try {
  // ------------------------------------------------------------- fixtures
  const clin = await run.user("clin");
  pat = await run.user("patient");
  acute = await run.user("acute");
  built = await run.user("builder");
  recoverUser = pat;
  const { orgId, ceId } = run.setup({
    orgName: `M3.4a CSP ${RUN}`,
    members: [["fixture", clin.id, "clinician"], ["fixture", pat.id, "member"], ["fixture", acute.id, "member"], ["fixture", built.id, "member"]],
    assignments: [["fixture", clin.id, pat.id], ["fixture", clin.id, acute.id], ["fixture", clin.id, built.id]],
    names: { [pat.id]: "CSP Patient", [clin.id]: "CSP Clinician", [acute.id]: "CSP Acute", [built.id]: "CSP Builder" },
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
  const versionId = guardedSql(env, `SELECT current_prescription_version_id AS v FROM patient_prescriptions WHERE patient_id = ${q(pat.id)};`)[0].v;
  // M3.4g — an open acute episode through the real lifecycle functions.
  acuteFlow = run.safetyFlow(acute.id, clin.id, ceId, "l3");
  // M3.4g — an empty editing draft for the builder (the drag-and-drop surface).
  guardedSql(env, `
WITH pp AS (INSERT INTO patient_prescriptions (patient_id) VALUES (${q(built.id)}) RETURNING id)
INSERT INTO prescription_drafts (patient_prescription_id, status, source, created_by, editing_clinician_id, updated_by)
  SELECT id, 'editing', 'empty', ${q(clin.id)}, ${q(clin.id)}, ${q(clin.id)} FROM pp;
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
    const servedName = CSP_HEADER.toLowerCase();
    const otherName = servedName === "content-security-policy" ? "content-security-policy-report-only" : "content-security-policy";
    const policy = h[servedName] ?? "";
    check(`production serves the policy as ${CSP_HEADER} (lib/securityHeaders.ts CSP_HEADER), and only that header`, !!policy && !h[otherName]);
    const d = Object.fromEntries(policy.split(";").map((p) => p.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    check("script-src: 'self', a per-request nonce, 'strict-dynamic' — no unsafe-inline / unsafe-eval / hosts",
      d["script-src"]?.includes("'self'") && d["script-src"]?.some((x) => /^'nonce-/.test(x)) && d["script-src"]?.includes("'strict-dynamic'") && !d["script-src"]?.some((x) => /unsafe|\*|https?:/.test(x)), policy);
    check("style-src: 'self' + nonce only (no unsafe-inline in production)", d["style-src"]?.includes("'self'") && d["style-src"]?.some((x) => /^'nonce-/.test(x)) && !d["style-src"]?.some((x) => /unsafe|\*|https?:/.test(x)), policy);
    check("img/font/connect-src are 'self' only; frame-ancestors/object-src/base-uri locked", ["img-src", "font-src", "connect-src"].every((k) => d[k]?.join(" ") === "'self'") && d["frame-ancestors"]?.join() === "'none'" && d["object-src"]?.join() === "'none'" && d["base-uri"]?.join() === "'none'", policy);
    await ctx.close();
  }

  const PASSES = CSP_HEADER === "Content-Security-Policy" ? [["enforced", false]] : [["report-only", false], ["enforced", true]];
  for (const [passLabel, enforced] of PASSES) {
    const last = passLabel === PASSES[PASSES.length - 1][0];
    section(`pass: ${passLabel}${enforced ? " (rehearsal: header name rewritten)" : " (as served)"}`);
    const anon = await newContext(browser, enforced);
    const p0 = await anon.newPage();
    await visit(p0, passLabel, "login", "/login", { status: 200 });
    await visit(p0, passLabel, "invitation acceptance (pending fixture invitation)", `/invite/accept?token=${encodeURIComponent(inviteToken)}`, { status: 200 });
    await visit(p0, passLabel, "invitation acceptance (invalid token)", "/invite/accept?token=not-a-real-token", { status: 200 });
    await visit(p0, passLabel, "unknown path while signed out (redirected to login)", `/m34a-no-such-page-${RUN}`, { status: 200 });
    await visit(p0, passLabel, "development-only /setup (proxy 404)", "/setup", { status: 404, expect: "plain" });
    await visit(p0, passLabel, "S4 forgot password", "/login/forgot", { status: 200 });
    await visit(p0, passLabel, "S4 recovery link (well-formed, unknown token)", `/auth/confirm?token_hash=${"ab".repeat(28)}&type=recovery`, { status: 200 });
    await anon.close();
    if (last) await s4Flows(passLabel, enforced);

    const pctx = await newContext(browser, enforced);
    const pp = await pctx.newPage();
    await login(pp, pat.email, passLabel);
    await visit(pp, passLabel, "patient dashboard", "/patient/dashboard", { status: 200 });
    await visit(pp, passLabel, "patient session (rehab experience, workout preview)", "/patient/session", { status: 200 });
    await visit(pp, passLabel, "patient progress", "/patient/progress", { status: 200 });
    await visit(pp, passLabel, "patient settings", "/patient/settings", { status: 200 });
    await visit(pp, passLabel, "application not-found page (signed in)", `/m34a-no-such-page-${RUN}`, { status: 404 });
    await visit(pp, passLabel, "patient check-in (C5; nothing due yet)", "/patient/check-in", { status: 200 });
    await visit(pp, passLabel, "patient morning-response (C5 → check-in)", "/patient/morning-response", { status: 200 });
    await visit(pp, passLabel, "S4 change password (signed in)", "/account/password", { status: 200 });
    if (last) await patientWorkflow(pp, passLabel);
    await pctx.close();

    const actx = await newContext(browser, enforced);
    const ap = await actx.newPage();
    await login(ap, acute.email, passLabel);
    await visit(ap, passLabel, "acute patient dashboard (open episode)", "/patient/dashboard", { status: 200 });
    await visit(ap, passLabel, "patient acute-safety reassessment", "/patient/acute-safety", { status: 200 });
    if (last) await acuteWorkflow(ap, passLabel);
    await actx.close();

    const cctx = await newContext(browser, enforced);
    const cp = await cctx.newPage();
    await login(cp, clin.email, passLabel);
    await visit(cp, passLabel, "clinician dashboard", "/clinician/dashboard", { status: 200 });
    await visit(cp, passLabel, "clinician patient page", `/clinician/patients/${pat.id}`, { status: 200 });
    await visit(cp, passLabel, "clinician invitations", "/clinician/invitations", { status: 200 });
    await visit(cp, passLabel, "clinician notifications", "/clinician/notifications", { status: 200 });
    await visit(cp, passLabel, "clinician patient progress", `/clinician/patients/${pat.id}/progress`, { status: 200 });
    await visit(cp, passLabel, "clinician patient sessions", `/clinician/patients/${pat.id}/sessions`, { status: 200 });
    await visit(cp, passLabel, "clinician patient safety (open acute episode)", `/clinician/patients/${acute.id}/safety`, { status: 200 });
    await visit(cp, passLabel, "clinician patient review", `/clinician/patients/${acute.id}/review`);
    await visit(cp, passLabel, "clinician prescription", `/clinician/patients/${pat.id}/prescription`);
    await visit(cp, passLabel, "clinician prescription version", `/clinician/patients/${pat.id}/prescription/versions/${versionId}`, { status: 200 });
    if (last) await clinicianWorkflow(cp, passLabel);
    await cctx.close();
  }

  section("error pages (build artifacts)");
  {
    // The application's own global-error (per-request render, with the nonce).
    const chunks = readdirSync(".next/server/chunks/ssr").filter((f) => /^app_global-error_tsx_.*\.js$/.test(f));
    const src = chunks.map((f) => readFileSync(`.next/server/chunks/ssr/${f}`, "utf8")).join("\n");
    check("the application's own global-error component is built (replaces Next's inline-styled fallback)", chunks.length > 0 && src.includes("Something went wrong") && src.includes("Go to your dashboard"), chunks.join(","));
    // Next's separate built-in 500 document (prerendered, no nonce) is not
    // replaced by app/global-error: report it, do not hide it.
    const builtin = readFileSync(".next/server/app/_global-error.html", "utf8");
    const inline = (builtin.match(/\sstyle="/g) ?? []).length;
    console.log(`      OBSERVATION: Next's built-in 500 document (.next/server/app/_global-error.html) carries ${inline} inline style attribute(s); under the enforced policy it renders unstyled (text intact).`);
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
