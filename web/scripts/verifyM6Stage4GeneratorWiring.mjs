// Milestone 6, Stage 4 — live verification that the longitudinal
// interpretation generators (Stage 3B/3C) are actually wired into the
// production morning-response finalize lifecycle, and that a retried
// finalize call never creates duplicate m6_longitudinal_interpretations
// rows. Drives the REAL route (POST /api/patient/morning-response/[id])
// over authenticated HTTP via Playwright (real login, real session
// cookies) — not a dev-only bypass route, not a direct engine call.
//
// Seeds the minimum a single response episode needs (rehab_session +
// set_outcomes + an UNSUBMITTED morning_response), then:
//   1. calls the real finalize route once and asserts exactly one
//      m6_longitudinal_interpretations row was persisted per domain
//      (symptoms_short_window, capacity_series, training_response_series)
//      — a single episode is expected to be "insufficient"/"building" for
//      every domain, which is fine; this test is about ROW COUNT, not
//      clinical state;
//   2. retries the exact same finalize call and asserts the row counts
//      are UNCHANGED (proving the didFinalizeThisRequest/CAS gate in
//      app/api/patient/morning-response/[id]/route.ts prevents duplicate
//      generation on a retry).
//
// Requires: `next dev` running on localhost:3000, web/.env.local
// populated, Playwright Chromium installed. Point at a dev/staging
// Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyM6Stage4GeneratorWiring.mjs
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

async function makeUser(label) {
  const email = `m6-stage4-genwiring-${label}-${Date.now()}@example.invalid`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user.id;
  await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });
  return { userId, email };
}

async function makePrescriptionVersion(userId) {
  const { data, error } = await admin
    .from("prescription_versions")
    .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" })
    .select()
    .single();
  if (error) throw error;
  return data.id;
}

const EXERCISE = { ex_id: "heavy_calf_raise", name: "Heavy calf raise", category: "strength", loading_profile: "heavy_slow_resistance", order_index: 0, dosage: { sets: 3, reps_or_hold_time: 10 } };

// Seeds exactly what the real finalize route needs already present:
// rehab_session (response-in-progress shape, current_escalation_level=0,
// no acute-context fields) + set_outcomes for one exercise + an
// UNSUBMITTED morning_response row. Deliberately does NOT insert
// tolerance_evaluations or call any generator directly — the real route is
// what must do all of that.
async function seedUnfinalizedEpisode(userId, prescriptionVersionId) {
  const sessionId = genUuid();
  const date = "2026-06-01";
  const { error: sessionError } = await admin.from("rehab_sessions").insert({
    id: sessionId,
    user_id: userId,
    prescription_instance_id: `${sessionId}:i`,
    patient_local_date: date,
    started_at: `${date}T14:00:00Z`,
    status: "response_in_progress",
    exercise_outcome: "completed",
    prescription_snapshot: [EXERCISE],
    peak_session_pain: 3,
    prescription_version_id: prescriptionVersionId,
    current_escalation_level: 0,
  });
  if (sessionError) throw sessionError;

  const { error: setOutcomeError } = await admin.from("set_outcomes").insert(
    [0, 1, 2].map((setIndex) => ({
      rehab_session_id: sessionId,
      exercise_id: EXERCISE.ex_id,
      exercise_order_index: 0,
      set_index: setIndex,
      outcome: "completed",
      prescribed_reps: 10,
      prescribed_load: null,
      actual_reps: 10,
      actual_load: null,
      occurred_at: `${date}T14:05:00Z`,
    }))
  );
  if (setOutcomeError) throw setOutcomeError;

  const { data: morning, error: morningError } = await admin
    .from("morning_responses")
    .insert({ rehab_session_id: sessionId, user_id: userId, submitted_at: null })
    .select()
    .single();
  if (morningError) throw morningError;

  return { sessionId, morningResponseId: morning.id };
}

async function loginContext(browser, email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);
  await page.close();
  return context;
}

async function interpretationCounts(userId) {
  const { data, error } = await admin.from("m6_longitudinal_interpretations").select("domain").eq("user_id", userId);
  if (error) throw error;
  const counts = { symptoms_short_window: 0, capacity_series: 0, training_response_series: 0, total: data.length };
  for (const row of data) counts[row.domain] = (counts[row.domain] ?? 0) + 1;
  return counts;
}

async function main() {
  const browser = await chromium.launch();
  const userIds = [];
  const sessionIds = [];

  try {
    const user = await makeUser("a");
    userIds.push(user.userId);
    const prescriptionVersionId = await makePrescriptionVersion(user.userId);
    const { sessionId, morningResponseId } = await seedUnfinalizedEpisode(user.userId, prescriptionVersionId);
    sessionIds.push(sessionId);

    const beforeAny = await interpretationCounts(user.userId);
    check("before any finalize: zero interpretation rows exist", beforeAny.total === 0, JSON.stringify(beforeAny));

    const context = await loginContext(browser, user.email);
    const finalizeBody = { nextMorningPain: 2, nextMorningStiffness: 0, finalize: true };

    const res1 = await context.request.post(`${BASE_URL}/api/patient/morning-response/${morningResponseId}`, { data: finalizeBody });
    check("first finalize call succeeds (200)", res1.ok(), `status ${res1.status()}: ${await res1.text().catch(() => "")}`);

    // Generation runs synchronously inside the route today (no queue) —
    // by the time the HTTP response has returned, generation has either
    // completed or been logged-and-swallowed. No polling/sleep needed.
    const afterFirst = await interpretationCounts(user.userId);
    check("after first finalize: exactly 1 Symptoms interpretation persisted", afterFirst.symptoms_short_window === 1, JSON.stringify(afterFirst));
    check("after first finalize: exactly 1 Capacity interpretation persisted", afterFirst.capacity_series === 1, JSON.stringify(afterFirst));
    check("after first finalize: exactly 1 Training Response interpretation persisted", afterFirst.training_response_series === 1, JSON.stringify(afterFirst));
    check("after first finalize: exactly 3 total interpretation rows (no direct+indirect Symptoms double-generation)", afterFirst.total === 3, JSON.stringify(afterFirst));

    // --- Retry: same finalize call again (double-click / refresh / client retry) ---
    const res2 = await context.request.post(`${BASE_URL}/api/patient/morning-response/${morningResponseId}`, { data: finalizeBody });
    check("retried finalize call still succeeds (200) — idempotent, not an error", res2.ok(), `status ${res2.status()}: ${await res2.text().catch(() => "")}`);

    const afterRetry = await interpretationCounts(user.userId);
    check("after retry: Symptoms row count UNCHANGED (no duplicate)", afterRetry.symptoms_short_window === 1, JSON.stringify(afterRetry));
    check("after retry: Capacity row count UNCHANGED (no duplicate)", afterRetry.capacity_series === 1, JSON.stringify(afterRetry));
    check("after retry: Training Response row count UNCHANGED (no duplicate)", afterRetry.training_response_series === 1, JSON.stringify(afterRetry));
    check("after retry: total row count UNCHANGED", afterRetry.total === 3, JSON.stringify(afterRetry));

    await context.close();
  } catch (e) {
    fail++;
    console.log(`FAIL  unexpected error: ${e instanceof Error ? e.stack : e}`);
  } finally {
    // Full teardown — mirrors every other verify script's `finally` block.
    for (const sid of sessionIds) {
      await admin.from("m6_interpretation_rehab_sessions").delete().eq("rehab_session_id", sid);
    }
    const { data: interpRows } = userIds.length ? await admin.from("m6_longitudinal_interpretations").select("id").in("user_id", userIds) : { data: [] };
    const interpretationIds = (interpRows ?? []).map((r) => r.id);
    if (interpretationIds.length) {
      await admin.from("m6_interpretation_reason_codes").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_morning_responses").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_tolerance_evaluations").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_prescription_versions").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_heuristics").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_longitudinal_interpretations").delete().in("id", interpretationIds);
    }
    for (const sid of sessionIds) {
      await admin.from("tolerance_evaluations").delete().eq("rehab_session_id", sid);
      await admin.from("morning_responses").delete().eq("rehab_session_id", sid);
      await admin.from("set_outcomes").delete().eq("rehab_session_id", sid);
      await admin.from("session_load_observations").delete().eq("rehab_session_id", sid);
      await admin.from("rehab_sessions").delete().eq("id", sid);
    }
    for (const uid of userIds) {
      await admin.from("prescription_versions").delete().eq("user_id", uid);
      await admin.from("organization_members").delete().eq("user_id", uid);
      await admin.auth.admin.deleteUser(uid);
    }
    await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
