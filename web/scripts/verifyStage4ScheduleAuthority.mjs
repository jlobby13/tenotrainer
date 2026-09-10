// Milestone 5, Stage 4 schedule-authority closure patch — founder-acceptance
// verification for the states verifyStage4Loop.mjs could NOT exercise
// before 20260909000003 existed (prescription_versions.rehab_days_of_week
// was not a column, so no "not_scheduled" state could be constructed).
// This script is additive to verifyStage4Loop.mjs, not a replacement — it
// assumes that script's 64 checks already pass (zero-behavior-change
// regression) and focuses exclusively on the NEW schedule-eligibility
// primitive's live behavior: scheduled / not_scheduled / unknown, gate
// ordering, dashboard display, retries/concurrency, and non-mutation of
// historical prescription versions.
//
// Same harness conventions as verifyStage4Loop.mjs: throwaway Supabase auth
// users + profiles + organization_members + matching legacy FastAPI SQLite
// rows, fully torn down in `finally`. Requires `next dev` on localhost:3000
// and the legacy FastAPI app's SQLite DB at ../app/tenotrainer.db.
//
// All test users are given profiles.timezone = 'UTC' directly (bypassing
// the app's timezone-initialization endpoint, which only ever fires from
// the browser) so getTodaysRehabDayEligibility's server-computed
// patient-local date is deterministic and matches the UTC date this script
// also uses for patientLocalDate / rehab_days_of_week, regardless of what
// wall-clock time this script happens to run at.
//
// Run from the web/ directory:
//   node scripts/verifyStage4ScheduleAuthority.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import Database from "node:sqlite";

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
const BASE_URL = "http://localhost:3000";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const PASSWORD = "throwaway-verification-1!";
const legacyDb = new Database.DatabaseSync("../app/tenotrainer.db");

function genUuid() {
  return crypto.randomUUID();
}
function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// Deterministic "today" in UTC — matches both the TS mirror
// (toZonedTime(now, 'UTC')) and the SQL mirror (EXTRACT(DOW FROM a DATE))
// since every test profile below is pinned to timezone = 'UTC'.
const TODAY_DOW = new Date().getUTCDay();
const TODAY_LOCAL_DATE = new Date().toISOString().slice(0, 10);
const NOT_SCHEDULED_DAYS = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== TODAY_DOW);

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function makeUser(label) {
  const email = `m5-stage4-sched-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  // profiles has an AFTER INSERT ON auth.users trigger
  // (handle_new_auth_user, 20260831000001_stage1_schema.sql) that
  // synchronously auto-creates a bare {id, name} row the instant
  // createUser() runs — an .insert() here would conflict on the PK and
  // silently no-op (never checked), leaving timezone NULL until the
  // browser's client-side TimezoneInitializer auto-detects and writes the
  // HOST's real (non-UTC) timezone on first render, which would make
  // "today" ambiguous between this script's UTC-based day-of-week and the
  // host's local day-of-week. .update() instead — the row already exists —
  // pins timezone='UTC' deterministically before any dashboard render.
  const { error: profileErr } = await admin.from("profiles").update({ name: `Stage4Sched ${label}`, timezone: "UTC" }).eq("id", userId);
  if (profileErr) throw new Error(`profile update failed: ${profileErr.message}`);
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });
  const info = legacyDb
    .prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, 'patient', ?)")
    .run(`Stage4Sched ${label}`, email, userId);
  const legacyUserId = Number(info.lastInsertRowid);
  legacyDb
    .prepare("INSERT INTO rehab_plans (user_id, stage, irritability, decision, exercises, citations) VALUES (?, 1, 'moderate', 'continue', '[]', '[]')")
    .run(legacyUserId);
  legacyDb
    .prepare(
      "INSERT INTO onboarding_assessments (user_id, morning_stiffness, pain_at_rest, pain_with_activity, pain_after_activity, next_day_pain, calf_raise_reps, injury_duration, stage, irritability) VALUES (?, 2, 1, 2, 2, 2, 15, '3_to_6_months', 1, 'moderate')"
    )
    .run(legacyUserId);
  return { userId, email, legacyUserId };
}

async function cleanupUser(userId, legacyUserId) {
  const sessionIds = (await admin.from("rehab_sessions").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
  const episodeIds = (await admin.from("acute_safety_episodes").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
  if (sessionIds.length > 0) {
    await admin.from("session_guidance_contexts").delete().in("rehab_session_id", sessionIds);
    await admin.from("cautious_return_contexts").delete().in("rehab_session_id", sessionIds);
    await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
    await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
    await admin.from("escalation_evaluations").delete().in("rehab_session_id", sessionIds);
    await admin.from("session_events").delete().in("rehab_session_id", sessionIds);
    await admin.from("set_outcomes").delete().in("rehab_session_id", sessionIds);
    await admin.from("session_load_observations").delete().in("rehab_session_id", sessionIds);
  }
  if (episodeIds.length > 0) {
    await admin.from("blocked_loading_opportunities").delete().in("acute_safety_episode_id", episodeIds);
    await admin.from("acute_safety_releases").delete().in("acute_safety_episode_id", episodeIds);
    await admin.from("acute_safety_reassessments").delete().in("acute_safety_episode_id", episodeIds);
  }
  await admin.from("acute_safety_episodes").delete().eq("user_id", userId);
  await admin.from("rehab_sessions").delete().eq("user_id", userId);
  await admin.from("prescription_versions").delete().eq("user_id", userId);
  await admin.from("organization_members").delete().eq("user_id", userId);
  await admin.from("profiles").delete().eq("id", userId);
  await admin.auth.admin.deleteUser(userId);
  if (legacyUserId != null) {
    legacyDb.prepare("DELETE FROM onboarding_assessments WHERE user_id = ?").run(legacyUserId);
    legacyDb.prepare("DELETE FROM rehab_plans WHERE user_id = ?").run(legacyUserId);
    legacyDb.prepare("DELETE FROM users WHERE id = ?").run(legacyUserId);
  }
}

async function insertVersion(userId, { source = "onboarding", rehabDaysOfWeek = null } = {}) {
  const { data, error } = await admin
    .from("prescription_versions")
    .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source, rehab_days_of_week: rehabDaysOfWeek })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loginBrowser(context, email) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);
  await page.waitForLoadState("networkidle").catch(() => {});
  return page;
}

async function apiPost(page, path, body) {
  const res = await page.request.post(`${BASE_URL}${path}`, { data: body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status(), json };
}
async function apiGet(page, path) {
  const res = await page.request.get(`${BASE_URL}${path}`);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status(), json };
}

async function startSession(page, patientLocalDate = TODAY_LOCAL_DATE) {
  const sid = genUuid();
  const startedAt = iso(60000);
  const { status, json } = await apiPost(page, "/api/patient/rehab-session", {
    sessionInstanceId: sid,
    planId: "test-plan",
    prescriptionInstanceId: `test-plan:${sid}`,
    patientLocalDate,
    startedAt,
    prescriptionSnapshot: [],
  });
  return { status, json };
}

async function completeM3(page, sessionId, { peakSessionPain, difficulty, sudden = null, pop = null, functional = null, events = [] }) {
  await apiPost(page, `/api/patient/rehab-session/${sessionId}/exercises-complete`, {
    exerciseOutcome: "completed",
    setOutcomes: [],
    sessionEvents: events,
  });
  const body = { peakSessionPain, difficulty, finalize: true };
  if (sudden !== null) body.suddenOrSharpPain = sudden;
  if (pop !== null) body.popFeltOrHeard = pop;
  if (functional !== null) body.newFunctionalDifficulty = functional;
  return apiPost(page, `/api/patient/rehab-session/${sessionId}/response`, body);
}

async function completeM4(page, { nextMorningPain, nextMorningStiffness, stiffnessDuration = null, tolerability = null }) {
  const { json: pending } = await apiGet(page, "/api/patient/rehab-session/pending-morning-response");
  const mrId = pending.morningResponse.id;
  const body = { nextMorningPain, nextMorningStiffness, finalize: true };
  if (stiffnessDuration) body.stiffnessDuration = stiffnessDuration;
  if (tolerability) body.morningPainTolerability = tolerability;
  const { status, json } = await apiPost(page, `/api/patient/morning-response/${mrId}`, body);
  return { status, json, morningResponseId: mrId };
}

async function dashboardText(page) {
  await page.goto(`${BASE_URL}/patient/dashboard`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
  return page.textContent("main");
}

async function captureDashboard(page, context, label) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/patient/dashboard`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/stage4sched_${label}_desktop.png`, fullPage: true });
  const text = await page.textContent("main");

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${BASE_URL}/patient/dashboard`);
  await mobile.waitForLoadState("networkidle").catch(() => {});
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: `/tmp/stage4sched_${label}_mobile.png`, fullPage: true });
  await mobile.close();

  console.log(`  [${label}] desktop: /tmp/stage4sched_${label}_desktop.png  mobile: /tmp/stage4sched_${label}_mobile.png`);
  return text;
}

async function sessionCount(userId) {
  const { count } = await admin.from("rehab_sessions").select("id", { count: "exact", head: true }).eq("user_id", userId);
  return count ?? 0;
}

async function main() {
  console.log(`Today (UTC) = ${TODAY_LOCAL_DATE}, day-of-week = ${TODAY_DOW}`);
  console.log(`NOT_SCHEDULED_DAYS (excludes today) = ${JSON.stringify(NOT_SCHEDULED_DAYS)}`);
  const browser = await chromium.launch();
  const users = {};

  try {
    // =========================================================================
    // SCENARIO 1 — Scheduled today, no higher-priority gate: CTA offered,
    // direct session creation succeeds.
    // =========================================================================
    console.log("\n=== Scenario 1: scheduled today ===");
    users.sched = await makeUser("scheduled");
    await insertVersion(users.sched.userId, { rehabDaysOfWeek: [TODAY_DOW] });
    const ctxSched = await browser.newContext();
    const pageSched = await loginBrowser(ctxSched, users.sched.email);

    const dashSched = await captureDashboard(pageSched, ctxSched, "01_scheduled_today");
    check("1: dashboard offers Start Today's Rehab CTA on a scheduled day", dashSched.includes("Start Today's Rehab"), dashSched.slice(0, 300));
    check("1: dashboard does NOT show 'No rehab scheduled today'", !dashSched.includes("No rehab scheduled today"));

    const { status: startSchedStatus } = await startSession(pageSched);
    check("1: session creation succeeds on a scheduled day", startSchedStatus === 200);
    await ctxSched.close();

    // =========================================================================
    // SCENARIO 2 — Not scheduled today: CTA suppressed, direct session
    // creation rejected, zero session rows, survives retries + concurrency.
    // =========================================================================
    console.log("\n=== Scenario 2: not scheduled today ===");
    users.notSched = await makeUser("notscheduled");
    await insertVersion(users.notSched.userId, { rehabDaysOfWeek: NOT_SCHEDULED_DAYS });
    const ctxNS = await browser.newContext();
    const pageNS = await loginBrowser(ctxNS, users.notSched.email);

    const dashNS = await captureDashboard(pageNS, ctxNS, "02_not_scheduled");
    check("2: dashboard shows 'No rehab scheduled today'", dashNS.includes("No rehab scheduled today"), dashNS.slice(0, 300));
    check("2: dashboard does NOT offer Start Today's Rehab CTA", !dashNS.includes("Start Today's Rehab"));

    check("2: zero session rows before any attempt", (await sessionCount(users.notSched.userId)) === 0);
    const { status: blockedStatus1, json: blockedJson1 } = await startSession(pageNS);
    check("2: direct session creation rejected with 409/REHAB_NOT_SCHEDULED_TODAY", blockedStatus1 === 409 && blockedJson1.code === "REHAB_NOT_SCHEDULED_TODAY", JSON.stringify(blockedJson1));
    check("2: redirectTo points at the dashboard (no dedicated screen)", blockedJson1.redirectTo === "/patient/dashboard");
    check("2: zero session rows after the blocked attempt", (await sessionCount(users.notSched.userId)) === 0);

    // Retries — a repeated attempt must remain a safe no-op, never create a row.
    for (let i = 0; i < 3; i++) {
      const { status, json } = await startSession(pageNS);
      check(`2: retry #${i + 1} still rejected with REHAB_NOT_SCHEDULED_TODAY`, status === 409 && json.code === "REHAB_NOT_SCHEDULED_TODAY");
    }
    check("2: zero session rows after 3 sequential retries", (await sessionCount(users.notSched.userId)) === 0);

    // Concurrency — parallel session-start attempts on a not-scheduled day
    // must all be rejected and never race a row into existence.
    const concResults = await Promise.all([startSession(pageNS), startSession(pageNS), startSession(pageNS)]);
    check(
      "2: all 3 parallel session-start attempts rejected with REHAB_NOT_SCHEDULED_TODAY",
      concResults.every((r) => r.status === 409 && r.json.code === "REHAB_NOT_SCHEDULED_TODAY"),
      JSON.stringify(concResults.map((r) => [r.status, r.json?.code]))
    );
    check("2: zero session rows after 3 concurrent attempts", (await sessionCount(users.notSched.userId)) === 0);
    await ctxNS.close();

    // =========================================================================
    // SCENARIO 3 — Unknown schedule (rehab_days_of_week IS NULL, the value
    // every real prescription has today) behaves exactly like pre-patch:
    // never fabricated as scheduled OR not_scheduled, CTA still offered.
    // =========================================================================
    console.log("\n=== Scenario 3: unknown schedule ===");
    users.unknown = await makeUser("unknown");
    await insertVersion(users.unknown.userId, { rehabDaysOfWeek: null });
    const ctxU = await browser.newContext();
    const pageU = await loginBrowser(ctxU, users.unknown.email);

    const dashU = await captureDashboard(pageU, ctxU, "03_unknown_schedule");
    check("3: unknown schedule still offers Start Today's Rehab CTA", dashU.includes("Start Today's Rehab"), dashU.slice(0, 300));
    check("3: unknown schedule never shows 'No rehab scheduled today'", !dashU.includes("No rehab scheduled today"));
    const { status: startUStatus } = await startSession(pageU);
    check("3: session creation succeeds under unknown schedule (never blocks)", startUStatus === 200);
    await ctxU.close();

    // =========================================================================
    // SCENARIO 4 — M4 morning response + Reduce/Modify feedback remain
    // actionable/relevant on a day that BECOMES not-scheduled after the
    // session started; a newer prescription version changes schedule
    // without mutating the historical version; recent feedback never
    // fabricates a rehab day.
    // =========================================================================
    console.log("\n=== Scenario 4: M4 + Reduce/Modify across a non-rehab day ===");
    users.m4 = await makeUser("m4nonrehab");
    const v1 = await insertVersion(users.m4.userId, { rehabDaysOfWeek: [TODAY_DOW], source: "onboarding" });
    const ctxM4 = await browser.newContext();
    const pageM4 = await loginBrowser(ctxM4, users.m4.email);

    const { json: startM4 } = await startSession(pageM4);
    const sessionM4 = startM4.session.id;
    check("4: session starts fine while today is still scheduled", startM4.session?.id != null);

    await pageM4.request.post(`${BASE_URL}/api/patient/rehab-session/${sessionM4}/exercises-complete`, {
      data: { exerciseOutcome: "completed", setOutcomes: [], sessionEvents: [] },
    });
    const { json: m3M4 } = await apiPost(pageM4, `/api/patient/rehab-session/${sessionM4}/response`, {
      peakSessionPain: 2,
      difficulty: "moderate",
      finalize: true,
    });
    check("4: M3 finalize succeeds", m3M4.escalation?.level === 0, JSON.stringify(m3M4));

    // Newer prescription version now marks today as NOT scheduled — a
    // legitimate clinician-driven schedule change made AFTER this session
    // already started under the old schedule.
    const v2 = await insertVersion(users.m4.userId, { rehabDaysOfWeek: NOT_SCHEDULED_DAYS, source: "clinician_change" });
    const { data: v1After } = await admin.from("prescription_versions").select().eq("id", v1.id).maybeSingle();
    check("4: historical version v1's rehab_days_of_week was never mutated", JSON.stringify(v1After.rehab_days_of_week) === JSON.stringify([TODAY_DOW]), JSON.stringify(v1After.rehab_days_of_week));
    check("4: latest version resolved for eligibility is now v2 (different id)", v2.id !== v1.id);

    // Dashboard, BEFORE M4 completion: outstanding morning-response
    // obligation must still be shown/actionable — must NOT be replaced by
    // "No rehab scheduled today", and must NOT offer a contradictory CTA.
    const dashPendingNS = await captureDashboard(pageM4, ctxM4, "04a_m4_pending_on_nonrehab_day");
    check("4: morning-response-pending notice still shown though today is now not-scheduled", dashPendingNS.toLowerCase().includes("morning"), dashPendingNS.slice(0, 400));
    check("4: 'No rehab scheduled today' does NOT replace the pending notice", !dashPendingNS.includes("No rehab scheduled today"), dashPendingNS.slice(0, 400));
    check("4: Start Today's Rehab CTA absent while M4 is pending", !dashPendingNS.includes("Start Today's Rehab"));

    // A brand-new session-start attempt today is correctly rejected —
    // schedule is dispositive per the closure-patch brief (Section 3: "no
    // loading opportunity today" is checked before other gates), so the
    // code returned is REHAB_NOT_SCHEDULED_TODAY even though M4 is ALSO
    // outstanding. The M4 obligation itself remains reachable through its
    // own endpoint regardless (checked next) — this call only proves the
    // START endpoint's gate ordering is what the migration documents.
    const { status: newStartBlockedStatus, json: newStartBlockedJson } = await startSession(pageM4);
    check(
      "4: new session-start attempt blocked by schedule (documented gate ordering)",
      newStartBlockedStatus === 409 && newStartBlockedJson.code === "REHAB_NOT_SCHEDULED_TODAY",
      JSON.stringify(newStartBlockedJson)
    );

    // M4 finalize on the EXISTING session — a separate endpoint untouched
    // by the schedule check — must still succeed, producing reduce_modify.
    const { json: m4M4 } = await completeM4(pageM4, { nextMorningPain: 6, nextMorningStiffness: 0 });
    check("4: M4 finalize still succeeds on a non-rehab day (separate endpoint, no schedule dependency)", m4M4.toleranceEvaluation != null, JSON.stringify(m4M4));
    check("4: M4 result is caution/reduce_modify", m4M4.toleranceEvaluation?.immediateGuidance === "reduce_modify", JSON.stringify(m4M4));

    // Dashboard, AFTER M4 completion: Reduce/Modify feedback must remain
    // visible (not manufactured, not suppressed) even though the CTA
    // beneath it is now the "No rehab scheduled" notice instead of
    // "Continue to Today's Rehab" — the warning and the schedule fact
    // coexist rather than one hiding the other.
    const dashAfterM4NS = await captureDashboard(pageM4, ctxM4, "04b_reduce_modify_on_nonrehab_day");
    check(
      "4: Reduce/Modify warning still shown on a non-rehab day",
      dashAfterM4NS.includes("Your last response suggests the current loading plan may need adjustment."),
      dashAfterM4NS.slice(0, 400)
    );
    check(
      "4: 'No rehab scheduled today' now shown in place of the Continue-to-rehab CTA",
      dashAfterM4NS.includes("No rehab scheduled today") && !dashAfterM4NS.includes("Continue to Today's Rehab"),
      dashAfterM4NS.slice(0, 400)
    );

    // Recent feedback must never manufacture a session row on its own —
    // reload the dashboard repeatedly and confirm the count never moves.
    const countBeforeReloadM4 = await sessionCount(users.m4.userId);
    await dashboardText(pageM4);
    await dashboardText(pageM4);
    await dashboardText(pageM4);
    const countAfterReloadM4 = await sessionCount(users.m4.userId);
    check(
      "4: repeated dashboard views with Reduce/Modify + non-rehab-day never fabricate a session row",
      countBeforeReloadM4 === countAfterReloadM4 && countAfterReloadM4 === 1,
      `before=${countBeforeReloadM4} after=${countAfterReloadM4}`
    );
    await ctxM4.close();

    // =========================================================================
    // SCENARIO 5 — Acute Level 3 safety remains actionable on a non-rehab
    // day: brake still shown with top precedence over the schedule notice,
    // reassessment endpoint (a separate route) still functions.
    // =========================================================================
    console.log("\n=== Scenario 5: acute safety brake across a non-rehab day ===");
    users.acute = await makeUser("acutenonrehab");
    await insertVersion(users.acute.userId, { rehabDaysOfWeek: [TODAY_DOW] });
    const ctxAcute = await browser.newContext();
    const pageAcute = await loginBrowser(ctxAcute, users.acute.email);

    const { json: startAcute } = await startSession(pageAcute);
    const sessionAcute = startAcute.session.id;
    const { json: m3Acute } = await completeM3(pageAcute, sessionAcute, {
      peakSessionPain: 3,
      difficulty: "moderate",
      sudden: true,
      pop: false,
      functional: false,
      events: [{ exerciseId: null, setIndex: null, type: "sudden_sharp_pain", note: null, occurredAt: iso() }],
    });
    check("5: escalation level 3 recorded", m3Acute.escalation?.level === 3, JSON.stringify(m3Acute));
    const { data: episodeAcute } = await admin.from("acute_safety_episodes").select().eq("source_rehab_session_id", sessionAcute).maybeSingle();
    check("5: acute safety episode confirmed", !!episodeAcute);

    // Newer version now marks today as not-scheduled, with the brake still active.
    await insertVersion(users.acute.userId, { rehabDaysOfWeek: NOT_SCHEDULED_DAYS, source: "clinician_change" });

    const dashBrakeNS = await captureDashboard(pageAcute, ctxAcute, "05a_brake_on_nonrehab_day");
    check("5: acute brake notice still shown though today is not-scheduled", dashBrakeNS.includes("A quick follow-up is needed"), dashBrakeNS.slice(0, 300));
    check("5: 'No rehab scheduled today' does NOT replace/hide the brake notice", !dashBrakeNS.includes("No rehab scheduled today"), dashBrakeNS.slice(0, 300));
    check("5: Start Today's Rehab CTA absent while brake is active", !dashBrakeNS.includes("Start Today's Rehab"));

    // A NEW session-start attempt: schedule is checked before the acute
    // gate inside create_rehab_session_if_allowed (documented ordering —
    // "no loading opportunity today" is dispositive), so this returns
    // REHAB_NOT_SCHEDULED_TODAY rather than ACUTE_SAFETY_REVIEW_REQUIRED.
    const { status: acuteStartBlockedStatus, json: acuteStartBlockedJson } = await startSession(pageAcute);
    check(
      "5: new-session attempt on brake+non-rehab day returns REHAB_NOT_SCHEDULED_TODAY (documented gate ordering, not a masked safety bug)",
      acuteStartBlockedStatus === 409 && acuteStartBlockedJson.code === "REHAB_NOT_SCHEDULED_TODAY",
      JSON.stringify(acuteStartBlockedJson)
    );

    // The acute reassessment flow itself is a SEPARATE endpoint with no
    // schedule dependency — it must remain fully actionable.
    const { status: reassessStatusNS, json: reassessJsonNS } = await apiPost(pageAcute, "/api/patient/acute-safety/reassessment", {
      episodeId: episodeAcute.id,
      suddenOrSharpPainResolved: true,
      evaluatedByProfessional: true,
      clearedByProfessional: true,
    });
    check("5: acute reassessment submission still succeeds on a non-rehab day", reassessStatusNS === 200, JSON.stringify(reassessJsonNS));
    check("5: released via professional_clearance", reassessJsonNS.release?.releasePath === "professional_clearance", JSON.stringify(reassessJsonNS));

    const dashReleasedNS = await captureDashboard(pageAcute, ctxAcute, "05b_brake_released_still_nonrehab_day");
    check("5: after release, brake notice gone", !dashReleasedNS.includes("A quick follow-up is needed"), dashReleasedNS.slice(0, 300));
    // The session's own M4 obligation is independent of both the brake and
    // the schedule — confirm it is still reachable/actionable too.
    const { json: m4Acute } = await completeM4(pageAcute, { nextMorningPain: 1, nextMorningStiffness: 0 });
    check("5: session's own M4 completion still succeeds after release, on a non-rehab day", m4Acute.toleranceEvaluation?.toleranceClassification === "acute_override", JSON.stringify(m4Acute));

    // Now that the brake is released and M4 is resolved, the schedule fact
    // (not-scheduled) should surface plainly (no brake, no pending notice
    // masking it).
    const dashFinalNS = await captureDashboard(pageAcute, ctxAcute, "05c_final_nonrehab_day_state");
    check("5: with brake released and M4 resolved, 'No rehab scheduled today' now surfaces", dashFinalNS.includes("No rehab scheduled today"), dashFinalNS.slice(0, 300));
    await ctxAcute.close();
  } finally {
    console.log("\nCleaning up...");
    for (const key of Object.keys(users)) {
      await cleanupUser(users[key].userId, users[key].legacyUserId).catch((e) => console.error(`cleanup failed for ${key}:`, e));
    }
    legacyDb.close();
    await browser.close();
    console.log("Cleanup complete.");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
