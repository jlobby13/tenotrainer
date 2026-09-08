// Acute Safety Gate founder-acceptance patch — regression coverage for the
// missed-episode reconciliation fail-safe (supabase/migrations/
// 20260911000004 and 20260911000005). Verifies against the LIVE LINKED
// Supabase dev database: creates disposable throwaway auth users, exercises
// reconcile_missing_acute_episodes() and create_rehab_session_if_allowed()
// exactly as the real web/app/api/patient/rehab-session/route.ts calls
// them, then deletes every row and auth user it created.
//
// This script previously caught a real transaction-rollback bug (an
// orphaned Level 3/5 escalation's reconciled episode was silently rolled
// back by a later RAISE EXCEPTION in the same transaction) — keep it, and
// re-run it after ANY change to reconciliation, create_rehab_session_if_allowed,
// or the acute safety brake/gate RPCs.
//
// Talks to Supabase directly via RPC — no running Next.js server required.
// Requires web/.env.local populated with NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY, pointed at a
// dev/staging project — never run against production.
//
// Run from the web/ directory:
//   node scripts/verifyReconciliation.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}
function genUuid() { return crypto.randomUUID(); }

async function insertVersion(userId) {
  const { data } = await admin.from("prescription_versions").insert({ user_id: userId, stage: 1, irritability: "low", is_insertional: false, source: "onboarding" }).select().maybeSingle();
  return data;
}
async function insertSession(userId, versionId, startedAt, findings = {}) {
  const id = genUuid();
  await admin.from("rehab_sessions").insert({
    id, user_id: userId, plan_id: "test-plan", prescription_instance_id: `test-plan:${id}`,
    patient_local_date: startedAt.slice(0, 10), status: "awaiting_morning_response", started_at: startedAt,
    prescription_snapshot: [], peak_session_pain: 2, difficulty: "moderate", prescription_version_id: versionId,
    response_recorded_at: startedAt, ...findings,
  });
  return id;
}
// Simulates the REAL failure: escalation_evaluations gets written but
// confirmAcuteSafetyEpisode() never runs (e.g. it threw) — no episode row
// created, matching the exact debt this patch closes.
async function insertOrphanEscalation(sessionId, level, evaluatedAt) {
  const { data } = await admin.from("escalation_evaluations").insert({
    rehab_session_id: sessionId, escalation_level: level, escalation_reason: "test", rule_version: "v1", inputs_snapshot: {}, evaluated_at: evaluatedAt,
  }).select().maybeSingle();
  return data;
}
async function makeUser(label) {
  const email = `m5-reconcile-verify-${label}-${Date.now()}@example.invalid`;
  const password = "throwaway-verification-1!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  await client.auth.signInWithPassword({ email, password });
  return { userId: data.user.id, client };
}
// Mirrors the fixed web/app/api/patient/rehab-session/route.ts exactly:
// reconcile_missing_acute_episodes() is called FIRST, as its own separately
// -committed transaction, before create_rehab_session_if_allowed() — this
// is what makes the reconciled episode durably visible to the gate's own
// read-only brake check.
async function callCreateSession(authed) {
  const userId = (await authed.auth.getUser()).data.user.id;
  const { error: reconcileError } = await authed.rpc("reconcile_missing_acute_episodes", { p_user_id: userId });
  if (reconcileError) {
    return { data: null, error: reconcileError, sessionId: null, reconcileError };
  }
  const sid = genUuid();
  const startedAt = new Date(Date.now() + 60000).toISOString();
  const { data, error } = await authed.rpc("create_rehab_session_if_allowed", {
    p_session_id: sid, p_plan_id: "test-plan", p_prescription_instance_id: `test-plan:${sid}`,
    p_patient_local_date: startedAt.slice(0, 10), p_started_at: startedAt, p_prescription_snapshot: [],
  });
  return { data, error, sessionId: sid };
}
async function cleanupUser(userId) {
  const sessionIds = (await admin.from("rehab_sessions").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
  const episodeIds = (await admin.from("acute_safety_episodes").select("id").eq("user_id", userId)).data?.map((r) => r.id) ?? [];
  if (sessionIds.length > 0) await admin.from("session_guidance_contexts").delete().in("rehab_session_id", sessionIds);
  if (episodeIds.length > 0) {
    await admin.from("cautious_return_contexts").delete().in("acute_safety_episode_id", episodeIds);
    await admin.from("blocked_loading_opportunities").delete().in("acute_safety_episode_id", episodeIds);
    await admin.from("acute_safety_releases").delete().in("acute_safety_episode_id", episodeIds);
    await admin.from("acute_safety_reassessments").delete().in("acute_safety_episode_id", episodeIds);
  }
  await admin.from("acute_safety_episodes").delete().eq("user_id", userId);
  await admin.from("rehab_sessions").delete().eq("user_id", userId);
  await admin.from("prescription_versions").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId);
}

async function main() {
  const u1 = await makeUser("l3orphan");
  const u2 = await makeUser("l5orphan");
  const u3 = await makeUser("idempotent");
  const u4 = await makeUser("nofabricate");

  try {
    // === 1. Level 3 escalation exists, episode missing -> session start does NOT proceed normally ===
    console.log("\n--- Test 1: Level 3 orphan ---");
    const v1 = await insertVersion(u1.userId);
    const historicalTime1 = new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(); // 5h ago, preserved below
    const s1 = await insertSession(u1.userId, v1.id, new Date(Date.now() - 1000 * 60 * 60 * 5.5).toISOString(), { sudden_or_sharp_pain: true, new_functional_difficulty: false, pop_felt_or_heard: false });
    const orphan1 = await insertOrphanEscalation(s1, 3, historicalTime1);
    const { count: episodeCountBefore1 } = await admin.from("acute_safety_episodes").select("id", { count: "exact", head: true }).eq("source_escalation_evaluation_id", orphan1.id);
    check("1a. episode genuinely absent before session-start attempt", (episodeCountBefore1 ?? 0) === 0);
    const attempt1 = await callCreateSession(u1.client);
    check("1b. session start does NOT proceed normally (blocked by reconciled Level 3 brake)", attempt1.error?.message === "ACUTE_SAFETY_REVIEW_REQUIRED", JSON.stringify(attempt1.error));
    const { count: sessCount1 } = await admin.from("rehab_sessions").select("id", { count: "exact", head: true }).eq("id", attempt1.sessionId);
    check("1c. no new rehab_sessions row was created", (sessCount1 ?? 0) === 0);

    // === 2. Level 5 escalation exists, episode missing -> session start does NOT proceed normally ===
    console.log("\n--- Test 2: Level 5 orphan ---");
    const v2 = await insertVersion(u2.userId);
    const historicalTime2 = new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString();
    const s2 = await insertSession(u2.userId, v2.id, new Date(Date.now() - 1000 * 60 * 60 * 3.5).toISOString(), { sudden_or_sharp_pain: false, new_functional_difficulty: false, pop_felt_or_heard: true });
    const orphan2 = await insertOrphanEscalation(s2, 5, historicalTime2);
    const attempt2 = await callCreateSession(u2.client);
    check("2. session start does NOT proceed normally for a Level 5 orphan (professional-review code)", attempt2.error?.message === "ACUTE_SAFETY_PROFESSIONAL_REVIEW_REQUIRED", JSON.stringify(attempt2.error));

    // === 3. reconciliation creates exactly one episode ===
    console.log("\n--- Test 3: exactly one episode created ---");
    const { data: reconciledEpisodes1 } = await admin.from("acute_safety_episodes").select().eq("source_escalation_evaluation_id", orphan1.id);
    check("3. exactly one episode created for the orphan escalation", (reconciledEpisodes1 ?? []).length === 1, JSON.stringify(reconciledEpisodes1));
    check("3b. reconciled episode's initial_level matches the escalation", reconciledEpisodes1[0].initial_level === 3);
    check("3c. reconciled episode's findings match the source session's own columns", reconciledEpisodes1[0].initial_sudden_or_sharp_pain === true && reconciledEpisodes1[0].initial_new_functional_difficulty === false);

    // === 4. repeated reconciliation is idempotent ===
    console.log("\n--- Test 4: idempotent on repeat ---");
    const attempt1retry = await callCreateSession(u1.client); // triggers reconciliation again (already reconciled -> no-op)
    check("4a. repeated gate check still blocks the same way", attempt1retry.error?.message === "ACUTE_SAFETY_REVIEW_REQUIRED");
    const { count: episodeCountAfterRetry } = await admin.from("acute_safety_episodes").select("id", { count: "exact", head: true }).eq("source_escalation_evaluation_id", orphan1.id);
    check("4b. still exactly one episode after repeated reconciliation (no duplicate)", (episodeCountAfterRetry ?? 0) === 1);
    // Direct repeated calls to the reconciliation function itself.
    const direct1 = await u1.client.rpc("reconcile_missing_acute_episodes", { p_user_id: u1.userId });
    const direct2 = await u1.client.rpc("reconcile_missing_acute_episodes", { p_user_id: u1.userId });
    check("4c. direct repeated RPC calls to reconcile_missing_acute_episodes return no new rows the second time", !direct1.error && !direct2.error && (direct2.data ?? []).length === 0, JSON.stringify({ direct1: direct1.error, direct2: direct2.error, secondCount: direct2.data?.length }));

    // === 5. historical confirmation timestamp remains correct ===
    console.log("\n--- Test 5: chronology preserved ---");
    const { data: reconciled1 } = await admin.from("acute_safety_episodes").select("confirmed_at").eq("source_escalation_evaluation_id", orphan1.id).maybeSingle();
    check("5. reconciled episode's confirmed_at equals the ORIGINAL escalation's evaluated_at, not 'now'", new Date(reconciled1.confirmed_at).getTime() === new Date(historicalTime1).getTime(), `expected ${historicalTime1}, got ${reconciled1.confirmed_at}`);

    // === 6. no qualifying escalation -> no episode fabricated ===
    console.log("\n--- Test 6: no fabrication for non-qualifying escalations ---");
    const v4 = await insertVersion(u4.userId);
    const s4a = await insertSession(u4.userId, v4.id, new Date(Date.now() - 1000 * 60 * 60).toISOString());
    await admin.from("rehab_sessions").update({ status: "response_complete" }).eq("id", s4a);
    await admin.from("escalation_evaluations").insert({ rehab_session_id: s4a, escalation_level: 1, escalation_reason: "test", rule_version: "v1", inputs_snapshot: {} });
    await admin.from("escalation_evaluations").insert({ rehab_session_id: s4a, escalation_level: 0, escalation_reason: "test", rule_version: "v1", inputs_snapshot: {} });
    const reconcileResult4 = await u4.client.rpc("reconcile_missing_acute_episodes", { p_user_id: u4.userId });
    check("6a. reconciliation call succeeds with only non-qualifying escalations present", !reconcileResult4.error, JSON.stringify(reconcileResult4.error));
    check("6b. no episode fabricated for Level 0/1 escalations", (reconcileResult4.data ?? []).length === 0);
    const { count: episodeCount4 } = await admin.from("acute_safety_episodes").select("id", { count: "exact", head: true }).eq("user_id", u4.userId);
    check("6c. zero episodes exist for this patient", (episodeCount4 ?? 0) === 0);
    const attempt4 = await callCreateSession(u4.client);
    check("6d. ordinary session creation proceeds normally (no brake fabricated)", !attempt4.error, JSON.stringify(attempt4.error));

    // === Security: cross-user reconciliation still rejected ===
    console.log("\n--- Security ---");
    const crossCall = await u3.client.rpc("reconcile_missing_acute_episodes", { p_user_id: u1.userId });
    check("Security: user 3 cannot reconcile user 1's episodes", !!crossCall.error, JSON.stringify(crossCall));
  } finally {
    console.log("\nCleaning up...");
    await cleanupUser(u1.userId);
    await cleanupUser(u2.userId);
    await cleanupUser(u3.userId);
    await cleanupUser(u4.userId);
    console.log("Cleanup complete.");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
