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
// Core Patient Experience v1 blocker fix (scheduled-eligibility
// enforcement) — a second scenario below drives a SEPARATE throwaway user
// through: page access before eligibility (expect redirect to dashboard's
// existing "Morning Response Pending" state) -> finalize attempt before
// eligibility (expect 409, zero mutation, zero tolerance, zero M6 rows) ->
// scheduled_eligible_at flipped to the past via a real persisted timestamp
// update (never browser-clock manipulation) -> page access at eligibility
// (expect the real Morning Check-In form) -> finalize succeeds -> retry
// remains idempotent. See app/api/patient/morning-response/[id]/route.ts
// and app/patient/morning-response/page.tsx for the actual gate.
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

  // scheduled_eligible_at set to an already-past instant: this scenario
  // exists to test generator wiring/idempotency (a DIFFERENT concern from
  // the eligibility-gate scenario below) and must represent a normal,
  // legitimately-eligible finalize — the eligibility gate added for the
  // Core Patient Experience v1 blocker fix now correctly rejects a null
  // scheduled_eligible_at (matching the existing dashboard convention:
  // "unknown eligibility" is never treated as eligible), so this seed must
  // set a real, already-past timestamp rather than leaving it null.
  const { data: morning, error: morningError } = await admin
    .from("morning_responses")
    .insert({ rehab_session_id: sessionId, user_id: userId, submitted_at: null, scheduled_eligible_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    .select()
    .single();
  if (morningError) throw morningError;

  return { sessionId, morningResponseId: morning.id };
}

// Seeds an outstanding morning-response obligation with an EXPLICIT,
// caller-supplied scheduled_eligible_at — the real persisted-timestamp
// mechanism the eligibility gate reads, never faked via the browser clock.
// status='awaiting_morning_response' (not 'response_in_progress') because
// this scenario also exercises the PAGE-level gate, which discovers the
// obligation via getOldestOutstandingMorningResponse -> that function only
// considers sessions in this exact status.
async function seedAwaitingMorningResponseEpisode(userId, prescriptionVersionId, scheduledEligibleAt) {
  const sessionId = genUuid();
  const date = "2026-06-01";
  const { error: sessionError } = await admin.from("rehab_sessions").insert({
    id: sessionId,
    user_id: userId,
    prescription_instance_id: `${sessionId}:i`,
    patient_local_date: date,
    started_at: `${date}T14:00:00Z`,
    status: "awaiting_morning_response",
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
    .insert({ rehab_session_id: sessionId, user_id: userId, submitted_at: null, scheduled_eligible_at: scheduledEligibleAt })
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

    // ---------------------------------------------------------------------
    // Core Patient Experience v1 blocker fix: scheduled-eligibility gate.
    // Separate throwaway user so this scenario's row counts are independent
    // of the one above.
    // ---------------------------------------------------------------------
    const userB = await makeUser("b");
    userIds.push(userB.userId);
    const prescriptionVersionIdB = await makePrescriptionVersion(userB.userId);
    const futureEligibleAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const { sessionId: sessionIdB, morningResponseId: morningResponseIdB } = await seedAwaitingMorningResponseEpisode(
      userB.userId,
      prescriptionVersionIdB,
      futureEligibleAt
    );
    sessionIds.push(sessionIdB);

    const contextB = await loginContext(browser, userB.email);
    const pageB = await contextB.newPage();

    // 1. Page access BEFORE eligibility -> redirected to the dashboard's
    // existing "Morning Response Pending" state, not a bare form.
    await pageB.goto(`${BASE_URL}/patient/morning-response`);
    await pageB.waitForLoadState("networkidle");
    check(
      "page access before eligibility: redirected to dashboard",
      pageB.url() === `${BASE_URL}/patient/dashboard`,
      pageB.url()
    );
    // Only asserts the check-in FORM is absent — the dashboard's own
    // "Morning Response Pending" copy additionally depends on
    // getPatientSummary() (lib/fastapi.ts), a pre-existing, separately
    // scoped legacy dependency (see the Core Patient Experience v1 audit)
    // that may not be reachable in every dev environment this script runs
    // in. That dependency is explicitly out of scope for this fix — this
    // assertion only verifies what THIS fix is responsible for: the bare
    // check-in form is never shown before eligibility.
    const bodyBeforeEligible = await pageB.locator("body").innerText();
    check(
      "page access before eligibility: redirected away from the check-in form (never shows it before eligibility)",
      !bodyBeforeEligible.includes("Morning Check-In"),
      bodyBeforeEligible.slice(0, 300)
    );

    // 3. Finalize attempt BEFORE eligibility -> rejected, no mutation.
    const finalizeBodyB = { nextMorningPain: 2, nextMorningStiffness: 0, finalize: true };
    const earlyRes = await contextB.request.post(`${BASE_URL}/api/patient/morning-response/${morningResponseIdB}`, { data: finalizeBodyB });
    check("finalize before eligibility: rejected with 409", earlyRes.status() === 409, `status ${earlyRes.status()}`);
    const earlyBody = await earlyRes.json().catch(() => ({}));
    check("finalize before eligibility: machine-readable code present", earlyBody.code === "MORNING_RESPONSE_NOT_YET_ELIGIBLE", JSON.stringify(earlyBody));

    const { data: rowAfterEarly } = await admin.from("morning_responses").select("submitted_at").eq("id", morningResponseIdB).maybeSingle();
    check("finalize before eligibility: submitted_at still null (not mutated into completed state)", rowAfterEarly?.submitted_at === null, JSON.stringify(rowAfterEarly));

    const { data: toleranceAfterEarly } = await admin.from("tolerance_evaluations").select("id").eq("rehab_session_id", sessionIdB);
    check("finalize before eligibility: zero tolerance evaluations persisted", (toleranceAfterEarly ?? []).length === 0, JSON.stringify(toleranceAfterEarly));

    const countsAfterEarly = await interpretationCounts(userB.userId);
    check("finalize before eligibility: zero M6 interpretation rows persisted", countsAfterEarly.total === 0, JSON.stringify(countsAfterEarly));

    // Flip eligibility using a REAL persisted timestamp (never the browser
    // clock) — simulates time having genuinely passed.
    const pastEligibleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // -1h
    const { error: flipError } = await admin.from("morning_responses").update({ scheduled_eligible_at: pastEligibleAt }).eq("id", morningResponseIdB);
    if (flipError) throw flipError;

    // 2. Page access AT/AFTER eligibility -> the real check-in form.
    await pageB.goto(`${BASE_URL}/patient/morning-response`);
    await pageB.waitForLoadState("networkidle");
    check("page access at eligibility: stays on morning-response (no redirect)", pageB.url() === `${BASE_URL}/patient/morning-response`, pageB.url());
    const bodyAtEligible = await pageB.locator("body").innerText();
    check("page access at eligibility: shows the real Morning Check-In form", bodyAtEligible.includes("Morning Check-In"), bodyAtEligible.slice(0, 300));

    // 4. Finalize AT/AFTER eligibility -> succeeds; legitimate downstream
    // processing runs exactly as the unrelated scenario above already
    // proved (tolerance + exactly one M6 row per domain).
    const legitRes = await contextB.request.post(`${BASE_URL}/api/patient/morning-response/${morningResponseIdB}`, { data: finalizeBodyB });
    check("finalize at eligibility: succeeds (200)", legitRes.ok(), `status ${legitRes.status()}: ${await legitRes.text().catch(() => "")}`);

    const { data: toleranceAfterLegit } = await admin.from("tolerance_evaluations").select("id").eq("rehab_session_id", sessionIdB);
    check("finalize at eligibility: tolerance evaluation now persisted", (toleranceAfterLegit ?? []).length === 1, JSON.stringify(toleranceAfterLegit));

    const countsAfterLegit = await interpretationCounts(userB.userId);
    check("finalize at eligibility: exactly 1 M6 row per domain now persisted (3 total)", countsAfterLegit.total === 3, JSON.stringify(countsAfterLegit));

    // 8. Retry after the legitimate finalize remains idempotent — early
    // rejection did not consume or disturb the normal CAS-gated protection
    // already verified in the scenario above.
    const retryLegitRes = await contextB.request.post(`${BASE_URL}/api/patient/morning-response/${morningResponseIdB}`, { data: finalizeBodyB });
    check("retry after legitimate finalize: still succeeds (200)", retryLegitRes.ok(), `status ${retryLegitRes.status()}`);
    const countsAfterRetryLegit = await interpretationCounts(userB.userId);
    check("retry after legitimate finalize: M6 row counts UNCHANGED (no duplicate)", countsAfterRetryLegit.total === 3, JSON.stringify(countsAfterRetryLegit));
    const { data: toleranceAfterRetryLegit } = await admin.from("tolerance_evaluations").select("id").eq("rehab_session_id", sessionIdB);
    check("retry after legitimate finalize: tolerance row count UNCHANGED (no duplicate)", (toleranceAfterRetryLegit ?? []).length === 1, JSON.stringify(toleranceAfterRetryLegit));

    await contextB.close();
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
