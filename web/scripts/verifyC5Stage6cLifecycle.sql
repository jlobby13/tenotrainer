-- C5.6C lifecycle RPC verification. Runs entirely inside one transaction
-- ROLLBACK'd at the end — nothing persists in the shared project. Uses one
-- real, pre-existing auth.users id with no prescription/session state purely
-- to satisfy FKs (same convention as verifyC5Stage3DraftPublishEngine.sql).
-- now() is fixed for the whole transaction, so "yesterday" facts are
-- written as backdated fixtures; real concurrency is covered separately by
-- verifyC5Stage6cLifecycleRaces.mjs.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage6cLifecycle.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

CREATE FUNCTION pg_temp.try(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END;
$$;

-- Runs a JSONB-returning statement; an exception becomes {"error": ...}.
CREATE FUNCTION pg_temp.j(p_sql TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r JSONB;
BEGIN
  EXECUTE p_sql INTO r;
  RETURN r;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

CREATE FUNCTION pg_temp.perf(p_ex UUID, p_idx INT, p_reps NUMERIC) RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('exercise_id', p_ex::text, 'unit_index', p_idx, 'outcome', 'completed', 'actual_reps', p_reps);
$$;

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_tz TEXT := 'America/New_York';
  v_patient UUID;
  v_pp UUID;
  v_ce UUID;
  v_v1 UUID; v_w0 UUID; v_w1 UUID; v_e0 UUID; v_e1 UUID;
  v_v2 UUID;
  v_v3 UUID; v_ca UUID; v_cb UUID; v_cc UUID; v_cea UUID;
  v_s0 UUID := gen_random_uuid();
  v_s_old UUID := gen_random_uuid();
  v_sess UUID;
  v_req UUID := gen_random_uuid();
  v_draft UUID;
  v_rev BIGINT;
  v_r JSONB;
  v_t TEXT;
  v_n INT;
  v_today DATE;
  v_due TIMESTAMPTZ;
  v_snap JSONB;
  v_pass INT; v_fail INT;
BEGIN
  -- ---------------- setup ----------------
  -- M2: throwaway in-transaction user(s) (rolled back). An assignment's patient
  -- must never be a staff account, and an assignment's clinician must hold a
  -- clinician role in its organization; the shared project has no spare real
  -- non-staff account to borrow.
  v_patient := gen_random_uuid();
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_patient, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-' || v_patient || '@example.invalid', '', now(), now(), now(), '{}', '{}');
  IF v_patient IS NULL THEN RAISE EXCEPTION 'C5.6C verify setup: need an auth.users row with a profile and no prescription/session state'; END IF;

  UPDATE profiles SET timezone = v_tz, morning_reminder_time = '05:00' WHERE id = v_patient;
  v_today := (now() AT TIME ZONE v_tz)::date;
  -- M2: an assignment requires the clinician's clinician-role membership in its organization.
  INSERT INTO organization_members (organization_id, user_id, role) VALUES ('07f342fd-075c-42b5-a885-30ca64953d46', v_clinician, 'clinician') ON CONFLICT (organization_id, user_id) DO NOTHING;
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('C5.6C verify exercise', 'global', true) RETURNING id INTO v_ce;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;

  -- V1: Sequence, two workouts, one 4 x 8 repetition exercise each, no stage/irritability.
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_patient, 'clinician_change', v_pp, 1, now() - interval '30 days', v_clinician, 'sequence', 3) RETURNING id INTO v_v1;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v1, 'A', 0) RETURNING id INTO v_w0;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v1, 'B', 1) RETURNING id INTO v_w1;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w0, v_ce, 0, 'active') RETURNING id INTO v_e0;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w1, v_ce, 0, 'active') RETURNING id INTO v_e1;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
    VALUES (v_e0, 'repetition', 4, 'exact', 8, 'not_applicable'), (v_e1, 'repetition', 4, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v1 WHERE id = v_pp;

  -- ================= SHARED STRUCTURAL HELPER =================
  PERFORM pg_temp.chk('c5_next_workout_id: A -> B', c5_next_workout_id(v_v1, v_w0) = v_w1);
  PERFORM pg_temp.chk('c5_next_workout_id: B -> A (wrap-around)', c5_next_workout_id(v_v1, v_w1) = v_w0);
  PERFORM pg_temp.chk('c5_next_workout_id: workout of another version -> NULL', c5_next_workout_id(v_v1, gen_random_uuid()) IS NULL);
  PERFORM pg_temp.chk('guard trigger uses the shared helper (no inline order arithmetic)',
    (SELECT prosrc LIKE '%c5_next_workout_id%' AND prosrc NOT LIKE '%order_index%' FROM pg_proc WHERE proname = 'trg_rehab_sessions_c5_guard'));
  PERFORM pg_temp.chk('Sequence derivation uses the shared helper',
    (SELECT prosrc LIKE '%c5_next_workout_id%' FROM pg_proc WHERE proname = 'c5_sequence_state'));
  PERFORM pg_temp.chk('shared helper is structural only (reads prescription_workouts only)',
    (SELECT prosrc NOT LIKE '%rehab_sessions%' AND prosrc NOT LIKE '%patient_prescriptions%' AND prosrc NOT LIKE '%acute%'
            AND prosrc NOT LIKE '%response%' AND prosrc NOT LIKE '%profiles%' FROM pg_proc WHERE proname = 'c5_next_workout_id'));

  -- ================= MORNING DUE RULE (founder-locked examples, 05:00) =================
  PERFORM pg_temp.chk('morning due: Mon 18:00-19:00 -> Tue 05:00',
    c5_morning_due_at('2026-01-05', '2026-01-05 19:00 America/New_York', v_tz, '05:00') = '2026-01-06 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('morning due: Mon 23:30-Tue 00:30 -> Tue 05:00',
    c5_morning_due_at('2026-01-05', '2026-01-06 00:30 America/New_York', v_tz, '05:00') = '2026-01-06 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('morning due: Mon 08:00-Tue 18:00 -> Wed 05:00 (never due while STARTED)',
    c5_morning_due_at('2026-01-05', '2026-01-06 18:00 America/New_York', v_tz, '05:00') = '2026-01-07 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('morning due: Mon 04:00-04:30 -> Tue 05:00',
    c5_morning_due_at('2026-01-05', '2026-01-05 04:30 America/New_York', v_tz, '05:00') = '2026-01-06 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('morning due is DST-correct (US spring-forward night -> 05:00 EDT = 09:00 UTC)',
    c5_morning_due_at('2026-03-07', '2026-03-07 21:00 America/New_York', v_tz, '05:00') = '2026-03-08 09:00+00'::timestamptz);

  -- ================= YESTERDAY: a Stopped session awaiting a Sequence choice =================
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_s0, v_patient, 'c5:' || v_s0::text, ((now() - interval '1 day') AT TIME ZONE v_tz)::date, NULL, 'started', now() - interval '1 day',
    c5_build_session_snapshot(v_v1, v_w0), v_v1, v_w0, v_tz, gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_s0, v_e0::text, 0, 0, 'completed', 8, now() - interval '1 day');
  UPDATE rehab_sessions SET training_status = 'stopped_early', training_closed_at = now() - interval '1 day' + interval '10 minutes' WHERE id = v_s0;
  INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe,
    sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
    VALUES (v_s0, v_patient, 2, 5, false, false, false, now());
  INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
    VALUES (v_s0, v_patient, now() - interval '2 hours', v_today, 'unable_to_recall', now());

  -- ================= START ELIGIBILITY =================
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('eligibility: eligible with an unresolved Sequence choice (repeat A / advance B)',
    v_r->>'result' = 'eligible' AND v_r->'sequence'->>'state' = 'pending_choice'
    AND v_r->'sequence'->>'repeat_workout_id' = v_w0::text AND v_r->'sequence'->>'advance_workout_id' = v_w1::text
    AND v_r->'sequence'->>'stopped_session_id' = v_s0::text, v_r::text);

  -- ================= FIRST-PERFORMANCE START: rejections =================
  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e1, 0, 8)));
  PERFORM pg_temp.chk('Start without a required Sequence choice -> sequence_choice_required', v_r->>'result' = 'sequence_choice_required', v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w0, pg_temp.perf(v_e0, 0, 8), '[]', 'advance_next'));
  PERFORM pg_temp.chk('advance_next naming workout A -> workout_not_eligible', v_r->>'result' = 'workout_not_eligible' AND v_r->>'eligible_workout_id' = v_w1::text, v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, gen_random_uuid(), v_w1, pg_temp.perf(v_e1, 0, 8), '[]', 'advance_next'));
  PERFORM pg_temp.chk('stale expected version -> version_changed', v_r->>'result' = 'version_changed', v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e1, 0, 0), '[]', 'advance_next'));
  PERFORM pg_temp.chk('first performance with 0 reps -> invalid_performance (primary_quantity_required)', v_r->>'detail' = 'primary_quantity_required', v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e1, 4, 8), '[]', 'advance_next'));
  PERFORM pg_temp.chk('unit index beyond prescribed sets -> unit_index_out_of_range', v_r->>'detail' = 'unit_index_out_of_range', v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1,
    jsonb_build_object('exercise_id', v_e1::text, 'unit_index', 0, 'outcome', 'skipped'), '[]', 'advance_next'));
  PERFORM pg_temp.chk('a skip alone cannot Start a session', v_r->>'detail' = 'first_performance_must_be_completed', v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e0, 0, 8), '[]', 'advance_next'));
  PERFORM pg_temp.chk('performance on an exercise outside the workout -> exercise_not_in_session', v_r->>'detail' = 'exercise_not_in_session', v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e1, 1, 8),
    jsonb_build_array(jsonb_build_object('exercise_id', v_e1::text, 'unit_index', 1)), 'advance_next'));
  PERFORM pg_temp.chk('pre-start skip conflicting with the performed unit rejected', v_r->>'detail' = 'skip_conflicts_with_performance', v_r::text);

  PERFORM pg_temp.chk('no session created by any rejected Start',
    NOT EXISTS (SELECT 1 FROM rehab_sessions WHERE user_id = v_patient AND patient_local_date = v_today));

  -- ================= FIRST-PERFORMANCE START: success =================
  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e1, 1, 8),
    jsonb_build_array(jsonb_build_object('exercise_id', v_e1::text, 'unit_index', 0)), 'advance_next'));
  v_sess := (v_r->>'session_id')::uuid;
  PERFORM pg_temp.chk('advance_next Start succeeds -> started', v_r->>'result' = 'started' AND v_sess IS NOT NULL, v_r::text);
  PERFORM pg_temp.chk('session records the Sequence resolution that actually Started it',
    (SELECT sequence_choice = 'advance_next' AND resolves_stopped_session_id = v_s0 AND prescription_workout_id = v_w1 AND training_status = 'started'
     FROM rehab_sessions WHERE id = v_sess));
  PERFORM pg_temp.chk('server-derived timezone and patient-local Start date',
    (SELECT patient_timezone = v_tz AND patient_local_date = v_today AND status IS NULL FROM rehab_sessions WHERE id = v_sess));
  PERFORM pg_temp.chk('snapshot built server-side from published content, without stage/irritability',
    (SELECT jsonb_array_length(prescription_snapshot->'exercises') = 1
            AND prescription_snapshot->'exercises'->0->>'exercise_id' = v_e1::text
            AND prescription_snapshot->'exercises'->0->'dosage'->>'sets' = '4'
            AND prescription_snapshot::text NOT LIKE '%irritab%' AND prescription_snapshot::text NOT LIKE '%"stage"%'
     FROM rehab_sessions WHERE id = v_sess));
  PERFORM pg_temp.chk('first performance + pre-start skip persisted atomically with the session',
    (SELECT count(*) FILTER (WHERE outcome = 'completed' AND set_index = 1 AND actual_reps = 8) = 1
            AND count(*) FILTER (WHERE outcome = 'skipped' AND set_index = 0) = 1 AND count(*) = 2
     FROM set_outcomes WHERE rehab_session_id = v_sess));

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L, %L, %L)', v_patient, v_req, v_v1, v_w1, pg_temp.perf(v_e1, 1, 8), '[]', 'advance_next'));
  PERFORM pg_temp.chk('retry of the same request is a replay (no second session)',
    v_r->>'result' = 'started' AND (v_r->>'replayed')::boolean AND v_r->>'session_id' = v_sess::text
    AND (SELECT count(*) FROM rehab_sessions WHERE user_id = v_patient AND patient_local_date = v_today) = 1, v_r::text);

  v_r := pg_temp.j(format('SELECT c5_record_first_performance(%L, %L, %L, %L, %L)', v_patient, gen_random_uuid(), v_v1, v_w0, pg_temp.perf(v_e0, 0, 8)));
  PERFORM pg_temp.chk('a different Start while one is STARTED -> resume_existing_session (same session)',
    v_r->>'result' = 'resume_existing_session' AND v_r->>'session_id' = v_sess::text, v_r::text);

  -- ================= SUBSEQUENT PERFORMANCE =================
  v_r := c5_record_performance(v_patient, v_sess, pg_temp.perf(v_e1, 2, 8));
  PERFORM pg_temp.chk('subsequent unit recorded', v_r->>'result' = 'recorded' AND NOT (v_r->>'replayed')::boolean, v_r::text);
  v_r := c5_record_performance(v_patient, v_sess, pg_temp.perf(v_e1, 2, 8));
  PERFORM pg_temp.chk('identical retry of a unit is a replay', v_r->>'result' = 'recorded' AND (v_r->>'replayed')::boolean, v_r::text);
  v_r := c5_record_performance(v_patient, v_sess, pg_temp.perf(v_e1, 2, 6));
  PERFORM pg_temp.chk('different value for a recorded unit refused (first write wins)', v_r->>'result' = 'performance_already_recorded', v_r::text);
  v_r := c5_record_performance(gen_random_uuid(), v_sess, pg_temp.perf(v_e1, 3, 8));
  PERFORM pg_temp.chk('another patient cannot write to the session', v_r->>'result' = 'session_not_found', v_r::text);

  v_r := c5_edit_performance(v_patient, v_sess, pg_temp.perf(v_e1, 2, 7));
  PERFORM pg_temp.chk('explicit edit path updates and marks was_edited',
    v_r->>'result' = 'edited' AND (SELECT actual_reps = 7 AND was_edited FROM set_outcomes WHERE rehab_session_id = v_sess AND set_index = 2), v_r::text);
  v_r := c5_edit_performance(v_patient, v_sess, jsonb_build_object('exercise_id', v_e1::text, 'unit_index', 1, 'outcome', 'skipped'));
  PERFORM pg_temp.chk('edit cannot turn a completed unit into a skip', v_r->>'detail' = 'completed_cannot_become_skipped', v_r::text);

  -- ================= PUBLISH WHILE STARTED (+ C5.4D debt) =================
  v_draft := create_prescription_draft(v_patient, v_clinician, 'clone_active', v_v1, NULL);
  UPDATE prescription_drafts SET recovery_days = 2 WHERE id = v_draft;
  v_rev := get_prescription_draft_revision(v_draft);
  PERFORM pg_temp.chk('draft metadata change bumps the content revision', v_rev >= 1, v_rev::text);
  UPDATE prescription_exercise_dosage SET reps_exact = 10
    WHERE prescription_exercise_id IN (SELECT pe.id FROM prescription_exercises pe JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
                                       WHERE pw.prescription_draft_id = v_draft AND pw.order_index = 0);
  PERFORM pg_temp.chk('draft content write bumps the content revision', get_prescription_draft_revision(v_draft) = v_rev + 1);
  PERFORM pg_temp.chk('validate_prescription_draft no longer has has_prior_clinical_state',
    NOT EXISTS (SELECT 1 FROM validate_prescription_draft(v_draft) WHERE rule = 'has_prior_clinical_state')
    AND NOT EXISTS (SELECT 1 FROM validate_prescription_draft(v_draft) WHERE NOT passed));
  v_t := pg_temp.try(format('SELECT publish_prescription_draft(%L, %L, %s)', v_draft, v_clinician, v_rev));
  PERFORM pg_temp.chk('publish with a stale reviewed revision refused inside the lock (DRAFT_CHANGED)', v_t LIKE '%DRAFT_CHANGED%', v_t);
  v_v2 := publish_prescription_draft(v_draft, v_clinician, v_rev + 1);
  PERFORM pg_temp.chk('publish with the current revision succeeds; current pointer moves; notification created',
    (SELECT current_prescription_version_id = v_v2 FROM patient_prescriptions WHERE id = v_pp)
    AND EXISTS (SELECT 1 FROM notifications WHERE prescription_version_id = v_v2 AND type = 'prescription_updated'));
  PERFORM pg_temp.chk('recovery_days copied draft -> version; stage/irritability absent is not a publish gate',
    (SELECT recovery_days = 2 AND stage IS NULL AND irritability IS NULL FROM prescription_versions WHERE id = v_v2));
  v_draft := create_prescription_draft(v_patient, v_clinician, 'clone_active', v_v2, NULL);
  PERFORM pg_temp.chk('clone copies recovery_days back into a draft', (SELECT recovery_days FROM prescription_drafts WHERE id = v_draft) = 2);
  UPDATE prescription_drafts SET status = 'discarded' WHERE patient_prescription_id = v_pp AND status = 'editing';

  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('STARTED old-version session survives publish (resume, still bound to V1)',
    v_r->>'result' = 'resume_existing_session' AND v_r->>'prescription_version_id' = v_v1::text
    AND (SELECT prescription_version_id = v_v1 AND prescription_snapshot->>'prescription_version_id' = v_v1::text FROM rehab_sessions WHERE id = v_sess), v_r::text);

  -- ================= PAUSE WHILE STARTED =================
  PERFORM pause_prescription(v_pp, v_clinician);
  PERFORM pg_temp.chk('pause does not terminate the STARTED session', (SELECT training_status FROM rehab_sessions WHERE id = v_sess) = 'started');
  PERFORM pg_temp.chk('pause creates the in-app notification and an open pause period',
    EXISTS (SELECT 1 FROM notifications WHERE patient_prescription_id = v_pp AND type = 'prescription_paused')
    AND EXISTS (SELECT 1 FROM prescription_pause_periods WHERE patient_prescription_id = v_pp AND resumed_at IS NULL));
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('while paused the existing session stays accessible (resume_existing_session)',
    v_r->>'result' = 'resume_existing_session' AND (v_r->>'prescription_paused')::boolean, v_r::text);
  v_r := c5_record_performance(v_patient, v_sess, pg_temp.perf(v_e1, 3, 8));
  PERFORM pg_temp.chk('performance can still be recorded while paused', v_r->>'result' = 'recorded', v_r::text);

  v_r := c5_stop_session(v_patient, v_sess);
  PERFORM pg_temp.chk('Stop while paused -> server-derived STOPPED_PAUSE', v_r->>'training_status' = 'stopped_pause' AND NOT (v_r->>'replayed')::boolean, v_r::text);
  v_r := c5_stop_session(v_patient, v_sess);
  PERFORM pg_temp.chk('repeated Stop is a replay', v_r->>'result' = 'closed' AND (v_r->>'replayed')::boolean, v_r::text);
  v_r := c5_finish_session(v_patient, v_sess);
  PERFORM pg_temp.chk('Finish after Stop -> session_already_closed', v_r->>'result' = 'session_already_closed', v_r::text);
  v_r := c5_record_performance(v_patient, v_sess, pg_temp.perf(v_e1, 0, 8));
  PERFORM pg_temp.chk('no performance after closure', v_r->>'result' = 'session_closed', v_r::text);

  SELECT c5_morning_due_at(patient_local_date, training_closed_at, patient_timezone, '05:00') INTO v_due FROM rehab_sessions WHERE id = v_sess;
  PERFORM pg_temp.chk('closure created exactly one outstanding immediate response (nothing fabricated)',
    (SELECT count(*) = 1 AND bool_and(resolved_at IS NULL AND peak_session_pain IS NULL AND overall_session_rpe IS NULL AND sudden_or_sharp_pain IS NULL)
     FROM session_immediate_responses WHERE rehab_session_id = v_sess));
  PERFORM pg_temp.chk('closure created exactly one morning obligation with the locked due rule and reference date',
    (SELECT count(*) = 1 AND bool_and(scheduled_eligible_at = v_due AND reference_local_date = (v_due AT TIME ZONE v_tz)::date
                                      AND submitted_at IS NULL AND next_morning_pain IS NULL)
     FROM morning_responses WHERE rehab_session_id = v_sess));
  PERFORM pg_temp.chk('no legacy Difficulty / response columns written', (SELECT difficulty IS NULL AND peak_session_pain IS NULL FROM rehab_sessions WHERE id = v_sess));

  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('paused with no STARTED session -> prescription_paused', v_r->>'result' = 'prescription_paused', v_r::text);

  PERFORM resume_prescription(v_pp, v_clinician);
  PERFORM pg_temp.chk('resume creates notification and closes the pause period',
    EXISTS (SELECT 1 FROM notifications WHERE patient_prescription_id = v_pp AND type = 'prescription_resumed')
    AND NOT EXISTS (SELECT 1 FROM prescription_pause_periods WHERE patient_prescription_id = v_pp AND resumed_at IS NULL));

  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('outstanding immediate response blocks the next Start', v_r->>'result' = 'immediate_response_required', v_r::text);

  UPDATE session_immediate_responses SET peak_session_pain = 0, rpe_unable_to_recall = true,
    sudden_or_sharp_pain = false, pop_felt_or_heard = true, new_functional_difficulty = false, resolved_at = now()
  WHERE rehab_session_id = v_sess;
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('resolved (score 0 + unable_to_recall) passes the response gate; not-yet-due morning does not block; same day -> already_trained_today',
    v_r->>'result' = 'already_trained_today', v_r::text);

  PERFORM pg_temp.chk('new version supersedes the unresolved old-version choice (V2 starts at its first workout)',
    c5_sequence_state(v_patient, v_v2)->>'state' = 'first'
    AND c5_sequence_state(v_patient, v_v2)->>'workout_id' = (SELECT id::text FROM prescription_workouts WHERE prescription_version_id = v_v2 AND order_index = 0));

  -- Morning gate (a due, unresolved morning response), via a backdated due instant.
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '1 minute' WHERE rehab_session_id = v_sess;
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('due unresolved morning response blocks the next Start', v_r->>'result' = 'morning_response_required', v_r::text);
  UPDATE morning_responses SET scheduled_eligible_at = v_due WHERE rehab_session_id = v_sess;

  -- ================= ACUTE SAFETY INTEGRATION =================
  -- A STARTED session exists BEFORE the brake activates (started 3 days ago,
  -- old version V1 — a direct fixture, since today's Start is already used).
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_s_old, v_patient, 'c5:' || v_s_old::text, ((now() - interval '3 days') AT TIME ZONE v_tz)::date, NULL, 'started', now() - interval '3 days',
    c5_build_session_snapshot(v_v1, v_w0), v_v1, v_w0, v_tz, gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_s_old, v_e0::text, 0, 0, 'completed', 8, now() - interval '3 days');
  SELECT prescription_snapshot INTO v_snap FROM rehab_sessions WHERE id = v_s_old;
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('acute: before the brake the open session is resume_existing_session', v_r->>'result' = 'resume_existing_session', v_r::text);

  -- The brake activates while the session is STARTED (level-5 escalation on today's closed session).
  INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot)
    VALUES (v_sess, 5, 'pop_reported', 'c56c-verify', '{}');
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('acute: unreconciled escalation + open session -> acute_resolution_required (fails closed, session still identified)',
    v_r->>'result' = 'acute_resolution_required' AND v_r->>'session_id' = v_s_old::text
    AND v_r->>'acute_gate' = 'acute_safety_reconciliation_required', v_r::text);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  v_t := pg_temp.try(format('SELECT reconcile_missing_acute_episodes(%L)', v_patient));
  PERFORM pg_temp.chk('reconcile still refuses another authenticated user', v_t LIKE '%UNAUTHENTICATED%', v_t);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  v_t := pg_temp.try(format('SELECT count(*) FROM reconcile_missing_acute_episodes(%L)', v_patient));
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.chk('trusted server reconciles; C5 safety facts read from the immediate response',
    v_t = 'OK' AND (SELECT initial_pop_felt_or_heard AND NOT initial_sudden_or_sharp_pain FROM acute_safety_episodes WHERE source_rehab_session_id = v_sess), v_t);

  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('acute: active brake + STARTED session stays discoverable as acute_resolution_required (not resume, not generic block)',
    v_r->>'result' = 'acute_resolution_required' AND v_r->>'session_id' = v_s_old::text
    AND v_r->>'prescription_version_id' = v_v1::text
    AND v_r->>'acute_gate' = 'acute_safety_professional_review_required' AND (v_r->>'brake_level')::int = 5
    AND v_r->>'acute_safety_episode_id' IS NOT NULL, v_r::text);
  SELECT count(*) INTO v_n FROM rehab_sessions WHERE user_id = v_patient;
  v_r := c5_record_first_performance(v_patient, gen_random_uuid(), v_v2, v_w0, pg_temp.perf(v_e0, 0, 8));
  PERFORM pg_temp.chk('acute: a new Start with an open session is refused, points at the open session, records no blocked opportunity',
    v_r->>'result' = 'acute_resolution_required' AND v_r->>'session_id' = v_s_old::text
    AND (SELECT count(*) FROM rehab_sessions WHERE user_id = v_patient AND training_status IS NOT NULL) = v_n
    AND NOT EXISTS (SELECT 1 FROM blocked_loading_opportunities WHERE user_id = v_patient), v_r::text);
  v_r := c5_record_performance(v_patient, v_s_old, pg_temp.perf(v_e0, 1, 8));
  PERFORM pg_temp.chk('acute brake blocks further performance', v_r->>'result' = 'acute_safety_professional_review_required', v_r::text);
  v_r := c5_edit_performance(v_patient, v_s_old, pg_temp.perf(v_e0, 0, 9));
  PERFORM pg_temp.chk('acute brake blocks editing performance too', v_r->>'result' = 'acute_safety_professional_review_required', v_r::text);
  v_r := c5_finish_session(v_patient, v_s_old);
  PERFORM pg_temp.chk('acute brake blocks ordinary Finish (session stays STARTED)',
    v_r->>'result' = 'acute_safety_professional_review_required'
    AND (SELECT training_status FROM rehab_sessions WHERE id = v_s_old) = 'started'
    AND NOT EXISTS (SELECT 1 FROM session_immediate_responses WHERE rehab_session_id = v_s_old), v_r::text);

  v_r := c5_stop_session(v_patient, v_s_old, '{"pop_felt_or_heard": true}');
  PERFORM pg_temp.chk('Stop under the acute pathway -> STOPPED_ACUTE', v_r->>'training_status' = 'stopped_acute' AND NOT (v_r->>'replayed')::boolean, v_r::text);
  PERFORM pg_temp.chk('acute stop pre-fills only the reported safety fact; graded values stay NULL',
    (SELECT pop_felt_or_heard AND sudden_or_sharp_pain IS NULL AND new_functional_difficulty IS NULL AND peak_session_pain IS NULL AND resolved_at IS NULL
     FROM session_immediate_responses WHERE rehab_session_id = v_s_old));
  PERFORM pg_temp.chk('acute stop preserves performed work, snapshot and version',
    (SELECT count(*) FROM set_outcomes WHERE rehab_session_id = v_s_old) = 1
    AND (SELECT actual_reps = 8 AND outcome = 'completed' AND NOT was_edited FROM set_outcomes WHERE rehab_session_id = v_s_old)
    AND (SELECT prescription_snapshot = v_snap AND prescription_version_id = v_v1 AND prescription_workout_id = v_w0 FROM rehab_sessions WHERE id = v_s_old));
  v_r := c5_stop_session(v_patient, v_s_old, '{"sudden_or_sharp_pain": true}');
  PERFORM pg_temp.chk('retrying acute Stop is an idempotent replay',
    v_r->>'result' = 'closed' AND v_r->>'training_status' = 'stopped_acute' AND (v_r->>'replayed')::boolean, v_r::text);
  v_r := c5_stop_session(v_patient, v_s_old);
  PERFORM pg_temp.chk('retrying Stop without a report is also a replay', (v_r->>'replayed')::boolean AND v_r->>'training_status' = 'stopped_acute', v_r::text);
  v_r := c5_finish_session(v_patient, v_s_old);
  PERFORM pg_temp.chk('Finish after acute Stop -> session_already_closed', v_r->>'result' = 'session_already_closed', v_r::text);
  PERFORM pg_temp.chk('acute stop: exactly one immediate + one morning obligation; replays changed nothing',
    (SELECT count(*) FROM session_immediate_responses WHERE rehab_session_id = v_s_old) = 1
    AND (SELECT count(*) FROM morning_responses WHERE rehab_session_id = v_s_old) = 1
    AND (SELECT sudden_or_sharp_pain IS NULL FROM session_immediate_responses WHERE rehab_session_id = v_s_old));

  -- No open session any more: the generic brake result, and a blocked Start is recorded.
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('active level-5 brake + no STARTED session blocks a new Start', v_r->>'result' = 'acute_safety_professional_review_required'
    AND v_r->>'session_id' IS NULL, v_r::text);
  v_r := c5_record_first_performance(v_patient, gen_random_uuid(), v_v2, v_w0, pg_temp.perf(v_e0, 0, 8));
  v_r := c5_record_first_performance(v_patient, gen_random_uuid(), v_v2, v_w0, pg_temp.perf(v_e0, 0, 8));
  PERFORM pg_temp.chk('blocked Start attempt recorded once per patient-local day',
    v_r->>'result' = 'acute_safety_professional_review_required'
    AND (SELECT count(*) FROM blocked_loading_opportunities WHERE user_id = v_patient AND prescription_instance_id = 'c5-day:' || v_today::text) = 1, v_r::text);
  PERFORM pg_temp.chk('acute brake never chose a workout (Sequence state unchanged)', c5_sequence_state(v_patient, v_v2)->>'state' = 'first');

  -- ================= CALENDAR OPPORTUNITIES (function-level, 2025 dates) =================
  -- V3: Calendar, Mon (A) / Wed (B) / Fri (C), published 2025-01-01. 2025-06-02 is a Monday.
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode)
    VALUES (v_patient, 'clinician_change', v_pp, 90, '2025-01-01 12:00+00', v_clinician, 'calendar') RETURNING id INTO v_v3;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index, days_of_week) VALUES (v_v3, 'A', 0, ARRAY[1]::SMALLINT[]) RETURNING id INTO v_ca;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index, days_of_week) VALUES (v_v3, 'B', 1, ARRAY[3]::SMALLINT[]) RETURNING id INTO v_cb;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index, days_of_week) VALUES (v_v3, 'C', 2, ARRAY[5]::SMALLINT[]) RETURNING id INTO v_cc;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_cb, v_ce, 0, 'active') RETURNING id INTO v_cea;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_cea, 'repetition', 3, 'exact', 8, 'not_applicable');

  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-04', v_tz);
  PERFORM pg_temp.chk('Calendar: scheduled day -> that day''s workout', v_r->>'state' = 'scheduled_today' AND v_r->>'workout_id' = v_cb::text, v_r::text);
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-05', v_tz);
  PERFORM pg_temp.chk('Calendar: missed Wed -> optional make-up on Thu', v_r->>'state' = 'make_up' AND v_r->>'workout_id' = v_cb::text AND v_r->>'calendar_scheduled_date' = '2025-06-04', v_r::text);
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-06', v_tz);
  PERFORM pg_temp.chk('Calendar: Fri scheduled workout takes precedence; Wed make-up expired', v_r->>'state' = 'scheduled_today' AND v_r->>'workout_id' = v_cc::text, v_r::text);

  -- Wed attempted and Stopped -> Thu make-up still offered; once Finished, not offered.
  v_sess := gen_random_uuid();
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id, calendar_scheduled_date)
  VALUES (v_sess, v_patient, 'c5:' || v_sess::text, '2025-06-04', NULL, 'started', '2025-06-04 08:00 America/New_York',
    c5_build_session_snapshot(v_v3, v_cb), v_v3, v_cb, v_tz, gen_random_uuid(), '2025-06-04');
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_sess, v_cea::text, 0, 0, 'completed', 8, '2025-06-04 08:05 America/New_York');
  UPDATE rehab_sessions SET training_status = 'stopped_early', training_closed_at = '2025-06-04 08:20 America/New_York' WHERE id = v_sess;
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-05', v_tz);
  PERFORM pg_temp.chk('Calendar: Stopped Wed -> Thu make-up still offered', v_r->>'state' = 'make_up', v_r::text);
  v_sess := gen_random_uuid();
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id, calendar_scheduled_date)
  VALUES (v_sess, v_patient, 'c5:' || v_sess::text, '2025-06-05', NULL, 'started', '2025-06-05 08:00 America/New_York',
    c5_build_session_snapshot(v_v3, v_cb), v_v3, v_cb, v_tz, gen_random_uuid(), '2025-06-04');
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_sess, v_cea::text, 0, 0, 'completed', 8, '2025-06-05 08:05 America/New_York');
  UPDATE rehab_sessions SET training_status = 'finished', training_closed_at = '2025-06-05 08:30 America/New_York' WHERE id = v_sess;
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-05', v_tz);
  PERFORM pg_temp.chk('Calendar: once the make-up is Finished it is no longer offered', v_r->>'state' = 'not_scheduled', v_r::text);
  PERFORM pg_temp.chk('Calendar: the schedule never shifts (Fri still C)',
    c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-06', v_tz)->>'workout_id' = v_cc::text);

  -- Pause overlapping Fri 2025-06-06 -> Sat is not a make-up for Fri.
  INSERT INTO prescription_pause_periods (patient_prescription_id, paused_at, resumed_at)
    VALUES (v_pp, '2025-06-05 22:00 America/New_York', '2025-06-06 12:00 America/New_York');
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-07', v_tz);
  PERFORM pg_temp.chk('Calendar: pause-overlapped scheduled day is never a later make-up', v_r->>'state' = 'not_scheduled', v_r::text);
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-03', v_tz);
  PERFORM pg_temp.chk('Calendar: non-paused missed Mon -> Tue make-up', v_r->>'state' = 'make_up' AND v_r->>'workout_id' = v_ca::text, v_r::text);
  UPDATE prescription_versions SET published_at = '2025-06-03 12:00+00' WHERE id = v_v3;
  v_r := c5_calendar_opportunity(v_patient, v_pp, v_v3, '2025-06-03', v_tz);
  PERFORM pg_temp.chk('Calendar: a new version voids an older scheduled day''s make-up', v_r->>'state' = 'not_scheduled', v_r::text);

  -- ================= AUTHORITY / GRANTS =================
  PERFORM pg_temp.chk('C5 lifecycle RPCs executable by service_role only',
    (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
                     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('c5_get_start_eligibility', 'c5_record_first_performance', 'c5_record_performance',
                                                  'c5_edit_performance', 'c5_finish_session', 'c5_stop_session')));
  PERFORM pg_temp.chk('C5 internal helpers not executable by API roles',
    (SELECT bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('c5_next_workout_id', 'c5_start_eligibility_internal', 'c5_sequence_state', 'c5_calendar_opportunity',
                                                  'c5_acute_gate', 'c5_lock_started_session', 'c5_close_session_internal', 'c5_create_response_obligations',
                                                  'c5_build_session_snapshot', 'c5_performance_error', 'c5_morning_due_at', 'bump_prescription_draft_revisions')));
  PERFORM pg_temp.chk('every C5 SECURITY DEFINER function pins search_path',
    (SELECT bool_and(p.proconfig IS NOT NULL AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%')
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef AND (p.proname LIKE 'c5\_%' OR p.proname IN ('publish_prescription_draft', 'pause_prescription', 'resume_prescription'))));
  PERFORM pg_temp.chk('legacy authenticated reconcile grant preserved',
    has_function_privilege('authenticated', 'reconcile_missing_acute_episodes(uuid)', 'EXECUTE'));
  PERFORM pg_temp.chk('no mutable Sequence pointer exists', to_regclass('public.prescription_sequence_state') IS NULL);

  -- ================= DEFERRED "NO SESSION WITHOUT PERFORMANCE" BACKSTOP =================
  -- Last, because SET CONSTRAINTS ... IMMEDIATE changes transaction state.
  v_sess := gen_random_uuid();
  v_t := pg_temp.try(format($q$
    DO $x$ BEGIN
      INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
        prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
      VALUES (%L, %L, %L, '2025-07-01', NULL, 'started', '2025-07-01 08:00 America/New_York', '{}', %L, %L, %L, gen_random_uuid());
      SET CONSTRAINTS trg_rehab_sessions_c5_has_performance IMMEDIATE;
    END $x$;$q$, v_sess, v_patient, 'c5:' || v_sess::text, v_v1, v_w0, v_tz));
  PERFORM pg_temp.chk('a C5 session with zero performed work cannot commit', v_t LIKE '%C5_SESSION_WITHOUT_PERFORMANCE%', v_t);

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%')
    INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES (format('=== C5.6C LIFECYCLE VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
