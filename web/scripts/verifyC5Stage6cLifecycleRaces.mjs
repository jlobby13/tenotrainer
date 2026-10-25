// C5.6C lifecycle — race / concurrency / idempotency verification against the
// linked dev database. Every RPC is invoked exactly as the trusted server
// layer will invoke it (service_role, patient id supplied server-side), with
// genuinely concurrent PostgREST requests (= concurrent transactions).
//
// Each scenario uses its own throwaway @example.invalid patient so the
// one-session-per-local-day rule never couples scenarios. Everything created
// is removed in teardown.
//
// Run from the web/ directory:
//   node scripts/verifyC5Stage6cLifecycleRaces.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const REPO_ROOT = "..";
const CLINICIAN = "44197ef7-7421-47ed-a164-75d2765fc019";

// M2 — an assignment requires the clinician's clinician-role membership in
// its organization. This shared fixture clinician has none, so the suite
// grants one for the run and removes it in teardown (only if it added it).
const M2_FIXTURE_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
let fixtureClinicianMembershipAdded = false;
async function ensureFixtureClinicianMembership() {
  if (fixtureClinicianMembershipAdded) return;
  const { data } = await admin.from("organization_members").select("id").eq("user_id", CLINICIAN).eq("organization_id", M2_FIXTURE_ORG_ID).maybeSingle();
  if (data) return;
  const { error } = await admin.from("organization_members").insert({ organization_id: M2_FIXTURE_ORG_ID, user_id: CLINICIAN, role: "clinician" });
  if (error) throw error;
  fixtureClinicianMembershipAdded = true;
}
async function removeFixtureClinicianMembership() {
  if (!fixtureClinicianMembershipAdded) return;
  await admin.from("supervisor_patients").delete().eq("supervisor_id", CLINICIAN);
  await admin.from("organization_members").delete().eq("user_id", CLINICIAN).eq("organization_id", M2_FIXTURE_ORG_ID);
}
const TZ = "America/New_York";
const PASSWORD = "throwaway-verification-1!";

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
const WORK = mkdtempSync(join(tmpdir(), "c56c-races-"));

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
function section(t) {
  console.log(`\n--- ${t} ---`);
}

function sqlQuery(sql) {
  const path = join(WORK, `q-${randomUUID()}.sql`);
  writeFileSync(path, sql);
  execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function rpc(name, params) {
  const { data, error } = await admin.rpc(name, params);
  if (error) return { error: error.message };
  return data;
}
const perf = (exerciseId, unit, reps = 8) => ({ exercise_id: exerciseId, unit_index: unit, outcome: "completed", actual_reps: reps });
const first = (f, o = {}) =>
  rpc("c5_record_first_performance", {
    p_patient_id: f.patientId,
    p_client_request_id: o.requestId ?? randomUUID(),
    p_expected_version_id: o.versionId ?? f.versionId,
    p_workout_id: o.workoutId ?? f.workouts[0].id,
    p_performance: o.performance ?? perf(f.workouts[0].exerciseId, 0),
    p_pre_start_skips: o.skips ?? [],
    p_sequence_choice: o.choice ?? null,
  });
const record = (f, sessionId, p) => rpc("c5_record_performance", { p_patient_id: f.patientId, p_session_id: sessionId, p_performance: p });
const finish = (f, sessionId) => rpc("c5_finish_session", { p_patient_id: f.patientId, p_session_id: sessionId });
const stop = (f, sessionId) => rpc("c5_stop_session", { p_patient_id: f.patientId, p_session_id: sessionId });
const eligibility = (f) => rpc("c5_get_start_eligibility", { p_patient_id: f.patientId });

async function rows(table, column, value) {
  const { data } = await admin.from(table).select("*").eq(column, value);
  return data ?? [];
}

// ---------------------------------------------------------------- fixtures
const createdUsers = [];
let exerciseId = null;

async function makePatient(label) {
  const email = `c56c-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  createdUsers.push(data.user.id);
  await admin.from("profiles").upsert({ id: data.user.id, name: `C5.6C ${label}`, timezone: TZ });
  await ensureFixtureClinicianMembership();
  await admin.from("supervisor_patients").insert({ supervisor_id: CLINICIAN, patient_id: data.user.id, status: "active" });
  return data.user.id;
}

async function addVersion(patientId, ppId, versionNumber, mode, workoutDays) {
  const { data: v, error } = await admin
    .from("prescription_versions")
    .insert({
      user_id: patientId, source: "clinician_change", patient_prescription_id: ppId, version_number: versionNumber,
      published_at: new Date(Date.now() - 30 * 86400000).toISOString(), published_by: CLINICIAN,
      scheduling_mode: mode, target_sessions_per_week: mode === "sequence" ? 3 : null,
    })
    .select("id")
    .single();
  if (error) throw error;
  const workouts = [];
  for (let i = 0; i < workoutDays.length; i++) {
    const { data: w } = await admin
      .from("prescription_workouts")
      .insert({ prescription_version_id: v.id, label: String.fromCharCode(65 + i), order_index: i, days_of_week: workoutDays[i] })
      .select("id")
      .single();
    const { data: e } = await admin
      .from("prescription_exercises")
      .insert({ prescription_workout_id: w.id, canonical_exercise_id: exerciseId, order_index: 0, status: "active" })
      .select("id")
      .single();
    await admin.from("prescription_exercise_dosage").insert({ prescription_exercise_id: e.id, dosage_type: "repetition", sets: 4, reps_mode: "exact", reps_exact: 8, load_type: "not_applicable" });
    workouts.push({ id: w.id, exerciseId: e.id });
  }
  await admin.from("patient_prescriptions").update({ current_prescription_version_id: v.id }).eq("id", ppId);
  return { versionId: v.id, workouts };
}

async function makeFixture(label, { mode = "sequence", workoutDays = [null, null] } = {}) {
  const patientId = await makePatient(label);
  const { data: pp } = await admin.from("patient_prescriptions").insert({ patient_id: patientId }).select("id").single();
  const version = await addVersion(patientId, pp.id, 1, mode, workoutDays);
  return { patientId, ppId: pp.id, ...version };
}

// Response submission is C5.6E; tests resolve the obligation directly, using
// the DATABASE clock (resolved_at >= created_at is checked against server
// time, and the local clock may lag it).
function resolveImmediate(sessionId) {
  sqlQuery(`UPDATE session_immediate_responses SET peak_session_pain = 1, overall_session_rpe = 5,
  sudden_or_sharp_pain = false, pop_felt_or_heard = false, new_functional_difficulty = false, resolved_at = now()
WHERE rehab_session_id = '${sessionId}';`);
}

async function teardown() {
  for (const userId of createdUsers) {
    await admin.from("rehab_sessions").delete().eq("user_id", userId).not("resolves_stopped_session_id", "is", null);
    await admin.from("rehab_sessions").delete().eq("user_id", userId);
    const { data: pp } = await admin.from("patient_prescriptions").select("id").eq("patient_id", userId).maybeSingle();
    if (pp) {
      await admin.from("patient_prescriptions").update({ current_prescription_version_id: null }).eq("id", pp.id);
      await admin.from("prescription_drafts").delete().eq("patient_prescription_id", pp.id);
    }
    await admin.from("notifications").delete().eq("patient_id", userId);
    await admin.from("prescription_versions").delete().eq("user_id", userId);
    if (pp) await admin.from("patient_prescriptions").delete().eq("id", pp.id);
  }
  await admin.from("supervisor_patients").delete().in("patient_id", createdUsers);
  await admin.from("profiles").delete().in("id", createdUsers);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  if (exerciseId) await admin.from("canonical_exercises").delete().eq("id", exerciseId);
  const { data: left } = await admin.from("rehab_sessions").select("id").in("user_id", createdUsers.length ? createdUsers : [randomUUID()]);
  console.log(`\nteardown: fixture users removed; remaining fixture sessions: ${left?.length ?? "?"}`);
  await removeFixtureClinicianMembership();
}

// ---------------------------------------------------------------- scenarios
async function main() {
  const { data: ex, error: exErr } = await admin.from("canonical_exercises").insert({ name: `C5.6C race exercise ${randomUUID().slice(0, 6)}`, visibility: "global", active: true }).select("id").single();
  if (exErr) throw exErr;
  exerciseId = ex.id;

  section("1. two simultaneous first-performance requests (different request ids)");
  {
    const f = await makeFixture("dual-start");
    const results = await Promise.all([first(f), first(f), first(f), first(f)]);
    const started = results.filter((r) => r.result === "started");
    const resumed = results.filter((r) => r.result === "resume_existing_session");
    check("exactly one Start wins", started.length === 1, JSON.stringify(results));
    check("every other request is told to resume the SAME session", resumed.length === 3 && resumed.every((r) => r.session_id === started[0]?.session_id), JSON.stringify(results));
    const sessions = await rows("rehab_sessions", "user_id", f.patientId);
    check("one C5 session in the database", sessions.length === 1);
    const units = await rows("set_outcomes", "rehab_session_id", sessions[0]?.id);
    check("one first performance recorded", units.length === 1 && units[0].outcome === "completed");
  }

  section("2. the same first-performance request retried concurrently");
  {
    const f = await makeFixture("retry");
    const requestId = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => first(f, { requestId })));
    const ids = new Set(results.map((r) => r.session_id));
    check("every retry returns started for one session", results.every((r) => r.result === "started") && ids.size === 1, JSON.stringify(results));
    check("exactly one non-replayed result", results.filter((r) => r.replayed === false).length === 1, JSON.stringify(results));
    const sessions = await rows("rehab_sessions", "user_id", f.patientId);
    check("one session, one performance unit", sessions.length === 1 && (await rows("set_outcomes", "rehab_session_id", sessions[0].id)).length === 1);

    section("7. subsequent performance racing Finish");
    const sessionId = sessions[0].id;
    const [p, fin] = await Promise.all([record(f, sessionId, perf(f.workouts[0].exerciseId, 1)), finish(f, sessionId)]);
    const unit1 = (await rows("set_outcomes", "rehab_session_id", sessionId)).filter((u) => u.set_index === 1);
    check("Finish closed the session", fin.result === "closed" && fin.training_status === "finished", JSON.stringify(fin));
    check("performance either landed before Finish or was refused after it — never after closure",
      (p.result === "recorded" && unit1.length === 1) || (p.result === "session_closed" && unit1.length === 0), JSON.stringify(p));

    section("8. repeated Finish (concurrent) + 16. obligations exactly once");
    const again = await Promise.all(Array.from({ length: 4 }, () => finish(f, sessionId)));
    check("repeated Finish is a stable replay", again.every((r) => r.result === "closed" && r.replayed === true), JSON.stringify(again));
    check("exactly one immediate-response obligation", (await rows("session_immediate_responses", "rehab_session_id", sessionId)).length === 1);
    const mornings = await rows("morning_responses", "rehab_session_id", sessionId);
    check("exactly one morning obligation, with due + reference date", mornings.length === 1 && mornings[0].scheduled_eligible_at && mornings[0].reference_local_date);

    section("3. two different Start requests on the same local day");
    const blockedByResponse = await first(f);
    check("outstanding immediate response blocks the next Start", blockedByResponse.result === "immediate_response_required", JSON.stringify(blockedByResponse));
    resolveImmediate(sessionId);
    const sameDay = await Promise.all([first(f, { workoutId: f.workouts[1].id, performance: perf(f.workouts[1].exerciseId, 0) }), first(f, { workoutId: f.workouts[1].id, performance: perf(f.workouts[1].exerciseId, 0) })]);
    check("both later same-day Starts -> already_trained_today", sameDay.every((r) => r.result === "already_trained_today"), JSON.stringify(sameDay));
    check("still exactly one session for the day", (await rows("rehab_sessions", "user_id", f.patientId)).length === 1);
  }

  section("6. Finish racing Stop  /  9. repeated Stop");
  {
    const f = await makeFixture("finish-vs-stop");
    const s = await first(f);
    const [a, b] = await Promise.all([finish(f, s.session_id), stop(f, s.session_id)]);
    const winners = [a, b].filter((r) => r.result === "closed" && r.replayed === false);
    const losers = [a, b].filter((r) => r.result === "session_already_closed");
    check("exactly one closure wins; the other is told the session is already closed", winners.length === 1 && losers.length === 1, JSON.stringify([a, b]));
    const [row] = await rows("rehab_sessions", "id", s.session_id);
    check("stored status matches the winning closure", row.training_status === winners[0]?.training_status, row.training_status);
    check("obligations created once", (await rows("session_immediate_responses", "rehab_session_id", s.session_id)).length === 1 && (await rows("morning_responses", "rehab_session_id", s.session_id)).length === 1);

    const f2 = await makeFixture("repeat-stop");
    const s2 = await first(f2);
    const stops = await Promise.all(Array.from({ length: 4 }, () => stop(f2, s2.session_id)));
    check("concurrent repeated Stop: one real closure, rest replays", stops.filter((r) => r.replayed === false).length === 1 && stops.every((r) => r.training_status === "stopped_early"), JSON.stringify(stops));
    check("Stop with active prescription -> STOPPED_EARLY; obligations once", (await rows("session_immediate_responses", "rehab_session_id", s2.session_id)).length === 1);
  }

  section("4. Start racing Pause  /  13-15. pause with a STARTED session");
  {
    const f = await makeFixture("start-vs-pause");
    const [s] = await Promise.all([first(f), rpc("pause_prescription", { p_patient_prescription_id: f.ppId, p_clinician_id: CLINICIAN })]);
    const sessions = await rows("rehab_sessions", "user_id", f.patientId);
    check("Start vs Pause resolves to exactly one consistent order",
      (s.result === "started" && sessions.length === 1) || (s.result === "prescription_paused" && sessions.length === 0), JSON.stringify(s));
    if (s.result === "started") {
      check("13. pause left the STARTED session open", sessions[0].training_status === "started");
      const p = await record(f, s.session_id, perf(f.workouts[0].exerciseId, 1));
      check("13. performance still recordable while paused", p.result === "recorded", JSON.stringify(p));
      const st = await stop(f, s.session_id);
      check("15. Stop Today's Session while paused -> STOPPED_PAUSE", st.training_status === "stopped_pause", JSON.stringify(st));
    } else {
      const e = await eligibility(f);
      check("paused, no session -> prescription_paused", e.result === "prescription_paused", JSON.stringify(e));
    }
    const notes = await rows("notifications", "patient_id", f.patientId);
    check("pause notification created exactly once", notes.filter((n) => n.type === "prescription_paused").length === 1);

    // 13 / 15 in a fixed order (the race above may resolve either way).
    const h = await makeFixture("stop-while-paused");
    const hs = await first(h);
    await rpc("pause_prescription", { p_patient_prescription_id: h.ppId, p_clinician_id: CLINICIAN });
    check("13. (fixed order) pause leaves the session STARTED", (await rows("rehab_sessions", "id", hs.session_id))[0].training_status === "started");
    const hp = await record(h, hs.session_id, perf(h.workouts[0].exerciseId, 1));
    check("13. (fixed order) performance recordable while paused", hp.result === "recorded", JSON.stringify(hp));
    const hst = await stop(h, hs.session_id);
    check("15. (fixed order) Stop while paused -> STOPPED_PAUSE", hst.training_status === "stopped_pause", JSON.stringify(hst));
    const hn = await first(h);
    check("pause blocks a NEW Start once no session is open", hn.result === "prescription_paused", JSON.stringify(hn));

    // 14. Finish the current session while paused (deterministic order).
    const g = await makeFixture("finish-while-paused");
    const gs = await first(g);
    await rpc("pause_prescription", { p_patient_prescription_id: g.ppId, p_clinician_id: CLINICIAN });
    const e = await eligibility(g);
    check("14. while paused the patient is told to resume the existing session", e.result === "resume_existing_session" && e.prescription_paused === true, JSON.stringify(e));
    const gf = await finish(g, gs.session_id);
    check("14. Finish Current Session while paused -> FINISHED", gf.result === "closed" && gf.training_status === "finished", JSON.stringify(gf));
    await rpc("resume_prescription", { p_patient_prescription_id: g.ppId, p_clinician_id: CLINICIAN });
    check("resume notification created", (await rows("notifications", "patient_id", g.patientId)).some((n) => n.type === "prescription_resumed"));
  }

  section("5. Start racing Publish  /  12. STARTED old-version session survives publish");
  {
    const f = await makeFixture("start-vs-publish");
    const { data: draftId, error } = await admin.rpc("create_prescription_draft", { p_patient_id: f.patientId, p_clinician_id: CLINICIAN, p_source: "clone_active", p_source_version_id: f.versionId });
    if (error) throw new Error(error.message);
    const [s, pub] = await Promise.all([first(f), admin.rpc("publish_prescription_draft", { p_draft_id: draftId, p_clinician_id: CLINICIAN })]);
    const newVersion = pub.data;
    check("publish succeeded", !pub.error && !!newVersion, pub.error?.message);
    const sessions = await rows("rehab_sessions", "user_id", f.patientId);
    check("Start vs Publish resolves to one consistent order",
      (s.result === "started" && sessions.length === 1 && sessions[0].prescription_version_id === f.versionId)
        || (s.result === "version_changed" && sessions.length === 0), JSON.stringify(s));
    if (s.result === "started") {
      check("12. STARTED session still bound to its frozen V1 snapshot after publish",
        sessions[0].prescription_snapshot.prescription_version_id === f.versionId);
      const p = await record(f, s.session_id, perf(f.workouts[0].exerciseId, 1));
      check("12. old-version session keeps accepting performance", p.result === "recorded", JSON.stringify(p));
    } else {
      check("publish won: the stale Start created nothing", sessions.length === 0);
    }

    // 12 in a fixed order: Start, then publish, then keep training.
    const k = await makeFixture("publish-after-start");
    const ks = await first(k);
    const { data: kDraft } = await admin.rpc("create_prescription_draft", { p_patient_id: k.patientId, p_clinician_id: CLINICIAN, p_source: "clone_active", p_source_version_id: k.versionId });
    const kPub = await admin.rpc("publish_prescription_draft", { p_draft_id: kDraft, p_clinician_id: CLINICIAN });
    check("12. (fixed order) publish while STARTED succeeds", !kPub.error, kPub.error?.message);
    const ke = await eligibility(k);
    check("12. (fixed order) patient resumes the V1 session, not the new version", ke.result === "resume_existing_session" && ke.prescription_version_id === k.versionId, JSON.stringify(ke));
    const kp = await record(k, ks.session_id, perf(k.workouts[0].exerciseId, 1));
    const kf = await finish(k, ks.session_id);
    check("12. (fixed order) old-version session records and Finishes normally", kp.result === "recorded" && kf.training_status === "finished", JSON.stringify([kp, kf]));
  }

  section("10. Sequence Repeat / Advance  /  11. new version supersedes an unresolved choice");
  {
    const f = await makeFixture("sequence");
    const yesterday = randomUUID();
    sqlQuery(`BEGIN;
INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
VALUES ('${yesterday}', '${f.patientId}', 'c5:${yesterday}', ((now() - interval '1 day') AT TIME ZONE '${TZ}')::date, NULL, 'started', now() - interval '1 day',
  c5_build_session_snapshot('${f.versionId}', '${f.workouts[1].id}'), '${f.versionId}', '${f.workouts[1].id}', '${TZ}', gen_random_uuid());
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${yesterday}', '${f.workouts[1].exerciseId}', 0, 0, 'completed', 8, now() - interval '1 day');
UPDATE rehab_sessions SET training_status = 'stopped_early', training_closed_at = now() - interval '1 day' + interval '5 minutes' WHERE id = '${yesterday}';
INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
VALUES ('${yesterday}', '${f.patientId}', 1, 4, false, false, false, now());
INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, next_morning_pain, next_morning_stiffness, resolution, submitted_at)
VALUES ('${yesterday}', '${f.patientId}', now() - interval '3 hours', (now() AT TIME ZONE '${TZ}')::date, 1, 0, 'answered', now());
COMMIT;`);
    const e = await eligibility(f);
    check("Stopped B -> choice between Repeat B and Advance (wrap) to A",
      e.sequence?.state === "pending_choice" && e.sequence.repeat_workout_id === f.workouts[1].id && e.sequence.advance_workout_id === f.workouts[0].id, JSON.stringify(e));
    const noChoice = await first(f, { workoutId: f.workouts[1].id, performance: perf(f.workouts[1].exerciseId, 0) });
    check("no automatic advancement — a choice is required", noChoice.result === "sequence_choice_required", JSON.stringify(noChoice));
    const rep = await first(f, { workoutId: f.workouts[1].id, performance: perf(f.workouts[1].exerciseId, 0), choice: "repeat_previous" });
    check("Repeat Previous starts a NEW session on the stopped workout", rep.result === "started" && rep.prescription_workout_id === f.workouts[1].id && rep.session_id !== yesterday, JSON.stringify(rep));
    const [repRow] = await rows("rehab_sessions", "id", rep.session_id);
    check("resolution recorded on the new session; the stopped session is untouched",
      repRow.sequence_choice === "repeat_previous" && repRow.resolves_stopped_session_id === yesterday
        && (await rows("rehab_sessions", "id", yesterday))[0].training_status === "stopped_early");
    await finish(f, rep.session_id);
    const after = await eligibility(f);
    check("same day after Finish: already_trained_today is gated behind the immediate response", after.result === "immediate_response_required", JSON.stringify(after));

    const g = await makeFixture("supersede");
    const stopped = randomUUID();
    sqlQuery(`BEGIN;
INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
  prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
VALUES ('${stopped}', '${g.patientId}', 'c5:${stopped}', ((now() - interval '1 day') AT TIME ZONE '${TZ}')::date, NULL, 'started', now() - interval '1 day',
  c5_build_session_snapshot('${g.versionId}', '${g.workouts[1].id}'), '${g.versionId}', '${g.workouts[1].id}', '${TZ}', gen_random_uuid());
INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
VALUES ('${stopped}', '${g.workouts[1].exerciseId}', 0, 0, 'completed', 8, now() - interval '1 day');
UPDATE rehab_sessions SET training_status = 'stopped_early', training_closed_at = now() - interval '1 day' + interval '5 minutes' WHERE id = '${stopped}';
INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
VALUES ('${stopped}', '${g.patientId}', 1, 4, false, false, false, now());
INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
VALUES ('${stopped}', '${g.patientId}', now() - interval '3 hours', (now() AT TIME ZONE '${TZ}')::date, 'unable_to_recall', now());
COMMIT;`);
    const v2 = await addVersion(g.patientId, g.ppId, 2, "sequence", [null, null, null]);
    const e2 = await eligibility(g);
    check("11. new version: unresolved old-version choice obsolete; V2 begins at its first workout",
      e2.sequence?.state === "first" && e2.sequence.workout_id === v2.workouts[0].id && e2.prescription_version_id === v2.versionId, JSON.stringify(e2));
    const s2 = await first(g, { versionId: v2.versionId, workoutId: v2.workouts[0].id, performance: perf(v2.workouts[0].exerciseId, 0) });
    check("11. Start on V2's first workout records no Sequence resolution", s2.result === "started" && s2.sequence_choice === null, JSON.stringify(s2));
  }

  section("Calendar end-to-end (today's scheduled workout)");
  {
    const f = await makeFixture("calendar", { mode: "calendar", workoutDays: [[0, 1, 2, 3, 4, 5, 6]] });
    const s = await first(f);
    check("Calendar Start records the scheduled opportunity fulfilled (today)", s.result === "started" && s.calendar_scheduled_date === s.patient_local_date, JSON.stringify(s));
  }

  section("Invariants across every fixture");
  {
    const { data: all } = await admin.from("rehab_sessions").select("id, user_id, patient_local_date, training_status, prescription_version_id, prescription_snapshot").in("user_id", createdUsers);
    let zeroWork = 0;
    for (const r of all ?? []) {
      const units = await rows("set_outcomes", "rehab_session_id", r.id);
      if (!units.some((u) => u.outcome === "completed")) zeroWork++;
    }
    check("no C5 session exists with zero actual performed work", zeroWork === 0, `${zeroWork}`);
    const perDay = new Map();
    for (const r of all ?? []) perDay.set(`${r.user_id}:${r.patient_local_date}`, (perDay.get(`${r.user_id}:${r.patient_local_date}`) ?? 0) + 1);
    check("no patient-local date consumed by two sessions", [...perDay.values()].every((n) => n === 1));
    check("no session's version differs from its frozen snapshot", (all ?? []).every((r) => r.prescription_snapshot.prescription_version_id === r.prescription_version_id));
    const { data: seqTable } = await admin.from("prescription_sequence_state").select("id").limit(1);
    check("no mutable Sequence pointer table exists (no drift possible)", seqTable === null);
  }
}

try {
  await main();
} catch (e) {
  fail++;
  console.log(`FAIL  unexpected error: ${e?.stack ?? e}`);
} finally {
  await teardown();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
