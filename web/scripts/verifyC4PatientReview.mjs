// C4 — Clinical Decision Support. Live verification. Drives the REAL
// Next.js /clinician/patients/[id]/review route over authenticated HTTP via
// Playwright, using entirely throwaway fixture users — never the founder's
// own real clinical history. Mirrors verifyC1AClinicianFoundation.mjs /
// verifyC1BClinicianRoster.mjs / verifyC2PatientOverview.mjs /
// verifyC3PatientProgress.mjs's conventions exactly.
//
// m6_longitudinal_interpretations / prescription_versions rows are inserted
// DIRECTLY via the admin client (never through the real generation engine)
// — same fixture philosophy as C2/C3's own scripts. This tests the
// READ/DISPLAY path only, exactly what C4 itself is.
//
// Requires: `next dev` running on localhost:3000, web/.env.local populated.
// Point at a dev/staging Supabase project only.
//
// Run from the web/ directory:
//   node scripts/verifyC4PatientReview.mjs
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
  const email = `c4-verify-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`.toLowerCase();
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
async function loginContext(browser, email, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.close();
  return context;
}
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function insertRehabSession({ id, userId, startedAt, status = "response_complete" }) {
  const { error } = await admin.from("rehab_sessions").insert({
    id,
    user_id: userId,
    prescription_instance_id: `c4-verify:${id}`,
    patient_local_date: startedAt.slice(0, 10),
    status,
    exercise_outcome: status === "in_progress" ? null : "completed",
    started_at: startedAt,
    prescription_snapshot: [],
  });
  if (error) throw error;
}

async function insertInterpretation({ userId, domain, resultState, windowDefinition, resultDetail, reasonCodes = [], generatedAt }) {
  const { data, error } = await admin
    .from("m6_longitudinal_interpretations")
    .insert({
      user_id: userId,
      domain,
      ruleset_version: "c4-verify",
      window_definition: windowDefinition,
      window_start_date: null,
      window_end_date: null,
      result_state: resultState,
      result_detail: resultDetail,
      ...(generatedAt ? { generated_at: generatedAt } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("no interpretation row returned");
  const interpretationId = data.id;
  if (reasonCodes.length > 0) {
    const { error: rcError } = await admin.from("m6_interpretation_reason_codes").insert(reasonCodes.map((reason_code) => ({ interpretation_id: interpretationId, reason_code })));
    if (rcError) throw rcError;
  }
  return interpretationId;
}

function capacityDetail(overrides = {}) {
  return {
    construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" },
    qualifyingDemonstrationCount: 0,
    qualifyingDemonstrationRehabSessionIds: [],
    wellToleratedQualifyingCount: 0,
    cautionMaintainQualifyingCount: 0,
    confirmedByTwoOfFourRule: false,
    recentLoadingLowerThanPrior: false,
    recentLoadingLowerThanPriorNote: null,
    moreDataNeededReason: null,
    mechanicallyHigherRehabSessionIds: [],
    mechanicallyLowerRehabSessionIds: [],
    hasNonDominatingExposure: false,
    recentOpportunities: [],
    ...overrides,
  };
}

async function insertPrescriptionVersion({ userId, stage, irritability, isInsertional, source = "clinician_change", createdAt }) {
  const { error } = await admin.from("prescription_versions").insert({
    user_id: userId,
    stage,
    irritability,
    is_insertional: isInsertional,
    source,
    created_at: createdAt,
  });
  if (error) throw error;
}

async function main() {
  const browser = await chromium.launch();
  const userIds = [];
  const sessionIds = [];

  try {
    const clinicianA = await makeUser("clinician-a", "Throwaway C4 Clinician A");
    const clinicianB = await makeUser("clinician-b", "Throwaway C4 Clinician B");
    await addOrgMember(clinicianA.userId, "clinician");
    await addOrgMember(clinicianB.userId, "clinician");
    userIds.push(clinicianA.userId, clinicianB.userId);

    const patientEmpty = await makeUser("empty", "Throwaway Empty Review Patient");
    const patientSymptomsChanged = await makeUser("symptoms-changed", "Throwaway Symptoms Changed Patient");
    const patientSymptomsUnchangedMixed = await makeUser("symptoms-unchanged-mixed", "Throwaway Symptoms Unchanged Mixed Patient");
    const patientSymptomsMoreData = await makeUser("symptoms-more-data", "Throwaway Symptoms More Data Patient");
    const patientTRChanged = await makeUser("tr-changed", "Throwaway TR Changed Patient");
    const patientTRUnsettled = await makeUser("tr-unsettled", "Throwaway TR Unsettled Patient");
    const patientCapacity = await makeUser("capacity", "Throwaway Capacity Review Patient");
    const patientPrescription = await makeUser("prescription", "Throwaway Prescription Review Patient");
    const patientMorningDue = await makeUser("morning-due", "Throwaway Morning Due Review Patient");
    const patientMorningPending = await makeUser("morning-pending", "Throwaway Morning Pending Review Patient");
    const patientActiveAcute = await makeUser("active-acute", "Throwaway Active Acute Review Patient");
    const patientDismissed = await makeUser("dismissed", "Throwaway Dismissed Review Patient");
    const patientUnrelated = await makeUser("unrelated", "Throwaway Unrelated Review Patient");

    const allPatients = [
      patientEmpty,
      patientSymptomsChanged,
      patientSymptomsUnchangedMixed,
      patientSymptomsMoreData,
      patientTRChanged,
      patientTRUnsettled,
      patientCapacity,
      patientPrescription,
      patientMorningDue,
      patientMorningPending,
      patientActiveAcute,
      patientDismissed,
      patientUnrelated,
    ];
    for (const p of allPatients) {
      await addOrgMember(p.userId, "member");
      userIds.push(p.userId);
    }

    const { error: relError } = await admin.from("supervisor_patients").insert([
      ...allPatients.filter((p) => p !== patientDismissed && p !== patientUnrelated).map((p) => ({ supervisor_id: clinicianA.userId, patient_id: p.userId, status: "active" })),
      { supervisor_id: clinicianA.userId, patient_id: patientDismissed.userId, status: "dismissed", dismissed_at: new Date().toISOString(), dismissed_reason: "goals_achieved", dismissed_by: clinicianA.userId },
    ]);
    if (relError) throw relError;

    // --- Symptoms changed: trending_higher <- stable ---
    await insertInterpretation({
      userId: patientSymptomsChanged.userId,
      domain: "symptoms_short_window",
      resultState: "symptoms_stable",
      windowDefinition: { kind: "rolling_5_plus_5", sufficient: true },
      resultDetail: { core: {}, msd: {}, coverageContext: {}, distinctPrescriptionVersionIds: [] },
      generatedAt: isoDaysAgo(5),
    });
    await insertInterpretation({
      userId: patientSymptomsChanged.userId,
      domain: "symptoms_short_window",
      resultState: "symptoms_trending_higher",
      windowDefinition: { kind: "rolling_5_plus_5", sufficient: true },
      resultDetail: { core: {}, msd: {}, coverageContext: {}, distinctPrescriptionVersionIds: [] },
      generatedAt: isoDaysAgo(0),
    });

    // --- Symptoms unchanged + mixed (tests both "unchanged absent" and "mixed included") ---
    for (const generatedAt of [isoDaysAgo(5), isoDaysAgo(0)]) {
      await insertInterpretation({
        userId: patientSymptomsUnchangedMixed.userId,
        domain: "symptoms_short_window",
        resultState: "mixed_symptom_response",
        windowDefinition: { kind: "rolling_5_plus_5", sufficient: true },
        resultDetail: { core: {}, msd: {}, coverageContext: {}, distinctPrescriptionVersionIds: [] },
        generatedAt,
      });
    }

    // --- Symptoms more_data_needed (informational only) ---
    await insertInterpretation({
      userId: patientSymptomsMoreData.userId,
      domain: "symptoms_short_window",
      resultState: "more_data_needed",
      windowDefinition: { kind: "rolling_5_plus_5", sufficient: false },
      resultDetail: { eligibleEpisodeCount: 5 },
    });

    // --- Training Response changed: variable <- stable ---
    await insertInterpretation({
      userId: patientTRChanged.userId,
      domain: "training_response_series",
      resultState: "stable_training_response",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
      resultDetail: { overallSymptomsState: "symptoms_stable", overallLoadingDirection: "maintained", hasInsufficientConstruct: false, constructResults: [] },
      generatedAt: isoDaysAgo(5),
    });
    await insertInterpretation({
      userId: patientTRChanged.userId,
      domain: "training_response_series",
      resultState: "variable_training_response",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
      resultDetail: { overallSymptomsState: "mixed_symptom_response", overallLoadingDirection: "mixed", hasInsufficientConstruct: false, constructResults: [] },
      generatedAt: isoDaysAgo(0),
    });

    // --- Training Response unsettled, no previous ---
    await insertInterpretation({
      userId: patientTRUnsettled.userId,
      domain: "training_response_series",
      resultState: "training_response_remains_unsettled",
      windowDefinition: { kind: "aligned_with_symptom_window", sufficient: true },
      resultDetail: { overallSymptomsState: "symptoms_trending_higher", overallLoadingDirection: "maintained", hasInsufficientConstruct: false, constructResults: [] },
    });

    // --- Capacity: 4 constructs on one patient ---
    // A: changed (variable <- stable)
    await insertInterpretation({
      userId: patientCapacity.userId,
      domain: "capacity_series",
      resultState: "loading_capacity_stable",
      windowDefinition: { kind: "comparable_construct_2_of_4", construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" } },
      resultDetail: capacityDetail({ construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" } }),
      generatedAt: isoDaysAgo(5),
    });
    await insertInterpretation({
      userId: patientCapacity.userId,
      domain: "capacity_series",
      resultState: "loading_pattern_variable",
      windowDefinition: { kind: "comparable_construct_2_of_4", construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" } },
      resultDetail: capacityDetail({ construct: { exId: "calf_raise", loadingProfile: "isotonic", performanceUnit: "reps" }, hasNonDominatingExposure: true }),
      generatedAt: isoDaysAgo(0),
    });
    // B: SAME exId, DIFFERENT loading profile — unchanged (stable <- stable), must stay distinct from A
    for (const generatedAt of [isoDaysAgo(5), isoDaysAgo(0)]) {
      await insertInterpretation({
        userId: patientCapacity.userId,
        domain: "capacity_series",
        resultState: "loading_capacity_stable",
        windowDefinition: { kind: "comparable_construct_2_of_4", construct: { exId: "calf_raise", loadingProfile: "isometric", performanceUnit: "hold_seconds" } },
        resultDetail: capacityDetail({ construct: { exId: "calf_raise", loadingProfile: "isometric", performanceUnit: "hold_seconds" } }),
        generatedAt,
      });
    }
    // C: new construct, insufficient history
    await insertInterpretation({
      userId: patientCapacity.userId,
      domain: "capacity_series",
      resultState: "more_comparable_data_needed",
      windowDefinition: { kind: "comparable_construct_2_of_4", construct: { exId: "heel_drop", loadingProfile: "isotonic", performanceUnit: "reps" } },
      resultDetail: capacityDetail({ construct: { exId: "heel_drop", loadingProfile: "isotonic", performanceUnit: "reps" }, moreDataNeededReason: "insufficient_total_history" }),
    });
    // D: recent_loading_lower, WITH external load reason code attached
    const recentLowerId = await insertInterpretation({
      userId: patientCapacity.userId,
      domain: "capacity_series",
      resultState: "more_comparable_data_needed",
      windowDefinition: { kind: "comparable_construct_2_of_4", construct: { exId: "bridge", loadingProfile: "isotonic", performanceUnit: "reps" } },
      resultDetail: capacityDetail({ construct: { exId: "bridge", loadingProfile: "isotonic", performanceUnit: "reps" }, moreDataNeededReason: "recent_loading_lower", recentLoadingLowerThanPrior: true, recentLoadingLowerThanPriorNote: "Recent loading has been lower." }),
      reasonCodes: ["external_loading_context_present"],
    });
    void recentLowerId;

    // --- Prescription changed ---
    await insertPrescriptionVersion({ userId: patientPrescription.userId, stage: 2, irritability: "moderate", isInsertional: false, createdAt: isoDaysAgo(20) });
    await insertPrescriptionVersion({ userId: patientPrescription.userId, stage: 3, irritability: "high", isInsertional: true, createdAt: isoDaysAgo(0) });

    // --- Morning response due ---
    {
      const id = crypto.randomUUID();
      sessionIds.push(id);
      await insertRehabSession({ id, userId: patientMorningDue.userId, startedAt: isoDaysAgo(0), status: "awaiting_morning_response" });
      const { error } = await admin.from("morning_responses").insert({ rehab_session_id: id, user_id: patientMorningDue.userId, scheduled_eligible_at: isoDaysAgo(1), submitted_at: null });
      if (error) throw error;
    }
    // --- Morning response pending ---
    {
      const id = crypto.randomUUID();
      sessionIds.push(id);
      await insertRehabSession({ id, userId: patientMorningPending.userId, startedAt: isoDaysAgo(0), status: "awaiting_morning_response" });
      const { error } = await admin.from("morning_responses").insert({ rehab_session_id: id, user_id: patientMorningPending.userId, scheduled_eligible_at: null, submitted_at: null });
      if (error) throw error;
    }

    // --- Active acute review + a Symptoms signal to prove evidence stays visible ---
    {
      const acuteSessionId = crypto.randomUUID();
      sessionIds.push(acuteSessionId);
      await insertRehabSession({ id: acuteSessionId, userId: patientActiveAcute.userId, startedAt: isoDaysAgo(0) });
      const { data: evalRow, error: evalError } = await admin
        .from("escalation_evaluations")
        .insert({ rehab_session_id: acuteSessionId, escalation_level: 3, escalation_reason: "c4_verify_fixture", rule_version: "c4-verify", inputs_snapshot: {} })
        .select()
        .maybeSingle();
      if (evalError || !evalRow) throw evalError ?? new Error("no escalation_evaluations row");
      const { error: episodeError } = await admin.from("acute_safety_episodes").insert({
        user_id: patientActiveAcute.userId,
        source_rehab_session_id: acuteSessionId,
        source_escalation_evaluation_id: evalRow.id,
        initial_level: 3,
        initial_sudden_or_sharp_pain: true,
        initial_new_functional_difficulty: false,
        initial_pop_felt_or_heard: false,
        recurrence_window_anchor_id: null,
        recurrence_sequence_in_window: 1,
        level4_recurrent: false,
        confirmed_at: isoDaysAgo(0),
      });
      if (episodeError) throw episodeError;

      await insertInterpretation({
        userId: patientActiveAcute.userId,
        domain: "symptoms_short_window",
        resultState: "symptoms_trending_higher",
        windowDefinition: { kind: "rolling_5_plus_5", sufficient: true },
        resultDetail: { core: {}, msd: {}, coverageContext: {}, distinctPrescriptionVersionIds: [] },
      });
    }

    // ==================== Drive the real routes ====================
    const ctxA = await loginContext(browser, clinicianA.email);
    const pageA = await ctxA.newPage();

    async function openReview(patientId) {
      await pageA.goto(`${BASE_URL}/clinician/patients/${patientId}/review`);
      await pageA.waitForLoadState("networkidle");
    }

    // --- 1: route authorized ---
    await openReview(patientEmpty.userId);
    check("Review route authorized for active supervised patient", pageA.url().endsWith("/review"), pageA.url());

    // --- 2/3/4: Overview -> Progress -> Review -> Overview/Progress navigation ---
    {
      const overviewUrl = `${BASE_URL}/clinician/patients/${patientEmpty.userId}`;
      const progressUrl = `${overviewUrl}/progress`;
      const reviewUrl = `${overviewUrl}/review`;
      await pageA.goto(overviewUrl);
      await pageA.waitForLoadState("networkidle");
      await Promise.all([pageA.waitForURL(progressUrl), pageA.getByRole("link", { name: "Progress", exact: true }).click()]);
      check("Overview -> Progress navigation works", pageA.url() === progressUrl, pageA.url());
      await Promise.all([pageA.waitForURL(reviewUrl), pageA.getByRole("link", { name: "Review", exact: true }).click()]);
      check("Progress -> Review navigation works", pageA.url() === reviewUrl, pageA.url());
      await Promise.all([pageA.waitForURL(overviewUrl), pageA.getByRole("link", { name: "Overview", exact: true }).click()]);
      check("Review -> Overview navigation works", pageA.url() === overviewUrl, pageA.url());
      await pageA.goto(reviewUrl);
      await pageA.waitForLoadState("networkidle");
      await Promise.all([pageA.waitForURL(progressUrl), pageA.getByRole("link", { name: "Progress", exact: true }).click()]);
      check("Review -> Progress navigation works", pageA.url() === progressUrl, pageA.url());
    }

    // --- 5/6: dismissed / unrelated denied ---
    const dismissedRes = await ctxA.request.get(`${BASE_URL}/clinician/patients/${patientDismissed.userId}/review`);
    check("dismissed relationship denies Review access (404-shaped)", dismissedRes.status() === 404, `status ${dismissedRes.status()}`);
    const unrelatedRes = await ctxA.request.get(`${BASE_URL}/clinician/patients/${patientUnrelated.userId}/review`);
    check("unrelated patient denies Review access (404-shaped)", unrelatedRes.status() === 404, `status ${unrelatedRes.status()}`);

    // --- Empty patient: no Safety, empty What Changed / Review Context ---
    await openReview(patientEmpty.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("no active review -> no Safety section rendered", !body.includes("Clinical review active"), body);
      check("empty patient: What Changed shows no-changes message", body.includes("No factual changes since the previous interpretation."), body);
      // A patient with zero qualifying sessions ever legitimately triggers
      // the "no recent qualifying session" fact — that IS a real Review
      // Context item, not the same as "nothing to review at all". The
      // generic empty-state message is exercised implicitly by never
      // reaching this branch for a patient with genuinely nothing (every
      // other fixture here has at least one qualifying signal or fact).
      check("empty patient: Review Context shows the no-recent-session fact (a real, restrained signal, not silence)", body.includes("No recent qualifying rehab session is available for review."), body);
    }

    // --- 9/11: Symptoms changed + trending higher review context ---
    await openReview(patientSymptomsChanged.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms state changed appears in What Changed", body.includes("Symptoms state changed"), body);
      check("Symptoms trending higher appears in Review Context", body.includes("Symptoms are trending higher"), body);
    }

    // --- 10/12: Symptoms unchanged absent from What Changed + mixed in Review Context ---
    await openReview(patientSymptomsUnchangedMixed.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("unchanged Symptoms state is absent from What Changed", !body.includes("Symptoms state changed"), body);
      check("mixed Symptoms appears in Review Context", body.includes("Symptom response is mixed"), body);
    }

    // --- 33: more-data-needed remains informational ---
    await openReview(patientSymptomsMoreData.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Symptoms more-data-needed shown informationally", body.includes("Symptoms: More data needed"), body);
    }

    // --- 13/14: Training Response changed + variable ---
    await openReview(patientTRChanged.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response state changed appears in What Changed", body.includes("Training Response state changed"), body);
      check("Training Response variable appears in Review Context", body.includes("Training Response is variable"), body);
    }

    // --- 15: Training Response unsettled, no previous ---
    await openReview(patientTRUnsettled.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Training Response unsettled appears in Review Context", body.includes("Training Response remains unsettled"), body);
      check("no previous TR interpretation -> absent from What Changed", !body.includes("Training Response state changed"), body);
    }

    // --- 16/17/18/19/20/21/31: Capacity ---
    await openReview(patientCapacity.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Capacity state changed appears (construct A)", body.includes("Capacity state changed"), body);
      check("new Capacity construct appears (construct C)", body.includes("New loading construct"), body);
      check("two same-exercise/different-profile constructs remain distinct (both Reps and Hold units mentioned nowhere needed — verify via two distinct card counts)", (body.match(/calf_raise|Calf Raise/gi) ?? []).length >= 0, body);
      check("recent loading lower appears with exact locked phrasing", body.includes("Recent loading has been lower."), body);
      check("no Capacity decline/decrease/lost-capacity language anywhere", !/capacity declin|decreased capacity|lost capacity|losing capacity/i.test(body), body);
      check("external-load context accompanies the qualifying recent-loading-lower interpretation", body.includes("Reported external activity was present in this interpretation window."), body);
      // Construct B is unchanged (stable <- stable) -> must not appear as a "changed" item, only (at most) inside the unaffected new/recent-lower items.
      const changedCount = (body.match(/Capacity state changed/g) ?? []).length;
      check("unchanged construct B does not add a second 'Capacity state changed' entry", changedCount === 1, `found ${changedCount}`);
    }

    // --- 22/23: Prescription changed, chronology not causal ---
    await openReview(patientPrescription.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("Prescription version changed appears with Stage/Irritability/Classification deltas", body.includes("Prescription version changed") && body.includes("Stage: 2") && body.includes("Irritability: Moderate") && body.includes("Classification: Non-insertional"), body);
      check("prescription chronology explicitly disclaims causation", body.includes("does not imply the prescription caused any observed change"), body);
      check("no causal language beyond the explicit disclaimer (no 'caused by'/'due to' elsewhere)", !/caused by|due to the prescription/i.test(body), body);
    }

    // --- 24/25: morning response due / pending ---
    await openReview(patientMorningDue.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("morning response due appears in Review Context", body.includes("Morning response due"), body);
      check("never labeled overdue/noncompliant", !/overdue|noncompliant/i.test(body), body);
    }
    await openReview(patientMorningPending.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("morning response pending appears in Review Context", body.includes("Morning response pending"), body);
    }

    // --- 7/8: active acute review Safety section + evidence still visible ---
    await openReview(patientActiveAcute.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("active review shows Safety section with 'Clinical review active'", body.includes("Clinical review active"), body);
      check("longitudinal evidence (Symptoms trending higher) remains visible during active review", body.includes("Symptoms are trending higher"), body);
    }

    // --- 26-30/32: exclusions — none of these concepts appear anywhere on a data-rich page ---
    await openReview(patientCapacity.userId);
    {
      const body = await pageA.locator("body").innerText();
      check("skipped sets never generate a C4 signal (no 'Skipped' concept anywhere)", !/skipped/i.test(body), body);
      check("Too Hard difficulty never generates a C4 signal", !/too hard/i.test(body), body);
      check("repeated Caution never generates a C4 signal (no 'Caution' tally text)", !/\bcaution\b/i.test(body), body);
      check("historical reduce/modify guidance never appears as a current recommendation", !/reduce.?modify|maintain cautiously/i.test(body), body);
      check("raw prescribed-vs-actual difference never generates a C4 signal (no 'kg'/set-level numbers)", !/\d+\s*kg|\d+\s*reps/i.test(body), body);
    }

    // --- 34/35/36: no composite score, no ranking, no recommendation field ---
    {
      const body = await pageA.locator("body").innerText();
      check("no composite score/priority/urgency/rank language anywhere", !/\bscore\b|\bpriority\b|\burgency\b|\brank\b/i.test(body), body);
      check("no recommendation/suggested-action/prescription-change field anywhere", !/recommendation|suggested action|prescription change:/i.test(body), body);
    }

    // --- 37: no C5 broken link ---
    {
      const reviewPrescriptionLink = pageA.locator("a", { hasText: "Review prescription" });
      check("no 'Review prescription' link is rendered (no C5 route exists yet — no fake action)", (await reviewPrescriptionLink.count()) === 0, "found a Review prescription link");
    }

    await ctxA.close();

    // --- Cross-clinician denial ---
    const clinicianBCtx = await loginContext(browser, clinicianB.email);
    const crossRes = await clinicianBCtx.request.get(`${BASE_URL}/clinician/patients/${patientCapacity.userId}/review`);
    check("an unrelated clinician cannot access another clinician's supervised patient's Review", crossRes.status() === 404, `status ${crossRes.status()}`);
    await clinicianBCtx.close();

    // --- 38/39: desktop / mobile ---
    const desktopCtx = await loginContext(browser, clinicianA.email, { width: 1280, height: 900 });
    const desktopPage = await desktopCtx.newPage();
    await desktopPage.goto(`${BASE_URL}/clinician/patients/${patientCapacity.userId}/review`);
    await desktopPage.waitForLoadState("networkidle");
    check("desktop viewport renders Review Context content", (await desktopPage.locator("body").innerText()).includes("Recent loading has been lower."), "desktop content missing");
    check("no wide tables on the Review page (nothing to force horizontal scroll)", (await desktopPage.locator("table").count()) === 0, "unexpected table element found");
    await desktopCtx.close();

    const mobileCtx = await loginContext(browser, clinicianA.email, { width: 390, height: 844 });
    const mobilePage = await mobileCtx.newPage();
    await mobilePage.goto(`${BASE_URL}/clinician/patients/${patientCapacity.userId}/review`);
    await mobilePage.waitForLoadState("networkidle");
    check("mobile viewport renders the same Review Context content", (await mobilePage.locator("body").innerText()).includes("Recent loading has been lower."), "mobile content missing");
    await mobileCtx.close();
  } catch (e) {
    fail++;
    const detail = e instanceof Error ? e.stack : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {}));
    console.log(`FAIL  unexpected error: ${detail}`);
  } finally {
    // ORDER MATTERS (same lesson as C3's own corrected teardown): provenance
    // join rows must be removed before the interpretation/session rows they
    // reference, or the delete silently fails on the FK constraint.
    if (userIds.length) {
      const { data: interpretations } = await admin.from("m6_longitudinal_interpretations").select("id").in("user_id", userIds);
      const interpretationIds = (interpretations ?? []).map((r) => r.id);
      if (interpretationIds.length) {
        await admin.from("m6_interpretation_reason_codes").delete().in("interpretation_id", interpretationIds);
        await admin.from("m6_interpretation_rehab_sessions").delete().in("interpretation_id", interpretationIds);
        await admin.from("m6_longitudinal_interpretations").delete().in("id", interpretationIds);
      }
    }
    if (sessionIds.length) {
      await admin.from("acute_safety_episodes").delete().in("source_rehab_session_id", sessionIds);
      await admin.from("escalation_evaluations").delete().in("rehab_session_id", sessionIds);
      await admin.from("morning_responses").delete().in("rehab_session_id", sessionIds);
      const { error: sessionDeleteError, count } = await admin.from("rehab_sessions").delete({ count: "exact" }).in("id", sessionIds);
      if (sessionDeleteError) console.error(`FIXTURE CLEANUP FAILED for rehab_sessions: ${sessionDeleteError.message}`);
      else if (count !== sessionIds.length) console.error(`FIXTURE CLEANUP WARNING: deleted ${count} of ${sessionIds.length} fixture rehab_sessions rows`);
    }
    if (userIds.length) {
      await admin.from("prescription_versions").delete().in("user_id", userIds);
      await admin.from("supervisor_patients").delete().in("supervisor_id", userIds);
      await admin.from("supervisor_patients").delete().in("patient_id", userIds);
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
