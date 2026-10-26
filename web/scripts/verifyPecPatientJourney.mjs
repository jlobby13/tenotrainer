// PEC — Patient Experience Completion: the native C5 patient journey, live
// end-to-end over the REAL authenticated Next.js boundary, with FastAPI
// UNREACHABLE. Covers review -> Begin -> first performance, frozen
// exercise guidance (snapshot v2), Last Time, rest, patient dosage
// wording, progress, Finish/Stop, pause + safety visibility, check-ins
// (incl. the upcoming morning line), new versions, notices, failures,
// accessibility and 390 px layout. Throwaway @example.invalid users and
// exercises, full teardown. Snapshot SQL: verifyPecSnapshotGuidance.sql.
//
// Server (isolated; never :3000 / :8000). From web/ after `next build`:
//   C5_PATIENT_RUNTIME_ENABLED=true FASTAPI_URL=http://127.0.0.1:59999 npx next start -p 3001
//
// Run from web/:
//   node scripts/verifyPecPatientJourney.mjs [onUrl] [deadFastapiUrl] [screenshotDir]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const ON = process.argv[2] ?? "http://localhost:3001";
const DEAD_FASTAPI = process.argv[3] ?? "http://127.0.0.1:59999";
const SHOTS = process.argv[4] ?? null;
const REPO_ROOT = "..";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";
const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };
const RUN = randomUUID().slice(0, 8);
const CAUTION_MARKER = `PEC-CLINICIAN-ONLY-CAUTION-${RUN}`;
const NOTE_MARKER = `PEC-CLINICIAN-ONLY-NOTE-${RUN}`;

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
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const WORK = mkdtempSync(join(tmpdir(), "pec-"));
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
function localDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86400000));
}
function localDow(offsetDays = 0) {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(Date.now() + offsetDays * 86400000));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}
function shortMonthDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
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
const createdUsers = [];
const exerciseIds = [];
let clinician = null;
const ex = {};

async function makeUser(label, { member = false } = {}) {
  const email = `pec-${label}-${RUN}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `PEC ${label}`, timezone: TZ, morning_reminder_time: "07:00" });
  if (member) await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: data.user.id, role: "clinician" });
  return { userId: data.user.id, email, label };
}

async function makeExercise(key, fields) {
  const { data, error } = await admin
    .from("canonical_exercises")
    .insert({ name: `PEC ${key} ${RUN}`, visibility: "global", active: true, ...fields })
    .select("id, name")
    .single();
  if (error) throw error;
  exerciseIds.push(data.id);
  ex[key] = data;
}

const DOSE = {
  X: { dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 10, load_type: "external", load_mode: "exact", load_value_exact: 20, load_unit: "kg", rest_seconds: 90, rpe: 7, rir: 2, rom: "full" },
  Y: { dosage_type: "hold", sets: 2, hold_duration_mode: "exact", hold_duration_exact_seconds: 30, load_type: "not_applicable" },
  Zreps: { dosage_type: "repetition", sets: 2, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" },
  Zhold: { dosage_type: "hold", sets: 1, hold_duration_mode: "exact", hold_duration_exact_seconds: 20, load_type: "not_applicable" },
};

// A version with ONE workout per entry of `workouts` ([{label, items:[[exKey, doseKey, note?]]}]).
async function addVersion(p, ppId, versionNumber, { mode = "sequence", recovery = 0, workouts, publishedDaysAgo = 30 }) {
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({
      user_id: p.userId, source: "clinician_change", patient_prescription_id: ppId, version_number: versionNumber,
      published_at: new Date(Date.now() - publishedDaysAgo * 86400000).toISOString(), published_by: clinician.userId,
      scheduling_mode: mode, target_sessions_per_week: mode === "sequence" ? 3 : null, recovery_days: recovery,
    })
    .select("id")
    .single();
  if (error) throw error;
  const ws = [];
  for (const [wi, w] of workouts.entries()) {
    const { data: wr } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: w.label, order_index: wi, days_of_week: w.days ?? null }).select("id").single();
    const exs = {};
    for (const [ei, [exKey, doseKey, note]] of w.items.entries()) {
      const { data: pe } = await admin.from("prescription_exercises").insert({ prescription_workout_id: wr.id, canonical_exercise_id: ex[exKey].id, order_index: ei, status: "active", additional_instructions: note ?? null }).select("id").single();
      const { error: de } = await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: pe.id, ...DOSE[doseKey] });
      if (de) throw de;
      exs[exKey] = pe.id;
    }
    ws.push({ id: wr.id, ex: exs });
  }
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", ppId);
  return { versionId: v.id, workouts: ws };
}

const STANDARD = [{ label: "A", items: [["X", "X", "Keep your knee straight."], ["Y", "Y"], ["Z", "Zreps"]] }, { label: "B", items: [["Z", "Zreps"]] }];

async function makePatient(label, opts = {}) {
  const p = await makeUser(label);
  await admin.from("supervisor_patients").insert({ supervisor_id: clinician.userId, patient_id: p.userId, status: "active" });
  if (opts.noProgram) return p;
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: p.userId }).select("id").single();
  const version = await addVersion(p, pp.id, 1, { workouts: opts.workouts ?? STANDARD, mode: opts.mode, recovery: opts.recovery ?? 0 });
  return { ...p, ppId: pp.id, ...version };
}

// A CLOSED C5 session `daysAgo` days ago (patient-local) with both
// responses resolved unless told otherwise.
// units: [{ exKey, idx, outcome, reps, dur, load }]
function priorSession(p, { versionId, workout, units, daysAgo = 1, status = "finished", morning = "resolved", immediate = "resolved", escalation = null }) {
  const sid = randomUUID();
  const started = `(now() - interval '${daysAgo} days')`;
  const lines = [`INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
VALUES ('${sid}', '${p.userId}', 'c5:${sid}', (${started} AT TIME ZONE '${TZ}')::date, NULL, 'started', ${started},
  c5_build_session_snapshot('${versionId}', '${workout.id}'), '${versionId}', '${workout.id}', '${TZ}', gen_random_uuid());`];
  for (const u of units) {
    const order = Object.keys(workout.ex).indexOf(u.exKey);
    lines.push(`INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, actual_duration_seconds, actual_load, actual_load_unit, occurred_at)
VALUES ('${sid}', '${workout.ex[u.exKey]}', ${order}, ${u.idx}, '${u.outcome}', ${u.reps ?? "NULL"}, ${u.dur ?? "NULL"}, ${u.load ?? "NULL"}, ${u.load != null ? "'kg'" : "NULL"}, ${started} + interval '${5 + u.idx} minutes');`);
  }
  if (status !== "started") {
    lines.push(`UPDATE rehab_sessions SET training_status = '${status}', training_closed_at = ${started} + interval '30 minutes' WHERE id = '${sid}';`);
    if (immediate === "resolved") {
      lines.push(`INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at, created_at)
VALUES ('${sid}', '${p.userId}', 2, 5, false, ${escalation ? "true" : "false"}, false, ${started} + interval '40 minutes', ${started} + interval '30 minutes');`);
    }
    if (morning === "resolved") {
      lines.push(`INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
VALUES ('${sid}', '${p.userId}', ${started} + interval '1 day', ((${started} + interval '1 day') AT TIME ZONE '${TZ}')::date, 'unable_to_recall', ${started} + interval '1 day 1 hour');`);
    } else if (morning === "due") {
      lines.push(`INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date)
VALUES ('${sid}', '${p.userId}', ${started} + interval '1 day', ((${started} + interval '1 day') AT TIME ZONE '${TZ}')::date);`);
    }
    if (escalation) {
      lines.push(`INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
VALUES ('${sid}', ${escalation}, 'pop_felt_or_heard', 'v1', '{"source":"c5_immediate_response"}'::jsonb, ${started} + interval '40 minutes');`);
    }
  }
  sqlQuery(`BEGIN;\n${lines.join("\n")}\nCOMMIT;`);
  return sid;
}

async function sessionsOf(p) {
  const { data } = await admin.from("rehab_sessions").select("*").eq("user_id", p.userId).not("training_status", "is", null).order("started_at");
  return data ?? [];
}
async function todaysSessions(p) {
  return (await sessionsOf(p)).filter((s) => s.patient_local_date === localDate(0));
}
async function unitsOf(sessionId) {
  const { data } = await admin.from("set_outcomes").select("*").eq("rehab_session_id", sessionId).order("set_index");
  return data ?? [];
}

async function teardown() {
  const ids = createdUsers.length ? createdUsers : [randomUUID()];
  for (const userId of createdUsers) {
    const { data: episodes } = await admin.from("acute_safety_episodes").select("id").eq("user_id", userId);
    const episodeIds = (episodes ?? []).map((e) => e.id);
    if (episodeIds.length) {
      await admin.from("cautious_return_contexts").delete().in("acute_safety_episode_id", episodeIds);
      await admin.from("blocked_loading_opportunities").delete().in("acute_safety_episode_id", episodeIds);
      await admin.from("acute_safety_releases").delete().in("acute_safety_episode_id", episodeIds);
      await admin.from("acute_safety_reassessments").delete().in("acute_safety_episode_id", episodeIds);
    }
    await admin.from("acute_safety_episodes").delete().eq("user_id", userId);
    await admin.from("c5_recovery_decisions").delete().eq("user_id", userId);
    await admin.from("rehab_sessions").delete().eq("user_id", userId).not("resolves_stopped_session_id", "is", null);
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
  }
  await admin.from("supervisor_patients").delete().in("patient_id", ids);
  await admin.from("supervisor_patients").delete().in("supervisor_id", ids);
  await admin.from("organization_members").delete().in("user_id", ids);
  await admin.from("profiles").delete().in("id", ids);
  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.log(`teardown: could not delete user ${id}: ${error.message}`);
  }
  for (const id of exerciseIds) {
    const { error } = await admin.from("canonical_exercises").delete().eq("id", id);
    if (error) console.log(`teardown: could not delete exercise ${id}: ${error.message}`);
  }
  const { data: left } = await admin.from("rehab_sessions").select("id").in("user_id", ids);
  console.log(`\nteardown: ${createdUsers.length} users, ${exerciseIds.length} exercises removed; remaining sessions: ${left?.length ?? "?"}`);
}

// ---------------------------------------------------------------- browser / API
async function login(browser, email, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport });
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
const stateOf = async (ctx) => (await api(ctx, "GET", "/api/patient/c5/state")).body?.state;
function perf(exerciseId, unit, extra = {}) {
  return { exercise_id: exerciseId, unit_index: unit, outcome: "completed", actual_reps: 10, ...extra };
}
async function apiStart(ctx, p, w, firstExKey, extra = {}, requestId = randomUUID()) {
  return api(ctx, "POST", "/api/patient/c5/start", {
    clientRequestId: requestId, expectedVersionId: p.versionId, workoutId: w.id,
    performance: perf(w.ex[firstExKey], 0, extra), preStartSkips: [], sequenceChoice: null,
  });
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
const card = (page, exerciseId) => page.locator(`[data-c5-exercise="${exerciseId}"]`);
const unitRow = (page, exerciseId, i) => card(page, exerciseId).locator("[data-c5-unit]").nth(i);

async function main() {
  section("0. Environment");
  {
    let refused = false;
    try {
      await fetch(`${DEAD_FASTAPI}/`, { signal: AbortSignal.timeout(3000) });
    } catch {
      refused = true;
    }
    check(`FastAPI URL ${DEAD_FASTAPI} refuses connections (FastAPI unreachable for this run)`, refused);
    const probe = await fetch(`${ON}/api/patient/c5/state`);
    check("isolated gate-on server reachable (unauthenticated state -> 401)", probe.status === 401, `status ${probe.status}`);
  }

  clinician = await makeUser("clinician", { member: true });
  await makeExercise("X", {
    patient_facing_explanation: "Heel raises build strength and load tolerance in your Achilles and calf. ".repeat(4).trim(),
    setup_instructions: "Stand on the edge of a step holding a rail for balance, heels hanging off the edge.",
    execution_cues: ["Rise up onto your toes over 2 seconds", "Pause briefly at the top", "Lower slowly for 3 seconds"],
    common_compensations: ["Bending the knee", "Rushing the lowering"],
    contraindications_or_cautions: CAUTION_MARKER,
    clinician_notes: NOTE_MARKER,
    media_url: null,
  });
  await makeExercise("Y", { patient_facing_explanation: null, setup_instructions: null, execution_cues: null, common_compensations: null });
  await makeExercise("W", { patient_facing_explanation: "Balance work.", setup_instructions: "Stand on one leg.", execution_cues: ["Stay steady"], common_compensations: [] });
  await makeExercise("Z", { patient_facing_explanation: "Hops for spring.", setup_instructions: "Stand tall.", execution_cues: ["Stay light"], common_compensations: ["Landing flat"] });

  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------ 1
    section("1. No program");
    {
      const N = await makePatient("noprogram", { noProgram: true });
      const ctx = await login(browser, N.email, MOBILE);
      const page = await ctx.newPage();
      await page.goto(`${ON}/patient/dashboard`);
      const body = await page.locator("body").innerText();
      check("1. no-program patient sees the native 'No active program' state", body.includes("No active program") && !/Track Session|Exercise Library/.test(body));
      await ctx.close();
    }

    // ------------------------------------------------------------------ A: the daily loop
    section("2-21, 26, 28, 34, 47. Daily loop (patient A, 390 px)");
    const A = await makePatient("daily", { workouts: [STANDARD[0], { label: "B", items: [["W", "Zreps"]] }] });
    // History on an OLDER version (Z was a hold then -> incompatible now; Y was skipped only).
    const old = await addVersion(A, A.ppId, 9, {
      workouts: [{ label: "A", items: [["X", "X"], ["Y", "Y"], ["Z", "Zhold"]] }],
      publishedDaysAgo: 40,
    });
    await admin.from("patient_prescriptions").update({ current_prescription_version_id: A.versionId }).eq("id", A.ppId);
    const lastDate = localDate(-2);
    priorSession(A, {
      versionId: old.versionId, workout: old.workouts[0], daysAgo: 2,
      units: [
        { exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 },
        { exKey: "X", idx: 1, outcome: "completed", reps: 10, load: 20 },
        { exKey: "X", idx: 2, outcome: "completed", reps: 8, load: 20 },
        { exKey: "Y", idx: 0, outcome: "skipped" },
        { exKey: "Y", idx: 1, outcome: "skipped" },
        { exKey: "Z", idx: 0, outcome: "completed", dur: 20 },
      ],
    });
    // A more recent session (workout B: another exercise) — it neither hides
    // nor supplies history for X, Y or Z.
    priorSession(A, { versionId: A.versionId, workout: A.workouts[1], daysAgo: 1, units: [{ exKey: "W", idx: 0, outcome: "completed", reps: 8 }] });
    const W = A.workouts[0];
    const ctxA = await login(browser, A.email, MOBILE);
    const page = await ctxA.newPage();
    await page.goto(`${ON}/patient/dashboard`);
    {
      const body = await page.locator("body").innerText();
      check("2. workout available on the dashboard", body.includes("Your workout is ready") && body.includes("Open workout"), body.slice(0, 300));
    }
    await page.getByRole("link", { name: "Open workout" }).click();
    await page.waitForURL(/\/patient\/session/);
    await page.waitForSelector("[data-c5-exercise]");
    check("3. opening the workout creates no session", (await sessionsOf(A)).length === 2);
    {
      const body = await page.locator("body").innerText();
      check("4. review mode: no performance controls (no Done / Log / Skip)",
        (await page.getByRole("button", { name: "Done" }).count()) === 0 && (await page.getByRole("button", { name: "Log" }).count()) === 0 && (await page.getByRole("button", { name: "Skip" }).count()) === 0);
      check("42. no Finish control before the session has Started", (await page.getByRole("button", { name: /Finish/ }).count()) === 0);
      check("4. review mode offers Begin workout", (await page.locator("[data-c5-begin]").count()) === 1);
      check("19. prescribed rest is shown prominently ('Rest 90 sec between sets')", (await card(page, W.ex.X).locator("[data-c5-rest]").innerText()).trim() === "Rest 90 sec between sets");
      const details = await card(page, W.ex.X).locator("[data-c5-dosage-details]").innerText();
      check("41. patient dosage wording: effort / reps-left / range of motion; no RPE/RIR/ROM shorthand",
        details.includes("Effort: about 7 out of 10") && details.includes("Stop with about 2 reps left") && details.includes("Range of motion: full") && !/\bRPE\b|\bRIR\b|ROM:/.test(details), details);
      check("clinician note shown separately and visibly", (await card(page, W.ex.X).locator("[data-c5-clinician-note]").innerText()).includes("Keep your knee straight."));
      const lt = await card(page, W.ex.X).locator("[data-c5-last-time]").innerText();
      check("16. Last Time: date + factual completed performance at a consistent load", lt.includes(`Last time · ${shortMonthDay(lastDate)}`) && lt.includes("10 · 10 · 8 reps at 20 kg"), lt);
      check("18. skipped-only history (Y) and an incompatible quantity type (Z: hold then, reps now) show no Last Time",
        (await card(page, W.ex.Y).locator("[data-c5-last-time]").count()) === 0 && (await card(page, W.ex.Z).locator("[data-c5-last-time]").count()) === 0);
      check("Last Time is factual only (no advice / comparison words)", !/increase|decrease|try|should|better|worse|progress/i.test(lt), lt);
      check("8. guidance is available before Start ('How to do it', collapsed)", (await card(page, W.ex.X).locator("[data-c5-guidance-toggle]").getAttribute("aria-expanded")) === "false");
      await card(page, W.ex.X).locator("[data-c5-guidance-toggle]").click();
      // textContent: the section headings are CSS-uppercased (innerText would be too).
      const g = await card(page, W.ex.X).locator("[data-c5-guidance-panel]").textContent();
      check("8. guidance shows why / setup / numbered cues / watch out for",
        g.includes("Why it helps") && g.includes("Stand on the edge of a step") && g.includes("Lower slowly for 3 seconds") && g.includes("Watch out for") && g.includes("Rushing the lowering"), g.slice(0, 200));
      check("D1. clinician-only content is never shown", !body.includes(CAUTION_MARKER) && !(await page.locator("body").innerText()).includes(NOTE_MARKER));
      check("12. no media for this exercise: nothing rendered (no player, image or link)",
        (await page.locator("video, img, [data-c5-guidance-panel] a").count()) === 0);
      check("empty library guidance (Y) renders no guidance block at all", (await card(page, W.ex.Y).locator("[data-c5-guidance]").count()) === 0);
      check("46. 390 px: review with expanded long guidance and Last Time has no horizontal overflow", await noOverflow(page));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/pec-review-mobile.png`, fullPage: true });
    }
    await page.locator("[data-c5-begin]").click();
    check("5. Begin workout creates no session (UI state only)", (await sessionsOf(A)).length === 2 && (await page.getByRole("button", { name: "Done" }).count()) > 0);
    check("42. still no Finish control after Begin (nothing performed yet)", (await page.getByRole("button", { name: /Finish/ }).count()) === 0);
    await unitRow(page, W.ex.Y, 0).getByRole("button", { name: "Skip" }).click();
    check("14. a pre-session skip does not Start", (await sessionsOf(A)).length === 2);
    await page.reload();
    await page.waitForSelector("[data-c5-exercise]");
    check("refresh before the first performance returns to review (no persisted Begin)", (await page.locator("[data-c5-begin]").count()) === 1);
    await page.locator("[data-c5-begin]").click();
    await unitRow(page, W.ex.Y, 0).getByRole("button", { name: "Skip" }).click();
    await unitRow(page, W.ex.X, 0).getByRole("button", { name: "Done" }).click();
    await page.waitForSelector("[data-c5-progress]", { timeout: 20000 });
    const today = await todaysSessions(A);
    check("6. the first confirmed performance Starts the session", today.length === 1 && today[0].training_status === "started");
    const sessA = today[0];
    const snap = sessA.prescription_snapshot;
    const gX = snap.exercises.find((e) => e.exercise_id === W.ex.X).patient_guidance;
    check("7. Start froze a version-2 snapshot with the patient guidance",
      snap.snapshot_version === 2 && gX.setup.startsWith("Stand on the edge") && gX.cues.length === 3 && gX.media_url === null && !JSON.stringify(snap).includes(CAUTION_MARKER) && !JSON.stringify(snap).includes(NOTE_MARKER));
    {
      const u = await unitsOf(sessA.id);
      check("pre-start skip persisted only because the session Started", u.some((x) => x.exercise_id === W.ex.Y && x.outcome === "skipped") && u.some((x) => x.exercise_id === W.ex.X && x.outcome === "completed"));
      const prog = await page.locator("[data-c5-progress]").innerText();
      check("43. progress shows done · skipped · left from server facts", prog.trim() === "1 done · 1 skipped · 5 left", prog);
      check("rest hint appears on the next set after one is done", (await unitRow(page, W.ex.X, 1).locator("[data-c5-rest-hint]").innerText()).includes("Rest 90 sec before this set"));
    }
    // Canonical library edit while Started.
    await admin.from("canonical_exercises").update({ setup_instructions: "EDITED setup text for later sessions." }).eq("id", ex.X.id);
    await page.reload();
    await page.waitForSelector("[data-c5-progress]");
    await card(page, W.ex.X).locator("[data-c5-guidance-toggle]").click();
    {
      const g = await card(page, W.ex.X).locator("[data-c5-guidance-panel]").textContent();
      check("9. frozen guidance unchanged after a canonical edit (Started session)", g.includes("Stand on the edge of a step") && !g.includes("EDITED"), g.slice(0, 120));
      check("13. confirmed performance survives refresh", (await unitRow(page, W.ex.X, 0).getAttribute("data-c5-unit-state")) === "completed");
    }
    // 39. failed save.
    await page.route("**/api/patient/c5/session/*/performance", (route) => route.abort("failed"));
    await unitRow(page, W.ex.X, 1).getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Not saved — retry" }).first().waitFor({ timeout: 10000 });
    check("39. a failed save says 'Not saved — retry' and nothing is recorded", (await unitsOf(sessA.id)).filter((u) => u.exercise_id === W.ex.X).length === 1);
    check("39. Finish is blocked while a write is unresolved", await page.getByRole("button", { name: "Saving…" }).isDisabled());
    await page.unroute("**/api/patient/c5/session/*/performance");
    await page.getByRole("button", { name: "Not saved — retry" }).first().click();
    check("39. retry saves it (server-confirmed)", await waitFor(async () => (await unitsOf(sessA.id)).filter((u) => u.exercise_id === W.ex.X).length === 2));
    // 46/numeric. Entry form on the last set, with the fixed bar.
    await unitRow(page, W.ex.Z, 1).getByRole("button", { name: "Change" }).click();
    const input = unitRow(page, W.ex.Z, 1).locator("input").first();
    check("numeric entry uses a decimal keyboard", (await input.getAttribute("inputmode")) === "decimal");
    await input.focus();
    const submit = unitRow(page, W.ex.Z, 1).getByRole("button", { name: "Save" });
    await submit.scrollIntoViewIfNeeded();
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector("[data-c5-action-bar]")?.getBoundingClientRect();
      const btns = [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Save");
      const r = btns[btns.length - 1]?.getBoundingClientRect();
      return bar && r ? r.bottom <= bar.top + 1 : false;
    });
    check("46. the last set's entry form is not hidden behind the fixed bottom bar", overlap);
    check("46. 390 px: entry form open, no horizontal overflow", await noOverflow(page));
    await unitRow(page, W.ex.Z, 1).getByRole("button", { name: "Cancel" }).click();
    // 45. Stop-sheet keyboard / focus behaviour.
    await page.getByRole("button", { name: "Stop session" }).focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-c5-stop-sheet]").waitFor();
    check("45. Stop sheet: initial focus is the safe choice ('Keep going')", (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Keep going");
    let contained = true;
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      contained &&= await page.evaluate(() => Boolean(document.activeElement?.closest("[data-c5-stop-sheet]")));
    }
    check("45. Tab keeps focus inside the Stop sheet", contained);
    check("46. 390 px: Stop sheet has no horizontal overflow", await noOverflow(page));
    await page.keyboard.press("Escape");
    check("45. Escape closes the sheet and returns focus to Stop session",
      (await page.locator("[data-c5-stop-sheet]").count()) === 0 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Stop session");
    check("the session is still open after Escape (nothing stopped)", (await todaysSessions(A))[0].training_status === "started");
    // 20. Finish.
    await page.getByRole("button", { name: "Finish workout" }).click();
    await page.locator("[data-c5-closed]").waitFor({ timeout: 20000 });
    check("20. Finish closes the session as finished", (await todaysSessions(A))[0].training_status === "finished" && (await page.locator("[data-c5-closed]").getAttribute("data-c5-closed")) === "finished");
    // 26 / 28. Immediate check-in, then the upcoming morning line.
    await page.getByRole("link", { name: "Continue to check-in" }).click();
    await page.waitForSelector("[data-c5-immediate-form]");
    check("44. score scales have meaningful accessible names",
      (await page.getByRole("radiogroup", { name: /Peak pain during the workout, from 0/ }).count()) === 1 &&
        (await page.getByRole("radiogroup", { name: /Overall, how hard did today’s workout feel/ }).count()) === 1 &&
        (await page.getByRole("radiogroup", { name: /^peak-pain$|^rpe$/ }).count()) === 0);
    check("46. 390 px: immediate check-in has no horizontal overflow", await noOverflow(page));
    await page.locator('[data-score-scale="peak-pain"] button').nth(2).click();
    await page.locator('[data-score-scale="rpe"] button').nth(6).click();
    for (const q of ["sudden_or_sharp_pain", "pop_felt_or_heard", "new_functional_difficulty"]) {
      await page.locator(`[data-safety-question="${q}"]`).getByRole("radio", { name: "No" }).click();
    }
    await page.getByRole("button", { name: "Submit check-in" }).click();
    await page.locator("[data-c5-checkin-saved]").waitFor({ timeout: 20000 });
    {
      const line = await page.locator("[data-c5-checkin-saved] [data-c5-upcoming-morning]").innerText();
      const { data: mr } = await admin.from("morning_responses").select("scheduled_eligible_at").eq("rehab_session_id", sessA.id).single();
      const expectedTime = new Date(mr.scheduled_eligible_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
      check("26. immediate check-in submitted", true);
      check("28. after the check-in: 'Morning check-in opens tomorrow at 7:00 AM.' from the authoritative due time",
        line === `Morning check-in opens tomorrow at ${expectedTime}.` && expectedTime === "7:00 AM", line);
    }
    await page.goto(`${ON}/patient/dashboard`);
    {
      const body = await page.locator("body").innerText();
      check("34. same-day block: already trained today", body.includes("You've already trained today"));
      check("28. dashboard shows the upcoming morning line while not yet due", (await page.locator("[data-c5-upcoming-morning]").innerText()).startsWith("Morning check-in opens tomorrow at"));
      check("not-yet-due morning is not offered as an action", (await page.getByRole("link", { name: "Start check-in" }).count()) === 0);
    }
    // 47. Next morning (moved by a real persisted timestamp, not the browser clock).
    await admin.from("morning_responses").update({ scheduled_eligible_at: new Date(Date.now() - 60000).toISOString() }).eq("rehab_session_id", sessA.id);
    await page.goto(`${ON}/patient/dashboard`);
    {
      const body = await page.locator("body").innerText();
      check("29. once due, the Morning check-in action is primary; the upcoming line is gone",
        body.includes("Morning check-in needed") && (await page.locator("[data-c5-upcoming-morning]").count()) === 0);
    }
    await page.getByRole("link", { name: "Start check-in" }).click();
    await page.waitForSelector("[data-c5-morning-form]");
    check("46. 390 px: morning check-in has no horizontal overflow", await noOverflow(page));
    await page.locator('[data-score-scale="morning-pain"] button').nth(1).click();
    await page.locator('[data-score-scale="morning-stiffness"] button').nth(0).click();
    await page.getByRole("button", { name: "Submit check-in" }).click();
    await page.locator("[data-c5-checkin-saved]").waitFor({ timeout: 20000 });
    {
      const { data: mr } = await admin.from("morning_responses").select("resolution, next_morning_pain, next_morning_stiffness, submitted_at").eq("rehab_session_id", sessA.id).single();
      check("47. full native daily workflow (review → Begin → perform → Finish → check-in → morning) with FastAPI unreachable",
        mr.resolution === "answered" && mr.next_morning_pain === 1 && mr.next_morning_stiffness === 0 && mr.submitted_at != null);
    }
    await ctxA.close();

    // ------------------------------------------------------------------ 10, 17, 32, 21
    section("10, 17, 32, 21. Updated guidance, varied-load Last Time, new version before Start, Stop");
    {
      const V = await makePatient("varied");
      priorSession(V, {
        versionId: V.versionId, workout: V.workouts[0], daysAgo: 1,
        units: [
          { exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 },
          { exKey: "X", idx: 1, outcome: "completed", reps: 10, load: 22.5 },
          { exKey: "X", idx: 2, outcome: "completed", reps: 10, load: 22.5 },
        ],
      });
      // That session was workout A, so the Sequence now offers workout B; point V at A again with a fresh single-workout version.
      const v2 = await addVersion(V, V.ppId, 2, { workouts: [STANDARD[0]] });
      const ctx = await login(browser, V.email, DESKTOP);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/session`);
      await pg.waitForSelector("[data-c5-exercise]");
      const xCard = card(pg, v2.workouts[0].ex.X);
      const lt = await xCard.locator("[data-c5-last-time]").innerText();
      check("17. varied loads are listed per set (never one load for all sets)", lt.includes("10 reps at 20 kg · 10 reps at 22.5 kg · 10 reps at 22.5 kg") && !lt.includes("10 · 10 · 10"), lt);
      await xCard.locator("[data-c5-guidance-toggle]").click();
      check("10. a newly built (later) snapshot preview carries the UPDATED canonical guidance", (await xCard.locator("[data-c5-guidance-panel]").innerText()).includes("EDITED setup text"));
      // 32. a new version is published while the patient is reviewing.
      const v3 = await addVersion(V, V.ppId, 3, { workouts: [STANDARD[0]] });
      await pg.locator("[data-c5-begin]").click();
      await unitRow(pg, v2.workouts[0].ex.X, 0).getByRole("button", { name: "Done" }).click();
      await pg.waitForSelector("[data-c5-begin]", { timeout: 20000 });
      const banner = await pg.locator("body").innerText();
      check("32. new version before Start: nothing Starts; the patient is told and returns to review",
        (await todaysSessions(V)).length === 0 && banner.includes("Your clinician updated your program"), banner.slice(0, 200));
      await pg.locator("[data-c5-begin]").click();
      await unitRow(pg, v3.workouts[0].ex.X, 0).getByRole("button", { name: "Done" }).click();
      await pg.waitForSelector("[data-c5-progress]", { timeout: 20000 });
      check("32. the latest version Starts after review", (await todaysSessions(V))[0]?.prescription_version_id === v3.versionId);
      await pg.getByRole("button", { name: "Stop session" }).click();
      await pg.getByRole("button", { name: "Stop today's session" }).click();
      await pg.locator("[data-c5-closed]").waitFor({ timeout: 20000 });
      check("21. Stop closes the session as stopped early, keeping the work", (await todaysSessions(V))[0].training_status === "stopped_early" && (await unitsOf((await todaysSessions(V))[0].id)).length === 1);
      await ctx.close();
    }

    // ------------------------------------------------------------------ 11
    section("11. Version-1 snapshot never falls back to live guidance");
    {
      const O = await makePatient("v1snap");
      const sid = randomUUID();
      sqlQuery(`INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
SELECT '${sid}', '${O.userId}', 'c5:${sid}', (now() AT TIME ZONE '${TZ}')::date, NULL, 'started', now() - interval '10 minutes',
  jsonb_set(s - 'snapshot_version', '{exercises}', (SELECT jsonb_agg(e - 'patient_guidance') FROM jsonb_array_elements(s->'exercises') e)) || '{"snapshot_version": 1}'::jsonb,
  '${O.versionId}', '${O.workouts[0].id}', '${TZ}', gen_random_uuid()
FROM (SELECT c5_build_session_snapshot('${O.versionId}', '${O.workouts[0].id}') AS s) x;
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${sid}', '${O.workouts[0].ex.X}', 0, 0, 'completed', 10, now() - interval '5 minutes');`);
      const ctx = await login(browser, O.email);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/session`);
      await pg.waitForSelector("[data-c5-progress]");
      check("11. a Started v1 session shows its exercises but no guidance (no live-library fallback)",
        (await pg.locator("[data-c5-exercise]").count()) === 3 && (await pg.locator("[data-c5-guidance]").count()) === 0);
      await ctx.close();
    }

    // ------------------------------------------------------------------ 15, 22, 40
    section("15, 22, 40. All-skipped, Repeat/Next choice, idempotent first performance");
    {
      const B = await makePatient("allskip", { workouts: [{ label: "A", items: [["Z", "Zreps"]] }, { label: "B", items: [["Z", "Zreps"]] }] });
      const ctx = await login(browser, B.email);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/session`);
      await pg.waitForSelector("[data-c5-begin]");
      await pg.locator("[data-c5-begin]").click();
      for (let i = 0; i < 2; i++) await unitRow(pg, B.workouts[0].ex.Z, i).getByRole("button", { name: "Skip" }).click();
      check("15. all units skipped before any performance: still no Finish control", (await pg.getByRole("button", { name: /Finish/ }).count()) === 0);
      await pg.getByRole("link", { name: "Leave" }).click();
      await pg.waitForURL(/\/patient\/dashboard/);
      check("15. all-skipped consumes no day: no session, workout still available",
        (await sessionsOf(B)).length === 0 && (await pg.locator("body").innerText()).includes("Your workout is ready"));
      const req = randomUUID();
      const r1 = await apiStart(ctx, B, B.workouts[0], "Z", { actual_reps: 8 }, req);
      const r2 = await apiStart(ctx, B, B.workouts[0], "Z", { actual_reps: 8 }, req);
      check("40. duplicate first performance with the same request id is idempotent (one session)",
        r1.body?.result === "started" && r2.body?.result === "started" && r2.body?.replayed === true
          && r1.body?.session?.id === r2.body?.session?.id && (await sessionsOf(B)).length === 1, JSON.stringify([r1.body?.result, r2.body?.result, r2.body?.replayed]));
      await ctx.close();

      const Q = await makePatient("choice");
      priorSession(Q, { versionId: Q.versionId, workout: Q.workouts[0], status: "stopped_early", units: [{ exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 }] });
      const cq = await login(browser, Q.email);
      const pq = await cq.newPage();
      await pq.goto(`${ON}/patient/session`);
      check("22. after a Stop: Repeat previous / Move to next choice", await pq.locator("[data-c5-sequence-choice]").isVisible());
      await pq.locator('[data-c5-choice="advance_next"]').click();
      check("22. after choosing, the workout opens in review (Begin required)", await pq.locator("[data-c5-begin]").isVisible());
      await cq.close();
    }

    // ------------------------------------------------------------------ 23, 33, 35
    section("23, 33, 35. Pause during a Started session, new version during it, cross-midnight resume");
    {
      const P = await makePatient("pause");
      const ctx = await login(browser, P.email);
      const r = await apiStart(ctx, P, P.workouts[0], "X");
      check("setup: P Started via the first performance", r.body?.result === "started", JSON.stringify(r.body));
      sqlQuery(`SELECT pause_prescription('${P.ppId}', '${clinician.userId}');`);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/session`);
      await pg.waitForSelector("[data-testid='c5-paused-banner']");
      check("23. pause during a Started session: calm notice, Finish current / Stop today offered, nothing terminated",
        (await pg.getByRole("button", { name: "Finish current session" }).count()) === 1 && (await pg.getByRole("button", { name: "Stop today's session" }).count()) === 1
          && (await todaysSessions(P))[0].training_status === "started");
      const v2 = await addVersion(P, P.ppId, 2, { workouts: [STANDARD[1]] });
      const st = await stateOf(ctx);
      check("33. a new version during a Started session never mutates it (resume keeps the old snapshot)",
        st?.kind === "resume" && st.session.snapshot.versionId === P.versionId && st.session.snapshot.versionId !== v2.versionId, JSON.stringify(st)?.slice(0, 200));
      await ctx.close();

      const X2 = await makePatient("midnight");
      priorSession(X2, { versionId: X2.versionId, workout: X2.workouts[0], status: "started", daysAgo: 1, units: [{ exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 }] });
      const cx = await login(browser, X2.email);
      const px = await cx.newPage();
      await px.goto(`${ON}/patient/session`);
      await px.waitForSelector("[data-c5-progress]");
      check("35. cross-midnight: yesterday's Started session resumes with its recorded work",
        (await unitRow(px, X2.workouts[0].ex.X, 0).getAttribute("data-c5-unit-state")) === "completed" && (await px.locator("[data-c5-begin]").count()) === 0);
      await cx.close();
    }

    // ------------------------------------------------------------------ 24, 25
    section("24, 25. Paused program with an open professional-review hold");
    {
      const S = await makePatient("pausedsafety");
      priorSession(S, { versionId: S.versionId, workout: S.workouts[0], escalation: 5, units: [{ exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 }] });
      const { error: recErr } = await admin.rpc("reconcile_missing_acute_episodes", { p_user_id: S.userId });
      if (recErr) throw recErr;
      sqlQuery(`SELECT pause_prescription('${S.ppId}', '${clinician.userId}');`);
      const ctx = await login(browser, S.email, MOBILE);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/dashboard`);
      const primary = await pg.locator("[data-c5-state-card]").first().innerText();
      const safety = await pg.locator("[data-c5-paused-safety-hold]").innerText();
      check("24. paused stays the primary state", primary.includes("Your clinician has paused your program"), primary);
      check("24. the open hold stays visible as a secondary card with process language and a safety check-in link",
        safety.includes("Clinician release required") && (await pg.locator("[data-c5-paused-safety-hold] a[href='/patient/acute-safety']").count()) === 1, safety);
      check("24. nothing offers training", (await pg.getByRole("link", { name: /Open workout|Resume session/ }).count()) === 0);
      const ep = (await admin.from("acute_safety_episodes").select("id").eq("user_id", S.userId).single()).data.id;
      const r = await api(ctx, "POST", "/api/patient/acute-safety/reassessment", { episodeId: ep, suddenOrSharpPainResolved: true, newFunctionalDifficultyResolved: true, evaluatedByProfessional: true, clearedByProfessional: true });
      const { data: brake } = await admin.rpc("get_patient_acute_brake_status", { p_user_id: S.userId });
      check("25. the patient's reassessment cannot release a professional-review hold", (brake ?? []).length === 1 && (await admin.from("acute_safety_releases").select("id").eq("acute_safety_episode_id", ep)).data.length === 0, JSON.stringify(r));
      await pg.goto(`${ON}/patient/acute-safety`);
      const sbody = await pg.locator("body").innerText();
      check("safety page wording: no 'Stop Loading'", !sbody.includes("Stop Loading"));
      await ctx.close();
    }

    // ------------------------------------------------------------------ 27, 30, 31
    section("27, 30, 31. Leaving before the check-in; overdue morning; unable to recall");
    {
      const C = await makePatient("leave");
      const ctx = await login(browser, C.email);
      const r = await apiStart(ctx, C, C.workouts[0], "X");
      await api(ctx, "POST", `/api/patient/c5/session/${r.body.session.id}/finish`, {});
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/dashboard`);
      check("27. leaving before the post-session check-in: the dashboard makes it the primary action",
        (await pg.locator("[data-c5-state-card]").first().innerText()).includes("Post-session check-in needed"));
      await ctx.close();

      const M = await makePatient("overdue");
      priorSession(M, { versionId: M.versionId, workout: M.workouts[0], daysAgo: 4, morning: "due", units: [{ exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 }] });
      const cm = await login(browser, M.email);
      const pm = await cm.newPage();
      await pm.goto(`${ON}/patient/check-in`);
      await pm.waitForSelector("[data-c5-morning-form]");
      const head = await pm.locator("[data-c5-morning-form] h1").innerText();
      check("30. overdue morning: asked about that reference morning", head.includes("on the morning of"), head);
      await pm.getByRole("button", { name: /I don.t remember/ }).click();
      await pm.locator("[data-forget-confirm]").getByRole("button").first().click();
      await pm.locator("[data-c5-checkin-saved]").waitFor({ timeout: 20000 });
      const { data: mr } = await admin.from("morning_responses").select("resolution, next_morning_pain").eq("user_id", M.userId).single();
      check("31. unable to recall stores no values (never zero)", mr.resolution === "unable_to_recall" && mr.next_morning_pain === null);
      await cm.close();
    }

    // ------------------------------------------------------------------ 36, 37, 38
    section("36, 37, 38. Recovery advice, calendar make-up, notice order + dismissal");
    {
      const R = await makePatient("recovery", { recovery: 2 });
      priorSession(R, { versionId: R.versionId, workout: R.workouts[0], units: [{ exKey: "X", idx: 0, outcome: "completed", reps: 10, load: 20 }] });
      const ctx = await login(browser, R.email);
      const pg = await ctx.newPage();
      await pg.goto(`${ON}/patient/dashboard`);
      check("36. recovery advisory offered", await pg.locator('[data-c5-recovery-guidance="offered"]').isVisible());
      await ctx.close();

      const K = await makePatient("calendar", { mode: "calendar", workouts: [{ label: "A", days: [localDow(-1)], items: [["Z", "Zreps"]] }] });
      const ck = await login(browser, K.email);
      const st = await stateOf(ck);
      const pk = await ck.newPage();
      await pk.goto(`${ON}/patient/dashboard`);
      check("37. calendar make-up for yesterday is offered", st?.kind === "available" && st.options[0].key === "make_up" && (await pk.locator("body").innerText()).includes("Make-up workout available"), JSON.stringify(st)?.slice(0, 150));
      await ck.close();

      const T = await makePatient("notice");
      await admin.from("notifications").insert({ patient_id: T.userId, type: "prescription_updated", prescription_version_id: T.versionId });
      const ct = await login(browser, T.email);
      const pt = await ct.newPage();
      await pt.goto(`${ON}/patient/dashboard`);
      const after = await pt.evaluate(() => {
        const primary = document.querySelector("[data-c5-state-card]");
        const notices = document.querySelector("[data-testid='program-notices']");
        return Boolean(primary && notices && primary.compareDocumentPosition(notices) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      check("38. notices render below the primary state card", after);
      await pt.locator("[data-testid='dismiss-notice']").first().click();
      check("38. dismissing sets read_at", await waitFor(async () => (await admin.from("notifications").select("read_at").eq("patient_id", T.userId).single()).data?.read_at != null));
      await ct.close();
    }
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
  await teardown().catch((e) => console.error("teardown error", e));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
