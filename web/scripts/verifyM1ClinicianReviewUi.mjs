// M1 — clinician C5 visibility + safety review, live end-to-end over the
// REAL authenticated Next.js boundary (cookie login, clinician pages, the
// clinician release API, the patient C5 + acute-safety APIs, patient
// Progress) on the applied M1 migration. Throwaway @example.invalid users,
// throwaway legacy SQLite supervisor rows (the temporary M1 high-consequence
// check reads them through the EXISTING :8000 FastAPI — never restarted),
// full teardown. The database-level matrix lives in verifyM1ClinicianReview.sql.
//
// Servers (gates are server env vars, never weakened for a test):
//   ON  (default http://localhost:3001) — `next build` then
//       C5_PATIENT_RUNTIME_ENABLED=true npx next start -p 3001
//   OFF (default http://localhost:3000) — the normal dev server (gate off).
//
// Run from web/:
//   node scripts/verifyM1ClinicianReviewUi.mjs [onUrl] [offUrl] [screenshotDir]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { localDateOffset, localDowOffset, sqlLocalDate, sqlLocalInstant } from "./lib/patientLocalDate.mjs";
import { guardedFixtureTeardown } from "./lib/safetyFixturePurge.mjs";

const ON = process.argv[2] ?? "http://localhost:3001";
const OFF = process.argv[3] ?? "http://localhost:3000";
const SHOTS = process.argv[4] ?? null;
const REPO_ROOT = "..";
const LEGACY_DB_PATH = "../app/tenotrainer.db";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

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
const WORK = mkdtempSync(join(tmpdir(), "m1-"));
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
function sqlQuery(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
// Patient-local calendar arithmetic (never elapsed time: see lib/patientLocalDate.mjs).
function localDate(offsetDays = 0) {
  return localDateOffset(TZ, offsetDays);
}
function localDow(offsetDays = 0) {
  return localDowOffset(TZ, offsetDays);
}
function fmtLocal(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
async function waitFor(fn, timeoutMs = 15000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------- fixtures
const RUN_STARTED_AT = new Date(Date.now() - 60_000).toISOString();
const createdUsers = [];
const legacyUserIds = [];
const legacyLinkIds = [];
const exerciseIds = [];

async function makeUser(label, { role = null } = {}) {
  const email = `m1-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `M1 ${label}`, timezone: TZ });
  if (role) {
    const { error: e } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: data.user.id, role });
    if (e) throw e;
  }
  return { userId: data.user.id, email, label };
}
function legacy(fn) {
  const db = new DatabaseSync(LEGACY_DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function legacyUser(db, user, role) {
  const id = db.prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, ?, ?)").run(`m1-${user.label}`, user.email, role, user.userId).lastInsertRowid;
  legacyUserIds.push(id);
  return id;
}
// PG assignment (+ the temporary legacy mirror used by the high-consequence check).
async function assign(clinician, patient, { legacyMirror = true } = {}) {
  const { error } = await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: patient.userId, status: "active" });
  if (error) throw error;
  if (legacyMirror) {
    legacy((db) => {
      clinician.legacyId ??= legacyUser(db, clinician, "supervisor");
      patient.legacyId ??= legacyUser(db, patient, "patient");
      legacyLinkIds.push(db.prepare("INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (?, ?, 'active')").run(clinician.legacyId, patient.legacyId).lastInsertRowid);
    });
  }
}

async function makeExercise(name) {
  const { data, error } = await admin.from("canonical_exercises").insert({ name: `M1 ${name} ${randomUUID().slice(0, 6)}`, visibility: "global", active: true }).select("id, name").single();
  if (error) throw error;
  exerciseIds.push(data.id);
  return data;
}

// Program: workouts [{ label, days, exercises: [{ ex, dosage }] }].
async function makeProgram(patient, clinicianId, { mode = "sequence", target = 3, recovery = 1, workouts }) {
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({
      user_id: patient.userId, source: "clinician_change", patient_prescription_id: pp.id, version_number: 1,
      published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: clinicianId,
      scheduling_mode: mode, target_sessions_per_week: mode === "sequence" ? target : null, recovery_days: recovery,
    })
    .select("id")
    .single();
  if (error) throw error;
  const ws = [];
  for (const [wi, w] of workouts.entries()) {
    const { data: wr } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: w.label, order_index: wi, days_of_week: w.days ?? null }).select("id").single();
    const exs = [];
    for (const [ei, e] of w.exercises.entries()) {
      const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: wr.id, canonical_exercise_id: e.ex.id, order_index: ei, status: "active", additional_instructions: e.instructions ?? null }).select("id").single();
      const { error: de } = await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, ...e.dosage });
      if (de) throw de;
      exs.push(pe.id);
    }
    ws.push({ id: wr.id, exercises: exs });
  }
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return { ppId: pp.id, versionId: v.id, workouts: ws, mode };
}

const q = (v) => (v == null ? "NULL" : typeof v === "number" || typeof v === "boolean" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// SQL for one closed C5 session started `daysAgo` patient-local calendar days
// ago, at 2 h before now's local clock time (kept on that date: see
// sqlLocalClock); its morning is due the next local date at the same time. units: [{ ex, si, outcome, reps, load, unit, dur }].
// immediate: { pain, painUtr, rpe, rpeUtr, sudden, pop, nfd } | "pending".
// morning: { kind: "answered", pain, stiff, dur, note, lateDays } | { kind: "utr" } | "open".
// escalation: { level, hoursAgo } | null.
function closedSessionSql(patient, program, { sid = randomUUID(), daysAgo, status, wi, units, immediate, morning, escalation = null, calendarDate = null, sequenceChoice = null, resolves = null }) {
  const w = program.workouts[wi];
  const started = sqlLocalInstant(TZ, -daysAgo, { minutesBefore: 120 });
  const lines = [];
  lines.push(`INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id, calendar_scheduled_date, sequence_choice, resolves_stopped_session_id)
VALUES ('${sid}', '${patient.userId}', 'c5:${sid}', ${sqlLocalDate(TZ, -daysAgo)}, NULL, 'started', ${started},
  c5_build_session_snapshot('${program.versionId}', '${w.id}'), '${program.versionId}', '${w.id}', '${TZ}', gen_random_uuid(), ${calendarDate ? `${q(calendarDate)}::date` : "NULL"}, ${q(sequenceChoice)}, ${resolves ? q(resolves) : "NULL"});`);
  for (const u of units) {
    lines.push(`INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, actual_load, actual_load_unit, actual_duration_seconds, occurred_at)
VALUES ('${sid}', '${w.exercises[u.ex]}', ${u.ex}, ${u.si}, '${u.outcome}', ${q(u.reps ?? null)}, ${q(u.load ?? null)}, ${q(u.unit ?? null)}, ${q(u.dur ?? null)}, ${started} + interval '${5 + u.si} minutes');`);
  }
  lines.push(`UPDATE rehab_sessions SET training_status = '${status}', training_closed_at = ${started} + interval '30 minutes' WHERE id = '${sid}';`);
  if (immediate === "pending") {
    lines.push(`INSERT INTO session_immediate_responses (rehab_session_id, user_id) VALUES ('${sid}', '${patient.userId}');`);
  } else {
    lines.push(`INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, peak_pain_unable_to_recall, overall_session_rpe, rpe_unable_to_recall, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at, created_at)
VALUES ('${sid}', '${patient.userId}', ${q(immediate.painUtr ? null : immediate.pain)}, ${!!immediate.painUtr}, ${q(immediate.rpeUtr ? null : immediate.rpe)}, ${!!immediate.rpeUtr}, ${!!immediate.sudden}, ${!!immediate.pop}, ${!!immediate.nfd}, ${started} + interval '40 minutes', ${started} + interval '30 minutes');`);
  }
  const due = sqlLocalInstant(TZ, 1 - daysAgo, { minutesBefore: 120 });
  if (morning === "open") {
    lines.push(`INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date) VALUES ('${sid}', '${patient.userId}', ${due}, (${due} AT TIME ZONE '${TZ}')::date);`);
  } else if (morning.kind === "utr") {
    lines.push(`INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at) VALUES ('${sid}', '${patient.userId}', ${due}, (${due} AT TIME ZONE '${TZ}')::date, 'unable_to_recall', ${due} + interval '1 hour');`);
  } else {
    lines.push(`INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at, next_morning_pain, next_morning_stiffness, stiffness_duration, patient_note)
VALUES ('${sid}', '${patient.userId}', ${due}, (${due} AT TIME ZONE '${TZ}')::date, 'answered', ${due} + interval '${morning.lateDays ?? 0} days' + interval '1 minute', ${morning.pain}, ${morning.stiff}, ${q(morning.dur ?? null)}, ${q(morning.note ?? null)});`);
  }
  if (escalation) {
    lines.push(`INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
VALUES ('${sid}', ${escalation.level}, '${escalation.level === 5 ? "pop_felt_or_heard" : "sudden_or_sharp_pain"}', 'v1', '{"source":"c5_immediate_response"}'::jsonb, now() - interval '${escalation.hoursAgo} hours');`);
  }
  return { sid, sql: lines.join("\n") };
}

async function reconcile(patient) {
  const { error } = await admin.rpc("reconcile_missing_acute_episodes", { p_user_id: patient.userId });
  if (error) throw error;
}
async function episodesOf(patient) {
  const { data } = await admin.from("acute_safety_episodes").select("id, initial_level, confirmed_at").eq("user_id", patient.userId).order("confirmed_at");
  return data ?? [];
}
async function releasesOf(patient) {
  const { data } = await admin.from("acute_safety_releases").select("*").eq("user_id", patient.userId);
  return data ?? [];
}

async function teardown() {
  // M3.2 — the guarded exact-id purge (safety-notification history is
  // immutable, so ordinary deletes can no longer remove these fixtures).
  guardedFixtureTeardown(env, { userIds: createdUsers, exerciseIds, runStartedAt: RUN_STARTED_AT });
  legacy((db) => {
    for (const id of legacyLinkIds) db.prepare("DELETE FROM supervisor_patients WHERE id = ?").run(id);
    for (const id of legacyUserIds) db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
}

// ---------------------------------------------------------------- browser / API
async function login(browser, email, viewport = DESKTOP, base = ON) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  await page.close();
  return context;
}
async function api(ctx, method, path, data, base = ON) {
  const res = await ctx.request.fetch(`${base}${path}`, { method, data, failOnStatusCode: false, maxRedirects: 0 });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status(), body };
}
const state = async (ctx) => (await api(ctx, "GET", "/api/patient/c5/state")).body?.state;
async function text(ctx, path, base = ON) {
  const page = await ctx.newPage();
  const res = await page.goto(`${base}${path}`);
  const body = await page.locator("body").innerText();
  const status = res?.status() ?? 0;
  return { page, status, body };
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
const JUDGMENT = /\b(good|bad|poor|excellent|non-?complian|failed|failure|warning|risk|overtrain|L[345]\b)/i;

async function main() {
  const probe = await fetch(`${ON}/api/clinician/patients/${randomUUID()}/acute-safety/${randomUUID()}/release`, { method: "POST" });
  check("gate-on server reachable; unauthenticated clinician release is 401", probe.status === 401, `status ${probe.status}`);

  // ------------------------------------------------------------ people
  const clinA = await makeUser("clinician-a", { role: "clinician" });
  const clinB = await makeUser("clinician-b", { role: "clinician" }); // never assigned
  const P1 = await makeUser("p1-record");
  const P2 = await makeUser("p2-level3");
  const P3 = await makeUser("p3-level5");
  const P4 = await makeUser("p4-eff4");
  const P5 = await makeUser("p5-multi");
  const P6 = await makeUser("p6-calendar");
  const P7 = await makeUser("p7-mixed", { role: "tester" });
  for (const p of [P1, P2, P6, P7]) await assign(clinA, p, { legacyMirror: false });
  for (const p of [P3, P4, P5]) await assign(clinA, p);

  const exRep = await makeExercise("Heel raise");
  const exHold = await makeExercise("Isometric hold");
  const REP = { dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "external", load_mode: "exact", load_value_exact: 20, load_unit: "kg" };
  const HOLD = { dosage_type: "hold", sets: 2, hold_duration_mode: "exact", hold_duration_exact_seconds: 30, load_type: "not_applicable" };
  const simple = [
    { label: "A", exercises: [{ ex: exRep, dosage: REP }] },
    { label: "B", exercises: [{ ex: exRep, dosage: REP }] },
  ];

  const prog1 = await makeProgram(P1, clinA.userId, {
    target: 3, recovery: 1,
    workouts: [
      { label: "A", exercises: [{ ex: exRep, dosage: REP, instructions: "Slow lowering" }, { ex: exHold, dosage: HOLD }] },
      { label: "B", exercises: [{ ex: exRep, dosage: REP }] },
    ],
  });
  const progs = {};
  for (const p of [P2, P3, P4, P5, P7]) progs[p.label] = await makeProgram(p, clinA.userId, { workouts: simple, recovery: 0 });
  const prog6 = await makeProgram(P6, clinA.userId, { mode: "calendar", recovery: 0, workouts: [{ label: "A", days: [localDow(-3)], exercises: [{ ex: exRep, dosage: REP }] }] });

  // ------------------------------------------------------------ fixture history (one transaction)
  const s6 = closedSessionSql(P1, prog1, {
    daysAgo: 6, status: "finished", wi: 0,
    units: [
      { ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" },
      { ex: 0, si: 1, outcome: "completed", reps: 6, load: 20, unit: "kg" },
      { ex: 0, si: 2, outcome: "skipped" },
      { ex: 1, si: 0, outcome: "completed", dur: 30 },
      { ex: 1, si: 1, outcome: "skipped" },
    ],
    immediate: { pain: 0, rpe: 7 },
    morning: { kind: "answered", pain: 2, stiff: 3, dur: "min_5_15", note: "Felt fine", lateDays: 2 },
  });
  const s4 = closedSessionSql(P1, prog1, { daysAgo: 4, status: "stopped_early", wi: 1, units: [{ ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" }], immediate: { painUtr: true, rpe: 0 }, morning: { kind: "utr" } });
  const s3 = closedSessionSql(P1, prog1, { daysAgo: 3, status: "stopped_pause", wi: 0, units: [{ ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" }], immediate: { pain: 1, rpe: 3 }, morning: { kind: "answered", pain: 1, stiff: 0 } });
  const s1 = closedSessionSql(P1, prog1, { daysAgo: 1, status: "finished", wi: 1, units: [{ ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" }], immediate: { pain: 4, rpe: 5 }, morning: { kind: "answered", pain: 2, stiff: 0 }, sequenceChoice: "advance_next", resolves: s3.sid });

  const acute = (p, daysAgo, flags, escalation) =>
    closedSessionSql(p, progs[p.label], { daysAgo, status: "stopped_acute", wi: 0, units: [{ ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" }], immediate: { pain: 5, rpe: 6, ...flags }, morning: { kind: "utr" }, escalation });
  const a2 = acute(P2, 1, { sudden: true }, { level: 3, hoursAgo: 2 });
  const a3 = acute(P3, 1, { pop: true }, { level: 5, hoursAgo: 3 });
  const a4 = acute(P4, 3, { sudden: true }, { level: 3, hoursAgo: 60 });
  const a5old = acute(P5, 4, { pop: true }, { level: 5, hoursAgo: 50 });
  const a5new = acute(P5, 2, { sudden: true }, { level: 3, hoursAgo: 3 });
  const c6 = closedSessionSql(P6, prog6, { daysAgo: 2, status: "finished", wi: 0, units: [{ ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" }], immediate: "pending", morning: "open", calendarDate: localDate(-3) });
  const m7 = closedSessionSql(P7, progs[P7.label], { daysAgo: 1, status: "finished", wi: 0, units: [{ ex: 0, si: 0, outcome: "completed", reps: 8, load: 20, unit: "kg" }], immediate: { pain: 2, rpe: 4 }, morning: { kind: "answered", pain: 1, stiff: 0 } });
  const legacySid = randomUUID();
  const legacyRow = `INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, started_at, prescription_snapshot)
VALUES ('${legacySid}', '${P7.userId}', 'legacy-${legacySid}', ${sqlLocalDate(TZ, -10)}, 'in_progress', ${sqlLocalInstant(TZ, -10)},
  '[{"ex_id":"legacy_heel_raise","name":"Legacy heel raise","category":"strength","loading_profile":null,"order_index":0,"dosage":{"sets":3,"reps_or_hold_time":8}}]'::jsonb);`;
  sqlQuery(["BEGIN;", s6.sql, s4.sql, s3.sql, s1.sql, a2.sql, a3.sql, a4.sql, a5old.sql, a5new.sql, c6.sql, m7.sql, legacyRow, "COMMIT;"].join("\n"));
  for (const p of [P2, P3, P4, P5]) await reconcile(p);
  // Old M5 release path: a NEWER prescription version after P3's episode.
  await admin.from("prescription_versions").insert({
    user_id: P3.userId, source: "clinician_change", patient_prescription_id: progs[P3.label].ppId, version_number: 2,
    published_at: new Date().toISOString(), published_by: clinA.userId, scheduling_mode: "sequence", target_sessions_per_week: 3, recovery_days: 0,
  });

  const browser = await chromium.launch();
  try {
    // ======================================================================
    section("A. Today's session through the real patient API (edit provenance, skip, Finish)");
    let todaySid = null;
    {
      const ctx = await login(browser, P1.email);
      const s = await state(ctx);
      check("P1 eligible today with advisory recovery guidance (trained yesterday, 1 day recommended)", s?.kind === "available" && !!s.recovery, JSON.stringify({ k: s?.kind, r: s?.recovery }));
      const dec = await api(ctx, "POST", "/api/patient/c5/recovery-decision", { clientRequestId: randomUUID(), decision: "continue" });
      check("Continue recorded", dec.body?.result === "recorded", JSON.stringify(dec.body));
      const opt = s.options[0];
      const ex0 = prog1.workouts[0].exercises[0];
      check("Sequence offers workout A after B", opt.workoutId === prog1.workouts[0].id);
      const start = await api(ctx, "POST", "/api/patient/c5/start", {
        clientRequestId: randomUUID(), expectedVersionId: prog1.versionId, workoutId: opt.workoutId, sequenceChoice: null, preStartSkips: [],
        performance: { exercise_id: ex0, unit_index: 0, outcome: "completed", actual_reps: 8, actual_load: 20, actual_load_unit: "kg" },
      });
      todaySid = start.body?.session?.id;
      check("Start on first confirmed set", start.body?.result === "started" && !!todaySid, JSON.stringify(start.body).slice(0, 200));
      const edit = await api(ctx, "POST", `/api/patient/c5/session/${todaySid}/performance`, { edit: true, performance: { exercise_id: ex0, unit_index: 0, outcome: "completed", actual_reps: 10, actual_load: 20, actual_load_unit: "kg" } });
      const retry = await api(ctx, "POST", `/api/patient/c5/session/${todaySid}/performance`, { edit: true, performance: { exercise_id: ex0, unit_index: 0, outcome: "completed", actual_reps: 10, actual_load: 20, actual_load_unit: "kg" } });
      const { data: edits } = await admin.from("set_outcome_edits").select("*").eq("rehab_session_id", todaySid);
      const { data: unit0 } = await admin.from("set_outcomes").select("actual_reps, was_edited").eq("rehab_session_id", todaySid).eq("set_index", 0).eq("exercise_id", ex0).single();
      check("F. edit: original 8 preserved, corrected 10 authoritative, identical retry adds no history",
        edit.status === 200 && retry.status === 200 && edits?.length === 1 && Number(edits[0].previous_actual_reps) === 8 && Number(edits[0].new_actual_reps) === 10
        && edits[0].user_id === P1.userId && Number(unit0.actual_reps) === 10 && unit0.was_edited === true, JSON.stringify({ edits, unit0 }));
      const skip = await api(ctx, "POST", `/api/patient/c5/session/${todaySid}/performance`, { performance: { exercise_id: ex0, unit_index: 1, outcome: "skipped" } });
      const finish = await api(ctx, "POST", `/api/patient/c5/session/${todaySid}/finish`, {});
      check("skip recorded and session Finished", skip.status === 200 && finish.body?.result === "closed" && finish.body?.trainingStatus === "finished", JSON.stringify(finish.body).slice(0, 200));
      await ctx.close();
    }

    // ======================================================================
    section("B/C. Clinician: roster, Overview, Sessions list + detail (C5 patient P1)");
    const ctxA = await login(browser, clinA.email);
    {
      const { page, body } = await text(ctxA, "/clinician/dashboard");
      const row = (p) => page.locator("tr", { hasText: `M1 ${p.label}` }).first();
      const r1 = await row(P1).innerText();
      check("10. roster: C5 last activity counted (Today) and stage shown as Not recorded (no stale stage)", r1.includes("Today") && r1.includes("Not recorded") && !/Stage \d/.test(r1), r1);
      check("10. roster: recent C5 activity counted (5 closed sessions in 14 days)", r1.includes("5 sessions in last 14 days"), r1);
      check("11. roster: immediate check-in pending for today's session", r1.includes("Check-in pending"), r1);
      const r6 = await row(P6).innerText();
      check("11. roster: C5 morning obligation shows (due)", r6.includes("Morning response due"), r6);
      const r3 = await row(P3).innerText();
      check("roster: Level 5 hold reads 'Clinician release required' (process language)", r3.includes("Clinician release required") && !/level|L5/i.test(r3.replace(`M1 ${P3.label}`, "")), r3);
      const r2 = await row(P2).innerText();
      check("roster: ordinary Level 3 reads 'Safety check-in pending'", r2.includes("Safety check-in pending"), r2);
      check("roster renders without legacy-only blind spots for C5 patients", body.includes(`M1 ${P1.label}`));
      await page.close();
    }
    {
      const { page, status, body } = await text(ctxA, `/clinician/patients/${P1.userId}`);
      const nav = await page.locator('[data-testid="patient-nav"]').innerText();
      check("D3. C5 nav is Overview | Program | Sessions | Safety (no legacy Progress/Review tabs)", nav.includes("Program") && nav.includes("Sessions") && nav.includes("Safety") && !nav.includes("Progress") && !nav.includes("Review"), nav);
      const pState = await state(await login(browser, P1.email));
      check("Overview: current version, pause state, weekly X/Y from the authoritative state",
        status === 200 && body.includes("Version 1 · Sequence") && body.includes("Active") && body.includes(`${pState.weekly.finishedSessions} of 3 sessions finished`), body.slice(0, 600));
      check("Overview: eligibility (post-session check-in needed) and latest session shown", body.includes("Post-session check-in needed before the next workout") && body.toLowerCase().includes("most recent session") && body.includes("Check-in pending"), body.slice(0, 900));
      check("Overview: no stale Stage/Irritability presented", !/Irritability|Stage \d/.test(body));
      check("Overview: recent recovery choice listed as advisory", body.includes("continued with training"));
      await page.close();
    }
    {
      const { page, status, body } = await text(ctxA, `/clinician/patients/${P1.userId}/sessions`);
      const items = await page.locator("[data-c5-session]").count();
      check("2. Sessions list: all 5 C5 sessions, newest first", status === 200 && items === 5 && (await page.locator("[data-c5-session]").first().getAttribute("data-c5-session")) === todaySid, `items ${items}`);
      check("6. list shows each terminal state distinctly", ["Finished", "Stopped early", "Stopped — program paused"].every((t) => body.includes(t)));
      check("8. list: unknown pain is 'Unknown (unable to recall)', a recorded 0 is '0/10', RPE 0 is '0 · At rest'",
        body.includes("Unknown (unable to recall)") && body.includes("0/10") && body.includes("0 · At rest") && body.includes("7 · Very hard"));
      check("list: no performance judgment wording", !JUDGMENT.test(body), body.match(JUDGMENT)?.[0]);
      await page.close();
    }
    {
      const { page, status, body } = await text(ctxA, `/clinician/patients/${P1.userId}/sessions/${s6.sid}`);
      check("2/3. detail: prescribed vs performed with load and unit", status === 200 && body.includes("Prescribed: 3 × 8") && body.includes("8 reps · 20 kg") && body.includes("6 reps · 20 kg"), body.slice(0, 800));
      check("4. skipped is 'Skipped', never 0 reps; hold recorded in seconds", (await page.locator('[data-c5-unit="skipped"]').count()) === 2 && body.includes("30 seconds") && !body.includes("0 reps"));
      check("7. immediate: peak pain 0/10 and RPE '7 · Very hard'", body.includes("0/10") && body.includes("7 · Very hard"));
      check("9. morning: intended morning, due, submitted and the 2-day delay; stiffness duration and note",
        body.includes("Submitted (2 days after the intended morning)") && body.includes("Intended morning") && body.includes("5–15 minutes") && body.includes("Felt fine") && body.includes(`(${TZ})`));
      check("timestamps are labelled with the patient's time zone", body.includes(`(${TZ})`));
      await page.close();
    }
    {
      const { page, body } = await text(ctxA, `/clinician/patients/${P1.userId}/sessions/${todaySid}`);
      check("5. detail: corrected set shows original -> corrected neutrally", body.includes("Corrected by patient during the session: 8 reps · 20 → 10 reps · 20") || body.includes("Corrected by patient during the session: 8 reps"), body.match(/Corrected[^\n]*/)?.[0]);
      check("5. no misconduct wording for a correction", !/suspicious|tamper|alter(ed)? record|void/i.test(body));
      check("detail: today's Continue recovery decision with its recorded facts (advisory)", body.includes("Chose to continue") && body.includes("Advisory only"));
      check("detail: open check-in shown as not yet submitted", body.includes("Not yet submitted"));
      await page.close();
    }
    {
      const { body } = await text(ctxA, `/clinician/patients/${P1.userId}/sessions/${s4.sid}`);
      check("8. detail: pain unable-to-recall stays Unknown; RPE 0 stays '0 · At rest'; morning unable to recall", body.includes("Unknown (unable to recall)") && body.includes("0 · At rest") && body.includes("Submitted — unable to recall"));
    }
    {
      const { body } = await text(ctxA, `/clinician/patients/${P1.userId}/sessions/${s1.sid}`);
      check("detail: Sequence choice and stiffness 0 (no duration) shown", body.includes("Moved on to the next workout") && body.includes("No stiffness"));
    }
    {
      const { body } = await text(ctxA, `/clinician/patients/${P6.userId}/sessions/${c6.sid}`);
      check("scheduled date != performed date (Calendar make-up)", body.includes("Scheduled date") && body.includes(fmtLocal(localDate(-3))) && body.includes(fmtLocal(localDate(-2))));
      check("open morning obligation is 'Due — not yet submitted'", body.includes("Due — not yet submitted"));
    }
    {
      const { body } = await text(ctxA, `/clinician/patients/${P3.userId}/sessions/${a3.sid}`);
      check("6. Stopped Acute is labelled as a safety stop, distinct from Stopped early", body.includes("Stopped for a safety concern") && !body.includes("Stopped early"));
      check("detail safety: process language first, level only as provenance", body.includes("A safety episode was raised") && body.includes("Provenance: escalation level 5"));
    }

    // ======================================================================
    section("E. Level 3 self-resolution (P2)");
    {
      const ctx = await login(browser, P2.email);
      const before = await state(ctx);
      check("Level 3: brake active (safety check-in)", before?.kind === "acute_blocked" && before.gate === "acute_safety_review_required", JSON.stringify(before));
      const [ep] = await episodesOf(P2);
      const r = await api(ctx, "POST", "/api/patient/acute-safety/reassessment", { episodeId: ep.id, suddenOrSharpPainResolved: true, newFunctionalDifficultyResolved: null, evaluatedByProfessional: false });
      check("13. Level 3 patient reassessment releases (self-resolved)", r.body?.release?.releasePath === "self_resolved_no_evaluation" && r.body?.clinicianReleaseRequired === false, JSON.stringify(r.body).slice(0, 200));
      const after = await state(ctx);
      check("Level 3: C5 eligibility restored", after?.kind === "available", after?.kind);
      await ctx.close();
    }

    // ======================================================================
    section("E. Level 5 requires clinician release (P3)");
    const [ep3] = await episodesOf(P3);
    {
      const ctx = await login(browser, P3.email);
      const before = await state(ctx);
      check("Level 5: hold active, professional review", before?.kind === "acute_blocked" && before.gate === "acute_safety_professional_review_required", JSON.stringify(before));
      const r = await api(ctx, "POST", "/api/patient/acute-safety/reassessment", { episodeId: ep3.id, suddenOrSharpPainResolved: null, newFunctionalDifficultyResolved: null, evaluatedByProfessional: true, clearedByProfessional: true });
      check("15. Level 5 patient 'cleared' + newer version does NOT release (recorded, clinician required)",
        r.status === 200 && r.body?.release === null && r.body?.clinicianReleaseRequired === true && (await releasesOf(P3)).length === 0, JSON.stringify(r.body).slice(0, 200));
      const still = await state(ctx);
      check("21. training remains blocked before clinician release", still?.kind === "acute_blocked" && still.gate === "acute_safety_professional_review_required");
      const { body } = await text(ctx, "/patient/acute-safety", ON);
      check("patient copy: the clinician reviews and releases the hold", body.includes("Your clinician needs to review this concern and release your training hold"), body.slice(0, 400));
      const selfRelease = await api(ctx, "POST", `/api/clinician/patients/${P3.userId}/acute-safety/${ep3.id}/release`, { note: "self" });
      check("18. the patient cannot invoke the clinician release (role refused, nothing written)", selfRelease.status === 403 && (await releasesOf(P3)).length === 0, `status ${selfRelease.status}`);
      await ctx.close();
    }
    {
      const ctxB = await login(browser, clinB.email);
      const page = await text(ctxB, `/clinician/patients/${P3.userId}/safety`);
      check("17/26. unrelated clinician: Safety page is 404", page.status === 404, `status ${page.status}`);
      const r = await api(ctxB, "POST", `/api/clinician/patients/${P3.userId}/acute-safety/${ep3.id}/release`, { note: "not mine" });
      check("17. unrelated clinician release refused (404 not_authorized), nothing written", r.status === 404 && (await releasesOf(P3)).length === 0, JSON.stringify(r));
      const sess = await text(ctxB, `/clinician/patients/${P1.userId}/sessions`);
      check("26. unrelated clinician: Sessions page is 404", sess.status === 404);
      await ctxB.close();
    }
    {
      const page = await ctxA.newPage();
      await page.setViewportSize(MOBILE);
      await page.goto(`${ON}/clinician/patients/${P3.userId}/safety`);
      const open = await page.locator('[data-testid="safety-open"]').innerText();
      check("Safety: reassessment info visible, clinician release required, level as provenance only",
        open.includes("Clinician release required") && open.includes("evaluated by a professional — Yes") && open.includes("(patient report)") && open.includes("effective level 5"), open);
      check("Safety page fits 390px (no horizontal overflow)", await noOverflow(page));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/safety-mobile.png`, fullPage: true });
      const empty = await api(ctxA, "POST", `/api/clinician/patients/${P3.userId}/acute-safety/${ep3.id}/release`, { note: "   " });
      check("note is required (blank refused)", empty.status === 400 && empty.body?.result === "invalid_note");
      await page.getByTestId("release-open").click();
      await page.fill(`#release-note-${ep3.id}`, "Reviewed in clinic today; cleared to resume loading.");
      await page.getByTestId("release-confirm").click();
      check("16. assigned clinician releases through the UI", await waitFor(async () => (await releasesOf(P3)).length === 1));
      const [rel] = await releasesOf(P3);
      check("20. release provenance: clinician id, note, database time, no patient reassessment",
        rel?.release_path === "clinician_release" && rel.released_by_clinician_id === clinA.userId && rel.release_note === "Reviewed in clinic today; cleared to resume loading."
        && rel.source_reassessment_id === null && !!rel.released_at, JSON.stringify(rel));
      const dup = await api(ctxA, "POST", `/api/clinician/patients/${P3.userId}/acute-safety/${ep3.id}/release`, { note: "again" });
      check("19. duplicate release is idempotent (same release, note unchanged)",
        dup.status === 200 && dup.body?.result === "already_released" && dup.body?.release?.id === rel.id && (await releasesOf(P3)).length === 1 && (await releasesOf(P3))[0].release_note === rel.release_note, JSON.stringify(dup.body).slice(0, 200));
      await page.reload();
      const resolved = await page.locator('[data-testid="safety-resolved"]').innerText();
      check("immutable release history shown with clinician and note", resolved.includes("Released by clinician") && resolved.includes("Reviewed in clinic today"), resolved);
      await page.close();
      const ctx = await login(browser, P3.email);
      check("22. eligibility returns after the clinician release", (await state(ctx))?.kind === "available");
      await ctx.close();
    }

    // ======================================================================
    section("E. Effective Level 4 (Level 3 unresolved > 48 h) — P4");
    {
      const [ep] = await episodesOf(P4);
      const ctx = await login(browser, P4.email);
      const before = await state(ctx);
      check("effective >=4: professional-review hold", before?.kind === "acute_blocked" && before.gate === "acute_safety_professional_review_required", JSON.stringify(before));
      const r = await api(ctx, "POST", "/api/patient/acute-safety/reassessment", { episodeId: ep.id, suddenOrSharpPainResolved: true, newFunctionalDifficultyResolved: null, evaluatedByProfessional: false });
      check("14. effective >=4 patient reassessment does NOT release", r.body?.release === null && r.body?.clinicianReleaseRequired === true && (await releasesOf(P4)).length === 0, JSON.stringify(r.body).slice(0, 200));
      check("21. still blocked", (await state(ctx))?.kind === "acute_blocked");
      const rel = await api(ctxA, "POST", `/api/clinician/patients/${P4.userId}/acute-safety/${ep.id}/release`, { note: "Reviewed; symptoms resolved." });
      check("assigned clinician releases the effective-4 hold", rel.status === 200 && rel.body?.result === "released", JSON.stringify(rel.body).slice(0, 200));
      check("22. eligibility restored", (await state(ctx))?.kind === "available");
      await ctx.close();
    }

    // ======================================================================
    section("E. Two simultaneous open episodes (older Level 5 + newer Level 3) — P5");
    {
      const eps = await episodesOf(P5);
      const older = eps.find((e) => e.initial_level === 5);
      const newer = eps.find((e) => e.initial_level === 3);
      const page = await ctxA.newPage();
      await page.goto(`${ON}/clinician/patients/${P5.userId}/safety`);
      check("23. both open episodes visible on Safety", (await page.locator('[data-testid="safety-open"] [data-c5-episode]').count()) === 2);
      const ctx = await login(browser, P5.email);
      const r = await api(ctx, "POST", "/api/patient/acute-safety/reassessment", { episodeId: newer.id, suddenOrSharpPainResolved: true, newFunctionalDifficultyResolved: null, evaluatedByProfessional: false });
      check("newer ordinary Level 3 resolves by patient reassessment", r.body?.release?.releasePath === "self_resolved_no_evaluation", JSON.stringify(r.body).slice(0, 200));
      check("training still held by the older Level 5", (await state(ctx))?.gate === "acute_safety_professional_review_required");
      await page.reload();
      check("23. the Level 5 episode stays open and visible; the Level 3 moves to resolved (nothing disappears)",
        (await page.locator(`[data-testid="safety-open"] [data-c5-episode="${older.id}"]`).count()) === 1 && (await page.locator(`[data-testid="safety-resolved"] [data-c5-episode="${newer.id}"]`).count()) === 1);
      await page.getByTestId("release-open").click();
      await page.fill(`#release-note-${older.id}`, "Seen by physician; cleared.");
      await page.getByTestId("release-confirm").click();
      check("23. the Level 5 episode is released independently", await waitFor(async () => (await releasesOf(P5)).length === 2));
      check("22. eligibility restored once both are resolved", await waitFor(async () => (await state(ctx))?.kind === "available"));
      await page.reload();
      check("both episodes in the resolved history", (await page.locator('[data-testid="safety-resolved"] [data-c5-episode]').count()) === 2);
      await page.close();
      await ctx.close();
    }

    // ======================================================================
    section("G. Authorization / isolation");
    {
      const forged = await text(ctxA, `/clinician/patients/${P2.userId}/sessions/${s6.sid}`);
      check("26. a session id paired with another (assigned) patient is 404", forged.status === 404, `status ${forged.status}`);
      const ctxP = await login(browser, P1.email);
      const res = await ctxP.request.fetch(`${ON}/clinician/patients/${P1.userId}/sessions`, { maxRedirects: 0, failOnStatusCode: false });
      check("26. a patient cannot open clinician pages (redirected away)", res.status() >= 300 && res.status() < 400, `status ${res.status()}`);
      await ctxP.close();
    }

    // ======================================================================
    section("A/H. Snapshot shape + Patient Progress");
    {
      const ctx = await login(browser, P1.email, MOBILE);
      const { page, status, body } = await text(ctx, "/patient/progress");
      check("24. C5 Patient Progress loads (no object-as-array crash)", status === 200 && (await page.locator('[data-testid="c5-progress-history"]').count()) === 1, `status ${status}`);
      check("25. no legacy interpretation exposed to the C5 patient", !/interpretation|capacity|tolerance|improving/i.test(body), body.match(/interpretation|capacity|tolerance|improving/i)?.[0]);
      check("H. factual history: 5 sessions, unknown explicit, no zero-filling", (await page.locator("[data-c5-progress-session]").count()) === 5 && body.includes("Not recorded (couldn't recall)") && body.includes("0/10"));
      check("C5 Progress fits 390px", await noOverflow(page));
      await page.close();
      await ctx.close();
    }
    {
      // Mixed legacy + C5 history on the legacy (gate-off) Progress page.
      const ctx = await login(browser, P7.email, DESKTOP, OFF);
      const page = await ctx.newPage();
      const res = await page.goto(`${OFF}/patient/progress`);
      const body = await page.locator("body").innerText();
      check("24/A. mixed legacy + C5 patient: legacy Progress (gate off) loads without crashing", res?.status() === 200 && body.includes("Progress") && !/Application error|Unhandled Runtime Error|is not iterable/i.test(body), `status ${res?.status()}`);
      await page.close();
      await ctx.close();
    }
    {
      for (const path of ["progress", "review"]) {
        const { status, body } = await text(ctxA, `/clinician/patients/${P7.userId}/${path}`);
        check(`A. clinician legacy ${path} page loads for a mixed patient and says C5 sessions are not analyzed`, status === 200 && body.includes("does not include") && body.includes("says nothing about them"), `status ${status}`);
      }
      const { status } = await text(ctxA, `/clinician/patients/${P7.userId}`);
      check("A. clinician Overview loads for the mixed patient", status === 200);
    }
    {
      // Responsive clinician pages.
      const page = await ctxA.newPage();
      await page.setViewportSize(MOBILE);
      for (const path of ["", "/sessions", `/sessions/${s6.sid}`]) {
        await page.goto(`${ON}/clinician/patients/${P1.userId}${path}`);
        check(`clinician ${path || "/overview"} fits 390px`, await noOverflow(page));
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/clinician${path.replace(/\//g, "-") || "-overview"}-mobile.png`, fullPage: true });
      }
      await page.setViewportSize(DESKTOP);
      await page.goto(`${ON}/clinician/patients/${P1.userId}/sessions/${s6.sid}`);
      check("session detail fits 1280px", await noOverflow(page));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/clinician-session-detail-desktop.png`, fullPage: true });
      await page.close();
    }
    await ctxA.close();
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  fail++;
  console.error("ERROR", err);
} finally {
  try {
    await teardown();
  } catch (e) {
    fail++;
    console.log(`FAIL  teardown: ${e.message}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
