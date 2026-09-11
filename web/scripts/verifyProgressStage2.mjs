// Milestone 6, Stage 2 — end-to-end verification for /patient/progress.
//
// Creates throwaway Supabase auth users + a rich, hand-built Postgres
// history (prescription_versions, rehab_sessions, morning_responses,
// set_outcomes, session_load_observations, tolerance_evaluations, one
// escalation_evaluation + acute_safety_episode), drives the REAL page over
// authenticated HTTP via Playwright (desktop + mobile viewport), and
// asserts on the rendered text. Fully torn down in `finally`, mirroring the
// established pattern in scripts/verifyStage4Loop.mjs.
//
// Deliberately does NOT touch the legacy FastAPI/SQLite database — the
// Progress page has no dependency on it (see lib/progressServer.ts), so
// this script doesn't need one either.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated,
// Playwright Chromium installed. Point at a dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyProgressStage2.mjs
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
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46"; // founder's existing org — throwaway membership rows added+removed, founder's own rows untouched
const PASSWORD = "throwaway-verification-1!";

function genUuid() {
  return crypto.randomUUID();
}

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

async function makeBareUser(label) {
  const email = `m6-progress-verify-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });
  return { userId, email };
}

async function cleanupUser(userId) {
  const sessionIds = (await admin.from("rehab_sessions").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
  const episodeIds = (await admin.from("acute_safety_episodes").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
  if (sessionIds.length > 0) {
    await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
    await admin.from("tolerance_evaluations").delete().in("rehab_session_id", sessionIds);
    await admin.from("escalation_evaluations").delete().in("rehab_session_id", sessionIds);
    await admin.from("set_outcomes").delete().in("rehab_session_id", sessionIds);
    await admin.from("session_load_observations").delete().in("rehab_session_id", sessionIds);
  }
  if (episodeIds.length > 0) {
    await admin.from("acute_safety_episodes").delete().in("id", episodeIds);
  }
  await admin.from("rehab_sessions").delete().eq("user_id", userId);
  await admin.from("prescription_versions").delete().eq("user_id", userId);
  await admin.from("organization_members").delete().eq("user_id", userId);
  await admin.from("profiles").delete().eq("id", userId);
  await admin.auth.admin.deleteUser(userId);
}

const EX_REP = { ex_id: "ex_rep_1", name: "Eccentric Heel Drop", category: "eccentric_biased", loading_profile: "eccentric_biased", order_index: 0, dosage: { sets: 3, reps_or_hold_time: 12, tempo: "2-0-6", rest: "90s" } };
const EX_HOLD = { ex_id: "ex_hold_1", name: "Double-Leg Calf Isometric Hold", category: "isometric", loading_profile: "isometric", order_index: 1, dosage: { sets: 3, reps_or_hold_time: "45s hold", tempo: "hold", rest: "90s" } };

async function insertVersion(userId, createdAt) {
  const { data, error } = await admin
    .from("prescription_versions")
    .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding", created_at: createdAt })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

async function insertSession(userId, { date, startedAt, versionId, peakPain, snapshot }) {
  const id = genUuid();
  const { error } = await admin.from("rehab_sessions").insert({
    id,
    user_id: userId,
    prescription_instance_id: `${id}:instance`,
    patient_local_date: date,
    started_at: startedAt,
    status: "response_complete",
    prescription_snapshot: snapshot,
    peak_session_pain: peakPain,
    prescription_version_id: versionId,
  });
  if (error) throw error;
  return id;
}

async function insertMorningResponse(sessionId, userId, { pain, stiffness, duration, submitted }) {
  const { error } = await admin.from("morning_responses").insert({
    rehab_session_id: sessionId,
    user_id: userId,
    next_morning_pain: pain,
    next_morning_stiffness: stiffness,
    stiffness_duration: duration,
    submitted_at: submitted ? new Date().toISOString() : null,
  });
  if (error) throw error;
}

async function insertSetOutcomes(sessionId, exerciseId, orderIndex, sets) {
  const rows = sets.map((s, i) => ({
    rehab_session_id: sessionId,
    exercise_id: exerciseId,
    exercise_order_index: orderIndex,
    set_index: i,
    outcome: s.outcome,
    prescribed_reps: s.prescribedReps ?? null,
    prescribed_load: null,
    actual_reps: s.outcome === "completed" ? s.actualReps : null,
    actual_load: null,
    occurred_at: new Date().toISOString(),
  }));
  const { error } = await admin.from("set_outcomes").insert(rows);
  if (error) throw error;
}

async function loginBrowser(context, email) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);
  return page;
}

async function main() {
  const browser = await chromium.launch();
  const users = {};

  try {
    // -------------------------------------------------------------------
    // Scenario 1: brand-new patient, zero history.
    // -------------------------------------------------------------------
    users.empty = await makeBareUser("empty");

    // -------------------------------------------------------------------
    // Scenario 2: rich multi-session history on one patient covering:
    // decreasing/increasing/zero/missing numeric values, a stiffness-
    // duration bucket change, a prescription-version boundary ("Rehab plan
    // updated"), rep-based AND hold-based loading history, a skipped set,
    // external loading context, tolerance history, an incomplete morning
    // response, and an acute-safety event that must not contaminate any of
    // the above computations.
    // -------------------------------------------------------------------
    users.rich = await makeBareUser("rich");
    const uid = users.rich.userId;

    const versionA = await insertVersion(uid, "2026-08-01T00:00:00Z");
    const versionB = await insertVersion(uid, "2026-08-20T00:00:00Z");

    // Session 1 — oldest. Prescription A. First-ever values (no "previous").
    const s1 = await insertSession(uid, {
      date: "2026-09-01",
      startedAt: "2026-09-01T14:00:00Z",
      versionId: versionA,
      peakPain: 6,
      snapshot: [EX_REP, EX_HOLD],
    });
    await insertMorningResponse(s1, uid, { pain: 4, stiffness: 5, duration: "min_5_15", submitted: true });
    await insertSetOutcomes(s1, EX_REP.ex_id, 0, [
      { outcome: "completed", prescribedReps: 12, actualReps: 12 },
      { outcome: "completed", prescribedReps: 12, actualReps: 12 },
      { outcome: "completed", prescribedReps: 12, actualReps: 10 },
    ]);
    await insertSetOutcomes(s1, EX_HOLD.ex_id, 1, [
      { outcome: "completed", prescribedReps: null, actualReps: 40 },
      { outcome: "completed", prescribedReps: null, actualReps: 45 },
      { outcome: "skipped", prescribedReps: null, actualReps: null },
    ]);
    await admin.from("tolerance_evaluations").insert({
      rehab_session_id: s1,
      morning_response_id: (await admin.from("morning_responses").select("id").eq("rehab_session_id", s1).single()).data.id,
      tolerance_classification: "well_tolerated",
      immediate_guidance: "maintain",
      patient_facing_label: "Well Tolerated",
      reason: "test fixture",
      rule_version: "v1",
      inputs_snapshot: {},
    });

    // Session 2 — same prescription A ("same" boundary). Pain decreases
    // (6->4 on peak isn't tested here; morning pain 4->2 decreasing),
    // stiffness intensity increases (5->7), stiffness duration bucket
    // increases (min_5_15 -> gt_30_min). Also carries external loading
    // context and a fully-completed hold exercise (no skip this time).
    const s2 = await insertSession(uid, {
      date: "2026-09-03",
      startedAt: "2026-09-03T14:00:00Z",
      versionId: versionA,
      peakPain: 4,
      snapshot: [EX_REP, EX_HOLD],
    });
    await insertMorningResponse(s2, uid, { pain: 2, stiffness: 7, duration: "gt_30_min", submitted: true });
    await insertSetOutcomes(s2, EX_REP.ex_id, 0, [
      { outcome: "completed", prescribedReps: 12, actualReps: 14 },
      { outcome: "completed", prescribedReps: 12, actualReps: 14 },
      { outcome: "completed", prescribedReps: 12, actualReps: 12 },
    ]);
    await insertSetOutcomes(s2, EX_HOLD.ex_id, 1, [
      { outcome: "completed", prescribedReps: null, actualReps: 45 },
      { outcome: "completed", prescribedReps: null, actualReps: 45 },
      { outcome: "completed", prescribedReps: null, actualReps: 45 },
    ]);
    await admin.from("session_load_observations").insert({
      rehab_session_id: s2,
      user_id: uid,
      category: "running",
      timing: "previous_day",
      captured_during: "m3_session_response",
    });
    await admin.from("tolerance_evaluations").insert({
      rehab_session_id: s2,
      morning_response_id: (await admin.from("morning_responses").select("id").eq("rehab_session_id", s2).single()).data.id,
      tolerance_classification: "caution",
      immediate_guidance: "maintain_cautiously",
      patient_facing_label: "Caution",
      reason: "test fixture",
      rule_version: "v1",
      inputs_snapshot: {},
    });

    // Session 3 — prescription B ("different" boundary -> "Rehab plan
    // updated"). Explicit zero peak pain (real 0, not "unavailable"). All
    // sets skipped. Morning response created but never finalized
    // (submitted_at NULL) — must be treated as "not yet recorded", not read
    // via its draft next_morning_pain value.
    const s3 = await insertSession(uid, {
      date: "2026-09-05",
      startedAt: "2026-09-05T14:00:00Z",
      versionId: versionB,
      peakPain: 0,
      snapshot: [EX_REP],
    });
    await insertMorningResponse(s3, uid, { pain: 7, stiffness: null, duration: null, submitted: false });
    await insertSetOutcomes(s3, EX_REP.ex_id, 0, [
      { outcome: "skipped", prescribedReps: 12, actualReps: null },
      { outcome: "skipped", prescribedReps: 12, actualReps: null },
      { outcome: "skipped", prescribedReps: 12, actualReps: null },
    ]);

    // Session 4 — most recent. Same prescription B ("same" boundary). No
    // response ever recorded (peak pain NULL, no morning_responses row, no
    // set_outcomes) — simulates an abandoned/in-progress session. Anchors
    // an acute-safety episode to verify it shows up as a separate factual
    // marker WITHOUT changing any comparison above (which should still
    // resolve "current" to session 3's real values, skipping this null one).
    const s4 = await insertSession(uid, {
      date: "2026-09-07",
      startedAt: "2026-09-07T14:00:00Z",
      versionId: versionB,
      peakPain: null,
      snapshot: [EX_REP],
    });
    const { data: escalation } = await admin
      .from("escalation_evaluations")
      .insert({ rehab_session_id: s4, escalation_level: 3, escalation_reason: "test fixture", rule_version: "v1", inputs_snapshot: {} })
      .select()
      .single();
    await admin.from("acute_safety_episodes").insert({
      user_id: uid,
      source_rehab_session_id: s4,
      source_escalation_evaluation_id: escalation.id,
      initial_level: 3,
      initial_sudden_or_sharp_pain: true,
      initial_new_functional_difficulty: false,
      initial_pop_felt_or_heard: false,
      recurrence_sequence_in_window: 1,
      confirmed_at: "2026-09-07T15:00:00Z",
    });

    // -------------------------------------------------------------------
    // Drive the real page.
    // -------------------------------------------------------------------
    const ctxEmpty = await browser.newContext();
    const pageEmpty = await loginBrowser(ctxEmpty, users.empty.email);
    await pageEmpty.goto(`${BASE_URL}/patient/progress`);
    const emptyText = await pageEmpty.locator("main").innerText();
    check("no-history: shows the empty state, not an error", emptyText.includes("haven't completed a rehab session yet"), emptyText);
    check("no-history: does not render Recent Response cards", !emptyText.includes("Peak session pain"), emptyText);
    await ctxEmpty.close();

    const ctxRich = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pageRich = await loginBrowser(ctxRich, users.rich.email);
    await pageRich.goto(`${BASE_URL}/patient/progress`);
    await pageRich.waitForSelector("text=Recent Response");
    const richText = await pageRich.locator("main").innerText();

    check("recent response: decreasing next-morning pain shows 4 -> 2 and Decreased by 2", richText.includes("4") && richText.includes("Decreased by 2 point"), richText);
    check("recent response: increasing stiffness intensity shows 5 -> 7", /5[\s\S]{0,10}7/.test(richText) && richText.includes("Increased by 2 point"), richText);
    check("recent response: stiffness duration bucket change shown as category labels, not minutes", richText.includes("5–15 min") && richText.includes("Over 30 min"), richText);
    check("recent response: explicit zero peak pain rendered as a real value (not blank/unavailable)", /Peak session pain[\s\S]{0,40}4[\s\S]{0,10}0\b/.test(richText), richText);
    check("recent response: incomplete (unsubmitted) morning response excluded from 'current'", !richText.includes("→ 7"), richText);

    check("loading history: 'Rehab plan updated' marker present at the prescription-version boundary", richText.includes("Rehab plan updated"), richText);
    check("loading history: rep-based exercise shows reps unit", richText.includes("14 reps") || richText.includes("14reps"), richText);
    check("loading history: hold-based exercise shows 'held' unit, never mislabeled as reps", richText.includes("s held"), richText);
    check("loading history: skipped sets shown as 'Skipped', not zero", richText.includes("Skipped"), richText);
    check("loading history: external loading context shown factually", richText.includes("Running"), richText);

    check("tolerance history: patient-facing classification labels shown, no raw score", richText.includes("Well Tolerated") && richText.includes("Caution"), richText);
    check("tolerance history: no raw rule-version string ('v1') shown to the patient", !richText.includes("v1"), richText);

    check("acute event: shown as a separate factual note", richText.includes("Acute safety event"), richText);
    check(
      "acute event: does not contaminate Recent Response (current peak pain is still session 3's real 0, not session 4's null)",
      /Peak session pain[\s\S]{0,40}4[\s\S]{0,10}0\b/.test(richText),
      richText
    );

    await pageRich.screenshot({ path: "scripts/.progress-verify-desktop.png", fullPage: true });

    // Mobile viewport, same authenticated context (touch-friendly / no
    // horizontal overflow check).
    const mobilePage = await ctxRich.newPage();
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    await mobilePage.goto(`${BASE_URL}/patient/progress`);
    await mobilePage.waitForSelector("text=Recent Response");
    const scrollWidth = await mobilePage.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await mobilePage.evaluate(() => document.documentElement.clientWidth);
    check("mobile: no horizontal overflow", scrollWidth <= clientWidth + 1, `scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
    await mobilePage.screenshot({ path: "scripts/.progress-verify-mobile.png", fullPage: true });

    await ctxRich.close();
  } finally {
    await browser.close();
    for (const key of Object.keys(users)) {
      await cleanupUser(users[key].userId).catch((e) => console.error(`cleanup failed for ${key}:`, e));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
