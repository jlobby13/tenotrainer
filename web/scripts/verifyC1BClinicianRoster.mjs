// C1B — Clinician Dashboard & Roster. Live verification. Drives the REAL
// Next.js /clinician/dashboard route over authenticated HTTP via
// Playwright, using entirely throwaway fixture users — never the
// founder's own real supervisor_patients relationship. Mirrors
// verifyC1AClinicianFoundation.mjs's conventions exactly (loadEnv, admin
// client, makeUser, loginContext, full teardown).
//
// Covers the C1B locked founder decisions: prescription stage / "No
// current prescription", last-qualifying-session recency labels, the
// 14-day factual recent-activity count (qualifying = exercise_outcome IS
// NOT NULL, excluding a bare in_progress session and excluding sessions
// outside the window), acute-safety "Clinical review active" (no
// diagnostic detail leaked), morning-response due/pending/none (including
// the not-yet-due case rendering NO badge, never "overdue"), and
// alphabetical case-insensitive roster sorting independent of any
// clinical signal.
//
// Requires: `next dev` running on localhost:3000, web/.env.local
// populated. Point at a dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyC1BClinicianRoster.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

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

async function makeUser(label, name) {
  const email = `c1b-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, name });
  if (profileError) throw profileError;
  return { userId, email };
}

async function addOrgMember(userId, role) {
  const { error } = await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role });
  if (error) throw error;
}

async function loginContext(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.close();
  return context;
}

const MINIMAL_PRESCRIPTION_SNAPSHOT = [];

async function insertRehabSession({ id, userId, prescriptionInstanceId, status, exerciseOutcome, startedAt, patientLocalDate }) {
  const { error } = await admin.from("rehab_sessions").insert({
    id,
    user_id: userId,
    prescription_instance_id: prescriptionInstanceId,
    patient_local_date: patientLocalDate,
    status,
    exercise_outcome: exerciseOutcome,
    started_at: startedAt,
    prescription_snapshot: MINIMAL_PRESCRIPTION_SNAPSHOT,
  });
  if (error) throw error;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
function localDateDaysAgo(days) {
  return isoDaysAgo(days).slice(0, 10);
}

async function main() {
  const browser = await chromium.launch();
  const userIds = [];
  const sessionIds = [];

  try {
    const clinician = await makeUser("clinician", "Throwaway C1B Clinician");
    await addOrgMember(clinician.userId, "clinician");
    userIds.push(clinician.userId);

    // Distinct, alphabetically-orderable display names — deliberately mixed
    // case to exercise case-insensitive sorting.
    const noPrescription = await makeUser("no-rx", "aaa NoPrescriptionNoSessions");
    const recentActivity = await makeUser("recent", "Bbb RecentActivity");
    const acuteReview = await makeUser("acute", "Ccc AcuteReviewActive");
    const responseDue = await makeUser("due", "Ddd MorningResponseDue");
    const responsePending = await makeUser("pending", "Eee MorningResponsePending");
    const responseNotYetDue = await makeUser("notyetdue", "Fff MorningResponseNotYetDue");
    for (const u of [noPrescription, recentActivity, acuteReview, responseDue, responsePending, responseNotYetDue]) {
      await addOrgMember(u.userId, "member");
      userIds.push(u.userId);
    }

    const { error: relError } = await admin.from("supervisor_patients").insert(
      [noPrescription, recentActivity, acuteReview, responseDue, responsePending, responseNotYetDue].map((p) => ({
        supervisor_id: clinician.userId,
        patient_id: p.userId,
        status: "active",
      }))
    );
    if (relError) throw relError;

    // --- Prescription stage fixtures ---------------------------------------
    await admin.from("prescription_versions").insert([
      { user_id: recentActivity.userId, stage: 4, irritability: "moderate", is_insertional: false, source: "onboarding" },
      { user_id: acuteReview.userId, stage: 2, irritability: "high", is_insertional: false, source: "onboarding" },
      { user_id: responseDue.userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" },
      { user_id: responsePending.userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" },
      { user_id: responseNotYetDue.userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" },
    ]);

    // --- Recent-activity fixtures: one qualifying session today, one
    // qualifying session 20 days ago (outside the 14-day window but must
    // NOT beat today's session for "last session"), one non-qualifying
    // in_progress session with no exercise_outcome (must be ignored
    // entirely, never counted, never shown as "last session"). ---
    const recentTodayId = crypto.randomUUID();
    const recentOldId = crypto.randomUUID();
    const recentInProgressId = crypto.randomUUID();
    sessionIds.push(recentTodayId, recentOldId, recentInProgressId);
    await insertRehabSession({
      id: recentTodayId,
      userId: recentActivity.userId,
      prescriptionInstanceId: `c1b-verify:${recentTodayId}`,
      status: "response_complete",
      exerciseOutcome: "completed",
      startedAt: isoDaysAgo(0),
      patientLocalDate: localDateDaysAgo(0),
    });
    await insertRehabSession({
      id: recentOldId,
      userId: recentActivity.userId,
      prescriptionInstanceId: `c1b-verify:${recentOldId}`,
      status: "response_complete",
      exerciseOutcome: "completed",
      startedAt: isoDaysAgo(20),
      patientLocalDate: localDateDaysAgo(20),
    });
    await insertRehabSession({
      id: recentInProgressId,
      userId: recentActivity.userId,
      prescriptionInstanceId: `c1b-verify:${recentInProgressId}`,
      status: "in_progress",
      exerciseOutcome: null,
      startedAt: isoDaysAgo(0),
      patientLocalDate: localDateDaysAgo(0),
    });

    // --- Acute-safety fixture: one qualifying session -> escalation
    // evaluation (level 3) -> confirmed acute_safety_episodes row, no
    // release -> brake is active by derivation. ---
    const acuteSessionId = crypto.randomUUID();
    sessionIds.push(acuteSessionId);
    await insertRehabSession({
      id: acuteSessionId,
      userId: acuteReview.userId,
      prescriptionInstanceId: `c1b-verify:${acuteSessionId}`,
      status: "response_complete",
      exerciseOutcome: "completed",
      startedAt: isoDaysAgo(1),
      patientLocalDate: localDateDaysAgo(1),
    });
    const { data: evalRow, error: evalError } = await admin
      .from("escalation_evaluations")
      .insert({
        rehab_session_id: acuteSessionId,
        escalation_level: 3,
        escalation_reason: "c1b_verify_fixture",
        rule_version: "c1b-verify",
        inputs_snapshot: {},
      })
      .select()
      .maybeSingle();
    if (evalError || !evalRow) throw evalError ?? new Error("no escalation_evaluations row returned");
    const { error: episodeError } = await admin.from("acute_safety_episodes").insert({
      user_id: acuteReview.userId,
      source_rehab_session_id: acuteSessionId,
      source_escalation_evaluation_id: evalRow.id,
      initial_level: 3,
      initial_sudden_or_sharp_pain: true,
      initial_new_functional_difficulty: false,
      initial_pop_felt_or_heard: false,
      recurrence_window_anchor_id: null,
      recurrence_sequence_in_window: 1,
      level4_recurrent: false,
      confirmed_at: isoDaysAgo(1),
    });
    if (episodeError) throw episodeError;

    // --- Morning-response fixtures: due / pending / not-yet-due. Each has
    // an awaiting_morning_response session with a qualifying exercise
    // outcome already recorded (legitimate recent rehab awaiting its
    // morning response — never required to be response_complete). ---
    async function makeAwaitingMorningResponse(patientUserId, scheduledEligibleAt) {
      const sessionId = crypto.randomUUID();
      sessionIds.push(sessionId);
      await insertRehabSession({
        id: sessionId,
        userId: patientUserId,
        prescriptionInstanceId: `c1b-verify:${sessionId}`,
        status: "awaiting_morning_response",
        exerciseOutcome: "completed",
        startedAt: isoDaysAgo(0),
        patientLocalDate: localDateDaysAgo(0),
      });
      const { error } = await admin.from("morning_responses").insert({
        rehab_session_id: sessionId,
        user_id: patientUserId,
        scheduled_eligible_at: scheduledEligibleAt,
      });
      if (error) throw error;
    }
    await makeAwaitingMorningResponse(responseDue.userId, isoDaysAgo(1));
    await makeAwaitingMorningResponse(responsePending.userId, null);
    await makeAwaitingMorningResponse(responseNotYetDue.userId, isoDaysFromNow(1));

    // --- Drive the real route -----------------------------------------------
    const ctx = await loginContext(browser, clinician.email);
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/clinician/dashboard`);
    await page.waitForLoadState("networkidle");
    check("clinician allowed into dashboard", page.url() === `${BASE_URL}/clinician/dashboard`, page.url());

    async function rowText(name) {
      const row = page.locator("tr", { hasText: name });
      await row.first().waitFor({ state: "attached" });
      return row.first().innerText();
    }

    // No prescription / no sessions patient.
    {
      const text = await rowText("aaa NoPrescriptionNoSessions");
      check("no-prescription patient shows 'No current prescription' (never 'Stage 0')", text.includes("No current prescription"), text);
      check("never-sessioned patient shows 'No sessions yet' (never 'No recent session')", text.includes("No sessions yet"), text);
      check("never-sessioned patient shows factual zero '0 sessions in last 14 days'", text.includes("0 sessions in last 14 days"), text);
      check("no-signal patient shows no status badges", !text.includes("Clinical review") && !text.includes("Morning response"), text);
    }

    // Recent-activity patient.
    {
      const text = await rowText("Bbb RecentActivity");
      check("recent-activity patient shows correct stage", text.includes("Stage 4"), text);
      check("recent-activity patient's last session is Today (in_progress session ignored)", text.includes("Today"), text);
      check(
        "recent-activity patient counts only the 14-day-window qualifying session (1), excluding the 20-day-old one and the in_progress one",
        text.includes("1 session in last 14 days"),
        text
      );
    }

    // Acute-review patient: badge present, no diagnostic detail leaked.
    {
      const text = await rowText("Ccc AcuteReviewActive");
      check("active acute episode shows 'Clinical review active'", text.includes("Clinical review active"), text);
      check("acute badge never leaks level/trigger/diagnosis detail", !/level|rupture|pop|sudden|diagnos/i.test(text), text);
    }

    // Morning response: due / pending / not-yet-due(no badge).
    {
      const text = await rowText("Ddd MorningResponseDue");
      check("past scheduled_eligible_at shows 'Morning response due'", text.includes("Morning response due"), text);
      check("'due' badge never says 'overdue'", !/overdue/i.test(text), text);
    }
    {
      const text = await rowText("Eee MorningResponsePending");
      check("null scheduled_eligible_at shows 'Morning response pending' (UNKNOWN != ZERO)", text.includes("Morning response pending"), text);
    }
    {
      const text = await rowText("Fff MorningResponseNotYetDue");
      check(
        "future scheduled_eligible_at renders NO morning-response badge (not yet due, never 'overdue')",
        !text.includes("Morning response due") && !text.includes("Morning response pending"),
        text
      );
    }

    // --- Alphabetical, case-insensitive sort, independent of any signal ---
    const names = await page.locator("table tbody tr td:first-child").allInnerTexts();
    const trimmed = names.map((n) => n.trim());
    const expectedOrder = [
      "aaa NoPrescriptionNoSessions",
      "Bbb RecentActivity",
      "Ccc AcuteReviewActive",
      "Ddd MorningResponseDue",
      "Eee MorningResponsePending",
      "Fff MorningResponseNotYetDue",
    ];
    check(
      "roster is sorted alphabetically, case-insensitive, regardless of acute/morning-response/activity signal",
      JSON.stringify(trimmed) === JSON.stringify(expectedOrder),
      `got ${JSON.stringify(trimmed)}`
    );

    // --- Mobile: same facts rendered as cards, same semantic ordering ---
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto(`${BASE_URL}/login`);
    await mobilePage.fill("#email", clinician.email);
    await mobilePage.fill("#password", PASSWORD);
    await mobilePage.click('button[type="submit"]');
    await mobilePage.waitForLoadState("networkidle");
    await mobilePage.goto(`${BASE_URL}/clinician/dashboard`);
    await mobilePage.waitForLoadState("networkidle");
    const mobileBody = await mobilePage.locator("body").innerText();
    check("mobile view shows the same stage fact", mobileBody.includes("Stage 4"), "Stage 4 missing on mobile");
    check("mobile view shows the same acute badge", mobileBody.includes("Clinical review active"), "badge missing on mobile");
    check("mobile view shows the same morning-response due badge", mobileBody.includes("Morning response due"), "badge missing on mobile");
    await mobileCtx.close();

    await ctx.close();
  } catch (e) {
    fail++;
    const detail = e instanceof Error ? e.stack : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}));
    console.log(`FAIL  unexpected error: ${detail}`);
  } finally {
    // Full teardown — fixtures only, never the founder's own data.
    if (sessionIds.length) {
      await admin.from("acute_safety_episodes").delete().in("source_rehab_session_id", sessionIds);
      await admin.from("escalation_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
      await admin.from("rehab_sessions").delete().in("id", sessionIds);
    }
    if (userIds.length) {
      await admin.from("supervisor_patients").delete().in("supervisor_id", userIds);
      await admin.from("supervisor_patients").delete().in("patient_id", userIds);
      await admin.from("prescription_versions").delete().in("user_id", userIds);
      await admin.from("organization_members").delete().in("user_id", userIds);
      await admin.from("profiles").delete().in("id", userIds);
      for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
    }
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
