// M3.2 — committed synthetic fixtures for the safety-notification worker /
// UI / mode suites (development only). Every id created here is recorded so
// teardown can purge EXACTLY this run's fixtures (safetyFixturePurge.mjs).
// Guarded: nothing runs unless TENOTRAINER_MODE=development and both the
// .env project and the linked CLI project are the allow-listed development
// project.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertPurgeTarget, purgeSafetyFixtures } from "./safetyFixturePurge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
export const FIXTURE_PASSWORD = "M32-fixture-password-1!";

export function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

export const q = (id) => {
  if (!UUID_RE.test(String(id))) throw new Error(`not a uuid: ${id}`);
  return `'${String(id).toLowerCase()}'::uuid`;
};

// Runs SQL as the migration owner through the linked CLI, after the guard.
// Returns the rows of the last statement.
export function guardedSql(env, sql) {
  assertPurgeTarget(env);
  const path = join(mkdtempSync(join(tmpdir(), "m32-fx-")), "fx.sql");
  writeFileSync(path, sql);
  let out;
  try {
    out = execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const detail = String(e?.stdout ?? e?.message).match(/ERROR: [^\\"]*/)?.[0] ?? String(e?.message).slice(0, 300);
    throw new Error(`guarded SQL failed: ${detail}`);
  }
  const i = out.indexOf("{");
  return i >= 0 ? (JSON.parse(out.slice(i)).rows ?? []) : [];
}

export class FixtureRun {
  constructor(env, admin, tag) {
    this.env = env;
    this.admin = admin;
    this.tag = tag;
    this.startedAt = new Date(Date.now() - 5_000).toISOString();
    this.users = [];
    this.organizations = [];
    this.exercises = [];
  }

  async user(label) {
    const email = `m32-${this.tag}-${label}-${randomUUID()}@example.invalid`.toLowerCase();
    const { data, error } = await this.admin.auth.admin.createUser({ email, password: FIXTURE_PASSWORD, email_confirm: true, user_metadata: { name: `M32 ${label}` } });
    if (error) throw new Error(`createUser ${label}: ${error.message}`);
    this.users.push(data.user.id);
    return { id: data.user.id, email };
  }

  // Organization, memberships, assignments, profiles (name/timezone) and a
  // canonical exercise — one guarded statement batch.
  setup({ orgName, members, assignments, names }) {
    const orgId = randomUUID();
    const ceId = randomUUID();
    this.organizations.push(orgId);
    this.exercises.push(ceId);
    const sql = `
INSERT INTO organizations (id, name, slug) VALUES (${q(orgId)}, '${orgName.replace(/'/g, "")}', 'm32-${this.tag}-${orgId.slice(0, 8)}');
${members.map(([org, id, role]) => `INSERT INTO organization_members (organization_id, user_id, role) VALUES (${org === "fixture" ? q(orgId) : q(org)}, ${q(id)}, '${role}');`).join("\n")}
${Object.entries(names).map(([id, name]) => `UPDATE profiles SET name = '${name.replace(/'/g, "")}', timezone = 'America/New_York', morning_reminder_time = '05:00' WHERE id = ${q(id)};`).join("\n")}
${assignments.map(([org, clin, pat]) => `INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (${org === "fixture" ? q(orgId) : q(org)}, ${q(clin)}, ${q(pat)});`).join("\n")}
INSERT INTO canonical_exercises (id, name, visibility, active) VALUES (${q(ceId)}, 'M3.2 ${this.tag} exercise ${ceId.slice(0, 8)}', 'global', true);
SELECT 1 AS ok;`;
    guardedSql(this.env, sql);
    return { orgId, ceId };
  }

  // A real C5 program + closed session through the real lifecycle RPCs.
  // kind: "l5" (acute Stop pop -> check-in -> reconcile), "l3" (plain Stop,
  // sudden pain check-in -> reconcile), "acute_stop_outstanding" (acute
  // Stop recorded, check-in NOT submitted -> D6 notice only).
  safetyFlow(patientId, publisherId, ceId, kind) {
    const sql = `
DO $fx$
DECLARE v_pp UUID; v_v UUID; v_w UUID; v_e UUID; s UUID := gen_random_uuid(); v_r JSONB;
BEGIN
  INSERT INTO patient_prescriptions (patient_id) VALUES (${q(patientId)}) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (${q(patientId)}, 'clinician_change', v_pp, 1, now() - interval '30 days', ${q(publisherId)}, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, ${q(ceId)}, 0, 'active') RETURNING id INTO v_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_e, 'repetition', 3, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (s, ${q(patientId)}, 'c5:' || s::text, ((now() - interval '2 days') AT TIME ZONE 'America/New_York')::date, NULL, 'started', now() - interval '2 days',
    c5_build_session_snapshot(v_v, v_w), v_v, v_w, 'America/New_York', gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (s, v_e::text, 0, 0, 'completed', 8, now() - interval '2 days');
  ${kind === "l3"
    ? `v_r := c5_stop_session(${q(patientId)}, s, NULL);
  v_r := c5_submit_immediate_response(${q(patientId)}, s, '{"peak_session_pain": 4, "overall_session_rpe": 5, "sudden_or_sharp_pain": true, "pop_felt_or_heard": false, "new_functional_difficulty": false}');`
    : `v_r := c5_stop_session(${q(patientId)}, s, '{"pop_felt_or_heard": true}');`}
  ${kind === "l5"
    ? `v_r := c5_submit_immediate_response(${q(patientId)}, s, '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');`
    : ""}
  IF ${kind === "acute_stop_outstanding" ? "false" : "true"} THEN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM reconcile_missing_acute_episodes(${q(patientId)});
  END IF;
END
$fx$;
SELECT (SELECT id FROM acute_safety_episodes WHERE user_id = ${q(patientId)} ORDER BY confirmed_at DESC LIMIT 1) AS episode_id,
       (SELECT id FROM rehab_sessions WHERE user_id = ${q(patientId)} ORDER BY created_at DESC LIMIT 1) AS session_id;`;
    return guardedSql(this.env, sql)[0];
  }

  // Throws on any failure: a suite whose teardown fails must fail.
  teardown() {
    const result = purgeSafetyFixtures(this.env, {
      userIds: this.users, organizationIds: this.organizations, exerciseIds: this.exercises, runStartedAt: this.startedAt,
    });
    // Independent zero-residue verification (separate statement).
    const ids = this.users.map(q).join(", ");
    const rows = guardedSql(this.env, `SELECT
      (SELECT count(*) FROM auth.users WHERE id IN (${ids})) AS users,
      (SELECT count(*) FROM safety_notification_events WHERE patient_id IN (${ids})) AS events,
      (SELECT count(*) FROM safety_acute_stop_notices WHERE patient_id IN (${ids})) AS notices,
      (SELECT count(*) FROM safety_notification_recipients WHERE recipient_user_id IN (${ids})) AS recipients,
      (SELECT count(*) FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id IN (${ids})) AS outbox,
      (SELECT count(*) FROM safety_email_requeues WHERE requested_by IN (${ids})) AS requeues,
      (SELECT count(*) FROM acute_safety_episodes WHERE user_id IN (${ids})) AS episodes,
      (SELECT count(*) FROM rehab_sessions WHERE user_id IN (${ids})) AS sessions,
      (SELECT count(*) FROM organizations WHERE id IN (${this.organizations.map(q).join(", ") || "NULL"})) AS organizations,
      (SELECT count(*) FROM canonical_exercises WHERE id IN (${this.exercises.map(q).join(", ") || "NULL"})) AS exercises`)[0];
    const residue = Object.entries(rows).filter(([, n]) => Number(n) !== 0);
    if (residue.length) throw new Error(`teardown residue: ${JSON.stringify(rows)}`);
    return { purge: result, residue: rows };
  }
}
