// M3.2 — proves test fixtures coexist with the production sweep (pg_cron,
// every minute, ENABLED — never paused, locked or stopped here).
//
//   control: the OLD two-call fixture pattern (back-dated evaluation, then a
//            separate episode insert) left across one sweep tick is
//            legitimately reconciled by the sweep first — the race is real;
//   atomic : the evaluation + episode written in ONE statement (the
//            BrowserStates fixture helper's construction) many times across
//            several sweep ticks never conflicts: every evaluation has
//            exactly the one episode the fixture inserted, none from the sweep.
//
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM32SweepRaceStress.mjs [pairs=60]
import { createClient } from "@supabase/supabase-js";
import { FixtureRun, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { assertPurgeTarget } from "./lib/safetyFixturePurge.mjs";

const PAIRS = Number(process.argv[2] ?? 60);
const env = loadEnv(".env.local");
assertPurgeTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); }
};
const lastSweep = () => guardedSql(env, "SELECT last_succeeded_at AS t FROM safety_notification_heartbeats WHERE component = 'sweep'")[0].t;
const cronActive = () => guardedSql(env, "SELECT count(*) AS n FROM cron.job WHERE jobname = 'tenotrainer_m32_safety_notification_sweep' AND active")[0].n;

const run = new FixtureRun(env, admin, "race");
try {
  check("the production sweep job is enabled (and stays enabled throughout)", Number(cronActive()) === 1);
  const p = await run.user("p");
  run.setup({ orgName: "M3.2 race org", members: [["fixture", p.id, "member"]], assignments: [], names: { [p.id]: "Race Patient" } });
  // One legacy-shaped session for the fixture evaluations.
  const sid = guardedSql(env, `INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, prescription_snapshot)
    VALUES (gen_random_uuid(), ${q(p.id)}, 'legacy:m32-race-' || gen_random_uuid(), current_date - 3, '[]'::jsonb) RETURNING id`)[0].id;
  const backdated = new Date(Date.now() - 5 * 3600_000).toISOString();

  // ---------------- control: the old two-call pattern across one sweep tick
  const ee = guardedSql(env, `INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
    VALUES (${q(sid)}, 3, 'test', 'v1', '{}'::jsonb, '${backdated}'::timestamptz) RETURNING id`)[0].id;
  const t0 = lastSweep();
  let swept = false;
  for (let i = 0; i < 90 && !swept; i++) { await new Promise((r) => setTimeout(r, 2000)); swept = lastSweep() !== t0; }
  const byS = guardedSql(env, `SELECT count(*) AS n FROM acute_safety_episodes WHERE source_escalation_evaluation_id = ${q(ee)}`)[0].n;
  let conflict = "";
  try {
    guardedSql(env, `INSERT INTO acute_safety_episodes (user_id, source_rehab_session_id, source_escalation_evaluation_id, initial_level,
      initial_sudden_or_sharp_pain, initial_new_functional_difficulty, initial_pop_felt_or_heard, recurrence_sequence_in_window, confirmed_at)
      VALUES (${q(p.id)}, ${q(sid)}, ${q(ee)}, 3, true, false, false, 1, '${backdated}'::timestamptz) RETURNING id`);
  } catch (e) { conflict = e.message; }
  check("control: an orphan left across a sweep tick is reconciled by the sweep (the old race is real)",
    swept && Number(byS) === 1 && /unique|duplicate|23505/i.test(conflict), `swept ${swept}, episodes ${byS}, ${conflict.slice(0, 120)}`);

  // ---------------- atomic construction, many times across sweep ticks
  const sweepsBefore = lastSweep();
  const ids = [];
  const started = Date.now();
  let errors = 0;
  for (let i = 0; i < PAIRS; i++) {
    try {
      const r = guardedSql(env, `WITH ee AS (
          INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
          VALUES (${q(sid)}, 3, 'test', 'v1', '{}'::jsonb, '${backdated}'::timestamptz) RETURNING id
        ), ep AS (
          INSERT INTO acute_safety_episodes (user_id, source_rehab_session_id, source_escalation_evaluation_id, initial_level,
            initial_sudden_or_sharp_pain, initial_new_functional_difficulty, initial_pop_felt_or_heard,
            recurrence_window_anchor_id, recurrence_sequence_in_window, level4_recurrent, confirmed_at)
          SELECT ${q(p.id)}, ${q(sid)}, ee.id, 3, true, false, false, NULL, 1, false, '${backdated}'::timestamptz FROM ee RETURNING id
        ) SELECT (SELECT id FROM ee) AS e, (SELECT id FROM ep) AS ep`)[0];
      ids.push(r);
    } catch { errors++; }
  }
  const minutes = (Date.now() - started) / 60000;
  const sweepsDuring = guardedSql(env, `SELECT count(*) AS n FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
    WHERE j.jobname = 'tenotrainer_m32_safety_notification_sweep' AND d.start_time >= to_timestamp(${started / 1000}) AND d.status = 'succeeded'`)[0].n;
  const mismatch = guardedSql(env, `SELECT count(*) AS n FROM escalation_evaluations ee
    WHERE ee.id IN (${ids.map((x) => q(x.e)).join(", ") || "NULL"})
      AND (SELECT count(*) FROM acute_safety_episodes a WHERE a.source_escalation_evaluation_id = ee.id) <> 1`)[0].n;
  const foreign = guardedSql(env, `SELECT count(*) AS n FROM acute_safety_episodes a
    WHERE a.source_escalation_evaluation_id IN (${ids.map((x) => q(x.e)).join(", ") || "NULL"}) AND a.id NOT IN (${ids.map((x) => q(x.ep)).join(", ") || "NULL"})`)[0].n;
  check(`atomic: ${PAIRS} back-dated evaluation+episode fixtures over ${minutes.toFixed(1)} min spanning ${sweepsDuring} real sweep runs — 0 errors`,
    errors === 0 && ids.length === PAIRS && Number(sweepsDuring) >= 2, `errors ${errors}, sweeps ${sweepsDuring}`);
  check("atomic: every fixture evaluation has exactly one episode — the one the fixture inserted (the sweep never got there first)",
    Number(mismatch) === 0 && Number(foreign) === 0, `mismatch ${mismatch}, foreign ${foreign}`);
  check("the production sweep stayed enabled and kept succeeding", Number(cronActive()) === 1 && lastSweep() !== sweepsBefore);
} catch (e) {
  check("stress ran without an unexpected error", false, e?.stack ?? e);
} finally {
  try { run.teardown(); check("teardown: exact-id purge, zero residue", true); } catch (e) { check("teardown", false, e.message); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
