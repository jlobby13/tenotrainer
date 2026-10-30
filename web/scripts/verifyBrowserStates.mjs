// Acute Safety Gate — end-to-end browser regression coverage for the
// patient-facing acute brake states (dashboard rendering + the real
// authenticated POST through /api/patient/acute-safety/reassessment).
// Distinct from e2e/ (Playwright *.spec.ts run via the `playwright test`
// runner): this is a standalone script, run directly with `node`, because
// it needs to interleave real Supabase/legacy-SQLite writes with browser
// actions across several disposable patient identities in one pass.
//
// Sets up (and fully tears down) throwaway Supabase auth users + profiles +
// organization_members rows, PLUS matching legacy FastAPI SQLite rows
// (../app/tenotrainer.db) — the dashboard needs both to render at all.
// Screenshots land in /tmp for manual inspection.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated
// (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY), and the Playwright Chromium browser installed
// (`npx playwright install chromium`). Point at a dev/staging project only.
//
// Re-run after any change to BrakeDisplayState/describeActiveBrake copy or
// styling, the acute-safety reassessment route, or get_patient_acute_brake_status.
//
// Run from the web/ directory:
//   node scripts/verifyBrowserStates.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import Database from "node:sqlite";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { guardedFixtureTeardown } from "./lib/safetyFixturePurge.mjs";
import { guardedSql, q } from "./lib/m32Fixtures.mjs";

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
const RUN_STARTED_AT = new Date(Date.now() - 60_000).toISOString();
// M3.1 — refuse unless TENOTRAINER_MODE=development and the target project is allow-listed.
assertDevTestTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
// M3.1 — optional base URL so the suite can target an isolated server.
const BASE_URL = process.argv[2] ?? "http://localhost:3000";
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46"; // founder's existing org — throwaway membership rows added+removed, founder's own rows untouched
const PASSWORD = "throwaway-verification-1!";

const legacyDb = new Database.DatabaseSync("../app/tenotrainer.db");

function genUuid() {
  return crypto.randomUUID();
}

async function makeUser(label) {
  const email = `m5-browser-verify-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;

  await admin.from("profiles").insert({ id: userId, name: `Throwaway ${label}` });
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });

  const insertUser = legacyDb.prepare(
    "INSERT INTO users (name, email, role, supabase_id) VALUES (?, ?, 'patient', ?)"
  );
  const info = insertUser.run(`Throwaway ${label}`, email, userId);
  const legacyUserId = Number(info.lastInsertRowid);
  legacyDb
    .prepare(
      "INSERT INTO rehab_plans (user_id, stage, irritability, decision, exercises, citations) VALUES (?, 1, 'moderate', 'continue', '[]', '[]')"
    )
    .run(legacyUserId);

  return { userId, email, legacyUserId };
}

async function insertVersion(userId) {
  const { data } = await admin
    .from("prescription_versions")
    .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" })
    .select()
    .maybeSingle();
  return data;
}

async function insertSession(userId, versionId, startedAt, findings = {}) {
  const id = genUuid();
  await admin.from("rehab_sessions").insert({
    id,
    user_id: userId,
    plan_id: "test-plan",
    prescription_instance_id: `test-plan:${id}`,
    patient_local_date: startedAt.slice(0, 10),
    status: "response_complete",
    started_at: startedAt,
    prescription_snapshot: [],
    peak_session_pain: 2,
    difficulty: "moderate",
    prescription_version_id: versionId,
    response_recorded_at: startedAt,
    ...findings,
  });
  return id;
}

// M3.2 — the escalation evaluation and its episode are created in ONE SQL
// statement (one transaction) through the guarded test harness, so the
// production sweep (pg_cron, every minute) can never observe the
// intermediate "orphan" evaluation and legitimately reconcile it first.
// Test fixture construction only; no product function, no lock, no pause.
function insertEscalationAndEpisode(userId, sessionId, level, at, findings) {
  if (![3, 5].includes(level)) throw new Error("fixture level must be 3 or 5");
  const iso = new Date(at).toISOString();
  const b = (v) => (v ? "true" : "false");
  const row = guardedSql(env, `WITH ee AS (
      INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
      VALUES (${q(sessionId)}, ${level}, 'test', 'v1', '{}'::jsonb, '${iso}'::timestamptz) RETURNING id
    ), ep AS (
      INSERT INTO acute_safety_episodes (user_id, source_rehab_session_id, source_escalation_evaluation_id, initial_level,
        initial_sudden_or_sharp_pain, initial_new_functional_difficulty, initial_pop_felt_or_heard,
        recurrence_window_anchor_id, recurrence_sequence_in_window, level4_recurrent, confirmed_at)
      SELECT ${q(userId)}, ${q(sessionId)}, ee.id, ${level}, ${b(findings.sudden)}, ${b(findings.functional)}, ${b(findings.pop)},
        NULL, 1, false, '${iso}'::timestamptz FROM ee RETURNING id
    ) SELECT (SELECT id FROM ee) AS escalation_id, (SELECT id FROM ep) AS episode_id`)[0];
  if (!row?.escalation_id || !row?.episode_id) throw new Error("atomic fixture escalation + episode failed");
  return { ee: { id: row.escalation_id }, ep: { id: row.episode_id } };
}


async function insertReassessment(userId, episodeId, { suddenResolved = null, functionalResolved = null, evaluated, cleared = null }) {
  await admin.from("acute_safety_reassessments").insert({
    acute_safety_episode_id: episodeId,
    user_id: userId,
    sudden_or_sharp_pain_resolved: suddenResolved,
    new_functional_difficulty_resolved: functionalResolved,
    evaluated_by_professional: evaluated,
    cleared_by_professional: cleared,
  });
}

async function loginBrowser(context, email) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);
  return page;
}

async function screenshotBothViewports(context, email, label, screenshotPrefix) {
  const desktopPage = await loginBrowser(context, email);
  await desktopPage.setViewportSize({ width: 1280, height: 900 });
  await desktopPage.waitForTimeout(500);
  await desktopPage.screenshot({ path: `/tmp/${screenshotPrefix}_desktop.png`, fullPage: true });
  const desktopText = await desktopPage.textContent("main");
  await desktopPage.close();

  const mobilePage = await context.newPage();
  await mobilePage.setViewportSize({ width: 390, height: 844 });
  await mobilePage.goto(`${BASE_URL}/patient/dashboard`);
  await mobilePage.waitForTimeout(500);
  await mobilePage.screenshot({ path: `/tmp/${screenshotPrefix}_mobile.png`, fullPage: true });
  const mobileText = await mobilePage.textContent("main");
  await mobilePage.close();

  console.log(`  [${label}] desktop screenshot: /tmp/${screenshotPrefix}_desktop.png`);
  console.log(`  [${label}] mobile screenshot:  /tmp/${screenshotPrefix}_mobile.png`);
  return { desktopText, mobileText };
}

// M3.2 — Postgres fixtures are removed by the guarded exact-id purge (in the
// finally block); only the legacy SQLite rows are cleaned here.
function cleanupLegacyUser(legacyUserId) {
  if (legacyUserId != null) {
    legacyDb.prepare("DELETE FROM rehab_plans WHERE user_id = ?").run(legacyUserId);
    legacyDb.prepare("DELETE FROM users WHERE id = ?").run(legacyUserId);
  }
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

async function main() {
  const browser = await chromium.launch();
  const users = {};
  try {
    // === State B: Level 3, symptoms unresolved (active, never professionally held) ===
    console.log("\n--- State B: Level 3 unresolved ---");
    users.b = await makeUser("stateB");
    const vB = await insertVersion(users.b.userId);
    const sB = await insertSession(users.b.userId, vB.id, new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(), { sudden_or_sharp_pain: true });
    const { ee: eeB } = insertEscalationAndEpisode(users.b.userId, sB, 3, new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(), { sudden: true });
    const ctxB = await browser.newContext();
    const { desktopText: bDesktop, mobileText: bMobile } = await screenshotBothViewports(ctxB, users.b.email, "State B", "state_b");
    check("B desktop shows 'A quick follow-up is needed'", bDesktop.includes("A quick follow-up is needed"), bDesktop.slice(0, 300));
    check("B mobile shows 'A quick follow-up is needed'", bMobile.includes("A quick follow-up is needed"));
    check("B does not show the normal Start Rehab CTA", !bDesktop.includes("Start Today's Rehab") && !bDesktop.toLowerCase().includes("begin session"));
    await ctxB.close();

    // === State C: Level 3, self-resolved, no provider evaluation — FULL authenticated POST through the reassessment endpoint ===
    console.log("\n--- State C: Level 3 self-resolved (full authenticated reassessment POST) ---");
    users.c = await makeUser("stateC");
    const vC = await insertVersion(users.c.userId);
    const sC = await insertSession(users.c.userId, vC.id, new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(), { sudden_or_sharp_pain: true });
    const { ee: eeC } = insertEscalationAndEpisode(users.c.userId, sC, 3, new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(), { sudden: true });
    const ctxC = await browser.newContext();
    const pageC = await loginBrowser(ctxC, users.c.email);
    await pageC.goto(`${BASE_URL}/patient/acute-safety`);
    await pageC.waitForSelector("text=Has the sharp or pulling pain you reported resolved?");
    // "Yes" for resolved
    await pageC.getByRole("button", { name: "Yes", exact: true }).first().click();
    // "Were you evaluated by a healthcare professional?" -> No
    const evaluatedQuestion = pageC.locator("text=Were you evaluated by a healthcare professional for this issue?").locator("..");
    await evaluatedQuestion.getByRole("button", { name: "No", exact: true }).click();

    const [response] = await Promise.all([
      pageC.waitForResponse((r) => r.url().includes("/api/patient/acute-safety/reassessment") && r.request().method() === "POST"),
      pageC.getByRole("button", { name: "Continue" }).click(),
    ]);
    const responseJson = await response.json();
    check("C: real network POST to /api/patient/acute-safety/reassessment returned 200", response.status() === 200, `status=${response.status()}`);
    check("C: response body reports a release with self_resolved_no_evaluation path", responseJson.release?.releasePath === "self_resolved_no_evaluation", JSON.stringify(responseJson));
    await pageC.waitForTimeout(300);
    const releasedScreenText = await pageC.textContent("body");
    check("C: post-submit screen shows the released confirmation", releasedScreenText.includes("Return to Dashboard"));
    await pageC.screenshot({ path: "/tmp/state_c_released_desktop.png", fullPage: true });

    // Confirm the release is durably persisted server-side (not just client-displayed)
    const { data: releaseRowC } = await admin.from("acute_safety_releases").select().eq("acute_safety_episode_id", (await admin.from("acute_safety_episodes").select("id").eq("source_escalation_evaluation_id", eeC.id).maybeSingle()).data.id).maybeSingle();
    check("C: acute_safety_releases row durably persisted with correct release_path", releaseRowC?.release_path === "self_resolved_no_evaluation", JSON.stringify(releaseRowC));

    // Reload dashboard — brake should now be cleared (no acute_brake feedback)
    const pageC2 = await ctxC.newPage();
    await pageC2.goto(`${BASE_URL}/patient/dashboard`);
    await pageC2.waitForTimeout(500);
    const dashboardAfterReleaseText = await pageC2.textContent("main");
    check("C: dashboard no longer shows the acute brake after release", !dashboardAfterReleaseText.includes("A quick follow-up is needed"));
    await pageC2.screenshot({ path: "/tmp/state_c_post_release_dashboard.png", fullPage: true });
    await pageC2.close();
    await pageC.close();
    await ctxC.close();

    // === State E: Level 3, evaluated but not cleared (professional hold) ===
    console.log("\n--- State E: Level 3 professional hold (evaluated, not cleared) ---");
    users.e = await makeUser("stateE");
    const vE = await insertVersion(users.e.userId);
    const sE = await insertSession(users.e.userId, vE.id, new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(), { new_functional_difficulty: true });
    const { ee: eeE, ep: epE } = insertEscalationAndEpisode(users.e.userId, sE, 3, new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(), { functional: true });
    await insertReassessment(users.e.userId, epE.id, { functionalResolved: false, evaluated: true, cleared: false });
    const ctxE = await browser.newContext();
    const { desktopText: eDesktop, mobileText: eMobile } = await screenshotBothViewports(ctxE, users.e.email, "State E", "state_e");
    check("E desktop shows 'Rehab on hold'", eDesktop.includes("Rehab on hold"), eDesktop.slice(0, 300));
    check("E mobile shows 'Rehab on hold'", eMobile.includes("Rehab on hold"));
    await ctxE.close();

    // === State G: Level 4, patient reports cleared — M1: a clinician must release ===
    console.log("\n--- State G: Level 4 cleared, awaiting clinician release (M1) ---");
    users.g = await makeUser("stateG");
    const vG = await insertVersion(users.g.userId);
    const confirmedAtG = new Date(Date.now() - 1000 * 60 * 60 * 60).toISOString(); // 60h ago -> >48h threshold -> effective level 4
    const sG = await insertSession(users.g.userId, vG.id, confirmedAtG, { sudden_or_sharp_pain: true });
    const { ee: eeG, ep: epG } = insertEscalationAndEpisode(users.g.userId, sG, 3, confirmedAtG, { sudden: true });
    await insertReassessment(users.g.userId, epG.id, { suddenResolved: true, evaluated: true, cleared: true });
    const ctxG = await browser.newContext();
    const { desktopText: gDesktop, mobileText: gMobile } = await screenshotBothViewports(ctxG, users.g.email, "State G", "state_g");
    check("G desktop shows 'Professional review recommended'", gDesktop.includes("Professional review recommended"), gDesktop.slice(0, 300));
    check("G desktop shows the awaiting-clinician-release body (M1)", gDesktop.includes("Your clinician will review this and release the hold"));
    check("G mobile shows the same Level 4 awaiting-clinician-release state", gMobile.includes("Professional review recommended") && gMobile.includes("Your clinician will review this and release the hold"));
    // Founder-acceptance item 2: Level 4 must be visually distinguishable from Level 3 — orange, heavier border/weight
    const gLevel4Card = await ctxG.pages()[0]?.locator("h2", { hasText: "Professional review recommended" }).first();
    await ctxG.close();

    // === State I: Level 5 ===
    console.log("\n--- State I: Level 5 ---");
    users.i = await makeUser("stateI");
    const vI = await insertVersion(users.i.userId);
    const sI = await insertSession(users.i.userId, vI.id, new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), { pop_felt_or_heard: true });
    const { ee: eeI } = insertEscalationAndEpisode(users.i.userId, sI, 5, new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), { pop: true });
    const ctxI = await browser.newContext();
    const { desktopText: iDesktop, mobileText: iMobile } = await screenshotBothViewports(ctxI, users.i.email, "State I", "state_i");
    // PEC: the shared Level 5 hold title is now patient wording ("Stop Loading" retired).
    check("I desktop shows 'Pause your rehab exercises'", iDesktop.includes("Pause your rehab exercises") && !iDesktop.includes("Stop Loading"), iDesktop.slice(0, 300));
    check("I mobile shows 'Pause your rehab exercises'", iMobile.includes("Pause your rehab exercises") && !iMobile.includes("Stop Loading"));
    await ctxI.close();
  } finally {
    console.log("\nCleaning up...");
    try {
      guardedFixtureTeardown(env, { userIds: Object.values(users).map((u) => u.userId), runStartedAt: RUN_STARTED_AT });
    } catch (e) {
      fail++;
      console.log(`FAIL  teardown: ${e.message}`);
    }
    for (const key of Object.keys(users)) cleanupLegacyUser(users[key].legacyUserId);
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
