// C5.6F — weekly target + advisory recovery guidance, live end-to-end over
// the REAL authenticated Next.js boundary (cookie login, /api/patient/c5/**,
// the rendered dashboard / session page, the clinician builder) on the
// applied C5.6C–F RPCs. Throwaway @example.invalid users only; full teardown.
// The date/anchor/precedence matrix lives in verifyC5Stage6fFrequencyRecovery.sql.
//
// Servers (the runtime gate is a server env var, never weakened for a test):
//   GATE_ON  (default http://localhost:3001) — `next build` then
//            C5_PATIENT_RUNTIME_ENABLED=true npx next start -p 3001
//   GATE_OFF (default http://localhost:3000) — the normal dev server.
//
// Run from web/:
//   node scripts/verifyC5Stage6fRecoveryUi.mjs [gateOnUrl] [gateOffUrl] [screenshotDir]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";

const ON = process.argv[2] ?? "http://localhost:3001";
const OFF = process.argv[3] ?? "http://localhost:3000";
const SHOTS = process.argv[4] ?? null;
const REPO_ROOT = "..";
const CLINICIAN = "44197ef7-7421-47ed-a164-75d2765fc019";

// M2 — an assignment requires the clinician's clinician-role membership in
// its organization. This shared fixture clinician has none, so the suite
// grants one for the run and removes it in teardown (only if it added it).
const M2_FIXTURE_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
let fixtureClinicianMembershipAdded = false;
async function ensureFixtureClinicianMembership() {
  if (fixtureClinicianMembershipAdded) return;
  const { data } = await admin.from("organization_members").select("id").eq("user_id", CLINICIAN).eq("organization_id", M2_FIXTURE_ORG_ID).maybeSingle();
  if (data) return;
  const { error } = await admin.from("organization_members").insert({ organization_id: M2_FIXTURE_ORG_ID, user_id: CLINICIAN, role: "clinician" });
  if (error) throw error;
  fixtureClinicianMembershipAdded = true;
}
async function removeFixtureClinicianMembership() {
  if (!fixtureClinicianMembershipAdded) return;
  await admin.from("supervisor_patients").delete().eq("supervisor_id", CLINICIAN);
  await admin.from("organization_members").delete().eq("user_id", CLINICIAN).eq("organization_id", M2_FIXTURE_ORG_ID);
}
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
const WORK = mkdtempSync(join(tmpdir(), "c56f-"));
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
// Weekday-independent fixtures: the server derives "today" from the DB clock
// in the patient's stored time zone (production authority, untouched). The
// weekly-target fixtures need a patient-local today that is NOT Monday (so
// yesterday is inside the same Mon–Sun week). Fixed-offset zones span UTC-12
// to UTC+14 (26 h), so at any instant at least one of them is on a non-Monday
// date, away from midnight; the fixture patient lives in that zone.
const FIXED_ZONES = [TZ, ...Array.from({ length: 27 }, (_, i) => i - 12).map((h) => (h === 0 ? "Etc/GMT" : `Etc/GMT${h < 0 ? "+" : "-"}${Math.abs(h)}`))];
function zoneParts(tz, at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value])
  );
  return { isoDow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1, minute: Number(p.hour) * 60 + Number(p.minute) };
}
const zoneOk = (z, at) => {
  const { isoDow, minute } = zoneParts(z, at);
  return isoDow >= 2 && minute >= 15 && minute <= 23 * 60;
};
// C56F_FIXTURE_ZONE (optional) forces a candidate zone when it qualifies,
// to exercise the fixed-offset path on days the default zone already works.
function nonMondayZone(at = new Date()) {
  const forced = process.env.C56F_FIXTURE_ZONE;
  if (forced && zoneOk(forced, at)) return forced;
  const tz = FIXED_ZONES.find((z) => zoneOk(z, at));
  if (!tz) throw new Error("no fixed-offset zone is on a non-Monday date (impossible: 26 h span)");
  return tz;
}
function localDateIn(tz, offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + offsetDays * 86400000));
}
function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}
async function waitFor(fn, timeoutMs = 15000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
let exerciseId = null;

async function makeUser(label, tz = TZ) {
  const email = `c56f-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `C5.6F ${label}`, timezone: tz });
  return { userId: data.user.id, email };
}

// Two-workout program. mode 'sequence' (target, recovery) or 'calendar' (days, recovery).
async function makeFixture(label, { mode = "sequence", target = 2, recovery = 1, days = [null, null], tz = TZ } = {}) {
  const patient = await makeUser(label, tz);
  await ensureFixtureClinicianMembership();
  await admin.from("supervisor_patients").insert({ supervisor_id: CLINICIAN, patient_id: patient.userId, status: "active" });
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patient.userId }).select("id").single();
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({
      user_id: patient.userId, source: "clinician_change", patient_prescription_id: pp.id, version_number: 1,
      published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: CLINICIAN,
      scheduling_mode: mode, target_sessions_per_week: mode === "sequence" ? target : null, recovery_days: recovery,
    })
    .select("id")
    .single();
  if (error) throw error;
  const workouts = [];
  for (let i = 0; i < days.length; i++) {
    const { data: w } = await admin.from("prescription_workouts").insert({ prescription_version_id: v.id, label: String.fromCharCode(65 + i), order_index: i, days_of_week: days[i] }).select("id").single();
    const { data: e } = await admin.from("prescription_exercises").insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseId, order_index: 0, status: "active" }).select("id").single();
    await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: e.id, dosage_type: "repetition", sets: 3, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
    workouts.push({ id: w.id, exerciseId: e.id });
  }
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", pp.id);
  return { ...patient, mode, tz, ppId: pp.id, versionId: v.id, workouts };
}

// A closed C5 session that started `daysAgo` local days ago on workout
// `wi`, with both responses resolved (C5.6E is not under test here).
// daysAgo = 0 is a session finished earlier today (started 10 min ago).
// Calendar sessions carry calendar_scheduled_date (guard trigger); the
// fixture uses the session's own date so an earlier missed day stays open.
function priorSession(f, daysAgo, { status = "finished", wi = 0 } = {}) {
  const sid = randomUUID();
  const w = f.workouts[wi];
  const TZ = f.tz;
  const started = daysAgo === 0 ? `(now() - interval '10 minutes')` : `(now() - interval '${daysAgo} days')`;
  const calendarDate = f.mode === "calendar" ? `(${started} AT TIME ZONE '${TZ}')::date` : "NULL";
  sqlQuery(`BEGIN;
INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id, calendar_scheduled_date)
VALUES ('${sid}', '${f.userId}', 'c5:${sid}', (${started} AT TIME ZONE '${TZ}')::date, NULL, 'started', ${started},
  c5_build_session_snapshot('${f.versionId}', '${w.id}'), '${f.versionId}', '${w.id}', '${TZ}', gen_random_uuid(), ${calendarDate});
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${sid}', '${w.exerciseId}', 0, 0, 'completed', 8, ${started});
UPDATE rehab_sessions SET training_status = '${status}', training_closed_at = ${started} + interval '5 minutes' WHERE id = '${sid}';
INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
VALUES ('${sid}', '${f.userId}', 2, 5, false, false, false, now());
INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
VALUES ('${sid}', '${f.userId}', now() - interval '1 hour', (now() AT TIME ZONE '${TZ}')::date, 'unable_to_recall', now());
COMMIT;`);
  return sid;
}

async function sessionsOf(f) {
  const { data } = await admin.from("rehab_sessions").select("*").eq("user_id", f.userId).not("training_status", "is", null).order("started_at");
  return data ?? [];
}
async function decisionsOf(f) {
  const { data } = await admin.from("c5_recovery_decisions").select("*").eq("user_id", f.userId).order("decided_at");
  return data ?? [];
}

async function teardown() {
  for (const userId of createdUsers) {
    await admin.from("c5_recovery_decisions").delete().eq("user_id", userId);
    await admin.from("rehab_sessions").delete().eq("user_id", userId).not("resolves_stopped_session_id", "is", null);
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
      await admin.from("prescription_pause_periods").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("notifications").delete().eq("patient_id", userId);
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
  }
  const ids = createdUsers.length ? createdUsers : [randomUUID()];
  await admin.from("organization_members").delete().in("user_id", ids);
  await admin.from("supervisor_patients").delete().in("patient_id", ids);
  await admin.from("supervisor_patients").delete().in("supervisor_id", ids);
  await admin.from("profiles").delete().in("id", ids);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  if (exerciseId) await admin.from("canonical_exercises").delete().eq("id", exerciseId);
  const { data: left } = await admin.from("rehab_sessions").select("id").in("user_id", ids);
  console.log(`\nteardown: ${createdUsers.length} fixture users removed; remaining fixture sessions: ${left?.length ?? "?"}`);
  await removeFixtureClinicianMembership();
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
async function api(ctx, method, path, data, base = ON) {
  const res = await ctx.request.fetch(`${base}${path}`, { method, data, failOnStatusCode: false });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status(), body };
}
const state = async (ctx) => (await api(ctx, "GET", "/api/patient/c5/state")).body?.state;
const decide = (ctx, decision, extra = {}, base) => api(ctx, "POST", "/api/patient/c5/recovery-decision", { clientRequestId: randomUUID(), decision, ...extra }, base);
const NON_NEUTRAL = /overtrain|too much|warning|danger|risk|non-?complian|override|unsafe|injur|harm|you should not|not allowed/i;

async function layoutCheck(page, name) {
  const r = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [];
    for (const el of document.querySelectorAll("main button, main a")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.height < 43.5) small.push(`${el.textContent?.trim().slice(0, 30)} (${Math.round(b.height)}px)`);
    }
    return { overflow, small };
  });
  check(`layout ${name}: no horizontal overflow`, r.overflow <= 0, `overflow ${r.overflow}px`);
  check(`layout ${name}: tap targets >= 44px`, r.small.length === 0, r.small.join(", "));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------- scenarios
// PEC — the workout opens in a passive review; "Begin workout" (UI state
// only, never a write) reveals the performance controls.
async function beginIfReviewing(page) {
  await page.waitForSelector("[data-c5-exercise], [data-c5-state-card], [data-c5-sequence-choice], [data-c5-recovery-guidance], [data-c5-closed]", { timeout: 15000 }).catch(() => {});
  const begin = page.locator("[data-c5-begin]");
  if ((await begin.count()) > 0) await begin.click();
}

async function main() {
  const probe = await fetch(`${ON}/api/patient/c5/recovery-decision`, { method: "POST" });
  check("gate-on server reachable; unauthenticated decision API is 401", probe.status === 401, `status ${probe.status}`);
  const { data: ex, error: exErr } = await admin.from("canonical_exercises").insert({ name: `C5.6F exercise ${randomUUID().slice(0, 6)}`, visibility: "global", active: true }).select("id").single();
  if (exErr) throw exErr;
  exerciseId = ex.id;

  const browser = await chromium.launch();
  try {
    // ======================================================================
    section("A. Recovery unmet -> guidance; Take Recovery Day; then Continue -> first set");
    {
      const A = await makeFixture("take", { target: 3, recovery: 1 });
      const anchor = priorSession(A, 1);
      const ctx = await login(browser, A.email, MOBILE);
      const s = await state(ctx);
      check("17. trained yesterday + 1 recovery day: guidance present (server)", s?.kind === "available" && s.recovery?.earliestRecommendedDate === localDate(1) && s.recovery.anchorStartLocalDate === localDate(-1), JSON.stringify(s?.recovery));
      check("11/12. guidance never changes the workout the server offers (Sequence -> B)", s?.options?.[0]?.workoutId === A.workouts[1].id);
      const page = await ctx.newPage();
      await page.goto(`${ON}/patient/dashboard`);
      await page.waitForSelector('[data-c5-recovery-guidance="offered"]');
      const msg = await page.locator("[data-c5-recovery-message]").textContent();
      check("guidance copy: clinician recommendation + next recommended day, neutral", msg.includes("1 recovery day") && msg.includes(shortDate(localDate(1))) && !NON_NEUTRAL.test(msg), msg);
      check("Take Recovery Day and Continue are both offered", (await page.getByRole("button", { name: "Take Recovery Day" }).count()) === 1 && (await page.getByRole("button", { name: "Continue" }).count()) === 1);
      await layoutCheck(page, "mobile-recovery-guidance");
      await page.getByRole("button", { name: "Take Recovery Day" }).click();
      await page.waitForSelector('[data-c5-recovery-guidance="taken"]');
      const d1 = await decisionsOf(A);
      check("24. Take Recovery Day recorded objectively (values actually used)",
        d1.length === 1 && d1[0].decision === "take_recovery_day" && d1[0].recommended_recovery_days === 1 && d1[0].anchor_session_id === anchor
        && d1[0].anchor_start_local_date === localDate(-1) && d1[0].earliest_recommended_date === localDate(1) && d1[0].decision_local_date === localDate(0)
        && d1[0].rest_days_completed === 0 && d1[0].prescription_version_id === A.versionId, JSON.stringify(d1[0]));
      const after = await state(ctx);
      check("18/19. no session created, day not consumed (still eligible)", (await sessionsOf(A)).length === 1 && after?.kind === "available");
      check("20. no Sequence movement (still B)", after?.options?.[0]?.workoutId === A.workouts[1].id);
      const { data: imm } = await admin.from("session_immediate_responses").select("id").eq("user_id", A.userId);
      check("no response obligation created", imm.length === 1);
      await page.reload();
      await page.waitForSelector('[data-c5-recovery-guidance="taken"]');
      check("the choice persists: dashboard shows the recovery day, Continue still available", (await page.getByRole("button", { name: "Continue to workout" }).count()) === 1);
      await page.getByRole("button", { name: "Continue to workout" }).click();
      await page.waitForURL(/\/patient\/session/);
      await page.waitForSelector("[data-c5-exercise]");
      const d2 = await decisionsOf(A);
      check("24. Continue recorded objectively; no wording of override/noncompliance", d2.length === 2 && d2[1].decision === "continue");
      check("22. Continue alone creates no session", (await sessionsOf(A)).length === 1);
      await beginIfReviewing(page);
      await page.locator("[data-c5-unit]").first().getByRole("button", { name: "Done" }).click();
      check("23. first confirmed performance after Continue Starts normally", await waitFor(async () => (await sessionsOf(A)).length === 2));
      await page.close();
      await ctx.close();
    }

    section("B. Session-page variant: Continue reveals the workout; leaving creates nothing");
    {
      const B = await makeFixture("session", { target: 3, recovery: 2 });
      priorSession(B, 2);
      const ctx = await login(browser, B.email);
      const page = await ctx.newPage();
      await page.goto(`${ON}/patient/session`);
      await beginIfReviewing(page);
      await page.waitForSelector('[data-c5-recovery-guidance="offered"]');
      check("2 recovery days, trained 2 days ago: still inside the interval (1 rest day so far)", (await page.locator("[data-c5-recovery-message]").textContent()).includes("2 recovery days"));
      await layoutCheck(page, "desktop-recovery-guidance");
      check("no workout is shown before the choice", (await page.locator("[data-c5-exercise]").count()) === 0);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.waitForSelector("[data-c5-exercise]");
      check("Continue reveals the workout in place", (await page.locator("[data-c5-exercise]").count()) === 1);
      await page.goto(`${ON}/patient/dashboard`);
      check("22. Continue + leave: no session", (await sessionsOf(B)).length === 1 && (await decisionsOf(B)).length === 1);
      const sB = await state(ctx);
      check("after Continue today, the dashboard offers the workout (no repeated prompt)", sB?.recovery?.todaysDecision === "continue" && (await page.getByRole("link", { name: "Open workout" }).count()) === 1);
      await page.close();
      await ctx.close();
    }

    // ======================================================================
    section("C. Weekly target: reached / exceeded never blocks; consolidated message");
    {
      // The zone picker qualifies at every minute of a full week (incl. Monday).
      let picked = 0;
      const t0 = Date.UTC(2026, 9, 19); // Monday 2026-10-19 00:00 UTC
      for (let m = 0; m < 7 * 24 * 60; m++) if (zoneOk(nonMondayZone(new Date(t0 + m * 60000)), new Date(t0 + m * 60000))) picked++;
      check("fixture zone picker finds a non-Monday patient-local date at every minute of the week", picked === 7 * 24 * 60, `${picked}/${7 * 24 * 60}`);
      // Patient-local today is a non-Monday in the fixture's zone (see
      // nonMondayZone), so "yesterday" is always inside this Mon–Sun week.
      // No weekday-dependent skips. (Target reached + recovery MET needs an
      // in-week exposure >= 2 days ago, which cannot exist on Mon/Tue; its
      // date math is covered on every weekday by the fixed-date SQL suite.)
      const zone = nonMondayZone();
      console.log(`      fixture zone ${zone}: patient-local today ${localDateIn(zone)} (ISO weekday ${zoneParts(zone).isoDow})`);

      const C = await makeFixture("target-met", { target: 1, recovery: 0, tz: zone });
      priorSession(C, 1);
      {
        const ctx = await login(browser, C.email);
        const s = await state(ctx);
        check("9/10. reaching the target (1 of 1) does not block training", s?.kind === "available" && s.weekly?.targetReached && s.weekly.finishedSessions === 1 && s.weekly.target === 1, JSON.stringify(s?.weekly));
        check("target reached, no recommendation: no recovery choice", s?.kind === "available" && !s.recovery);
        const page = await ctx.newPage();
        await page.goto(`${ON}/patient/dashboard`);
        const card = await page.locator("[data-c5-state-card]").textContent();
        check("neutral copy: 'You've reached this week's target.' with the workout still offered", card.includes("You've reached this week's target.") && (await page.getByRole("link", { name: "Open workout" }).count()) === 1 && !NON_NEUTRAL.test(card), card);
        check("weekly line shows the objective fact", (await page.locator("[data-c5-weekly]").textContent()).includes("1 of 1 sessions completed"));
        await page.close();
        await ctx.close();
      }

      const X = await makeFixture("target-exceeded", { target: 1, recovery: 0, tz: zone });
      priorSession(X, 1);
      priorSession(X, 0);
      {
        const ctx = await login(browser, X.email);
        const s = await state(ctx);
        check("8. numerator exceeds the target: 2 of 1, not capped", s?.weekly?.finishedSessions === 2 && s.weekly.target === 1 && s.weekly.targetReached, JSON.stringify(s?.weekly));
        check("8. today's limit is the one-session-per-day rule, not the target", s?.kind === "already_trained_today", s?.kind);
        const page = await ctx.newPage();
        await page.goto(`${ON}/patient/dashboard`);
        check("8. weekly line shows 2 of 1 (uncapped)", (await page.locator("[data-c5-weekly]").textContent()).includes("2 of 1 sessions completed"));
        await page.close();
        await ctx.close();
      }

      const D = await makeFixture("consolidated", { target: 1, recovery: 2, tz: zone });
      const anchorD = priorSession(D, 1);
      {
        const ctx = await login(browser, D.email);
        const s = await state(ctx);
        check("28. target reached AND recovery unmet AND otherwise eligible: one consolidated guidance",
          s?.kind === "available" && s.weekly?.targetReached && s.recovery?.earliestRecommendedDate === localDateIn(zone, 2), JSON.stringify({ k: s?.kind, w: s?.weekly, r: s?.recovery }));
        const page = await ctx.newPage();
        await page.goto(`${ON}/patient/dashboard`);
        await page.waitForSelector('[data-c5-recovery-guidance="offered"]');
        const msg = await page.locator("[data-c5-recovery-message]").textContent();
        check("28. consolidated wording names both facts once, neutrally",
          msg.includes("You've completed this week's target (1 of 1 sessions), and your clinician recommended more recovery time before your next session.") && !NON_NEUTRAL.test(msg)
          && (await page.locator("[data-c5-recovery-guidance]").count()) === 1, msg);
        await page.getByRole("button", { name: "Take Recovery Day" }).click();
        await page.waitForSelector('[data-c5-recovery-guidance="taken"]');
        const d1 = await decisionsOf(D);
        check("28. Take Recovery Day in the combined state records the weekly context and values used",
          d1.length === 1 && d1[0].decision === "take_recovery_day" && d1[0].weekly_target === 1 && d1[0].weekly_finished_sessions === 1
          && d1[0].recommended_recovery_days === 2 && d1[0].anchor_session_id === anchorD && d1[0].decision_local_date === localDateIn(zone, 0)
          && d1[0].earliest_recommended_date === localDateIn(zone, 2), JSON.stringify(d1[0]));
        const after = await state(ctx);
        check("28. Take Recovery Day: no session, day not consumed, no Sequence movement", (await sessionsOf(D)).length === 1 && after?.kind === "available" && after.options?.[0]?.workoutId === D.workouts[1].id);
        await page.getByRole("button", { name: "Continue to workout" }).click();
        await page.waitForURL(/\/patient\/session/);
        await page.waitForSelector("[data-c5-exercise]");
        const d2 = await decisionsOf(D);
        check("28. Continue in the combined state is recorded and starts nothing", d2.length === 2 && d2[1].decision === "continue" && (await sessionsOf(D)).length === 1);
        await beginIfReviewing(page);
        await page.locator("[data-c5-unit]").first().getByRole("button", { name: "Done" }).click();
        check("28. first confirmed performance after Continue Starts normally", await waitFor(async () => (await sessionsOf(D)).length === 2));
        await page.close();
        await ctx.close();
      }
    }

    section("D. No recommendation / NULL recommendation -> no prompt");
    {
      const E = await makeFixture("none", { target: 3, recovery: 0 });
      priorSession(E, 1);
      const ctxE = await login(browser, E.email);
      const sE = await state(ctxE);
      check("15. None (0) -> no recovery prompt", sE?.kind === "available" && !sE.recovery);
      const n = await decide(ctxE, "take_recovery_day");
      check("a decision without guidance is refused (nothing recorded)", n.body?.result === "recovery_guidance_not_applicable" && (await decisionsOf(E)).length === 0);
      await ctxE.close();
      const F = await makeFixture("null", { target: 3, recovery: null });
      priorSession(F, 1);
      const ctxF = await login(browser, F.email);
      const sF = await state(ctxF);
      const { data: vF } = await admin.from("prescription_versions").select("recovery_days").eq("id", F.versionId).single();
      check("NULL (never authored) -> no prompt; NULL preserved", sF?.kind === "available" && !sF.recovery && vF.recovery_days === null);
      await ctxF.close();
    }

    section("E. Calendar: never against a scheduled day; make-ups only");
    {
      const G = await makeFixture("cal-sched", { mode: "calendar", recovery: 2, days: [[localDow(0)]] });
      priorSession(G, 1);
      const ctx = await login(browser, G.email);
      const s = await state(ctx);
      check("13/35. scheduled Calendar day inside the interval: no prompt, no weekly X/Y, schedule authoritative", s?.kind === "available" && s.options[0].key === "scheduled_today" && !s.recovery && !s.weekly);
      await ctx.close();
      const H = await makeFixture("cal-makeup", { mode: "calendar", recovery: 2, days: [[localDow(-2)]] });
      priorSession(H, 1, { wi: 0 });
      const ctxH = await login(browser, H.email);
      const sH = await state(ctxH);
      check("make-up inside the interval: guidance offered", sH?.kind === "available" && sH.options[0].key === "make_up" && !!sH.recovery, JSON.stringify(sH)?.slice(0, 200));
      await decide(ctxH, "take_recovery_day");
      const sH2 = await state(ctxH);
      check("21. Take Recovery Day does not shift / consume the Calendar make-up", sH2?.options?.[0]?.key === "make_up" && sH2.options[0].calendarScheduledDate === localDate(-2));
      await ctxH.close();
    }

    section("F. Hard gates suppress the choice; spoofing; gate off");
    {
      const I = await makeFixture("gates", { target: 3, recovery: 2 });
      priorSession(I, 1);
      const ctx = await login(browser, I.email);
      const start = await api(ctx, "POST", "/api/patient/c5/start", {
        clientRequestId: randomUUID(), expectedVersionId: I.versionId, workoutId: I.workouts[1].id,
        performance: { exercise_id: I.workouts[1].exerciseId, unit_index: 0, outcome: "completed", actual_reps: 8 }, preStartSkips: [], sequenceChoice: null,
      });
      check("fixture: training today is still possible (advisory only)", start.body?.result === "started", JSON.stringify(start.body)?.slice(0, 120));
      await api(ctx, "POST", `/api/patient/c5/session/${start.body.session.id}/finish`, {});
      const s = await state(ctx);
      check("31. immediate-response gate: no recovery choice", s?.kind === "immediate_response_required" && !s.recovery);
      const refused = await decide(ctx, "continue");
      check("31. a Continue under the response gate is refused with that gate", refused.body?.result === "immediate_response_required" && (await decisionsOf(I)).length === 0);
      const page = await ctx.newPage();
      await page.goto(`${ON}/patient/dashboard`);
      check("31. dashboard offers no Continue under a hard gate", (await page.getByRole("button", { name: /Continue/ }).count()) === 0);
      await page.close();

      const J = await makeFixture("spoof", { target: 3, recovery: 1 });
      priorSession(J, 1);
      const ctxJ = await login(browser, J.email);
      const spoof = await decide(ctxJ, "continue", { patientId: A_PLACEHOLDER, decisionLocalDate: "2020-01-01", recommendedRecoveryDays: 0, earliestRecommendedDate: "2020-01-02" });
      const dJ = await decisionsOf(J);
      check("36/37. browser timing / identity / recommendation are ignored (server-derived)",
        spoof.body?.result === "recorded" && dJ.length === 1 && dJ[0].user_id === J.userId && dJ[0].decision_local_date === localDate(0)
        && dJ[0].recommended_recovery_days === 1 && dJ[0].earliest_recommended_date === localDate(1), JSON.stringify(dJ[0]));
      const bad = await api(ctxJ, "POST", "/api/patient/c5/recovery-decision", { clientRequestId: randomUUID(), decision: "override" });
      check("only take_recovery_day / continue accepted", bad.status === 400);
      const off = await decide(ctxJ, "continue", {}, OFF);
      check("39. gate off (:3000): decision endpoint unavailable (404)", off.status === 404 && off.body?.code === "C5_RUNTIME_DISABLED", JSON.stringify(off));
      await ctxJ.close();
      await ctx.close();
    }

    // ======================================================================
    section("G. Clinician builder: Recommended recovery between sessions");
    {
      const clin = await makeUser("clinician");
      await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: clin.userId, role: "clinician" });
      const K = await makeFixture("builder", { target: 2, recovery: 0 });
      await admin.from("supervisor_patients").insert({ supervisor_id: clin.userId, patient_id: K.userId, status: "active" });
      const { data: draftId, error: dErr } = await admin.rpc("create_prescription_draft", { p_patient_id: K.userId, p_clinician_id: clin.userId, p_source: "clone_active", p_source_version_id: K.versionId });
      check("fixture: clinician draft", !dErr && !!draftId, dErr?.message);
      const ctx = await login(browser, clin.email);
      const page = await ctx.newPage();
      await page.goto(`${ON}/clinician/patients/${K.userId}/prescription/builder`);
      await page.waitForSelector("[data-testid=recovery-authoring]");
      const options = await page.locator("#recovery-days option").allTextContents();
      check("builder offers None / 1 day / 2 days", options.join("|") === "None|1 day|2 days", options.join("|"));
      check("helper text says it is advisory and does not prevent training",
        (await page.locator("[data-testid=scheduling-panel]").textContent()).includes("It does not prevent them from training."));
      await page.selectOption("#recovery-days", "2");
      check("selection persists to the draft", await waitFor(async () => (await admin.from("prescription_drafts").select("recovery_days").eq("id", draftId).single()).data?.recovery_days === 2));
      const badPatch = await api(ctx, "PATCH", `/api/clinician/prescription-drafts/${draftId}`, { recoveryDays: 15 });
      check("server rejects a value outside 0-14", badPatch.status >= 400 && (await admin.from("prescription_drafts").select("recovery_days").eq("id", draftId).single()).data?.recovery_days === 2);
      const pub = await admin.rpc("publish_prescription_draft", { p_draft_id: draftId, p_clinician_id: clin.userId });
      const { data: pp } = await admin.from("patient_prescriptions").select("current_prescription_version_id").eq("id", K.ppId).single();
      const { data: v2 } = await admin.from("prescription_versions").select("recovery_days").eq("id", pp.current_prescription_version_id).single();
      const { data: v1 } = await admin.from("prescription_versions").select("recovery_days").eq("id", K.versionId).single();
      check("27. publishing copies the value into the new version; the old version keeps its own", !pub.error && v2?.recovery_days === 2 && v1?.recovery_days === 0, pub.error?.message);
      await page.goto(`${ON}/clinician/patients/${K.userId}/prescription/versions/${pp.current_prescription_version_id}`);
      check("published view shows the recommendation", (await page.locator("[data-testid=schedule-recovery]").textContent()).includes("2 days"));
      await page.close();
      await ctx.close();
    }

    // ======================================================================
    section("H. Static checks");
    {
      const files = [
        "lib/c5RuntimeServer.ts",
        "lib/c5RuntimeTypes.ts",
        "lib/c5RuntimeClient.ts",
        "app/api/patient/c5/recovery-decision/route.ts",
        "app/patient/dashboard/components/C5RecoveryGuidance.tsx",
        "app/patient/dashboard/components/C5TodaysRehabCard.tsx",
        "app/patient/dashboard/components/C5Dashboard.tsx",
        "app/patient/session/components/c5/C5SessionRunner.tsx",
      ];
      const src = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
      const writers = files.filter((f) => /\.from\([^)]*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/.test(src[f]));
      check("38. no direct table writes in the runtime code (RPCs only)", writers.length === 0, writers.join(", "));
      const browserFiles = files.filter((f) => f.includes("components/") || f.endsWith("Client.ts") || f.endsWith("Types.ts"));
      check("38. browser code never talks to Supabase", browserFiles.every((f) => !/supabase|createClient|\.rpc\(/.test(src[f])));
      const dateMath = browserFiles.filter((f) => /earliestRecommended[A-Za-z]*\s*=|recoveryDays\s*\+|anchor[A-Za-z]*\s*\+|getTime\(\)\s*[-+]/.test(src[f]));
      check("25/36. no recovery date arithmetic in browser code (server-derived)", dateMath.length === 0, dateMath.join(", "));
      const copy = readFileSync("app/patient/dashboard/components/C5RecoveryGuidance.tsx", "utf8").replace(/\/\/.*$/gm, "");
      check("neutral language: no override / noncompliance / risk / injury wording", !NON_NEUTRAL.test(copy));
      const rxWrites = ["lib/c5RuntimeServer.ts"].filter((f) => /prescription_(versions|drafts|workouts|exercises|exercise_dosage)/.test(src[f]) && /\.(insert|update|upsert)\(/.test(src[f]));
      check("14. no automatic prescription change anywhere in the runtime path", rxWrites.length === 0);
    }
  } finally {
    await browser.close();
  }
}

// A real-looking but foreign patient id for the spoofing check.
const A_PLACEHOLDER = randomUUID();

try {
  await main();
} catch (e) {
  fail++;
  console.log(`FAIL  unexpected error: ${e?.stack ?? e}`);
} finally {
  await teardown();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
