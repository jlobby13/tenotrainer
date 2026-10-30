// M3.1 — operating-mode suite. Proves, against REAL isolated `next start`
// servers that this script starts itself (own process groups; only those
// are ever stopped; never :3000 / :8000):
//
//   A. startup refusal: missing / invalid TENOTRAINER_MODE, bridge
//      configuration or a legacy-selecting runtime gate in production /
//      maintenance -> the process exits, nothing listens.
//   B. production (publication frozen): C5 is the patient runtime, legacy
//      pages / APIs / bridge routes retired, tester/admin invitation
//      surfaces gone, FastAPI not configured or reachable, publish refused.
//   C. maintenance: unavailable copy for patients, every patient API
//      refused (reads too), clinician reads work, every clinician mutation
//      API / server action refused, release + assignment + invitation
//      mutations refused, the clinical libraries refuse in-process, a
//      Started session and all rows are untouched.
//   D. production again: the same Started session resumes and finishes;
//      publication works when the gate is on.
//   E. development: legacy routes exist again (development only).
//
// Requires a production build of this worktree (`npx next build`).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM3OperatingModes.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";

const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const DEAD_FASTAPI = "http://127.0.0.1:59999";
const RUN = randomUUID().slice(0, 8);
const PORTS = { refuse: 3150, prodFrozen: 3151, maintenance: 3152, prodLive: 3153, dev: 3154 };

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
// M3.1 — refuse unless TENOTRAINER_MODE=development and the target project is allow-listed.
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
// The server environment: the developer .env.local is still loaded by Next
// itself, so every mode-relevant key is set EXPLICITLY here (an empty
// string counts as unset for validation and overrides .env.local).
// The mode and gate keys are blanked, not deleted: the normal development
// .env.local sets them since the M3.1 transition, and a deleted key would be
// filled from it. The bridge / app-URL keys are deleted so .env.local's
// developer values still apply where a case relies on them.
function serverEnv(overrides) {
  const base = { ...process.env };
  for (const k of ["FASTAPI_URL", "BRIDGE_SECRET", "NEXT_PUBLIC_APP_URL"]) delete base[k];
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED"]) base[k] = "";
  return { ...base, RESEND_API_KEY: "", ...overrides };
}
// M3.2: production / maintenance also require the safety email
// configuration; the dummy Resend key is never used (this suite sends no
// safety email and never calls the dispatch endpoint).
const PROD_ENV = { FASTAPI_URL: "", BRIDGE_SECRET: "", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.test",
  SAFETY_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: `m31-modes-${randomUUID()}-${randomUUID()}`,
  RESEND_API_KEY: "re_isolated_never_called", RESEND_FROM: "TenoTrainer <safety@tenotrainer.test>" };
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
// Expect the server to refuse to start: exits non-zero, never listens.
async function expectStartupRefusal(label, overrides, mentions) {
  const s = spawnServer(PORTS.refuse, overrides);
  let everListened = false;
  for (let i = 0; i < 60 && s.exited === null; i++) {
    if (await listening(PORTS.refuse)) everListened = true;
    await sleep(500);
  }
  if (s.exited === null) await stopServer(s);
  const named = s.log.includes("TenoTrainer refused to start") && s.log.includes(mentions);
  check(`startup refused: ${label}`, s.exited !== null && s.exited !== 0 && !everListened && named, `exit ${s.exited}, listened ${everListened}, log: ${s.log.slice(-300)}`);
  return s;
}

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
const exerciseIds = [];
let throwawayOrgId = null;

async function makeUser(label, membership = null) {
  const email = `m31-${label}-${RUN}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `M3.1 ${label}`, timezone: TZ, morning_reminder_time: "07:00" });
  if (membership) {
    const { error: me } = await admin.from("organization_members").insert({ organization_id: membership.org, user_id: data.user.id, role: membership.role });
    if (me) throw me;
  }
  return { userId: data.user.id, email };
}

async function makeProgramPatient(clinician, exerciseId) {
  const p = await makeUser("patient");
  await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: p.userId, status: "active" });
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: p.userId }).select("id").single();
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
  const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseId, order_index: 0, status: "active" }).select("id").single();
  const { error: de } = await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
  if (de) throw de;
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return { ...p, ppId: pp.id, versionId: v.id, workoutId: w.id, exerciseId: pe.id };
}

// Everything the suite's users own, for an exact before/after comparison.
async function rowState(patient, clinician) {
  const q = async (table, col, ids, order = "id") => {
    const { data, error } = await admin.from(table).select("*").in(col, ids).order(order);
    if (error) return `ERROR ${error.message}`;
    return data;
  };
  const sessions = await q("rehab_sessions", "user_id", [patient.userId]);
  const sessionIds = Array.isArray(sessions) && sessions.length ? sessions.map((s) => s.id) : [randomUUID()];
  return JSON.stringify({
    profiles: await q("profiles", "id", [patient.userId, clinician.userId]),
    rehab_sessions: sessions,
    set_outcomes: await q("set_outcomes", "rehab_session_id", sessionIds),
    immediate: await q("session_immediate_responses", "rehab_session_id", sessionIds, "rehab_session_id"),
    morning: await q("morning_responses", "rehab_session_id", sessionIds),
    escalations: await q("escalation_evaluations", "rehab_session_id", sessionIds),
    versions: await q("prescription_versions", "user_id", [patient.userId]),
    prescriptions: await q("patient_prescriptions", "patient_id", [patient.userId]),
    drafts: await q("prescription_drafts", "patient_prescription_id", [patient.ppId]),
    pauses: await q("prescription_pause_periods", "patient_prescription_id", [patient.ppId]),
    notifications: await q("notifications", "patient_id", [patient.userId]),
    assignments: await q("supervisor_patients", "patient_id", [patient.userId]),
    favorites: await q("clinician_exercise_favorites", "clinician_id", [clinician.userId]),
    invitations: await q("invitations", "invited_by", [clinician.userId]),
    episodes: await q("acute_safety_episodes", "user_id", [patient.userId]),
  });
}

async function teardown() {
  const ids = createdUsers.length ? createdUsers : [randomUUID()];
  for (const userId of createdUsers) {
    await admin.from("acute_safety_episodes").delete().eq("user_id", userId);
    await admin.from("c5_recovery_decisions").delete().eq("user_id", userId);
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    await admin.from("notifications").delete().eq("patient_id", userId);
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
      await admin.from("prescription_pause_periods").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
    await admin.from("invitations").delete().eq("invited_by", userId);
    await admin.from("clinician_exercise_favorites").delete().eq("clinician_id", userId);
  }
  await admin.from("supervisor_patients").delete().in("patient_id", ids);
  await admin.from("supervisor_patients").delete().in("supervisor_id", ids);
  await admin.from("organization_members").delete().in("user_id", ids);
  await admin.from("profiles").delete().in("id", ids);
  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.log(`teardown: could not delete user ${id}: ${error.message}`);
  }
  for (const id of exerciseIds) await admin.from("canonical_exercises").delete().eq("id", id);
  if (throwawayOrgId) await admin.from("organizations").delete().eq("id", throwawayOrgId);
  const { data: left } = await admin.from("rehab_sessions").select("id").in("user_id", ids);
  console.log(`\nteardown: ${createdUsers.length} users, ${exerciseIds.length} exercises, org ${throwawayOrgId ? 1 : 0} removed; remaining sessions: ${left?.length ?? "?"}`);
}

// ---------------------------------------------------------------- HTTP helpers
async function login(browser, base, email) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.close();
  return context;
}
// A fresh request context on another server, carrying the same auth cookies
// (the Supabase session cookie is host-scoped to 127.0.0.1/localhost, not port).
async function api(ctx, base, method, path, data, headers = {}) {
  const res = await ctx.request.fetch(`${base}${path}`, { method, data, headers, failOnStatusCode: false, maxRedirects: 0 });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status(), body };
}
async function rawStatus(base, method, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { method, headers, redirect: "manual", body: method === "GET" || method === "HEAD" ? undefined : "{}" });
  return res.status;
}

const LEGACY_ROUTES = [
  ["POST", "/api/patient/rehab-session"],
  ["GET", "/api/patient/rehab-session/current"],
  ["GET", "/api/patient/rehab-session/pending-morning-response"],
  ["POST", `/api/patient/rehab-session/${randomUUID()}/exercises-complete`],
  ["POST", `/api/patient/rehab-session/${randomUUID()}/response`],
  ["POST", `/api/patient/morning-response/${randomUUID()}`],
  ["GET", "/api/auth/launch-dashboard"],
  ["POST", "/api/auth/validate-bridge"],
  ["POST", "/api/internal/prescription-versions"],
  ["POST", "/api/internal/supervisor-patients-sync"],
];

async function main() {
  // ================================================================ A
  section("A. Startup refusal (fail closed, no implicit default)");
  check("FastAPI URL used for this run refuses connections", await fetch(`${DEAD_FASTAPI}/`, { signal: AbortSignal.timeout(3000) }).then(() => false, () => true));
  await expectStartupRefusal("TENOTRAINER_MODE missing (no default from NODE_ENV)", { NODE_ENV: "production" }, "TENOTRAINER_MODE is required");
  await expectStartupRefusal("TENOTRAINER_MODE invalid ('prod')", { TENOTRAINER_MODE: "prod" }, "must be exactly");
  await expectStartupRefusal("production with FASTAPI_URL", { ...PROD_ENV, TENOTRAINER_MODE: "production", FASTAPI_URL: DEAD_FASTAPI }, "FASTAPI_URL");
  await expectStartupRefusal("production with BRIDGE_SECRET", { ...PROD_ENV, TENOTRAINER_MODE: "production", BRIDGE_SECRET: "x" }, "BRIDGE_SECRET");
  await expectStartupRefusal("production with runtime gate false (cannot resurrect legacy)", { ...PROD_ENV, TENOTRAINER_MODE: "production", C5_PATIENT_RUNTIME_ENABLED: "false" }, "C5_PATIENT_RUNTIME_ENABLED");
  await expectStartupRefusal("production with the developer (local http) app URL", { ...PROD_ENV, TENOTRAINER_MODE: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, "NEXT_PUBLIC_APP_URL");
  await expectStartupRefusal("production with the developer .env.local bridge config left in place", { TENOTRAINER_MODE: "production", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.test" }, "FASTAPI_URL");
  await expectStartupRefusal("maintenance with FASTAPI_URL", { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", FASTAPI_URL: DEAD_FASTAPI }, "FASTAPI_URL");
  await expectStartupRefusal("maintenance with runtime gate false", { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", C5_PATIENT_RUNTIME_ENABLED: "false" }, "C5_PATIENT_RUNTIME_ENABLED");

  // ---------------------------------------------------------------- fixtures
  const { data: org, error: oe } = await admin.from("organizations").insert({ name: `M3.1 super org ${RUN}`, slug: `m31-super-${RUN}` }).select("id").single();
  if (oe) throw oe;
  throwawayOrgId = org.id;
  const clinician = await makeUser("clinician", { org: REAL_ORG_ID, role: "clinician" });
  const superUser = await makeUser("super", { org: throwawayOrgId, role: "super_user" });
  const { data: exRow, error: ee } = await admin.from("canonical_exercises").insert({ name: `M3.1 heel raise ${RUN}`, visibility: "global", active: true }).select("id").single();
  if (ee) throw ee;
  exerciseIds.push(exRow.id);
  const patient = await makeProgramPatient(clinician, exRow.id);

  const browser = await chromium.launch();
  let server = null;
  let sessionId = null;
  let draftId = null;
  try {
    // ================================================================ B
    section("B. Production (publication frozen; FastAPI not configured)");
    server = await startServer(PORTS.prodFrozen, { ...PROD_ENV, TENOTRAINER_MODE: "production", C5_PRESCRIPTION_PUBLISH_ENABLED: "false" });
    const P1 = `http://localhost:${PORTS.prodFrozen}`;
    check("production server started and logged its mode", server.log.includes("TenoTrainer operating mode: production"));
    for (const [m, path] of LEGACY_ROUTES) {
      const st = await rawStatus(P1, m, path);
      check(`production: legacy/bridge route ${m} ${path.replace(/[0-9a-f-]{36}/, ":id")} retired (410)`, st === 410, `status ${st}`);
    }
    check("production: /admin/invitations (tester/admin invitations, F9) unavailable (404)", (await rawStatus(P1, "GET", "/admin/invitations")) === 404);
    check("production: /api/auth/debug unavailable (404)", (await rawStatus(P1, "GET", "/api/auth/debug")) === 404);

    const pctx = await login(browser, P1, patient.email);
    const page = await pctx.newPage();
    await page.goto(`${P1}/patient/dashboard`);
    check("production: patient dashboard renders the C5 experience (runtime gate unset — C5 is always the runtime)", (await page.locator("[data-c5-begin], [data-c5-start-hint], [data-c5-progress]").count()) > 0 || (await page.content()).includes("Workout A"), page.url());
    const st0 = await api(pctx, P1, "GET", "/api/patient/c5/state");
    check("production: C5 state API serves the patient (workout available)", st0.status === 200 && st0.body?.state?.kind === "available", `status ${st0.status} ${st0.body?.state?.kind}`);
    const startRes = await api(pctx, P1, "POST", "/api/patient/c5/start", {
      clientRequestId: randomUUID(), expectedVersionId: patient.versionId, workoutId: patient.workoutId,
      performance: { exercise_id: patient.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, preStartSkips: [], sequenceChoice: null,
    });
    sessionId = startRes.body?.session?.id ?? null;
    check("production: C5 session starts with FastAPI unreachable", startRes.status === 200 && sessionId, `status ${startRes.status} ${JSON.stringify(startRes.body)?.slice(0, 200)}`);
    for (const path of ["/patient/session", "/patient/progress"]) {
      const resp = await page.goto(`${P1}${path}`);
      const notFound = (await page.locator("body").innerText()).includes("This page could not be found");
      check(`production: ${path} renders (C5 branch, not the retired legacy page)`, resp?.status() === 200 && !notFound && page.url().endsWith(path), `${resp?.status()} ${page.url()}`);
    }
    await page.close();

    const cctx = await login(browser, P1, clinician.email);
    const draft = await api(cctx, P1, "POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: "clone_active", sourceVersionId: patient.versionId });
    draftId = draft.body?.draftId ?? null;
    check("production: clinician creates a draft (mutations allowed)", draft.status === 201 && draftId, `status ${draft.status} ${JSON.stringify(draft.body)?.slice(0, 200)}`);
    const frozen = await api(cctx, P1, "POST", `/api/clinician/prescription-drafts/${draftId}/publish`, {});
    check("production: publication freeze — publish refused (PUBLISH_DISABLED)", frozen.status === 403 && frozen.body?.error === "PUBLISH_DISABLED", `status ${frozen.status} ${JSON.stringify(frozen.body)}`);

    const sctx = await login(browser, P1, superUser.email);
    const spage = await sctx.newPage();
    await spage.goto(`${P1}/super/dashboard`);
    check("production: super dashboard renders", spage.url().includes("/super/dashboard"), spage.url());
    check("production: super dashboard has no tester/admin Invitations tab (F9)", (await spage.locator('a[href="/super/dashboard?tab=invitations"]').count()) === 0);
    await spage.goto(`${P1}/super/dashboard?tab=invitations`);
    check("production: ?tab=invitations renders no invitation workflow", !(await spage.content()).includes("Send invitation"));
    await spage.close();
    await sctx.close();
    await stopServer(server);
    check("production server stopped (its own process group only)", server.exited !== null && !(await listening(PORTS.prodFrozen)));

    // ================================================================ C
    section("C. Maintenance (patients unavailable; staff read-only)");
    const before = await rowState(patient, clinician);
    const sessionBefore = (await admin.from("rehab_sessions").select("*").eq("id", sessionId).single()).data;
    check("maintenance precondition: the session is Started", sessionBefore?.training_status === "started", sessionBefore?.training_status);
    server = await startServer(PORTS.maintenance, { ...PROD_ENV, TENOTRAINER_MODE: "maintenance", C5_PRESCRIPTION_PUBLISH_ENABLED: "true" });
    const M = `http://localhost:${PORTS.maintenance}`;
    check("maintenance server started and logged its mode", server.log.includes("TenoTrainer operating mode: maintenance"));

    const mp = await login(browser, M, patient.email);
    const mpage = await mp.newPage();
    for (const path of ["/maintenance", "/patient/dashboard", "/patient/session", "/patient/progress", "/dashboard"]) {
      await mpage.goto(`${M}${path}`);
      const text = await mpage.locator("body").innerText();
      check(`maintenance: patient ${path} shows the unavailable copy`, (await mpage.locator('[data-testid="maintenance-screen"]').count()) === 1 && text.includes("TenoTrainer is temporarily unavailable.") && text.includes("Your progress is saved."), `${mpage.url()} ${text.slice(0, 120)}`);
    }
    check("maintenance: no C5 session UI anywhere for patients", (await mpage.locator("[data-c5-exercise], [data-c5-begin]").count()) === 0);
    await mpage.close();
    const PATIENT_APIS = [
      ["GET", "/api/patient/c5/state"],
      ["GET", "/api/patient/c5/check-ins"],
      ["GET", `/api/patient/c5/session/${sessionId}/view`],
      ["POST", "/api/patient/c5/start"],
      ["POST", `/api/patient/c5/session/${sessionId}/performance`],
      ["POST", `/api/patient/c5/session/${sessionId}/finish`],
      ["POST", `/api/patient/c5/session/${sessionId}/stop`],
      ["POST", `/api/patient/c5/check-ins/immediate/${sessionId}`],
      ["POST", `/api/patient/c5/check-ins/morning/${sessionId}`],
      ["POST", "/api/patient/c5/recovery-decision"],
      ["POST", "/api/patient/timezone"],
      ["PATCH", "/api/patient/reminder-time"],
      ["POST", "/api/patient/acute-safety/reassessment"],
    ];
    for (const [m, path] of PATIENT_APIS) {
      const r = await api(mp, M, m, path, m === "GET" ? undefined : { exercise_id: patient.exerciseId, unit_index: 1, outcome: "completed", actual_reps: 8, timezone: "Europe/Paris", morningReminderTime: "05:00" });
      check(`maintenance: patient API ${m} ${path.replace(/[0-9a-f-]{36}/, ":id")} unavailable (503 MAINTENANCE)`, r.status === 503 && (r.body?.error === "MAINTENANCE" || r.body?.code === "MAINTENANCE"), `status ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
    }
    for (const [m, path] of LEGACY_ROUTES.slice(0, 3)) {
      const r = await api(mp, M, m, path);
      check(`maintenance: legacy ${m} ${path} still retired (410)`, r.status === 410, `status ${r.status}`);
    }
    const action = await api(mp, M, "POST", "/patient/dashboard", "[]", { "next-action": "0".repeat(40), "content-type": "text/plain;charset=UTF-8" });
    check("maintenance: patient server-action POST refused (503)", action.status === 503, `status ${action.status}`);
    await mp.close();

    const mc = await login(browser, M, clinician.email);
    const cpage = await mc.newPage();
    await cpage.goto(`${M}/clinician/dashboard`);
    check("maintenance: clinician dashboard readable", cpage.url().includes("/clinician/dashboard") && (await cpage.locator("body").innerText()).length > 50, cpage.url());
    check("maintenance: read-only banner shown to clinicians", (await cpage.locator('[data-testid="maintenance-read-only-banner"]').count()) === 1);
    await cpage.goto(`${M}/clinician/patients/${patient.userId}`);
    check("maintenance: clinician patient record readable", cpage.url().includes(`/clinician/patients/${patient.userId}`) && (await cpage.locator("body").innerText()).includes("M3.1 patient"), cpage.url());
    const enabled = await cpage.locator('[data-testid="maintenance-read-only"] button:enabled, [data-testid="maintenance-read-only"] input:enabled, [data-testid="maintenance-read-only"] textarea:enabled, [data-testid="maintenance-read-only"] select:enabled').count();
    check("maintenance: every form control in the clinician UI is disabled", enabled === 0, `${enabled} enabled controls`);
    const reads = [
      ["GET", "/api/clinician/library/exercises"],
      ["GET", `/api/clinician/prescription-drafts/${draftId}`],
      ["GET", `/api/clinician/prescription-drafts/${draftId}/validate`],
    ];
    for (const [m, path] of reads) {
      const r = await api(mc, M, m, path);
      check(`maintenance: clinician read ${path.replace(/[0-9a-f-]{36}/, ":id")} works (200)`, r.status === 200, `status ${r.status}`);
    }
    const fakeId = randomUUID();
    const MUTATIONS = [
      ["POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: "clone_active", sourceVersionId: patient.versionId }],
      ["PATCH", `/api/clinician/prescription-drafts/${draftId}`, { title: "x" }],
      ["DELETE", `/api/clinician/prescription-drafts/${draftId}`],
      ["POST", `/api/clinician/prescription-drafts/${draftId}/publish`, {}],
      ["POST", `/api/clinician/prescription-drafts/${draftId}/workouts`, { label: "B" }],
      ["POST", `/api/clinician/prescription-drafts/${draftId}/workouts/reorder`, { order: [] }],
      ["PATCH", `/api/clinician/prescription-workouts/${fakeId}`, { label: "x" }],
      ["DELETE", `/api/clinician/prescription-workouts/${fakeId}`],
      ["POST", `/api/clinician/prescription-workouts/${fakeId}/exercises`, { canonicalExerciseId: exRow.id }],
      ["POST", `/api/clinician/prescription-workouts/${fakeId}/exercises/reorder`, { order: [] }],
      ["PATCH", `/api/clinician/prescription-exercises/${fakeId}`, {}],
      ["DELETE", `/api/clinician/prescription-exercises/${fakeId}`],
      ["POST", `/api/clinician/prescription-exercises/${fakeId}/move`, {}],
      ["PUT", `/api/clinician/prescription-exercises/${fakeId}/dosage`, {}],
      ["POST", `/api/clinician/patients/${patient.userId}/prescription/pause`, {}],
      ["POST", `/api/clinician/patients/${patient.userId}/prescription/resume`, {}],
      ["POST", `/api/clinician/patients/${patient.userId}/acute-safety/${fakeId}/release`, { releaseNote: "x" }],
      ["POST", `/api/clinician/library/exercises/${exRow.id}/favorite`, {}],
      ["DELETE", `/api/clinician/library/exercises/${exRow.id}/favorite`],
    ];
    for (const [m, path, body] of MUTATIONS) {
      const r = await api(mc, M, m, path, body);
      check(`maintenance: clinician mutation ${m} ${path.replace(/[0-9a-f-]{36}/g, ":id")} refused (503)`, r.status === 503 && r.body?.error === "MAINTENANCE", `status ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
    }
    for (const path of ["/clinician/dashboard", "/clinician/invitations", `/clinician/patients/${patient.userId}/prescription`, "/admin/assignments"]) {
      const r = await api(mc, M, "POST", path, "[]", { "next-action": "0".repeat(40), "content-type": "text/plain;charset=UTF-8" });
      check(`maintenance: server-action POST to ${path.replace(/[0-9a-f-]{36}/, ":id")} refused (503)`, r.status === 503, `status ${r.status}`);
    }
    await cpage.close();
    await mc.close();
    const ms = await login(browser, M, superUser.email);
    const mspage = await ms.newPage();
    await mspage.goto(`${M}/super/dashboard`);
    check("maintenance: super user dashboard readable with read-only banner", mspage.url().includes("/super/dashboard") && (await mspage.locator('[data-testid="maintenance-read-only-banner"]').count()) === 1, mspage.url());
    await mspage.close();
    const sa = await api(ms, M, "POST", "/admin/assignments", "[]", { "next-action": "0".repeat(40), "content-type": "text/plain;charset=UTF-8" });
    check("maintenance: super user assignment server action refused (503)", sa.status === 503, `status ${sa.status}`);
    await ms.close();

    // Library boundary, in-process (bypasses proxy, HTTP and action layers).
    const probeOut = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "scripts/lib/m3MaintenanceLibraryProbe.mjs", "maintenance"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const probe = JSON.parse(probeOut.trim().split("\n").pop());
    for (const r of probe) check(`maintenance: library ${r.fn.replace("@/lib/", "")} refuses in-process`, r.ok, r.detail);
    const controlOut = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "scripts/lib/m3MaintenanceLibraryProbe.mjs", "production"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    const control = JSON.parse(controlOut.trim().split("\n").pop());
    check("library probe negative control: in production mode none of them refuse with MAINTENANCE", control.every((r) => r.detail !== "MaintenanceError"));

    await sleep(1500);
    const after = await rowState(patient, clinician);
    check("maintenance: every row owned by the suite's users is byte-identical (no write of any kind)", before === after, "row state differs");
    const sessionAfter = (await admin.from("rehab_sessions").select("*").eq("id", sessionId).single()).data;
    check("maintenance: Started session unchanged — no auto Finish / Stop", sessionAfter?.training_status === "started" && sessionAfter?.training_closed_at === null && JSON.stringify(sessionAfter) === JSON.stringify(sessionBefore));
    await stopServer(server);
    check("maintenance server stopped (its own process group only)", server.exited !== null && !(await listening(PORTS.maintenance)));

    // ================================================================ D
    section("D. Production again (resume; publication on)");
    server = await startServer(PORTS.prodLive, { ...PROD_ENV, TENOTRAINER_MODE: "production", C5_PRESCRIPTION_PUBLISH_ENABLED: "true", C5_PATIENT_RUNTIME_ENABLED: "true" });
    const P2 = `http://localhost:${PORTS.prodLive}`;
    const rp = await login(browser, P2, patient.email);
    const resumed = await api(rp, P2, "GET", "/api/patient/c5/state");
    check("production again: the patient's Started session is offered for resume", resumed.status === 200 && resumed.body?.state?.kind === "resume" && resumed.body.state.session?.id === sessionId, `status ${resumed.status} ${JSON.stringify(resumed.body)?.slice(0, 200)}`);
    const perf2 = await api(rp, P2, "POST", `/api/patient/c5/session/${sessionId}/performance`, { performance: { exercise_id: patient.exerciseId, unit_index: 1, outcome: "completed", actual_reps: 8 } });
    check("production again: the session resumes (next set recorded)", perf2.status === 200, `status ${perf2.status} ${JSON.stringify(perf2.body)?.slice(0, 160)}`);
    const fin = await api(rp, P2, "POST", `/api/patient/c5/session/${sessionId}/finish`, {});
    check("production again: the session finishes normally", fin.status === 200, `status ${fin.status} ${JSON.stringify(fin.body)?.slice(0, 160)}`);
    const closed = (await admin.from("rehab_sessions").select("training_status").eq("id", sessionId).single()).data;
    check("production again: the session closed through the normal C5 path", closed?.training_status === "finished", closed?.training_status);
    await rp.close();
    const rc = await login(browser, P2, clinician.email);
    const pub = await api(rc, P2, "POST", `/api/clinician/prescription-drafts/${draftId}/publish`, {});
    check("production with the publish gate on: publish is not refused by the mode", pub.status !== 503 && pub.body?.error !== "PUBLISH_DISABLED", `status ${pub.status} ${JSON.stringify(pub.body)?.slice(0, 160)}`);
    await rc.close();
    await stopServer(server);
    check("production server stopped (its own process group only)", server.exited !== null && !(await listening(PORTS.prodLive)));

    // ================================================================ E
    section("E. Development (legacy available only here)");
    server = await startServer(PORTS.dev, { TENOTRAINER_MODE: "development", C5_PATIENT_RUNTIME_ENABLED: "true", FASTAPI_URL: DEAD_FASTAPI });
    const D = `http://localhost:${PORTS.dev}`;
    for (const [m, path] of LEGACY_ROUTES.slice(0, 2)) {
      const st = await rawStatus(D, m, path);
      check(`development: legacy route ${m} ${path} exists (not 410)`, st !== 410 && st !== 503, `status ${st}`);
    }
    check("development: /admin/invitations exists (not 404 from the mode)", (await rawStatus(D, "GET", "/admin/invitations")) !== 404);
    await stopServer(server);
    check("development server stopped (its own process group only)", server.exited !== null && !(await listening(PORTS.dev)));
    server = null;
  } finally {
    await browser.close().catch(() => {});
    for (const s of started) await stopServer(s);
    await teardown().catch((e) => console.error("teardown error", e));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  for (const s of started) await stopServer(s);
  await teardown().catch(() => {});
  process.exit(1);
});
