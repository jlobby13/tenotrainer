// Milestone 6, Stage 4 — visual/hierarchy smoke check for /patient/progress.
// Seeds a small amount of Stage 2 factual history PLUS one real finalize
// call through the actual production route (so real, persisted
// Symptoms/Capacity/Training Response interpretation rows exist — even
// though a single episode necessarily yields "more data needed"/"building"
// states, this still exercises the full read path end-to-end), then logs
// in via Playwright and screenshots both a mobile and a desktop viewport.
// Also asserts the founder-locked section headings render in the correct
// order (Progress Summary -> Symptoms -> Loading Capacity -> Training
// Response -> Recent Response -> Loading History -> Tolerance History).
//
// Requires: `next dev` running on localhost:3000, web/.env.local
// populated, Playwright Chromium installed.
//
// Run from the web/ directory:
//   node scripts/verifyM6Stage4ProgressUI.mjs
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

const EXERCISE = { ex_id: "heavy_calf_raise", name: "Heavy calf raise", category: "strength", loading_profile: "heavy_slow_resistance", order_index: 0, dosage: { sets: 3, reps_or_hold_time: 10 } };

async function main() {
  const browser = await chromium.launch();
  const userIds = [];
  const sessionIds = [];

  try {
    const email = `m6-stage4-ui-${Date.now()}@example.invalid`.toLowerCase();
    const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (userError) throw userError;
    const userId = userData.user.id;
    userIds.push(userId);
    await admin.from("organization_members").insert({ organization_id: REAL_ORG_ID, user_id: userId, role: "member" });
    const { data: version } = await admin
      .from("prescription_versions")
      .insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" })
      .select()
      .single();

    // A couple of prior, already-finalized sessions (Stage 2 factual
    // history) so RecentResponse/LoadingHistory/ToleranceHistory below the
    // fold have something real to show.
    for (let i = 0; i < 2; i++) {
      const sid = genUuid();
      sessionIds.push(sid);
      const date = i === 0 ? "2026-05-28" : "2026-05-30";
      await admin.from("rehab_sessions").insert({
        id: sid,
        user_id: userId,
        prescription_instance_id: `${sid}:i`,
        patient_local_date: date,
        started_at: `${date}T14:00:00Z`,
        status: "response_complete",
        exercise_outcome: "completed",
        prescription_snapshot: [EXERCISE],
        peak_session_pain: 4 - i,
        prescription_version_id: version.id,
        current_escalation_level: 0,
      });
      await admin
        .from("set_outcomes")
        .insert([0, 1, 2].map((setIndex) => ({ rehab_session_id: sid, exercise_id: EXERCISE.ex_id, exercise_order_index: 0, set_index: setIndex, outcome: "completed", prescribed_reps: 10, actual_reps: 10, occurred_at: `${date}T14:05:00Z` })));
      const { data: morning } = await admin
        .from("morning_responses")
        .insert({ rehab_session_id: sid, user_id: userId, next_morning_pain: 3 - i, next_morning_stiffness: 2, stiffness_duration: "lt_5_min", submitted_at: `${date}T20:00:00Z` })
        .select()
        .single();
      await admin.from("tolerance_evaluations").insert({ rehab_session_id: sid, morning_response_id: morning.id, tolerance_classification: "well_tolerated", immediate_guidance: "maintain", patient_facing_label: "Well Tolerated", reason: "fixture", rule_version: "v1", inputs_snapshot: {} });
    }

    // One MORE session, left unfinalized, driven through the real finalize
    // route below — this is what populates real m6_longitudinal_interpretations
    // rows for the interpretation sections to read.
    const finalSid = genUuid();
    sessionIds.push(finalSid);
    await admin.from("rehab_sessions").insert({
      id: finalSid,
      user_id: userId,
      prescription_instance_id: `${finalSid}:i`,
      patient_local_date: "2026-06-01",
      started_at: "2026-06-01T14:00:00Z",
      status: "response_in_progress",
      exercise_outcome: "completed",
      prescription_snapshot: [EXERCISE],
      peak_session_pain: 2,
      prescription_version_id: version.id,
      current_escalation_level: 0,
    });
    await admin
      .from("set_outcomes")
      .insert([0, 1, 2].map((setIndex) => ({ rehab_session_id: finalSid, exercise_id: EXERCISE.ex_id, exercise_order_index: 0, set_index: setIndex, outcome: "completed", prescribed_reps: 10, actual_reps: 10, occurred_at: "2026-06-01T14:05:00Z" })));
    const { data: morningFinal } = await admin.from("morning_responses").insert({ rehab_session_id: finalSid, user_id: userId, submitted_at: null }).select().single();

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#email", email);
    await page.fill("#password", PASSWORD);
    await Promise.all([page.waitForURL(`${BASE_URL}/patient/dashboard`, { timeout: 15000 }), page.click('button[type="submit"]')]);

    const finalizeRes = await context.request.post(`${BASE_URL}/api/patient/morning-response/${morningFinal.id}`, { data: { nextMorningPain: 1, nextMorningStiffness: 0, finalize: true } });
    check("seed finalize call succeeds", finalizeRes.ok(), `status ${finalizeRes.status()}`);

    await page.goto(`${BASE_URL}/patient/progress`);
    await page.waitForSelector("text=Progress Summary");

    const headings = await page.locator("h2").allTextContents();
    console.log("Rendered section order:", headings);
    const order = ["Progress Summary", "Symptoms", "Symptoms Over Time", "Loading Capacity", "Training Response", "Recent Response", "Loading History", "Response / Tolerance History"];
    let lastIndex = -1;
    let inOrder = true;
    for (const label of order) {
      const idx = headings.findIndex((h) => h.includes(label));
      if (idx === -1 || idx <= lastIndex) {
        inOrder = false;
        break;
      }
      lastIndex = idx;
    }
    check("all locked sections render in the founder-specified order", inOrder, JSON.stringify(headings));

    const bodyText = await page.locator("body").innerText();
    check("no raw internal resultState leaked onto the page", !/more_comparable_data_needed|capacity_building|symptoms_short_window|training_response_series/.test(bodyText), "");
    check("no raw exId leaked onto the page", !bodyText.includes("heavy_calf_raise"), "");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "scripts/.stage4-progress-mobile.png", fullPage: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "scripts/.stage4-progress-desktop.png", fullPage: true });
    console.log("Screenshots saved: scripts/.stage4-progress-mobile.png, scripts/.stage4-progress-desktop.png");

    await context.close();
  } catch (e) {
    fail++;
    console.log(`FAIL  unexpected error: ${e instanceof Error ? e.stack : e}`);
  } finally {
    const { data: interpRows } = userIds.length ? await admin.from("m6_longitudinal_interpretations").select("id").in("user_id", userIds) : { data: [] };
    const interpretationIds = (interpRows ?? []).map((r) => r.id);
    if (interpretationIds.length) {
      await admin.from("m6_interpretation_reason_codes").delete().in("interpretation_id", interpretationIds);
      await admin.from("m6_interpretation_rehab_sessions").delete().in("interpretation_id", interpretationIds);
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
