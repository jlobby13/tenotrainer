// M3.1 Phase B — one narrow, C5-native regression for the reconciliation
// invariant previously covered only by the (retired) legacy
// verifyReconciliation.mjs:
//
//   a reconciled acute safety episode's confirmed_at preserves the ORIGINAL
//   escalation evaluation's evaluated_at (it anchors the 14-day recurrence
//   window) — never the time reconciliation happened to run.
//
// Exercised through the current authoritative C5 path, over real
// authenticated HTTP on an isolated development server:
//   start / Finish (POST /api/patient/c5/start, /session/:id/finish)
//   -> c5_submit_immediate_response (the RPC c5ResponseServer.submit() calls;
//      it records the Level 5 escalation evaluation and commits)
//   -> getC5TrainingState() -> reconcileAcute() ->
//      reconcile_missing_acute_episodes (service role, its own transaction).
//
// Case A separates evaluation and reconciliation by a real >= 2 s gap, so a
// reconciliation that stamped "now" could not pass. Case B is the patient's
// own check-in request end to end. Throwaway users, full teardown.
//
// Run from web/ (server: TENOTRAINER_MODE=development
// C5_PATIENT_RUNTIME_ENABLED=true ... npx next start -p 3101):
//   TENOTRAINER_MODE=development node scripts/verifyM31ReconciliationAnchor.mjs [onUrl]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";

const ON = process.argv[2] ?? "http://localhost:3101";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const RUN = randomUUID().slice(0, 8);
const GAP_MS = 2500;
const POP = { peak_session_pain: 3, overall_session_rpe: 5, sudden_or_sharp_pain: false, pop_felt_or_heard: true, new_functional_difficulty: false };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const createdUsers = [];
const exerciseIds = [];

async function makeUser(label, role = null) {
  const email = `m31rec-${label}-${RUN}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `M3.1 rec ${label}`, timezone: TZ, morning_reminder_time: "07:00" });
  if (role) await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: data.user.id, role });
  return { userId: data.user.id, email };
}
async function makePatient(label, clinician, exerciseId) {
  const p = await makeUser(label);
  await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: p.userId, status: "active" });
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: p.userId }).select("id").single();
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({ user_id: p.userId, source: "clinician_change", patient_prescription_id: pp.id, version_number: 1, published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: clinician.userId, scheduling_mode: "sequence", target_sessions_per_week: 3, recovery_days: 0 })
    .select("id")
    .single();
  if (error) throw error;
  const { data: w } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: "A", order_index: 0 }).select("id").single();
  const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseId, order_index: 0, status: "active" }).select("id").single();
  await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 1, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return { ...p, ppId: pp.id, versionId: v.id, workoutId: w.id, exerciseId: pe.id };
}

async function teardown() {
  const ids = createdUsers.length ? createdUsers : [randomUUID()];
  for (const userId of createdUsers) {
    await admin.from("acute_safety_episodes").delete().eq("user_id", userId);
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    await admin.from("notifications").delete().eq("patient_id", userId);
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
  }
  await admin.from("supervisor_patients").delete().in("patient_id", ids);
  await admin.from("supervisor_patients").delete().in("supervisor_id", ids);
  await admin.from("organization_members").delete().in("user_id", ids);
  await admin.from("profiles").delete().in("id", ids);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  for (const id of exerciseIds) await admin.from("canonical_exercises").delete().eq("id", id);
  const { data: left } = await admin.from("rehab_sessions").select("id").in("user_id", ids);
  console.log(`\nteardown: ${createdUsers.length} users, ${exerciseIds.length} exercises removed; remaining sessions: ${left?.length ?? "?"}`);
}

async function login(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${ON}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.close();
  return context;
}
async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${ON}${path}`, { method, data, failOnStatusCode: false, maxRedirects: 0 });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status(), body };
}
// A closed (Finished) C5 session through the real patient HTTP path.
async function finishedSession(ctx, p) {
  const s = await api(ctx, "POST", "/api/patient/c5/start", {
    clientRequestId: randomUUID(), expectedVersionId: p.versionId, workoutId: p.workoutId,
    performance: { exercise_id: p.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, preStartSkips: [], sequenceChoice: null,
  });
  const id = s.body?.session?.id;
  if (s.status !== 200 || !id) throw new Error(`start failed: ${s.status} ${JSON.stringify(s.body)}`);
  const f = await api(ctx, "POST", `/api/patient/c5/session/${id}/finish`, {});
  if (f.status !== 200) throw new Error(`finish failed: ${f.status} ${JSON.stringify(f.body)}`);
  return id;
}
async function evaluationsOf(sessionId) {
  const { data } = await admin.from("escalation_evaluations").select("id, escalation_level, evaluated_at").eq("rehab_session_id", sessionId);
  return data ?? [];
}
async function episodesOf(sessionId) {
  const { data } = await admin.from("acute_safety_episodes").select("id, source_escalation_evaluation_id, initial_level, confirmed_at, created_at").eq("source_rehab_session_id", sessionId);
  return data ?? [];
}

async function main() {
  const probe = await fetch(`${ON}/api/patient/c5/state`).catch(() => null);
  check("isolated C5 development server reachable (unauthenticated state -> 401)", probe?.status === 401, `status ${probe?.status}`);

  const clinician = await makeUser("clinician", "clinician");
  const { data: exRow } = await admin.from("canonical_exercises").insert({ name: `M3.1 rec ${RUN}`, visibility: "global", active: true }).select("id").single();
  exerciseIds.push(exRow.id);
  const A = await makePatient("a", clinician, exRow.id);
  const B = await makePatient("b", clinician, exRow.id);
  const browser = await chromium.launch();
  try {
    console.log("\n--- Case A: evaluation and reconciliation separated by a real gap ---");
    {
      const ctx = await login(browser, A.email);
      const sid = await finishedSession(ctx, A);
      // Exactly what c5ResponseServer.submit() commits first.
      const { data: r, error } = await admin.rpc("c5_submit_immediate_response", { p_patient_id: A.userId, p_session_id: sid, p_response: POP });
      check("A: C5 immediate response with pop records a Level 5 evaluation", !error && r?.result === "submitted" && Number(r?.escalation_level) === 5, error?.message ?? JSON.stringify(r));
      const evals = await evaluationsOf(sid);
      const ev = evals.find((e) => e.escalation_level === 5);
      check("A: exactly one Level 5 escalation evaluation", evals.length === 1 && Boolean(ev), JSON.stringify(evals));
      check("A: not yet reconciled (no episode before the reconciliation step)", (await episodesOf(sid)).length === 0);
      await sleep(GAP_MS);
      const before = Date.now();
      // The authoritative reconciliation trigger: the patient's state read
      // (getC5TrainingState -> reconcileAcute -> reconcile_missing_acute_episodes).
      const st = await api(ctx, "GET", "/api/patient/c5/state");
      check("A: state read after reconciliation reports the acute brake", st.status === 200 && ["acute_blocked", "acute_resolution_required"].includes(st.body?.state?.kind), `${st.status} ${st.body?.state?.kind}`);
      const eps = await episodesOf(sid);
      check("A: reconciliation created exactly one episode from that evaluation", eps.length === 1 && eps[0].source_escalation_evaluation_id === ev?.id && eps[0].initial_level === 5, JSON.stringify(eps));
      const e = eps[0];
      check("A: confirmed_at === the escalation's evaluated_at (exact)", e && new Date(e.confirmed_at).getTime() === new Date(ev.evaluated_at).getTime() && e.confirmed_at === ev.evaluated_at, `confirmed_at ${e?.confirmed_at} evaluated_at ${ev?.evaluated_at}`);
      check(`A: reconciliation genuinely ran >= ${GAP_MS / 1000 - 0.5}s later (created_at), so confirmed_at is not reconciliation time`, e && new Date(e.created_at).getTime() - new Date(ev.evaluated_at).getTime() >= GAP_MS - 500, `created_at ${e?.created_at}`);
      check("A: confirmed_at precedes the reconciliation request", e && new Date(e.confirmed_at).getTime() < before);
      await api(ctx, "GET", "/api/patient/c5/state");
      check("A: a repeated reconciliation leaves exactly one episode, confirmed_at unchanged", (await episodesOf(sid)).length === 1 && (await episodesOf(sid))[0].confirmed_at === e?.confirmed_at);
      await ctx.close();
    }

    console.log("\n--- Case B: the patient's own check-in request end to end ---");
    {
      const ctx = await login(browser, B.email);
      const sid = await finishedSession(ctx, B);
      const r = await api(ctx, "POST", `/api/patient/c5/check-ins/immediate/${sid}`, { response: POP });
      check("B: patient check-in (HTTP) submitted", r.status === 200 && r.body?.result === "submitted", `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
      const ev = (await evaluationsOf(sid)).find((x) => x.escalation_level === 5);
      const eps = await episodesOf(sid);
      check("B: the same request reconciled exactly one episode", eps.length === 1 && eps[0].source_escalation_evaluation_id === ev?.id, JSON.stringify(eps));
      check("B: confirmed_at === the escalation's evaluated_at (exact)", eps[0] && ev && eps[0].confirmed_at === ev.evaluated_at, `confirmed_at ${eps[0]?.confirmed_at} evaluated_at ${ev?.evaluated_at}`);
      check("B: reconciliation ran in its own later transaction (created_at > evaluated_at)", eps[0] && new Date(eps[0].created_at).getTime() > new Date(ev.evaluated_at).getTime(), `created_at ${eps[0]?.created_at}`);
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    await teardown().catch((e) => console.error("teardown error", e));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
