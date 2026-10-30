// M3.1 — adversarial surface suite. Attacks the authority boundary the way
// a hostile client would, with REAL credentials:
//
//   1. PostgREST direct (real patient / clinician JWTs from Supabase Auth,
//      and the anon key): C5 / M1 / M2 authority, self-escalation,
//      self-release, assignment / membership forgery, cross-patient reads.
//   2. Legacy patient write authority (the Phase B revocation target).
//      Default: recorded as the pre-revocation BASELINE (still permitted —
//      the reason the revocation exists). With --expect-revoked (Phase B,
//      after the migration is applied) every one must be refused.
//   3. HTTP against an isolated PRODUCTION-mode server this script starts
//      (own process group; only it is stopped): path-normalisation tricks
//      and the x-middleware-subrequest proxy-bypass header against retired
//      routes, role confusion, cross-patient access, identity spoofing,
//      forged-origin server actions.
//
// Requires a production build of this worktree. Run from web/:
//   TENOTRAINER_MODE=development node scripts/verifyM3AdversarialSurface.mjs [--expect-revoked]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";

const EXPECT_REVOKED = process.argv.includes("--expect-revoked");
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const PORT = 3155;
const BASE = `http://localhost:${PORT}`;
const RUN = randomUUID().slice(0, 8);

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
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
const baseline = [];
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
// A privilege refusal (42501 / RLS) — never just any error, so a schema
// mistake in an attack can never masquerade as a refusal.
const denied = (r) => Boolean(r.error) && (r.error.code === "42501" || /permission denied|row-level security/i.test(r.error.message));
// PostgREST write refusal: a privilege error, or zero rows touched.
const refusedWrite = (r) => denied(r) || (!r.error && Array.isArray(r.data) && r.data.length === 0);
const why = (r) => (r.error ? `${r.error.code} ${r.error.message}` : `rows ${JSON.stringify(r.data)?.slice(0, 80)}`);

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
const exerciseIds = [];
const orgIds = [];
const heuristicKeys = [];

async function makeUser(label, role = null, orgId = REAL_ORG_ID) {
  const email = `m31adv-${label}-${RUN}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `M3.1 adv ${label}`, timezone: TZ, morning_reminder_time: "07:00" });
  if (role) await admin.from("organization_members").insert({ organization_id: orgId, user_id: data.user.id, role });
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: se } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (se) throw se;
  return { userId: data.user.id, email, db: client };
}
async function giveProgram(p, clinician, exerciseId) {
  await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: p.userId, status: "active" });
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: p.userId }).select("id").single();
  const { data: v } = await admin
    .from("prescription_versions")
    .insert({ user_id: p.userId, source: "clinician_change", patient_prescription_id: pp.id, version_number: 1, published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: clinician.userId, scheduling_mode: "sequence", target_sessions_per_week: 3, recovery_days: 0 })
    .select("id")
    .single();
  const { data: w } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: "A", order_index: 0 }).select("id").single();
  const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseId, order_index: 0, status: "active" }).select("id").single();
  await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, dosage_type: "repetition", sets: 2, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return Object.assign(p, { ppId: pp.id, versionId: v.id, workoutId: w.id, exerciseId: pe.id });
}

async function teardown() {
  const ids = createdUsers.length ? createdUsers : [randomUUID()];
  for (const userId of createdUsers) {
    const { data: episodes } = await admin.from("acute_safety_episodes").select("id").eq("user_id", userId);
    const episodeIds = (episodes ?? []).map((e) => e.id);
    if (episodeIds.length) await admin.from("acute_safety_releases").delete().in("acute_safety_episode_id", episodeIds);
    await admin.from("acute_safety_episodes").delete().eq("user_id", userId);
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    await admin.from("notifications").delete().eq("patient_id", userId);
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
    await admin.from("invitations").delete().eq("invited_by", userId);
  }
  await admin.from("supervisor_patients").delete().in("patient_id", ids);
  await admin.from("supervisor_patients").delete().in("supervisor_id", ids);
  await admin.from("organization_members").delete().in("user_id", ids);
  await admin.from("profiles").delete().in("id", ids);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  for (const id of exerciseIds) {
    await admin.from("exercise_reference_dosage").delete().eq("exercise_id", id);
    await admin.from("canonical_exercises").delete().eq("id", id);
  }
  for (const key of heuristicKeys) {
    const { data: h } = await admin.from("m6_heuristics").select("id").eq("heuristic_key", key).maybeSingle();
    if (h) {
      await admin.from("m6_heuristic_evidence").delete().eq("heuristic_id", h.id);
      await admin.from("m6_heuristics").delete().eq("id", h.id);
    }
  }
  await admin.from("m6_evidence_sources").delete().like("title", `M3.1 adv ${RUN}%`);
  for (const id of orgIds) await admin.from("organizations").delete().eq("id", id);
  const { data: left } = await admin.from("rehab_sessions").select("id").in("user_id", ids);
  console.log(`\nteardown: ${createdUsers.length} users, ${exerciseIds.length} exercises removed; remaining sessions: ${left?.length ?? "?"}`);
}

// ---------------------------------------------------------------- server (production mode)
let server = null;
async function listening() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/login`, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}
async function startProductionServer() {
  if (await listening()) throw new Error(`port ${PORT} already in use — refusing to touch a server this script did not start`);
  const e = { ...process.env };
  for (const k of ["TENOTRAINER_MODE", "C5_PATIENT_RUNTIME_ENABLED", "C5_PRESCRIPTION_PUBLISH_ENABLED"]) delete e[k];
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    // M3.2: production also requires the safety email configuration (the
    // dummy Resend key is never used — this suite sends no email).
    env: { ...e, TENOTRAINER_MODE: "production", FASTAPI_URL: "", BRIDGE_SECRET: "", NEXT_PUBLIC_APP_URL: "https://app.tenotrainer.test",
      SAFETY_EMAIL_PROVIDER: "resend", SAFETY_DISPATCH_SECRET: `m31-adv-${randomUUID()}-${randomUUID()}`, RESEND_API_KEY: "re_isolated_never_called", RESEND_FROM: "TenoTrainer <safety@tenotrainer.test>" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server = { proc, pid: proc.pid, log: "", exited: null };
  proc.stdout.on("data", (d) => (server.log += d));
  proc.stderr.on("data", (d) => (server.log += d));
  proc.on("exit", (c) => (server.exited = c ?? -1));
  for (let i = 0; i < 120; i++) {
    if (server.exited !== null) throw new Error(`server exited: ${server.log.slice(-1000)}`);
    if (await listening()) return;
    await sleep(500);
  }
  throw new Error("server not ready");
}
async function stopServer() {
  if (!server || server.exited !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM"); // only the process group this script created
  } catch {
    // gone
  }
  for (let i = 0; i < 40 && server.exited === null; i++) await sleep(250);
  if (server.exited === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}
// Cookie-authenticated HTTP as a user: Supabase SSR cookie built from the session.
function authCookie(session) {
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const name = `sb-${ref}-auth-token`;
  const chunks = value.match(/.{1,3180}/g);
  return chunks.length === 1 ? `${name}=${value}` : chunks.map((c, i) => `${name}.${i}=${c}`).join("; ");
}
async function http(user, method, path, body, headers = {}) {
  const h = { ...headers };
  if (user) h.cookie = authCookie((await user.db.auth.getSession()).data.session);
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status, body: json };
}

async function main() {
  const clinician = await makeUser("clinician", "clinician");
  const otherClinician = await makeUser("otherclin", "clinician");
  const { data: exRow } = await admin.from("canonical_exercises").insert({ name: `M3.1 adv ${RUN}`, visibility: "global", active: true }).select("id").single();
  exerciseIds.push(exRow.id);
  const patient = await giveProgram(await makeUser("patient"), clinician, exRow.id);
  const other = await giveProgram(await makeUser("other"), otherClinician, exRow.id);

  // A real C5 session for `other` (service role, the server's own path).
  const otherSessionId = randomUUID();
  const { data: os, error: ose } = await admin.rpc("c5_record_first_performance", {
    p_patient_id: other.userId, p_client_request_id: otherSessionId, p_expected_version_id: other.versionId, p_workout_id: other.workoutId,
    p_performance: { exercise_id: other.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, p_pre_start_skips: [], p_sequence_choice: null,
  });
  const otherSession = os?.session_id ?? null;
  if (ose || !otherSession) throw new Error(`fixture session failed: ${ose?.message ?? JSON.stringify(os)}`);

  // ================================================================ 1
  section("1. PostgREST direct — C5 / M1 / M2 authority (real JWTs)");
  {
    const p = patient.db;
    let r = await p.rpc("c5_record_first_performance", { p_patient_id: patient.userId, p_client_request_id: randomUUID(), p_expected_version_id: patient.versionId, p_workout_id: patient.workoutId, p_performance: { exercise_id: patient.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, p_pre_start_skips: [], p_sequence_choice: null });
    check("patient cannot call the C5 start RPC directly", denied(r), why(r));
    r = await p.rpc("c5_record_performance", { p_patient_id: other.userId, p_session_id: otherSession, p_performance: {} });
    check("patient cannot write another patient's C5 session via RPC", denied(r), why(r));
    r = await p.rpc("c5_finish_session", { p_patient_id: other.userId, p_session_id: otherSession });
    check("patient cannot Finish another patient's session via RPC", denied(r), why(r));
    r = await p.from("rehab_sessions").insert({ id: randomUUID(), user_id: patient.userId, prescription_instance_id: `c5:${randomUUID()}`, patient_local_date: "2026-10-26", training_status: "started", started_at: new Date().toISOString(), prescription_snapshot: [] }).select("id");
    check("patient cannot insert a C5 (training_status) session row directly", refusedWrite(r), why(r));
    r = await p.from("rehab_sessions").update({ training_status: "finished" }).eq("id", otherSession).select("id");
    check("patient cannot update another patient's C5 session", refusedWrite(r), why(r));
    r = await p.from("session_immediate_responses").insert({ rehab_session_id: otherSession, user_id: patient.userId }).select("rehab_session_id");
    check("patient cannot write immediate responses directly", refusedWrite(r), why(r));
    r = await p.from("escalation_evaluations").insert({ rehab_session_id: otherSession, escalation_level: 5, escalation_reason: "pop_felt_or_heard", rule_version: "v1", inputs_snapshot: {} }).select("id");
    check("patient cannot fabricate an escalation evaluation", refusedWrite(r), why(r));
    r = await p.from("acute_safety_episodes").insert({ user_id: patient.userId, source_rehab_session_id: otherSession, source_escalation_evaluation_id: randomUUID(), initial_level: 5, initial_sudden_or_sharp_pain: false, initial_new_functional_difficulty: false, initial_pop_felt_or_heard: true, recurrence_sequence_in_window: 1 }).select("id");
    check("patient cannot open (self-escalate) an acute episode directly", refusedWrite(r), why(r));
    r = await p.from("acute_safety_releases").insert({ acute_safety_episode_id: randomUUID(), user_id: patient.userId, release_path: "clinician" }).select("id");
    check("patient cannot self-release an acute episode", refusedWrite(r), why(r));
    r = await p.from("supervisor_patients").insert({ supervisor_id: patient.userId, patient_id: other.userId, status: "active" }).select("id");
    check("patient cannot forge a clinician assignment", refusedWrite(r), why(r));
    r = await p.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: patient.userId, role: "clinician" }).select("id");
    check("patient cannot grant themselves a clinician membership", refusedWrite(r), why(r));
    r = await p.from("organization_members").update({ role: "super_user" }).eq("user_id", patient.userId).select("id");
    check("patient cannot elevate an existing membership", refusedWrite(r), why(r));
    r = await p.from("prescription_versions").insert({ user_id: patient.userId, source: "clinician_change", patient_prescription_id: patient.ppId, version_number: 9 }).select("id");
    check("patient cannot publish a prescription version", refusedWrite(r), why(r));
    r = await p.from("patient_prescriptions").update({ current_prescription_version_id: other.versionId }).eq("id", patient.ppId).select("id");
    check("patient cannot repoint their current prescription", refusedWrite(r), why(r));
    r = await p.from("prescription_pause_periods").insert({ patient_prescription_id: patient.ppId, paused_at: new Date().toISOString(), paused_by: patient.userId }).select("id");
    check("patient cannot pause/resume their program", refusedWrite(r), why(r));
    r = await p.from("profiles").update({ timezone: "Europe/Paris" }).eq("id", other.userId).select("id");
    check("patient cannot change another patient's profile", refusedWrite(r), why(r));
    r = await p.from("rehab_sessions").select("id").eq("user_id", other.userId);
    check("patient cannot read another patient's sessions", !r.error && r.data.length === 0);
    r = await p.from("invitations").select("id, token_hash");
    check("patient cannot read invitations / token hashes", !r.error ? r.data.length === 0 : true);
    r = await p.rpc("create_patient_invitation", { p_clinician_id: clinician.userId, p_organization_id: REAL_ORG_ID, p_email: `x-${RUN}@example.invalid`, p_token_hash: "0".repeat(64) });
    check("patient cannot create invitations via RPC (M2 authority is server-only)", denied(r), why(r));
    r = await p.rpc("pause_prescription", { p_patient_prescription_id: patient.ppId, p_clinician_id: clinician.userId });
    check("patient cannot call pause_prescription impersonating their clinician", denied(r), why(r));

    const c = clinician.db;
    r = await c.rpc("clinician_release_acute_episode", { p_episode_id: randomUUID(), p_clinician_id: clinician.userId, p_note: "x" });
    check("clinician cannot call the release RPC directly (release is server-only)", denied(r), why(r));
    r = await c.from("rehab_sessions").select("id").eq("user_id", other.userId);
    check("clinician cannot read an unassigned patient's sessions", !r.error && r.data.length === 0);
    r = await c.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: other.userId, status: "active" }).select("id");
    check("clinician cannot self-assign a patient", refusedWrite(r), why(r));
    r = await c.from("prescription_versions").insert({ user_id: patient.userId, source: "clinician_change", patient_prescription_id: patient.ppId, version_number: 9 }).select("id");
    check("clinician cannot bypass publish via direct insert", refusedWrite(r), why(r));

    r = await anon.from("profiles").select("id").limit(1);
    check("anon reads no profiles", !r.error ? r.data.length === 0 : true);
    r = await anon.from("organizations").insert({ name: "x", slug: `anon-${RUN}` }).select("id");
    check("anon cannot create organizations", refusedWrite(r), why(r));
    r = await anon.rpc("c5_record_first_performance", { p_patient_id: patient.userId, p_client_request_id: randomUUID(), p_expected_version_id: patient.versionId, p_workout_id: patient.workoutId, p_performance: {}, p_pre_start_skips: [], p_sequence_choice: null });
    check("anon cannot call C5 RPCs", denied(r), why(r));
  }

  // ================================================================ 2
  section(`2. Legacy patient write authority (${EXPECT_REVOKED ? "EXPECT REVOKED — Phase B" : "pre-revocation BASELINE"})`);
  {
    const p = patient.db;
    const legacyId = randomUUID();
    const attempts = [
      ["insert a legacy rehab_sessions row", () => p.from("rehab_sessions").insert({ id: legacyId, user_id: patient.userId, prescription_instance_id: `legacy:${legacyId}`, patient_local_date: "2026-10-20", started_at: new Date().toISOString(), prescription_snapshot: [] }).select("id")],
      ["update a legacy rehab_sessions row", () => p.from("rehab_sessions").update({ status: "exercises_complete" }).eq("id", legacyId).select("id")],
      ["insert legacy set_outcomes", () => p.from("set_outcomes").insert({ rehab_session_id: legacyId, exercise_id: "ex", exercise_order_index: 0, set_index: 0, outcome: "completed", actual_reps: 8, occurred_at: new Date().toISOString() }).select("id")],
      ["insert legacy session_events", () => p.from("session_events").insert({ rehab_session_id: legacyId, type: "other", occurred_at: new Date().toISOString() }).select("id")],
      ["insert legacy morning_responses", () => p.from("morning_responses").insert({ rehab_session_id: legacyId, user_id: patient.userId, scheduled_eligible_at: new Date().toISOString() }).select("id")],
      ["insert daily_logs", () => p.from("daily_logs").insert({ user_id: patient.userId, pain_during: 1, pain_after: 1, next_day_pain: 1, difficulty: 1, confidence: 1 }).select("id")],
      ["insert messages", () => p.from("messages").insert({ sender_id: patient.userId, recipient_id: clinician.userId, body: "x" }).select("id")],
      ["execute create_rehab_session_if_allowed", () => p.rpc("create_rehab_session_if_allowed", { p_session_id: randomUUID(), p_plan_id: null, p_prescription_instance_id: `legacy:${randomUUID()}`, p_patient_local_date: "2026-10-22", p_started_at: new Date().toISOString(), p_prescription_snapshot: [] })],
      ["execute record_blocked_loading_opportunity (self-escalation surface)", () => p.rpc("record_blocked_loading_opportunity", { p_acute_safety_episode_id: randomUUID(), p_prescription_instance_id: "x", p_brake_level: 5 })],
    ];
    for (const [label, run] of attempts) {
      const r = await run();
      const isRpc = label.startsWith("execute");
      const refused = refusedWrite(r);
      // An RPC that raises from its own body was EXECUTED (authority present).
      // A table write that fails for a non-privilege reason did not test authority.
      const invalidAttempt = !isRpc && Boolean(r.error) && !denied(r);
      if (EXPECT_REVOKED) {
        check(`legacy authority revoked: patient cannot ${label}`, refused, why(r));
      } else {
        if (invalidAttempt) check(`baseline attempt is a valid authority probe: ${label}`, false, why(r));
        const state = invalidAttempt ? "INVALID PROBE" : refused ? `refused (${r.error?.code ?? "0 rows"})` : isRpc && r.error ? `PERMITTED (executes; body raised ${r.error.code})` : "PERMITTED";
        baseline.push(`${label}: ${state}`);
        console.log(`BASE  patient can ${label}? ${state}`);
      }
    }
    await admin.from("set_outcomes").delete().eq("rehab_session_id", legacyId);
    await admin.from("session_events").delete().eq("rehab_session_id", legacyId);
    await admin.from("morning_responses").delete().eq("rehab_session_id", legacyId);
    await admin.from("daily_logs").delete().eq("user_id", patient.userId);
    await admin.from("messages").delete().eq("sender_id", patient.userId);
    await admin.from("rehab_sessions").delete().eq("user_id", patient.userId).is("training_status", null);
  }

  // ================================================================ 4
  section(`4. Cross-org, ended assignment, DELETE, M6 catalog, service-only RPCs (${EXPECT_REVOKED ? "post-revocation" : "baseline"})`);
  const { data: orgB } = await admin.from("organizations").insert({ name: `M3.1 adv org B ${RUN}`, slug: `m31adv-b-${RUN}` }).select("id").single();
  orgIds.push(orgB.id);
  const clinicianB = await makeUser("clinb", "clinician", orgB.id);
  const superB = await makeUser("superb", "super_user", orgB.id);
  const endedClinician = await makeUser("ended", "clinician");
  const cadmin = await makeUser("cadmin", "clinician_admin");
  const superA = await makeUser("supera", "super_user");
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: patient.userId, role: "member" });
  globalThis.__m31 = { clinicianB, endedClinician };
  await admin.from("supervisor_patients").insert({ supervisor_id: endedClinician.userId, patient_id: patient.userId, organization_id: REAL_ORG_ID, status: "dismissed", dismissed_at: new Date().toISOString(), dismissed_reason: "M3.1 adversarial fixture" });
  {
    let r = await clinicianB.db.from("rehab_sessions").select("id").eq("user_id", patient.userId);
    check("cross-org: a clinician in another organization reads none of the patient's sessions", !r.error && r.data.length === 0);
    r = await clinicianB.db.from("supervisor_patients").insert({ supervisor_id: clinicianB.userId, patient_id: patient.userId, organization_id: orgB.id, status: "active" }).select("id");
    check("cross-org: a clinician cannot assign themselves a patient of another organization", refusedWrite(r), why(r));
    r = await admin.rpc("admin_add_assignment", { p_actor_id: superB.userId, p_organization_id: orgB.id, p_clinician_id: clinicianB.userId, p_patient_id: patient.userId });
    const crossRows = (await admin.from("supervisor_patients").select("id").eq("supervisor_id", clinicianB.userId).eq("status", "active")).data ?? [];
    check("cross-org: the server assignment authority refuses a cross-organization assignment", (Boolean(r.error) || r.data?.result !== "added") && crossRows.length === 0, r.error?.message ?? JSON.stringify(r.data));
    r = await endedClinician.db.from("rehab_sessions").select("id").eq("user_id", patient.userId);
    check("ended assignment: the ended clinician reads none of the patient's sessions", !r.error && r.data.length === 0);
    r = await admin.rpc("clinician_patient_access", { p_clinician_id: endedClinician.userId, p_patient_id: patient.userId });
    check("ended assignment: Postgres assignment authority denies access", !r.error && r.data === false, r.error?.message ?? JSON.stringify(r.data));
    r = await patient.db.from("acute_safety_releases").insert({ acute_safety_episode_id: randomUUID(), user_id: patient.userId, release_path: "clinician", released_by_clinician_id: clinician.userId }).select("id");
    check("professional-review self-release (forged clinician release) refused", refusedWrite(r), why(r));
    r = await patient.db.rpc("clinician_release_acute_episode", { p_episode_id: randomUUID(), p_clinician_id: clinician.userId, p_note: "self" });
    check("professional-review release RPC unavailable to patients", denied(r), why(r));
    for (const fn of [["admin_add_assignment", { p_actor_id: patient.userId, p_organization_id: REAL_ORG_ID, p_clinician_id: clinician.userId, p_patient_id: patient.userId }], ["end_assignment", { p_actor_id: patient.userId, p_assignment_id: randomUUID(), p_reason: "x" }], ["publish_prescription_draft", { p_draft_id: randomUUID(), p_clinician_id: clinician.userId, p_expected_revision: 1 }], ["create_prescription_draft", { p_patient_id: patient.userId, p_clinician_id: clinician.userId, p_source: "empty", p_source_version_id: null, p_template_id: null }], ["c5_submit_morning_response", { p_patient_id: patient.userId, p_session_id: otherSession, p_response: {} }], ["accept_patient_invitation", { p_token_hash: "0".repeat(64), p_user_id: patient.userId }]]) {
      const rr = await clinician.db.rpc(fn[0], fn[1]);
      check(`service-only RPC ${fn[0]} unavailable to an authenticated client`, denied(rr), why(rr));
    }

    // Authenticated DELETE.
    const delTargets = [
      ["profiles", patient, (q) => q.eq("id", patient.userId)],
      ["organizations", superA, (q) => q.eq("id", REAL_ORG_ID)],
      ["clinician_exercise_favorites", clinician, (q) => q.eq("clinician_id", clinician.userId)],
      ["rehab_sessions", patient, (q) => q.eq("user_id", patient.userId)],
      ["set_outcomes", patient, (q) => q.eq("rehab_session_id", otherSession)],
      ["notifications", patient, (q) => q.eq("patient_id", patient.userId)],
      ["m6_heuristics", cadmin, (q) => q.eq("heuristic_key", "__none__")],
      ["m6_evidence_sources", cadmin, (q) => q.eq("title", "__none__")],
      ["m6_heuristic_evidence", cadmin, (q) => q.eq("notes", "__none__")],
    ];
    for (const [table, who, filter] of delTargets) {
      const rr = await filter(who.db.from(table).delete()).select("*");
      if (EXPECT_REVOKED) check(`authenticated DELETE on ${table} refused (42501)`, denied(rr), why(rr));
      else console.log(`BASE  authenticated DELETE on ${table}: ${rr.error ? rr.error.code : `0-row delete allowed by grant (${rr.data.length} rows)`}`);
    }
    // exercise_reference_dosage: the one preserved authenticated DELETE (C5.3D super_user, global only).
    const { data: gce } = await admin.from("canonical_exercises").insert({ name: `M3.1 adv refdose ${RUN}`, visibility: "global", active: true }).select("id").single();
    exerciseIds.push(gce.id);
    const { data: rd } = await admin.from("exercise_reference_dosage").insert({ exercise_id: gce.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 10, load_type: "not_applicable" }).select("id").single();
    let rr = await clinician.db.from("exercise_reference_dosage").delete().eq("id", rd.id).select("id");
    const stillThere = (await admin.from("exercise_reference_dosage").select("id").eq("id", rd.id)).data?.length === 1;
    check("exercise_reference_dosage: a regular clinician's DELETE removes nothing", !rr.error && rr.data.length === 0 && stillThere, why(rr));
    rr = await patient.db.from("exercise_reference_dosage").delete().eq("id", rd.id).select("id");
    check("exercise_reference_dosage: a patient's DELETE removes nothing", !rr.error && rr.data.length === 0);
    rr = await anon.from("exercise_reference_dosage").delete().eq("id", rd.id).select("id");
    check("exercise_reference_dosage: anon DELETE refused", refusedWrite(rr), why(rr));
    rr = await superA.db.from("exercise_reference_dosage").delete().eq("id", rd.id).select("id");
    check("exercise_reference_dosage: platform super_user DELETE works (preserved C5.3D authority)", !rr.error && rr.data.length === 1, why(rr));

    // M6 catalog authoring (CURRENT AUTHORITY — M6 AUTHORING).
    const key = `m31_adv_${RUN}`;
    heuristicKeys.push(key);
    rr = await cadmin.db.from("m6_heuristics").insert({ heuristic_key: key, name: "M3.1 adv", description: "adversarial", version_introduced: "v-adv", status: "proposed" }).select("id");
    check("M6: clinician_admin INSERTs a heuristic", !rr.error && rr.data.length === 1, why(rr));
    const hid = rr.data?.[0]?.id;
    rr = await cadmin.db.from("m6_heuristics").update({ rationale: "edited" }).eq("id", hid).select("id");
    check("M6: clinician_admin UPDATEs a heuristic", !rr.error && rr.data.length === 1, why(rr));
    rr = await cadmin.db.from("m6_evidence_sources").insert({ title: `M3.1 adv ${RUN} evidence`, status: "active", does_not_establish: "nothing" }).select("id");
    check("M6: clinician_admin INSERTs an evidence source", !rr.error && rr.data.length === 1, why(rr));
    const eid = rr.data?.[0]?.id;
    rr = await cadmin.db.from("m6_heuristic_evidence").insert({ heuristic_id: hid, evidence_source_id: eid, notes: "adv" }).select("id");
    check("M6: clinician_admin links heuristic <-> evidence", !rr.error && rr.data.length === 1, why(rr));
    rr = await patient.db.from("m6_heuristics").insert({ heuristic_key: `${key}_forged`, name: "x", description: "x", version_introduced: "x" }).select("id");
    check("M6: a patient cannot write the catalog", refusedWrite(rr), why(rr));
    rr = await clinician.db.from("m6_heuristics").update({ rationale: "clinician" }).eq("id", hid).select("id");
    check("M6: a regular clinician cannot update the catalog", refusedWrite(rr), why(rr));
    rr = await anon.from("m6_evidence_sources").insert({ title: "anon" }).select("id");
    check("M6: anon cannot write the catalog", refusedWrite(rr), why(rr));
    rr = await cadmin.db.from("m6_heuristics").select("id").eq("id", hid);
    check("M6: the catalog stays readable by org members", !rr.error && rr.data.length === 1, why(rr));
  }

  // ================================================================ 3
  section("3. HTTP — isolated production-mode server");
  await startProductionServer();
  try {
    const RETIRED = [
      ["GET", "/api/patient/rehab-session/current"],
      ["GET", "/api/patient/rehab-session/current/"],
      ["GET", "//api/patient/rehab-session/current"],
      ["GET", "/api/patient/./rehab-session/current"],
      ["GET", "/api/patient/x/../rehab-session/current"],
      ["GET", "/api/patient/rehab-session%2Fcurrent"],
      ["GET", "/API/patient/rehab-session/current"],
      ["POST", "/api/patient/rehab-session"],
      ["GET", "/api/auth/launch-dashboard"],
      ["POST", "/api/auth/validate-bridge"],
      ["POST", "/api/internal/supervisor-patients-sync"],
      ["GET", "/admin/invitations"],
      ["GET", "/api/auth/debug"],
    ];
    for (const [m, path] of RETIRED) {
      for (const bypass of [{}, { "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" }, { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" }]) {
        const r = await http(patient, m, path, m === "POST" ? {} : undefined, bypass);
        const tag = bypass["x-middleware-subrequest"] ? ` + ${bypass["x-middleware-subrequest"].split(":")[0]} bypass header` : "";
        const ok = [404, 410, 308, 400].includes(r.status) && !(r.body && (r.body.session || r.body.authenticated || r.body.ok));
        check(`retired route stays unavailable: ${m} ${path}${tag} (${r.status})`, ok, `status ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
      }
    }
    let r = await http(patient, "POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: "empty" });
    check("role confusion: a patient cannot use clinician APIs (403)", r.status === 403, `status ${r.status}`);
    r = await http(null, "GET", "/api/patient/c5/state");
    check("unauthenticated patient API -> 401", r.status === 401, `status ${r.status}`);
    r = await http(clinician, "POST", `/api/clinician/patients/${other.userId}/prescription-drafts`, { source: "empty" });
    check("cross-patient: clinician cannot draft for an unassigned patient (403)", r.status === 403 && r.body?.error === "PATIENT_NOT_AUTHORIZED", `status ${r.status} ${JSON.stringify(r.body)}`);
    for (const [label, who] of [["cross-org clinician", globalThis.__m31.clinicianB], ["ended-assignment clinician", globalThis.__m31.endedClinician]]) {
      const d = await http(who, "POST", `/api/clinician/patients/${patient.userId}/prescription-drafts`, { source: "empty" });
      check(`${label}: cannot draft for the patient over HTTP (403)`, d.status === 403, `status ${d.status} ${JSON.stringify(d.body)}`);
      const pz = await http(who, "POST", `/api/clinician/patients/${patient.userId}/prescription/pause`, {});
      check(`${label}: cannot pause the patient's program over HTTP (403)`, pz.status === 403, `status ${pz.status}`);
    }
    r = await http(clinician, "POST", `/api/clinician/patients/${other.userId}/prescription/pause`, {});
    check("cross-patient: clinician cannot pause an unassigned patient's program", r.status === 403, `status ${r.status}`);
    r = await http(patient, "GET", `/api/patient/c5/session/${otherSession}/view`);
    check("cross-patient: a patient cannot view another patient's session (404)", r.status === 404, `status ${r.status}`);
    r = await http(patient, "POST", `/api/patient/c5/session/${otherSession}/finish`, {});
    console.log(`      (finish other's session -> ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)})`);
    check("cross-patient: a patient cannot Finish another patient's session", r.status >= 400 || (r.body?.result && r.body.result !== "closed"), `status ${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
    const { data: otherRow } = await admin.from("rehab_sessions").select("training_status").eq("id", otherSession).single();
    check("cross-patient: the other patient's session is still Started", otherRow?.training_status === "started", otherRow?.training_status);
    r = await http(patient, "POST", "/api/patient/c5/start", {
      clientRequestId: randomUUID(), expectedVersionId: other.versionId, workoutId: other.workoutId, patientId: other.userId, userId: other.userId,
      performance: { exercise_id: other.exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, preStartSkips: [], sequenceChoice: null,
    });
    console.log(`      (spoofed start -> ${r.status} ${JSON.stringify(r.body)?.slice(0, 240)})`);
    const { data: spoofRows } = await admin.from("rehab_sessions").select("id").eq("user_id", other.userId);
    const { data: ownRows } = await admin.from("rehab_sessions").select("id, prescription_version_id").eq("user_id", patient.userId).not("training_status", "is", null);
    check("identity spoofing: body patientId is ignored (no session created for the other patient)", (spoofRows ?? []).length === 1, `other's sessions ${(spoofRows ?? []).length}`);
    check("identity spoofing: another patient's prescription version is never used for this patient", (ownRows ?? []).every((x) => x.prescription_version_id !== other.versionId) && r.body?.result !== "started", `status ${r.status} result ${r.body?.result} own C5 sessions ${JSON.stringify(ownRows)}`);
    r = await http(clinician, "POST", "/clinician/dashboard", "[]", { "next-action": "0".repeat(40), origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" });
    check("forged-origin server action is refused", r.status >= 400, `status ${r.status}`);
  } finally {
    await stopServer();
  }
  check("production server stopped (own process group only)", server.exited !== null && !(await listening()));
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    await stopServer();
    await teardown().catch((e) => console.error("teardown error", e));
    if (!EXPECT_REVOKED) console.log(`\nbaseline (pre-revocation legacy authority):\n  ${baseline.join("\n  ")}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
