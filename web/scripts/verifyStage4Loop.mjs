// M5 Stage 4 — End-to-End Feedback Loop & Founder Acceptance. Regression
// coverage for the FULL loop (prescription -> session -> M3 -> M4 ->
// tolerance evaluation -> Today's Rehab feedback -> next session handoff)
// that the unit-test suites (guidance.test.ts, todaysRehabFeedback.test.ts,
// acuteSafety.test.ts, etc.) exercise only in isolation. Talks to the REAL
// Next.js API routes over authenticated HTTP (via Playwright's request
// context, sharing cookies with a real logged-in browser session) so it
// actually exercises route-level idempotency/concurrency guards, not just
// the pure functions underneath them.
//
// Sets up (and fully tears down) throwaway Supabase auth users + profiles +
// organization_members rows, PLUS matching legacy FastAPI SQLite rows
// (../app/tenotrainer.db) — the dashboard needs both to render at all (see
// scripts/verifyBrowserStates.mjs, which established this pattern first).
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated
// (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY), Playwright Chromium installed. Point at a
// dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyStage4Loop.mjs
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
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46"; // founder's existing org — throwaway membership rows added+removed, founder's own rows untouched
const PASSWORD = "throwaway-verification-1!";
const legacyDb = new Database.DatabaseSync("../app/tenotrainer.db");

function genUuid() {
  return crypto.randomUUID();
}
function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

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
  const email = `m5-stage4-verify-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("profiles").insert({ id: userId, name: `Stage4 ${label}` });
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });
  const info = legacyDb
    .prepare("INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, 'patient', ?)")
    .run(`Stage4 ${label}`, email, userId);
  const legacyUserId = Number(info.lastInsertRowid);
  legacyDb
    .prepare("INSERT INTO rehab_plans (user_id, stage, irritability, decision, exercises, citations) VALUES (?, 1, 'moderate', 'continue', '[]', '[]')")
    .run(legacyUserId);
  // has_onboarding drives TodaysRehabPanel's "Start Today's Rehab" CTA vs.
  // the "Complete your assessment" placeholder — a real onboarded patient
  // always has one of these rows; without it the dashboard never shows the
  // rehab CTA at all, regardless of anything Stage 4 computes.
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

async function insertVersion(userId, source = "onboarding") {
  const { data } = await admin
    .from("prescription_versions")
    .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source })
    .select()
    .maybeSingle();
  return data;
}

async function loginBrowser(context, email) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);
  // Let the post-login dashboard's own client-side fetches (e.g.
  // MorningResponsePendingNotice) fully settle before anything else
  // navigates again — two back-to-back navigations to the same URL can
  // otherwise overlap two mounts' in-flight requests and let a stale one
  // resolve last (a test-harness artifact, not a real user pattern: no
  // patient double-navigates within milliseconds of their own login
  // redirect).
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

async function startSession(page) {
  const sid = genUuid();
  const startedAt = iso(60000);
  const { status, json } = await apiPost(page, "/api/patient/rehab-session", {
    sessionInstanceId: sid,
    planId: "test-plan",
    prescriptionInstanceId: `test-plan:${sid}`,
    patientLocalDate: startedAt.slice(0, 10),
    startedAt,
    prescriptionSnapshot: [],
  });
  return { status, json };
}

// Completes M2 (exercises-complete) + M3 (peak pain/difficulty + finalize)
// in one call for script brevity. `events` lets a scenario force
// hasSuddenSharpPainEvent/hasPopEvent so the acute questionnaire is
// required, matching real client behavior.
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

// Section 21 browser verification: desktop (current page/viewport) +
// mobile (a fresh page sharing the same login cookies via the context).
async function captureDashboard(page, context, label) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/patient/dashboard`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/stage4_${label}_desktop.png`, fullPage: true });
  const text = await page.textContent("main");

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${BASE_URL}/patient/dashboard`);
  await mobile.waitForLoadState("networkidle").catch(() => {});
  await mobile.waitForTimeout(500);
  await mobile.screenshot({ path: `/tmp/stage4_${label}_mobile.png`, fullPage: true });
  await mobile.close();

  console.log(`  [${label}] desktop: /tmp/stage4_${label}_desktop.png  mobile: /tmp/stage4_${label}_mobile.png`);
  return text;
}

async function main() {
  const browser = await chromium.launch();
  const users = {};

  try {
    // =========================================================================
    // SCENARIO A — normal favorable loop
    // =========================================================================
    console.log("\n=== Scenario A: favorable loop ===");
    users.a = await makeUser("scenA");
    await insertVersion(users.a.userId);
    const ctxA = await browser.newContext();
    const pageA = await loginBrowser(ctxA, users.a.email);

    // Cold-start: brand-new patient, no sessions/evaluations at all yet —
    // no feedback must be fabricated (Section 15).
    const dashColdStart = await captureDashboard(pageA, ctxA, "01_cold_start");
    check("Cold-start: no fabricated 'Well Tolerated' or any tolerance feedback", !dashColdStart.includes("Well Tolerated") && !dashColdStart.includes("Caution") && !dashColdStart.includes("adjustment"), dashColdStart.slice(0, 400));
    check("Cold-start: ordinary Start Rehab CTA still offered", dashColdStart.includes("Start Today's Rehab"));

    const { json: startA } = await startSession(pageA);
    const sessionA = startA.session.id;
    const { json: m3A } = await completeM3(pageA, sessionA, { peakSessionPain: 2, difficulty: "moderate" });
    check("A: M3 finalize returns escalation level 0", m3A.escalation?.level === 0, JSON.stringify(m3A));

    // Morning-response pending: M3 is done, M4 is not — a clear pending
    // state, no normal tolerance result yet (Section 15).
    const dashPending = await captureDashboard(pageA, ctxA, "02_morning_pending");
    check("Morning-pending: no tolerance feedback fabricated while M4 is outstanding", !dashPending.includes("Well Tolerated") && !dashPending.includes("adjustment"), dashPending.slice(0, 400));
    check("Morning-pending: pending notice/CTA present", dashPending.toLowerCase().includes("morning"), dashPending.slice(0, 400));
    check("Morning-pending: contradictory Start Rehab CTA is suppressed (fixed — was previously offered alongside the pending notice)", !dashPending.includes("Start Today's Rehab"), dashPending.slice(0, 400));

    const { json: m4A } = await completeM4(pageA, { nextMorningPain: 1, nextMorningStiffness: 0 });
    check("A: M4 finalize produces well_tolerated evaluation", m4A.toleranceEvaluation?.toleranceClassification === "well_tolerated", JSON.stringify(m4A));

    const dashA = await captureDashboard(pageA, ctxA, "03_well_tolerated");
    check("A: dashboard shows 'Last session: Well Tolerated'", dashA.includes("Last session: Well Tolerated"), dashA.slice(0, 400));
    check("A: dashboard preserves Start Rehab CTA (no override)", dashA.includes("Start Today's Rehab"));

    const { json: startA2 } = await startSession(pageA);
    const sessionA2 = startA2.session.id;
    const { data: sgcA2 } = await admin.from("session_guidance_contexts").select().eq("rehab_session_id", sessionA2).maybeSingle();
    check("A: next session's guidance context captured", !!sgcA2);
    check("A: guidance context reflects well_tolerated/maintain", sgcA2?.source_tolerance_classification === "well_tolerated" && sgcA2?.source_immediate_guidance === "maintain");
    check("A: guidance context reports 'same' prescription version", sgcA2?.prescription_version_comparison === "same");
    await ctxA.close();

    // =========================================================================
    // SCENARIO B — Caution / Maintain Cautiously
    // =========================================================================
    console.log("\n=== Scenario B: Caution/Maintain Cautiously ===");
    users.b = await makeUser("scenB");
    await insertVersion(users.b.userId);
    const ctxB = await browser.newContext();
    const pageB = await loginBrowser(ctxB, users.b.email);

    const { json: startB } = await startSession(pageB);
    const sessionB = startB.session.id;
    await completeM3(pageB, sessionB, { peakSessionPain: 6, difficulty: "hard" });
    const { json: m4B } = await completeM4(pageB, { nextMorningPain: 2, nextMorningStiffness: 0 });
    check("B: produces caution/maintain_cautiously", m4B.toleranceEvaluation?.toleranceClassification === "caution" && m4B.toleranceEvaluation?.immediateGuidance === "maintain_cautiously", JSON.stringify(m4B));

    const dashB = await captureDashboard(pageB, ctxB, "04_caution_maintain_cautiously");
    check("B: dashboard shows 'Monitor today's response'", dashB.includes("Monitor today's response"), dashB.slice(0, 400));
    check("B: dashboard preserves Start Rehab CTA", dashB.includes("Start Today's Rehab"));
    await ctxB.close();

    // =========================================================================
    // SCENARIO C — Reduce/Modify, unchanged prescription, patient proceeds;
    // then a newer response supersedes the old warning without mutating it.
    // =========================================================================
    console.log("\n=== Scenario C: Reduce/Modify unchanged, then superseded ===");
    users.c = await makeUser("scenC");
    await insertVersion(users.c.userId);
    const ctxC = await browser.newContext();
    const pageC = await loginBrowser(ctxC, users.c.email);

    const { json: startC1 } = await startSession(pageC);
    const sessionC1 = startC1.session.id;
    await completeM3(pageC, sessionC1, { peakSessionPain: 2, difficulty: "moderate" });
    const { json: m4C1 } = await completeM4(pageC, { nextMorningPain: 6, nextMorningStiffness: 0 });
    check("C: session 1 produces caution/reduce_modify", m4C1.toleranceEvaluation?.immediateGuidance === "reduce_modify", JSON.stringify(m4C1));
    const evalC1Id = m4C1.toleranceEvaluation.id;

    const dashC1 = await captureDashboard(pageC, ctxC, "05_reduce_modify");
    check("C: dashboard shows the exact approved reduce/modify title", dashC1.includes("Your last response suggests the current loading plan may need adjustment."));
    check("C: dashboard shows the exact approved reduce/modify body", dashC1.includes("Today's prescribed rehab is still available, but this response deserves extra attention."));
    check("C: CTA reads 'Continue to Today's Rehab' (soft-hold, not blocked)", dashC1.includes("Continue to Today's Rehab"));
    check("C: does NOT use alarming 'continue anyway' language", !dashC1.toLowerCase().includes("continue anyway") && !dashC1.toLowerCase().includes("ignored"));

    const { json: startC2 } = await startSession(pageC);
    const sessionC2 = startC2.session.id;
    check("C: session 2 started under the SAME prescription version", startC2.session.prescriptionVersionId === startC1.session.prescriptionVersionId);
    const { data: sgcC2 } = await admin.from("session_guidance_contexts").select().eq("rehab_session_id", sessionC2).maybeSingle();
    check("C: session 2 guidance context shows unresolved reduce_modify", sgcC2?.source_immediate_guidance === "reduce_modify");
    check("C: session 2 guidance context reports 'same' version (no automatic escalation)", sgcC2?.prescription_version_comparison === "same");

    // Session 2 generates NEWER evidence — well tolerated this time.
    await completeM3(pageC, sessionC2, { peakSessionPain: 2, difficulty: "moderate" });
    const { json: m4C2 } = await completeM4(pageC, { nextMorningPain: 1, nextMorningStiffness: 0 });
    check("C: session 2 produces well_tolerated", m4C2.toleranceEvaluation?.toleranceClassification === "well_tolerated");

    const dashC2 = await dashboardText(pageC);
    check("C: dashboard now shows newer well-tolerated evidence, not the stale reduce/modify warning", dashC2.includes("Last session: Well Tolerated") && !dashC2.includes("may need adjustment"), dashC2.slice(0, 400));

    const { data: evalC1After } = await admin.from("tolerance_evaluations").select().eq("id", evalC1Id).maybeSingle();
    check("C: session 1's historical evaluation was never mutated", evalC1After?.immediate_guidance === "reduce_modify" && evalC1After?.tolerance_classification === "caution");
    await ctxC.close();

    // =========================================================================
    // SCENARIO D — Reduce/Modify followed by an updated prescription
    // =========================================================================
    console.log("\n=== Scenario D: Reduce/Modify + updated prescription ===");
    users.d = await makeUser("scenD");
    const versionD1 = await insertVersion(users.d.userId, "onboarding");
    const ctxD = await browser.newContext();
    const pageD = await loginBrowser(ctxD, users.d.email);

    const { json: startD1 } = await startSession(pageD);
    const sessionD1 = startD1.session.id;
    await completeM3(pageD, sessionD1, { peakSessionPain: 2, difficulty: "moderate" });
    const { json: m4D1 } = await completeM4(pageD, { nextMorningPain: 6, nextMorningStiffness: 0 });
    check("D: session 1 produces reduce_modify", m4D1.toleranceEvaluation?.immediateGuidance === "reduce_modify");
    const evalD1Id = m4D1.toleranceEvaluation.id;

    // Legitimate newer prescription version (simulating a clinician change).
    const versionD2 = await insertVersion(users.d.userId, "clinician_change");

    const dashD1 = await captureDashboard(pageD, ctxD, "06_updated_plan_after_response");
    check("D: dashboard recognizes the plan was updated since the last response", dashD1.includes("Your rehab plan has been updated since your last response."), dashD1.slice(0, 400));
    check("D: old warning demoted — no longer shows the active reduce/modify CTA", !dashD1.includes("Continue to Today's Rehab"));

    const { json: startD2 } = await startSession(pageD);
    const sessionD2 = startD2.session.id;
    check("D: session 2 resolves to the NEW prescription version", startD2.session.prescriptionVersionId === versionD2.id);
    const { data: sgcD2 } = await admin.from("session_guidance_contexts").select().eq("rehab_session_id", sessionD2).maybeSingle();
    check("D: session 2 guidance context source version is the OLD version", sgcD2?.source_prescription_version_id === versionD1.id);
    check("D: session 2 guidance context session version is the NEW version", sgcD2?.session_prescription_version_id === versionD2.id);
    check("D: session 2 guidance context reports 'different'", sgcD2?.prescription_version_comparison === "different");

    const { data: evalD1After } = await admin.from("tolerance_evaluations").select().eq("id", evalD1Id).maybeSingle();
    check("D: session 1's historical evaluation preserved unchanged", evalD1After?.immediate_guidance === "reduce_modify");
    await ctxD.close();

    // =========================================================================
    // SCENARIO E — M4 gate blocks a new session; unblocks after completion
    // =========================================================================
    console.log("\n=== Scenario E: M4 gate ===");
    users.e = await makeUser("scenE");
    await insertVersion(users.e.userId);
    const ctxE = await browser.newContext();
    const pageE = await loginBrowser(ctxE, users.e.email);

    const { json: startE1 } = await startSession(pageE);
    const sessionE1 = startE1.session.id;
    await completeM3(pageE, sessionE1, { peakSessionPain: 2, difficulty: "moderate" });

    const { status: blockedStatus, json: blockedJson } = await startSession(pageE);
    check("E: new session blocked while morning response outstanding", blockedStatus === 409 && blockedJson.code === "MORNING_RESPONSE_REQUIRED", JSON.stringify(blockedJson));
    const { data: sessCountE } = await admin.from("rehab_sessions").select("id").eq("user_id", users.e.userId);
    check("E: no session row was created by the blocked attempt", (sessCountE ?? []).length === 1);

    await completeM4(pageE, { nextMorningPain: 1, nextMorningStiffness: 0 });
    const { status: unblockedStatus } = await startSession(pageE);
    check("E: session proceeds once morning response is complete", unblockedStatus === 200);
    await ctxE.close();

    // =========================================================================
    // SCENARIO G — Level 3, evaluated=Yes, cleared=Yes: no prescription
    // required, cautious return captured on first subsequent session.
    // =========================================================================
    console.log("\n=== Scenario G: Level 3 evaluated + cleared ===");
    users.g = await makeUser("scenG");
    await insertVersion(users.g.userId);
    const ctxG = await browser.newContext();
    const pageG = await loginBrowser(ctxG, users.g.email);

    const { json: startG1 } = await startSession(pageG);
    const sessionG1 = startG1.session.id;
    const { json: m3G1 } = await completeM3(pageG, sessionG1, {
      peakSessionPain: 3,
      difficulty: "moderate",
      sudden: true,
      pop: false,
      functional: false,
      events: [{ exerciseId: null, setIndex: null, type: "sudden_sharp_pain", note: null, occurredAt: iso() }],
    });
    check("G: escalation level 3 recorded", m3G1.escalation?.level === 3, JSON.stringify(m3G1));

    const { data: episodeG } = await admin.from("acute_safety_episodes").select().eq("source_rehab_session_id", sessionG1).maybeSingle();
    check("G: acute safety episode confirmed", !!episodeG);

    const dashGBraked = await captureDashboard(pageG, ctxG, "07_level3_brake");
    check("G: dashboard shows the active Level 3 brake, no Start Rehab CTA", dashGBraked.includes("A quick follow-up is needed") && !dashGBraked.includes("Start Today's Rehab"), dashGBraked.slice(0, 300));

    const { status: reassessStatus, json: reassessJson } = await apiPost(pageG, "/api/patient/acute-safety/reassessment", {
      episodeId: episodeG.id,
      suddenOrSharpPainResolved: true,
      evaluatedByProfessional: true,
      clearedByProfessional: true,
    });
    check("G: reassessment POST succeeds", reassessStatus === 200, JSON.stringify(reassessJson));
    check("G: released via professional_clearance (no prescription path)", reassessJson.release?.releasePath === "professional_clearance", JSON.stringify(reassessJson));

    // The acute brake and the M4 morning-response obligation are
    // independent gates (precedence: acute > M4 > ordinary > normal
    // start) — releasing the brake does not itself resolve session G1's
    // own M4 obligation, which still independently blocks a new session.
    const { json: m4G1 } = await completeM4(pageG, { nextMorningPain: 1, nextMorningStiffness: 0 });
    check("G: session 1's own M4 completion produces acute_override (safety supersedes ordinary tolerance)", m4G1.toleranceEvaluation?.toleranceClassification === "acute_override", JSON.stringify(m4G1));

    const { json: startG2 } = await startSession(pageG);
    check("G: next session starts without requiring a new prescription version", startG2.session?.prescriptionVersionId, JSON.stringify(startG2));
    const { data: crcG2 } = await admin.from("cautious_return_contexts").select().eq("rehab_session_id", startG2.session.id).maybeSingle();
    check("G: cautious-return context captured for the first subsequent session", !!crcG2);

    const dashG2 = await captureDashboard(pageG, ctxG, "08_level3_cautious_return");
    check("G: dashboard shows cautious-return context, not a fresh brake", dashG2.includes("Returning after a recent concern") && !dashG2.includes("A quick follow-up is needed"), dashG2.slice(0, 300));

    // Idempotency: starting a THIRD session must not capture cautious-return again.
    const { json: startG3 } = await startSession(pageG);
    const { data: crcAllG } = await admin.from("cautious_return_contexts").select("id").eq("acute_safety_episode_id", episodeG.id);
    check("G: cautious-return context captured exactly once across subsequent sessions", (crcAllG ?? []).length === 1, JSON.stringify(crcAllG));
    await ctxG.close();

    // =========================================================================
    // IDEMPOTENCY — repeated M3 finalize must not duplicate escalation
    // rows or acute safety episodes (the bug this Stage found and fixed).
    // =========================================================================
    console.log("\n=== Idempotency: repeated M3 finalize ===");
    users.idem = await makeUser("idemM3");
    await insertVersion(users.idem.userId);
    const ctxIdem = await browser.newContext();
    const pageIdem = await loginBrowser(ctxIdem, users.idem.email);

    const { json: startIdem } = await startSession(pageIdem);
    const sessionIdem = startIdem.session.id;
    await apiPost(pageIdem, `/api/patient/rehab-session/${sessionIdem}/exercises-complete`, {
      exerciseOutcome: "completed",
      setOutcomes: [],
      sessionEvents: [{ exerciseId: null, setIndex: null, type: "sudden_sharp_pain", note: null, occurredAt: iso() }],
    });
    const finalizeBody = { peakSessionPain: 3, difficulty: "moderate", suddenOrSharpPain: true, popFeltOrHeard: false, newFunctionalDifficulty: false, finalize: true };
    const first = await apiPost(pageIdem, `/api/patient/rehab-session/${sessionIdem}/response`, finalizeBody);
    const second = await apiPost(pageIdem, `/api/patient/rehab-session/${sessionIdem}/response`, finalizeBody);
    const third = await apiPost(pageIdem, `/api/patient/rehab-session/${sessionIdem}/response`, finalizeBody);
    check("Idempotency: all three finalize calls succeed", first.status === 200 && second.status === 200 && third.status === 200);
    check("Idempotency: all three return the same escalation level", first.json.escalation?.level === 3 && second.json.escalation?.level === 3 && third.json.escalation?.level === 3);

    const { data: evalRowsIdem } = await admin.from("escalation_evaluations").select("id").eq("rehab_session_id", sessionIdem);
    check("Idempotency: exactly one escalation_evaluations row despite 3 finalize calls", (evalRowsIdem ?? []).length === 1, JSON.stringify(evalRowsIdem));

    const { data: episodesIdem } = await admin.from("acute_safety_episodes").select("id").eq("source_rehab_session_id", sessionIdem);
    check("Idempotency: exactly one acute_safety_episodes row despite 3 finalize calls", (episodesIdem ?? []).length === 1, JSON.stringify(episodesIdem));
    await ctxIdem.close();

    // =========================================================================
    // CONCURRENCY — parallel session-start attempts must not create
    // duplicate sessions; parallel M3 finalize attempts must not duplicate
    // the escalation row.
    // =========================================================================
    console.log("\n=== Concurrency ===");
    users.conc = await makeUser("concurrency");
    await insertVersion(users.conc.userId);
    const ctxConc = await browser.newContext();
    const pageConc = await loginBrowser(ctxConc, users.conc.email);

    const sidConc = genUuid();
    const startedAtConc = iso(60000);
    const concurrentStartBody = {
      sessionInstanceId: sidConc,
      planId: "test-plan",
      prescriptionInstanceId: `test-plan:${sidConc}`,
      patientLocalDate: startedAtConc.slice(0, 10),
      startedAt: startedAtConc,
      prescriptionSnapshot: [],
    };
    const concStarts = await Promise.all([
      apiPost(pageConc, "/api/patient/rehab-session", concurrentStartBody),
      apiPost(pageConc, "/api/patient/rehab-session", concurrentStartBody),
      apiPost(pageConc, "/api/patient/rehab-session", concurrentStartBody),
    ]);
    check("Concurrency: all 3 parallel session-start calls succeed", concStarts.every((r) => r.status === 200), JSON.stringify(concStarts.map((r) => r.status)));
    const ids = new Set(concStarts.map((r) => r.json.session.id));
    check("Concurrency: all 3 parallel calls resolve to the SAME session id", ids.size === 1, JSON.stringify([...ids]));
    const { data: sessRowsConc } = await admin.from("rehab_sessions").select("id").eq("user_id", users.conc.userId);
    check("Concurrency: exactly one rehab_sessions row exists", (sessRowsConc ?? []).length === 1);
    const sessionConcId = [...ids][0];
    const { data: sgcConc } = await admin.from("session_guidance_contexts").select("id").eq("rehab_session_id", sessionConcId);
    // No prior evaluation exists for this fresh patient, so 0 rows is correct; the point is there's never more than 1.
    check("Concurrency: never more than one guidance-context row from the race", (sgcConc ?? []).length <= 1, JSON.stringify(sgcConc));

    await apiPost(pageConc, `/api/patient/rehab-session/${sessionConcId}/exercises-complete`, { exerciseOutcome: "completed", setOutcomes: [], sessionEvents: [] });
    const concFinalizeBody = { peakSessionPain: 2, difficulty: "moderate", finalize: true };
    const concFinalizes = await Promise.all([
      apiPost(pageConc, `/api/patient/rehab-session/${sessionConcId}/response`, concFinalizeBody),
      apiPost(pageConc, `/api/patient/rehab-session/${sessionConcId}/response`, concFinalizeBody),
      apiPost(pageConc, `/api/patient/rehab-session/${sessionConcId}/response`, concFinalizeBody),
    ]);
    check("Concurrency: all 3 parallel M3 finalize calls succeed", concFinalizes.every((r) => r.status === 200), JSON.stringify(concFinalizes.map((r) => r.status)));
    const { data: evalRowsConc } = await admin.from("escalation_evaluations").select("id").eq("rehab_session_id", sessionConcId);
    check("Concurrency: exactly one escalation_evaluations row despite 3 parallel finalize calls", (evalRowsConc ?? []).length === 1, JSON.stringify(evalRowsConc));
    await ctxConc.close();

    // =========================================================================
    // CHRONOLOGY EDGE CASE — an evaluation with an EARLIER evaluated_at,
    // inserted into the DB AFTER (higher creation_at / row-insert order
    // than) a genuinely later one, must never be treated as "latest."
    // =========================================================================
    console.log("\n=== Chronology edge case ===");
    users.chron = await makeUser("chronology");
    await insertVersion(users.chron.userId);
    const ctxChron = await browser.newContext();
    const pageChron = await loginBrowser(ctxChron, users.chron.email);

    // Genuinely-later evaluation, inserted FIRST (well_tolerated).
    const { json: startChronNewer } = await startSession(pageChron);
    await completeM3(pageChron, startChronNewer.session.id, { peakSessionPain: 2, difficulty: "moderate" });
    await completeM4(pageChron, { nextMorningPain: 1, nextMorningStiffness: 0 });

    // Backfilled OLDER evaluation (reduce_modify), inserted SECOND — its
    // own row `created_at` is later in wall-clock/insertion order than the
    // one above, but its clinical evaluated_at predates it by 2 hours.
    const backfillSessionId = genUuid();
    await admin.from("rehab_sessions").insert({
      id: backfillSessionId,
      user_id: users.chron.userId,
      plan_id: "test-plan",
      prescription_instance_id: `test-plan:${backfillSessionId}`,
      patient_local_date: iso(-1000 * 60 * 60 * 3).slice(0, 10),
      status: "response_complete",
      started_at: iso(-1000 * 60 * 60 * 3),
      prescription_snapshot: [],
      peak_session_pain: 2,
      difficulty: "moderate",
      response_recorded_at: iso(-1000 * 60 * 60 * 2.5),
      current_escalation_level: 0,
    });
    await admin.from("tolerance_evaluations").insert({
      rehab_session_id: backfillSessionId,
      tolerance_classification: "caution",
      immediate_guidance: "reduce_modify",
      patient_facing_label: "Caution",
      reason: "backfilled older record",
      reason_codes: ["elevated_morning_pain"],
      rule_version: "v1",
      inputs_snapshot: {},
      evaluated_at: iso(-1000 * 60 * 60 * 2), // 2h in the past — OLDER than the well_tolerated evaluation just created above
    });

    const dashChron = await dashboardText(pageChron);
    check(
      "Chronology: dashboard still shows the clinically-newer well_tolerated evaluation, not the backfilled older reduce_modify one",
      dashChron.includes("Last session: Well Tolerated") && !dashChron.includes("may need adjustment"),
      dashChron.slice(0, 400)
    );

    // "No rehab scheduled today" (Section 15/Scenario K) — architectural
    // finding: the current system (session_plan from the legacy FastAPI
    // engine's _build_session_plan) has NO day-of-week/rest-day schedule
    // concept in the live M3+ codepath; the only such mechanism
    // (schedule_overrides + can_override_session_spacing in the legacy
    // /daily-log route) was explicitly retired in M4 Stage 3 and now
    // unconditionally redirects before any of that logic runs. A
    // "non-rehab day" therefore cannot be constructed as a distinct state
    // today. The closest genuinely-testable claim from the spec — that
    // viewing recent-response feedback never itself manufactures a session
    // — IS verifiable and is checked here: repeatedly loading the
    // dashboard (with real response history already on file, same as
    // every scenario above) must never change the patient's rehab_sessions
    // row count.
    const { count: sessionCountBeforeReload } = await admin.from("rehab_sessions").select("id", { count: "exact", head: true }).eq("user_id", users.chron.userId);
    const dashNoManufacture = await captureDashboard(pageChron, ctxChron, "09_no_manufactured_session");
    await dashboardText(pageChron);
    await dashboardText(pageChron);
    const { count: sessionCountAfterReload } = await admin.from("rehab_sessions").select("id", { count: "exact", head: true }).eq("user_id", users.chron.userId);
    check(
      "No-manufactured-session: repeated dashboard views never create a rehab_sessions row on their own",
      sessionCountBeforeReload === sessionCountAfterReload,
      `before=${sessionCountBeforeReload} after=${sessionCountAfterReload}`
    );
    check("No-manufactured-session: dashboard still shows recent response context, not a blank/broken state", dashNoManufacture.includes("Well Tolerated"));
    await ctxChron.close();

    // =========================================================================
    // SECURITY — patients cannot write authoritative facts directly.
    // =========================================================================
    console.log("\n=== Security spot checks ===");
    users.sec = await makeUser("security");
    await insertVersion(users.sec.userId);
    const anonForSec = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    await anonForSec.auth.signInWithPassword({ email: users.sec.email, password: PASSWORD });

    const writeTolerance = await anonForSec.from("tolerance_evaluations").insert({
      rehab_session_id: genUuid(),
      tolerance_classification: "well_tolerated",
      immediate_guidance: "maintain",
      patient_facing_label: "Well Tolerated",
      reason: "spoofed",
      reason_codes: [],
      rule_version: "v1",
      inputs_snapshot: {},
    });
    check("Security: authenticated patient cannot INSERT into tolerance_evaluations directly", !!writeTolerance.error, JSON.stringify(writeTolerance.error));

    const writeEpisode = await anonForSec.from("acute_safety_episodes").insert({
      user_id: users.sec.userId,
      source_rehab_session_id: genUuid(),
      source_escalation_evaluation_id: genUuid(),
      initial_level: 5,
      initial_sudden_or_sharp_pain: false,
      initial_new_functional_difficulty: false,
      initial_pop_felt_or_heard: true,
      recurrence_sequence_in_window: 1,
      confirmed_at: iso(),
    });
    check("Security: authenticated patient cannot INSERT into acute_safety_episodes directly", !!writeEpisode.error, JSON.stringify(writeEpisode.error));

    const writeVersion = await anonForSec.from("prescription_versions").insert({
      user_id: users.sec.userId,
      stage: 4,
      irritability: "low",
      is_insertional: false,
      source: "clinician_change",
    });
    check("Security: authenticated patient cannot INSERT into prescription_versions directly", !!writeVersion.error, JSON.stringify(writeVersion.error));

    const anonPublic = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    const anonRpc = await anonPublic.rpc("reconcile_missing_acute_episodes", { p_user_id: users.sec.userId });
    check("Security: unauthenticated (anon) caller cannot invoke reconcile_missing_acute_episodes", !!anonRpc.error, JSON.stringify(anonRpc.error));
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
