-- C5.6B runtime schema foundation — schema/constraint/privilege verification.
-- Runs entirely inside one transaction ROLLBACK'd at the end — no row
-- persists in the shared project regardless of outcome. Uses a real,
-- pre-existing auth.users id with no prescription state purely to satisfy
-- FKs (same convention as verifyC5Stage3DraftPublishEngine.sql).
--
-- No C5.6C lifecycle RPC exists yet, so fixtures are written directly as the
-- migration role; the assertions exercise the CHECKs, unique indexes, FKs,
-- guard triggers, column grants and RLS that the C5.6C RPCs will rely on.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage6bRuntimeSchema.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

-- Runs one statement in its own subtransaction; returns 'OK' or the error.
CREATE FUNCTION pg_temp.try(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END;
$$;

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

-- Inserts a C5 session; patient_local_date is computed from started_at+tz
-- unless p_local overrides it (to prove the guard rejects a mismatch).
CREATE FUNCTION pg_temp.ins_session(
  p_id UUID, p_user UUID, p_version UUID, p_workout UUID, p_started TIMESTAMPTZ,
  p_tz TEXT DEFAULT 'America/New_York', p_choice TEXT DEFAULT NULL, p_resolves UUID DEFAULT NULL,
  p_cal DATE DEFAULT NULL, p_status TEXT DEFAULT 'started', p_local DATE DEFAULT NULL
) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO rehab_sessions (
    id, user_id, prescription_instance_id, patient_local_date, status, training_status,
    started_at, prescription_snapshot, prescription_version_id, prescription_workout_id,
    patient_timezone, client_request_id, sequence_choice, resolves_stopped_session_id, calendar_scheduled_date
  ) VALUES (
    p_id, p_user, 'c5:' || p_id::text, COALESCE(p_local, (p_started AT TIME ZONE p_tz)::date), NULL, p_status,
    p_started, '{"workout": "fixture"}'::jsonb, p_version, p_workout,
    p_tz, gen_random_uuid(), p_choice, p_resolves, p_cal
  );
$$;

CREATE FUNCTION pg_temp.close_session(p_id UUID, p_status TEXT, p_at TIMESTAMPTZ) RETURNS VOID LANGUAGE sql AS $$
  UPDATE rehab_sessions SET training_status = p_status, training_closed_at = p_at WHERE id = p_id;
$$;

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_patient UUID;
  v_pp UUID;
  v_seq UUID;  v_w0 UUID; v_w1 UUID;
  v_cal UUID;  v_cw0 UUID;
  v_one UUID;  v_ow0 UUID;
  v_s1 UUID := gen_random_uuid(); v_s2 UUID := gen_random_uuid(); v_s3 UUID := gen_random_uuid();
  v_s4 UUID := gen_random_uuid(); v_s5 UUID := gen_random_uuid(); v_s6 UUID := gen_random_uuid();
  v_s7 UUID := gen_random_uuid(); v_s8 UUID := gen_random_uuid(); v_s9 UUID := gen_random_uuid();
  v_s10 UUID := gen_random_uuid();
  v_legacy UUID := gen_random_uuid();
  v_r TEXT;
  v_t TEXT;
  v_n INT;
  v_pass INT; v_fail INT;
BEGIN
  -- ---- setup ----
  SELECT u.id INTO v_patient FROM auth.users u
  WHERE u.id NOT IN (v_clinician, '53eaa2d2-b526-4d01-aa5b-033bff88dd46')
    AND coalesce(u.email, '') NOT LIKE '%@example.invalid'
    AND NOT EXISTS (SELECT 1 FROM patient_prescriptions pp WHERE pp.patient_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM prescription_versions pv WHERE pv.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.user_id = u.id)
  ORDER BY u.created_at, u.id LIMIT 1;
  IF v_patient IS NULL THEN RAISE EXCEPTION 'C5.6B verify setup: need an auth.users row with no prescription/session state'; END IF;

  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;

  -- Versions with NO stage / irritability / insertional status (C5.6A: contextual, optional).
  v_r := pg_temp.try(format(
    'INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week) VALUES (%L, %L, %L, 1, now(), %L, %L, 3)',
    v_patient, 'clinician_change', v_pp, v_clinician, 'sequence'));
  PERFORM pg_temp.chk('C5 version without stage/irritability/insertional status is accepted', v_r = 'OK', v_r);

  SELECT id INTO v_seq FROM prescription_versions WHERE patient_prescription_id = v_pp AND version_number = 1;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode)
    VALUES (v_patient, 'clinician_change', v_pp, 2, now(), v_clinician, 'calendar') RETURNING id INTO v_cal;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_patient, 'clinician_change', v_pp, 3, now(), v_clinician, 'sequence', 2) RETURNING id INTO v_one;

  INSERT INTO prescription_workouts (prescription_version_id, order_index) VALUES (v_seq, 0) RETURNING id INTO v_w0;
  INSERT INTO prescription_workouts (prescription_version_id, order_index) VALUES (v_seq, 1) RETURNING id INTO v_w1;
  INSERT INTO prescription_workouts (prescription_version_id, order_index, days_of_week) VALUES (v_cal, 0, ARRAY[1,3,5]::SMALLINT[]) RETURNING id INTO v_cw0;
  INSERT INTO prescription_workouts (prescription_version_id, order_index) VALUES (v_one, 0) RETURNING id INTO v_ow0;

  -- ================= LIFECYCLE STATES =================
  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s1, v_patient, v_seq, v_w0, '2026-01-05 08:00 America/New_York'));
  PERFORM pg_temp.chk('valid STARTED C5 session accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.close_session(%L, %L, %L)', v_s1, 'finished', '2026-01-05 09:00 America/New_York'));
  PERFORM pg_temp.chk('STARTED -> FINISHED accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s2, v_patient, v_seq, v_w1, '2026-01-05 18:00 America/New_York'));
  PERFORM pg_temp.chk('second independent C5 session on the same patient-local date rejected',
    v_r LIKE '23505%rehab_sessions_c5_one_per_local_date%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s2, v_patient, v_seq, v_w1, '2026-01-06 08:00 America/New_York'));
  PERFORM pg_temp.chk('next-day session accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w0, '2026-01-07 08:00 America/New_York'));
  PERFORM pg_temp.chk('second simultaneous STARTED C5 session rejected',
    v_r LIKE '23505%rehab_sessions_c5_one_started_per_patient%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.close_session(%L, %L, %L)', v_s2, 'stopped_early', '2026-01-06 08:30 America/New_York'));
  PERFORM pg_temp.chk('STARTED -> STOPPED_EARLY accepted', v_r = 'OK', v_r);

  -- ================= SEQUENCE RESOLUTION =================
  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w0, '2026-01-07 08:00 America/New_York', 'America/New_York', 'repeat_previous', v_s2));
  PERFORM pg_temp.chk('repeat_previous naming a different workout than the Stopped one rejected', v_r LIKE '%C5_REPEAT_PREVIOUS_WORKOUT_MISMATCH%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w1, '2026-01-07 08:00 America/New_York', 'America/New_York', 'advance_next', v_s2));
  PERFORM pg_temp.chk('advance_next naming the same workout rejected', v_r LIKE '%C5_ADVANCE_NEXT_WORKOUT_MISMATCH%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w1, '2026-01-07 08:00 America/New_York', 'America/New_York', 'single_workout_auto', v_s2));
  PERFORM pg_temp.chk('single_workout_auto on a multi-workout version rejected', v_r LIKE '%C5_SINGLE_WORKOUT_AUTO_REQUIRES_ONE_WORKOUT%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w1, '2026-01-07 08:00 America/New_York', 'America/New_York', 'repeat_previous', v_s1));
  PERFORM pg_temp.chk('resolving a FINISHED (not Stopped) session rejected', v_r LIKE '%C5_INVALID_STOPPED_SESSION_RESOLUTION%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w1, '2026-01-07 08:00 America/New_York', 'America/New_York', 'repeat_previous'));
  -- The BEFORE guard trigger fires ahead of the CHECK; either rejection proves the invariant.
  PERFORM pg_temp.chk('sequence_choice without resolves_stopped_session_id rejected', v_r LIKE '23514%rehab_sessions_sequence_choice_resolves_together%' OR v_r LIKE '%C5_INVALID_STOPPED_SESSION_RESOLUTION%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s3, v_patient, v_seq, v_w1, '2026-01-07 08:00 America/New_York', 'America/New_York', 'repeat_previous', v_s2));
  PERFORM pg_temp.chk('repeat_previous resolving the Stopped session accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.close_session(%L, %L, %L)', v_s3, 'stopped_pause', '2026-01-07 08:20 America/New_York'));
  PERFORM pg_temp.chk('STARTED -> STOPPED_PAUSE accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s4, v_patient, v_seq, v_w0, '2026-01-08 08:00 America/New_York', 'America/New_York', 'advance_next', v_s2));
  PERFORM pg_temp.chk('a Stopped session can be resolved only once', v_r LIKE '23505%rehab_sessions_resolves_stopped_session_unique%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s4, v_patient, v_seq, v_w0, '2026-01-08 08:00 America/New_York', 'America/New_York', 'advance_next', v_s3));
  PERFORM pg_temp.chk('advance_next (wrap-around to workout 0) resolving the Stopped session accepted', v_r = 'OK', v_r);

  -- Midnight: started 23:30, closed 00:30 next day — local date stays the START date.
  v_r := pg_temp.try(format('SELECT pg_temp.close_session(%L, %L, %L)', v_s4, 'stopped_acute', '2026-01-09 00:30 America/New_York'));
  PERFORM pg_temp.chk('STARTED -> STOPPED_ACUTE accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s5, v_patient, v_seq, v_w1, '2026-01-09 23:30 America/New_York'));
  PERFORM pg_temp.chk('late-evening Start accepted', v_r = 'OK', v_r);
  v_r := pg_temp.try(format('SELECT pg_temp.close_session(%L, %L, %L)', v_s5, 'finished', '2026-01-10 00:30 America/New_York'));
  PERFORM pg_temp.chk('session Started before midnight closes after midnight as the same session', v_r = 'OK'
    AND (SELECT patient_local_date FROM rehab_sessions WHERE id = v_s5) = DATE '2026-01-09', v_r);

  -- Single-workout version.
  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s6, v_patient, v_one, v_ow0, '2026-01-11 08:00 America/New_York'));
  v_r := v_r || '|' || pg_temp.try(format('SELECT pg_temp.close_session(%L, %L, %L)', v_s6, 'stopped_early', '2026-01-11 08:10 America/New_York'));
  v_r := v_r || '|' || pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s7, v_patient, v_one, v_ow0, '2026-01-12 08:00 America/New_York', 'America/New_York', 'repeat_previous', v_s6));
  PERFORM pg_temp.chk('single-workout version must use single_workout_auto', v_r LIKE 'OK|OK|%C5_SINGLE_WORKOUT_MUST_USE_AUTO%', v_r);
  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, %L, %L)', v_s7, v_patient, v_one, v_ow0, '2026-01-12 08:00 America/New_York', 'America/New_York', 'single_workout_auto', v_s6));
  PERFORM pg_temp.chk('single_workout_auto resolution accepted', v_r = 'OK', v_r);
  PERFORM pg_temp.close_session(v_s7, 'finished', '2026-01-12 09:00 America/New_York');

  -- ================= C5 SESSION INVARIANTS =================
  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, p_status => %L)', v_s8, v_patient, v_seq, v_w0, '2026-02-01 08:00 America/New_York', 'finished'));
  PERFORM pg_temp.chk('C5 session cannot be born terminal (must Start STARTED)', v_r LIKE '%C5_SESSION_MUST_START_STARTED%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, p_local => %L)', v_s8, v_patient, v_seq, v_w0, '2026-02-01 23:30 America/New_York', '2026-02-02'));
  PERFORM pg_temp.chk('patient_local_date not matching started_at in patient_timezone rejected', v_r LIKE '%C5_LOCAL_DATE_MISMATCH%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, %L, p_local => %L)', v_s8, v_patient, v_seq, v_w0, '2026-02-01 08:00 UTC', 'Not/A_Zone', '2026-02-01'));
  PERFORM pg_temp.chk('invalid patient_timezone rejected', v_r LIKE '%C5_INVALID_PATIENT_TIMEZONE%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s8, v_patient, v_seq, v_cw0, '2026-02-01 08:00 America/New_York'));
  PERFORM pg_temp.chk('workout belonging to another version rejected (composite FK)', v_r LIKE '23503%rehab_sessions_workout_of_version_fkey%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L)', v_s8, v_patient, v_cal, v_cw0, '2026-02-02 08:00 America/New_York'));
  PERFORM pg_temp.chk('Calendar-mode session without calendar_scheduled_date rejected', v_r LIKE '%C5_CALENDAR_DATE_MODE_MISMATCH%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, p_cal => %L)', v_s8, v_patient, v_cal, v_cw0, '2026-02-02 08:00 America/New_York', '2026-02-03'));
  PERFORM pg_temp.chk('calendar_scheduled_date after the Start date rejected', v_r LIKE '23514%rehab_sessions_calendar_date_not_future%', v_r);

  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, p_cal => %L)', v_s8, v_patient, v_seq, v_w0, '2026-02-02 08:00 America/New_York', '2026-02-02'));
  PERFORM pg_temp.chk('calendar_scheduled_date on a Sequence-mode session rejected', v_r LIKE '%C5_CALENDAR_DATE_MODE_MISMATCH%', v_r);

  -- Make-up: Monday 2026-02-02 scheduled, made up Tuesday.
  v_r := pg_temp.try(format('SELECT pg_temp.ins_session(%L, %L, %L, %L, %L, p_cal => %L)', v_s8, v_patient, v_cal, v_cw0, '2026-02-03 08:00 America/New_York', '2026-02-02'));
  PERFORM pg_temp.chk('Calendar make-up session (scheduled date earlier than Start date) accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET training_status = %L WHERE id = %L', 'finished', v_s8));
  PERFORM pg_temp.chk('closing without training_closed_at rejected', v_r LIKE '23514%rehab_sessions_c5_closure_consistent%', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET prescription_snapshot = %L WHERE id = %L', '{"tampered": true}', v_s8));
  PERFORM pg_temp.chk('STARTED session identity/snapshot is immutable', v_r LIKE '%C5_SESSION_IDENTITY_IMMUTABLE%', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET training_status = %L, training_closed_at = NULL WHERE id = %L', 'started', v_s1));
  PERFORM pg_temp.chk('terminal session cannot be reopened', v_r LIKE '%C5_SESSION_TERMINAL_IMMUTABLE%', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET prescription_snapshot = %L WHERE id = %L', '{"tampered": true}', v_s1));
  PERFORM pg_temp.chk('terminal session snapshot is immutable', v_r LIKE '%C5_SESSION_TERMINAL_IMMUTABLE%', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET current_escalation_level = 0 WHERE id = %L', v_s1));
  PERFORM pg_temp.chk('server-derived escalation mirror still updatable on a terminal session', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET difficulty = %L WHERE id = %L', 'easy', v_s8));
  PERFORM pg_temp.chk('legacy Difficulty cannot be recorded on a C5 session', v_r LIKE '%C5_SESSION_IDENTITY_IMMUTABLE%' OR v_r LIKE '23514%rehab_sessions_c5_no_legacy_response_columns%', v_r);

  -- ================= LEGACY COMPATIBILITY =================
  v_r := pg_temp.try(format(
    'INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, prescription_snapshot) VALUES (%L, %L, %L, %L, %L)',
    v_legacy, v_patient, 'legacy:' || v_legacy::text, '2026-01-05', '[]'));
  PERFORM pg_temp.chk('legacy-shaped session (no training_status) still accepted, defaults status=in_progress',
    v_r = 'OK' AND (SELECT status FROM rehab_sessions WHERE id = v_legacy) = 'in_progress', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET status = %L, exercise_outcome = %L, difficulty = %L, exercises_ended_at = now() WHERE id = %L', 'exercises_complete', 'completed', 'moderate', v_legacy));
  PERFORM pg_temp.chk('legacy session lifecycle/response update unchanged', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET training_status = %L, status = NULL WHERE id = %L', 'started', v_legacy));
  PERFORM pg_temp.chk('legacy row cannot be converted into a C5 row', v_r LIKE '%C5_LEGACY_ROW_CANNOT_BECOME_C5%' OR v_r LIKE '23514%', v_r);

  v_r := pg_temp.try(format('UPDATE rehab_sessions SET calendar_scheduled_date = %L WHERE id = %L', '2026-01-05', v_legacy));
  PERFORM pg_temp.chk('C5-only columns rejected on legacy rows', v_r LIKE '23514%rehab_sessions_c5_columns_only_on_c5_rows%', v_r);

  -- ================= PERFORMANCE UNITS (set_outcomes) =================
  PERFORM pg_temp.close_session(v_s8, 'finished', '2026-02-03 09:00 America/New_York');
  PERFORM pg_temp.ins_session(v_s9, v_patient, v_seq, v_w1, '2026-03-01 08:00 America/New_York');

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, actual_load, actual_load_unit, occurred_at) VALUES (%L, %L, 0, 0, %L, 8, 20, %L, now())', v_s9, 'ex-a', 'completed', 'kg'));
  PERFORM pg_temp.chk('first confirmed set (reps + load + unit) accepted on a STARTED session', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_duration_seconds, occurred_at) VALUES (%L, %L, 1, 0, %L, 30, now())', v_s9, 'ex-hold', 'completed'));
  PERFORM pg_temp.chk('duration-only performance unit (hold/bout) accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_distance_m, occurred_at) VALUES (%L, %L, 2, 0, %L, 400, now())', v_s9, 'ex-walk', 'completed'));
  PERFORM pg_temp.chk('distance-only performance unit accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, occurred_at) VALUES (%L, %L, 3, 0, %L, now())', v_s9, 'ex-skip', 'skipped'));
  PERFORM pg_temp.chk('explicit skip row accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at) VALUES (%L, %L, 3, 1, %L, 5, now())', v_s9, 'ex-skip', 'skipped'));
  PERFORM pg_temp.chk('skipped row carrying an actual value rejected', v_r LIKE '23514%set_outcomes_skipped_has_no_actuals%', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, occurred_at) VALUES (%L, %L, 4, 0, %L, now())', v_s9, 'ex-b', 'completed'));
  PERFORM pg_temp.chk('completed C5 unit with no primary quantity rejected', v_r LIKE '%C5_PERFORMANCE_REQUIRES_PRIMARY_QUANTITY%', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, actual_load, occurred_at) VALUES (%L, %L, 4, 0, %L, 8, 20, now())', v_s9, 'ex-b', 'completed'));
  PERFORM pg_temp.chk('C5 load without load unit rejected', v_r LIKE '%C5_PERFORMANCE_LOAD_REQUIRES_UNIT%', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at) VALUES (%L, %L, 4, 0, %L, -1, now())', v_s9, 'ex-b', 'completed'));
  PERFORM pg_temp.chk('negative actual reps rejected', v_r LIKE '23514%set_outcomes_actual_reps_nonnegative%', v_r);

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at) VALUES (%L, %L, 0, 0, %L, 8, now())', v_s9, 'ex-a', 'completed'));
  PERFORM pg_temp.chk('duplicate performance unit (session, exercise, index) rejected', v_r LIKE '23505%set_outcomes_unique_set%', v_r);

  -- ================= IMMEDIATE RESPONSE =================
  v_r := pg_temp.try(format('INSERT INTO session_immediate_responses (rehab_session_id, user_id) VALUES (%L, %L)', v_s9, v_patient));
  PERFORM pg_temp.chk('immediate response cannot exist while the session is STARTED', v_r LIKE '%C5_RESPONSE_REQUIRES_CLOSED_C5_SESSION%', v_r);

  PERFORM pg_temp.close_session(v_s9, 'finished', '2026-03-01 09:00 America/New_York');

  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at) VALUES (%L, %L, 5, 0, %L, 8, now())', v_s9, 'ex-c', 'completed'));
  PERFORM pg_temp.chk('performance cannot be added to a terminal session', v_r LIKE '%C5_PERFORMANCE_SESSION_NOT_STARTED%', v_r);

  v_r := pg_temp.try(format('UPDATE set_outcomes SET actual_reps = 9 WHERE rehab_session_id = %L AND exercise_id = %L', v_s9, 'ex-a'));
  PERFORM pg_temp.chk('performance on a terminal session is immutable', v_r LIKE '%C5_PERFORMANCE_SESSION_NOT_STARTED%', v_r);

  v_r := pg_temp.try(format('INSERT INTO session_immediate_responses (rehab_session_id, user_id) VALUES (%L, %L)', v_legacy, v_patient));
  PERFORM pg_temp.chk('immediate response rejected for a legacy session', v_r LIKE '%C5_RESPONSE_REQUIRES_CLOSED_C5_SESSION%', v_r);

  v_r := pg_temp.try(format('INSERT INTO session_immediate_responses (rehab_session_id, user_id) VALUES (%L, %L)', v_s9, v_patient));
  PERFORM pg_temp.chk('outstanding immediate response created for a closed C5 session', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET overall_session_rpe = 11 WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('Session RPE 11 rejected', v_r LIKE '23514%', v_r);
  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET overall_session_rpe = -1 WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('Session RPE -1 rejected', v_r LIKE '23514%', v_r);
  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET peak_session_pain = 11 WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('peak pain 11 rejected', v_r LIKE '23514%', v_r);
  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET peak_session_pain = -1 WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('peak pain -1 rejected', v_r LIKE '23514%', v_r);
  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET overall_session_rpe = 6, rpe_unable_to_recall = true WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('RPE value + unable_to_recall together rejected', v_r LIKE '23514%session_immediate_responses_rpe_unknown_not_value%', v_r);
  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET peak_session_pain = 3, peak_pain_unable_to_recall = true WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('pain value + unable_to_recall together rejected', v_r LIKE '23514%session_immediate_responses_pain_unknown_not_value%', v_r);

  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET peak_pain_unable_to_recall = true, rpe_unable_to_recall = true, resolved_at = now() WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('unable_to_recall cannot resolve unanswered acute-safety questions', v_r LIKE '23514%session_immediate_responses_resolution_complete%', v_r);

  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET peak_session_pain = 2, overall_session_rpe = 6, sudden_or_sharp_pain = false, pop_felt_or_heard = NULL, new_functional_difficulty = false, resolved_at = now() WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('resolution with one safety answer missing rejected', v_r LIKE '23514%session_immediate_responses_resolution_complete%', v_r);

  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET peak_pain_unable_to_recall = true, overall_session_rpe = 6, sudden_or_sharp_pain = false, pop_felt_or_heard = false, new_functional_difficulty = false, resolved_at = now() WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('resolution with graded unable_to_recall + explicit safety answers accepted (pain stays NULL)',
    v_r = 'OK' AND (SELECT peak_session_pain IS NULL FROM session_immediate_responses WHERE rehab_session_id = v_s9), v_r);

  v_r := pg_temp.try(format('UPDATE session_immediate_responses SET overall_session_rpe = 7 WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('resolved immediate response is immutable', v_r LIKE '%C5_RESPONSE_RESOLVED_IMMUTABLE%', v_r);

  -- ================= MORNING RESPONSE =================
  v_r := pg_temp.try(format('INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date) VALUES (%L, %L, %L, %L)', v_s9, v_patient, '2026-03-02 04:00 America/New_York', '2026-03-02'));
  PERFORM pg_temp.chk('outstanding morning response created for a closed C5 session', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('UPDATE morning_responses SET submitted_at = now() WHERE rehab_session_id = %L', v_s9));
  PERFORM pg_temp.chk('C5 morning submission without a resolution rejected', v_r LIKE '%C5_MORNING_RESOLUTION_REQUIRED%', v_r);

  v_r := pg_temp.try(format('UPDATE morning_responses SET next_morning_pain = 3, resolution = %L, submitted_at = now() WHERE rehab_session_id = %L', 'unable_to_recall', v_s9));
  PERFORM pg_temp.chk('unable_to_recall with a symptom value rejected', v_r LIKE '23514%morning_responses_unable_to_recall_has_no_values%', v_r);

  v_r := pg_temp.try(format('UPDATE morning_responses SET next_morning_pain = 3, resolution = %L, submitted_at = now() WHERE rehab_session_id = %L', 'answered', v_s9));
  PERFORM pg_temp.chk('answered without stiffness rejected', v_r LIKE '23514%morning_responses_answered_has_values%', v_r);

  v_r := pg_temp.try(format('UPDATE morning_responses SET resolution = %L WHERE rehab_session_id = %L', 'unable_to_recall', v_s9));
  PERFORM pg_temp.chk('resolution without submitted_at rejected', v_r LIKE '23514%morning_responses_resolution_requires_submitted%', v_r);

  v_r := pg_temp.try(format('UPDATE morning_responses SET resolution = %L, patient_note = %L, submitted_at = now() WHERE rehab_session_id = %L', 'unable_to_recall', 'not sure', v_s9));
  PERFORM pg_temp.chk('unable_to_recall morning response accepted with NULL symptoms (optional note kept)',
    v_r = 'OK' AND (SELECT next_morning_pain IS NULL AND next_morning_stiffness IS NULL FROM morning_responses WHERE rehab_session_id = v_s9), v_r);

  v_r := pg_temp.try(format('UPDATE morning_responses SET patient_note = %L WHERE rehab_session_id = %L', 'changed', v_s9));
  PERFORM pg_temp.chk('submitted C5 morning response is immutable', v_r LIKE '%C5_RESPONSE_RESOLVED_IMMUTABLE%', v_r);

  v_r := pg_temp.try(format('INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, next_morning_pain, next_morning_stiffness, stiffness_duration, resolution, submitted_at) VALUES (%L, %L, %L, %L, 2, 1, %L, %L, now())', v_s1, v_patient, '2026-01-06 05:00 America/New_York', '2026-01-06', 'lt_5_min', 'answered'));
  PERFORM pg_temp.chk('answered morning response (pain, stiffness, duration) accepted', v_r = 'OK', v_r);

  v_r := pg_temp.try(format('INSERT INTO morning_responses (rehab_session_id, user_id, next_morning_pain, next_morning_stiffness, submitted_at) VALUES (%L, %L, 2, 0, now())', v_legacy, v_patient));
  PERFORM pg_temp.chk('legacy morning submission without resolution still accepted', v_r = 'OK', v_r);

  -- ================= RECOVERY / STAGE =================
  FOREACH v_n IN ARRAY ARRAY[0, 1, 2, 3, 7, 14] LOOP
    v_r := pg_temp.try(format('UPDATE prescription_versions SET recovery_days = %s WHERE id = %L', v_n, v_seq));
    PERFORM pg_temp.chk(format('recovery_days = %s accepted', v_n), v_r = 'OK', v_r);
  END LOOP;
  FOREACH v_n IN ARRAY ARRAY[-1, 15, 365] LOOP
    v_r := pg_temp.try(format('UPDATE prescription_versions SET recovery_days = %s WHERE id = %L', v_n, v_seq));
    PERFORM pg_temp.chk(format('recovery_days = %s rejected (sanity bound)', v_n), v_r LIKE '23514%recovery_days_range%', v_r);
  END LOOP;
  v_r := pg_temp.try(format('INSERT INTO prescription_templates (name, owner_clinician_id, visibility, recovery_days) VALUES (%L, %L, %L, 3)', 'C5.6B verify template', v_clinician, 'private'));
  PERFORM pg_temp.chk('template recovery_days > 2 accepted', v_r = 'OK', v_r);
  v_r := pg_temp.try(format('INSERT INTO prescription_templates (name, owner_clinician_id, visibility, recovery_days) VALUES (%L, %L, %L, 15)', 'C5.6B verify template 2', v_clinician, 'private'));
  PERFORM pg_temp.chk('template recovery_days 15 rejected', v_r LIKE '23514%recovery_days_range%', v_r);
  PERFORM pg_temp.chk('draft recovery_days is NOT NULL DEFAULT 0 with 0-14 CHECK',
    (SELECT column_default = '0' AND is_nullable = 'NO' FROM information_schema.columns WHERE table_name = 'prescription_drafts' AND column_name = 'recovery_days')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_drafts_recovery_days_range' AND pg_get_constraintdef(oid) LIKE '%0%14%'));
  PERFORM pg_temp.chk('existing versions not backfilled (recovery_days NULL = not authored)',
    NOT EXISTS (SELECT 1 FROM prescription_versions WHERE recovery_days IS NOT NULL AND id NOT IN (v_seq)));
  PERFORM pg_temp.chk('prescription_versions stage/irritability/is_insertional nullable',
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'prescription_versions' AND column_name IN ('stage', 'irritability', 'is_insertional') AND is_nullable = 'YES') = 3);
  PERFORM pg_temp.chk('no stage/irritability value was changed (historical rows keep values)',
    NOT EXISTS (SELECT 1 FROM prescription_versions WHERE (stage IS NULL OR irritability IS NULL) AND id NOT IN (v_seq, v_cal, v_one)));

  -- ================= SEQUENCE STATE: ONE AUTHORITY =================
  PERFORM pg_temp.chk('prescription_sequence_state dropped', to_regclass('public.prescription_sequence_state') IS NULL);
  PERFORM pg_temp.chk('no function references prescription_sequence_state',
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosrc ILIKE '%prescription_sequence_state%'));
  PERFORM pg_temp.chk('no other mutable sequence pointer/cache table exists',
    NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%sequence_state%' OR table_name ILIKE '%sequence_resolution%')));

  -- ================= NOTIFICATIONS =================
  v_r := pg_temp.try(format('INSERT INTO notifications (patient_id, type) VALUES (%L, %L)', v_patient, 'prescription_paused'));
  PERFORM pg_temp.chk('prescription_paused without patient_prescription_id rejected', v_r LIKE '23514%notifications_pause_ref_required%', v_r);
  v_r := pg_temp.try(format('INSERT INTO notifications (patient_id, type, patient_prescription_id) VALUES (%L, %L, %L), (%L, %L, %L)', v_patient, 'prescription_paused', v_pp, v_patient, 'prescription_resumed', v_pp));
  PERFORM pg_temp.chk('prescription_paused / prescription_resumed notifications accepted', v_r = 'OK', v_r);
  v_r := pg_temp.try(format('INSERT INTO notifications (patient_id, type) VALUES (%L, %L)', v_patient, 'prescription_updated'));
  PERFORM pg_temp.chk('prescription_updated still requires a version reference', v_r LIKE '23514%notifications_prescription_ref_required%', v_r);

  -- ================= PRIVILEGES =================
  PERFORM pg_temp.chk('authenticated cannot INSERT/UPDATE any new C5 rehab_sessions column',
    NOT has_column_privilege('authenticated', 'rehab_sessions', 'training_status', 'UPDATE')
    AND NOT has_column_privilege('authenticated', 'rehab_sessions', 'training_status', 'INSERT')
    AND NOT has_column_privilege('authenticated', 'rehab_sessions', 'training_closed_at', 'UPDATE')
    AND NOT has_column_privilege('authenticated', 'rehab_sessions', 'prescription_workout_id', 'INSERT')
    AND NOT has_column_privilege('authenticated', 'rehab_sessions', 'sequence_choice', 'INSERT')
    AND NOT has_column_privilege('authenticated', 'rehab_sessions', 'calendar_scheduled_date', 'INSERT'));
  PERFORM pg_temp.chk('authenticated cannot write new set_outcomes actual_* columns',
    NOT has_column_privilege('authenticated', 'set_outcomes', 'actual_load_unit', 'INSERT')
    AND NOT has_column_privilege('authenticated', 'set_outcomes', 'actual_duration_seconds', 'UPDATE')
    AND NOT has_column_privilege('authenticated', 'set_outcomes', 'actual_distance_m', 'INSERT'));
  -- M3.1 (migration 20261026000002): legacy patient write authority is
  -- retired — these column grants are now intentionally revoked.
  PERFORM pg_temp.chk('legacy set_outcomes column grants revoked (M3.1)',
    NOT has_column_privilege('authenticated', 'set_outcomes', 'actual_reps', 'INSERT')
    AND NOT has_column_privilege('authenticated', 'set_outcomes', 'actual_load', 'UPDATE')
    AND NOT has_column_privilege('authenticated', 'set_outcomes', 'was_edited', 'UPDATE'));
  PERFORM pg_temp.chk('legacy rehab_sessions column grants revoked (M3.1)',
    NOT has_column_privilege('authenticated', 'rehab_sessions', 'status', 'UPDATE')
    AND NOT has_column_privilege('authenticated', 'rehab_sessions', 'prescription_snapshot', 'INSERT'));
  PERFORM pg_temp.chk('authenticated cannot write morning_responses.resolution',
    NOT has_column_privilege('authenticated', 'morning_responses', 'resolution', 'UPDATE')
    AND NOT has_column_privilege('authenticated', 'morning_responses', 'resolution', 'INSERT'));
  PERFORM pg_temp.chk('session_immediate_responses: authenticated SELECT only; anon nothing',
    has_table_privilege('authenticated', 'session_immediate_responses', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'session_immediate_responses', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'session_immediate_responses', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'session_immediate_responses', 'DELETE')
    AND NOT has_table_privilege('anon', 'session_immediate_responses', 'SELECT'));
  PERFORM pg_temp.chk('clinical_classifications: authenticated SELECT only; anon nothing',
    has_table_privilege('authenticated', 'clinical_classifications', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'clinical_classifications', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'clinical_classifications', 'UPDATE')
    AND NOT has_table_privilege('anon', 'clinical_classifications', 'SELECT'));
  PERFORM pg_temp.chk('RLS enabled on new tables',
    (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('session_immediate_responses', 'clinical_classifications')));
  PERFORM pg_temp.chk('guard trigger functions not executable by API roles',
    NOT has_function_privilege('authenticated', 'trg_rehab_sessions_c5_guard()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'trg_set_outcomes_c5_guard()', 'EXECUTE'));

  -- ================= RLS AS THE PATIENT (PostgREST-equivalent) =================
  -- v_s8 is a terminal C5 session; v_legacy a legacy session; same patient.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_patient, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_patient::text, true);
  SET LOCAL ROLE authenticated;

  -- M3.1: refused by privilege now (was: matched 0 rows under RLS).
  v_t := pg_temp.try(format('UPDATE rehab_sessions SET status = %L WHERE id = %L', 'response_complete', v_s8));
  v_r := pg_temp.try(format('UPDATE rehab_sessions SET training_status = %L WHERE id = %L', 'finished', v_s2));
  RESET ROLE;
  PERFORM pg_temp.chk('patient direct UPDATE of a C5 session refused (42501, M3.1)', v_t LIKE '42501%', v_t);
  PERFORM pg_temp.chk('patient direct UPDATE of training_status denied (column grant)', v_r LIKE '42501%', v_r);

  -- A STARTED C5 session (the trigger would otherwise reject a terminal one first).
  PERFORM pg_temp.ins_session(v_s10, v_patient, v_seq, v_w0, '2026-04-02 08:00 America/New_York');
  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at) VALUES (%L, %L, 9, 0, %L, 8, now())', v_s10, 'ex-x', 'completed'));
  RESET ROLE;
  PERFORM pg_temp.chk('patient direct INSERT of performance into a STARTED C5 session denied (RLS)', v_r LIKE '42501%', v_r);
  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format('UPDATE rehab_sessions SET status = %L WHERE id = %L', 'response_complete', v_s10));
  v_t := pg_temp.try(format('UPDATE rehab_sessions SET updated_at = now() WHERE id = %L', v_s10));
  RESET ROLE;
  PERFORM pg_temp.chk('patient direct UPDATE of a STARTED C5 session refused (42501, M3.1)', v_r LIKE '42501%' AND v_t LIKE '42501%', v_r || '/' || v_t);

  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format('INSERT INTO session_immediate_responses (rehab_session_id, user_id) VALUES (%L, %L)', v_s8, v_patient));
  RESET ROLE;
  PERFORM pg_temp.chk('patient direct INSERT into session_immediate_responses denied', v_r LIKE '42501%', v_r);

  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format('INSERT INTO morning_responses (rehab_session_id, user_id) VALUES (%L, %L)', v_s8, v_patient));
  RESET ROLE;
  -- Denied either by RLS (42501) or, since C5.6C, earlier by the BEFORE
  -- guard requiring the server-computed reference morning.
  PERFORM pg_temp.chk('patient direct INSERT of a morning response for a C5 session denied', v_r LIKE '42501%' OR v_r LIKE '%C5_MORNING_REFERENCE_REQUIRED%', v_r);

  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format('INSERT INTO session_events (rehab_session_id, type, occurred_at) VALUES (%L, %L, now())', v_s8, 'other'));
  RESET ROLE;
  PERFORM pg_temp.chk('patient direct INSERT of a session event for a C5 session denied (RLS)', v_r LIKE '42501%', v_r);

  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format(
    'INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, prescription_snapshot) VALUES (%L, %L, %L, %L, %L)',
    gen_random_uuid(), v_patient, 'legacy:' || gen_random_uuid()::text, '2026-04-01', '[]'));
  v_t := pg_temp.try(format('UPDATE rehab_sessions SET status = %L WHERE id = %L', 'response_complete', v_legacy));
  RESET ROLE;
  -- M3.1: legacy patient write authority retired (was: "still works").
  PERFORM pg_temp.chk('legacy patient direct INSERT of a legacy session refused (42501, M3.1)', v_r LIKE '42501%', v_r);
  PERFORM pg_temp.chk('legacy patient direct UPDATE of a legacy session refused (42501, M3.1)', v_t LIKE '42501%', v_t);

  SET LOCAL ROLE authenticated;
  v_r := pg_temp.try(format('INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, actual_load, occurred_at) VALUES (%L, %L, 0, 0, %L, 8, 20, now())', v_legacy, 'ex-l', 'completed'));
  SELECT count(*) INTO v_n FROM session_immediate_responses WHERE rehab_session_id = v_s9;
  RESET ROLE;
  PERFORM pg_temp.chk('legacy patient direct INSERT of set_outcomes refused (42501, M3.1)', v_r LIKE '42501%', v_r);
  PERFORM pg_temp.chk('patient can read own immediate response', v_n = 1, v_n::text);

  -- ================= RESULT =================
  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%')
    INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES (format('=== C5.6B SCHEMA VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
