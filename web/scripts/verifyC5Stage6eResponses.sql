-- C5.6E response submission verification (c5_submit_immediate_response /
-- c5_submit_morning_response + the existing reconciliation and C5 gates).
-- One transaction, ROLLBACK'd at the end — nothing persists. Uses one real,
-- pre-existing auth.users id with no prescription/session state purely to
-- satisfy FKs (same convention as the C5.6C suite). now() is fixed for the
-- transaction, so earlier sessions are written as backdated fixtures and
-- "due" mornings are produced by backdating the frozen due instant.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage6eResponses.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

-- A C5 session that STARTED p_days_ago (patient-local) with one performed unit.
CREATE FUNCTION pg_temp.session(p_user UUID, p_version UUID, p_workout UUID, p_ex UUID, p_tz TEXT, p_days_ago INT) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_id, p_user, 'c5:' || v_id::text, ((now() - make_interval(days => p_days_ago)) AT TIME ZONE p_tz)::date, NULL, 'started',
    now() - make_interval(days => p_days_ago), c5_build_session_snapshot(p_version, p_workout), p_version, p_workout, p_tz, gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_id, p_ex::text, 0, 0, 'completed', 8, now() - make_interval(days => p_days_ago));
  RETURN v_id;
END;
$$;

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_tz TEXT := 'America/New_York';
  v_patient UUID;
  v_other UUID := gen_random_uuid();
  v_pp UUID; v_ce UUID; v_v UUID; v_w UUID; v_e UUID;
  s1 UUID; s2 UUID; s3 UUID; s4 UUID; s5 UUID;
  v_r JSONB;
  v_ok BOOLEAN;
  v_mr morning_responses;
  v_sir session_immediate_responses;
  v_combo RECORD;
  v_pass INT; v_fail INT;
BEGIN
  SELECT u.id INTO v_patient FROM auth.users u
  WHERE u.id NOT IN (v_clinician, '53eaa2d2-b526-4d01-aa5b-033bff88dd46')
    AND coalesce(u.email, '') NOT LIKE '%@example.invalid'
    AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id)
    AND NOT EXISTS (SELECT 1 FROM patient_prescriptions pp WHERE pp.patient_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM prescription_versions pv WHERE pv.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes e WHERE e.user_id = u.id)
  ORDER BY u.created_at, u.id LIMIT 1;
  IF v_patient IS NULL THEN RAISE EXCEPTION 'C5.6E verify setup: need an auth.users row with a profile and no prescription/session state'; END IF;

  UPDATE profiles SET timezone = v_tz, morning_reminder_time = '05:00' WHERE id = v_patient;
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('C5.6E verify exercise', 'global', true) RETURNING id INTO v_ce;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_patient, 'clinician_change', v_pp, 1, now() - interval '30 days', v_clinician, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, v_ce, 0, 'active') RETURNING id INTO v_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
    VALUES (v_e, 'repetition', 4, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;

  -- ================= grants / pure rule =================
  PERFORM pg_temp.chk('grants: submission RPCs are service_role only',
    has_function_privilege('service_role', 'c5_submit_immediate_response(uuid, uuid, jsonb)', 'EXECUTE')
    AND has_function_privilege('service_role', 'c5_submit_morning_response(uuid, uuid, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_submit_immediate_response(uuid, uuid, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_submit_morning_response(uuid, uuid, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'c5_submit_morning_response(uuid, uuid, jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_escalation_v1(boolean, boolean, boolean)', 'EXECUTE'));
  v_ok := true;
  FOR v_combo IN SELECT a, b, c FROM (VALUES (false), (true)) x(a), (VALUES (false), (true)) y(b), (VALUES (false), (true)) z(c) LOOP
    -- a = sudden/sharp pain, b = pop, c = new functional difficulty
    IF (SELECT o_level FROM c5_escalation_v1(v_combo.a, v_combo.b, v_combo.c))
       <> (CASE WHEN v_combo.b THEN 5 WHEN v_combo.a OR v_combo.c THEN 3 ELSE 0 END) THEN v_ok := false; END IF;
  END LOOP;
  PERFORM pg_temp.chk('escalation v1: pop -> 5, sudden pain / new difficulty -> 3, else 0 (all 8 combinations)', v_ok);
  -- Reasons pinned to the same table as lib/__tests__/c5EscalationParity.test.ts.
  PERFORM pg_temp.chk('escalation v1 reasons match the TypeScript rule',
    (SELECT o_reason FROM c5_escalation_v1(false, false, false)) = 'routine_loading_exposure'
    AND (SELECT o_reason FROM c5_escalation_v1(true, false, false)) = 'sudden_or_sharp_pain'
    AND (SELECT o_reason FROM c5_escalation_v1(false, false, true)) = 'new_functional_difficulty'
    AND (SELECT o_reason FROM c5_escalation_v1(true, false, true)) = 'sudden_or_sharp_pain_and_new_functional_difficulty'
    AND (SELECT o_reason FROM c5_escalation_v1(true, true, true)) = 'pop_felt_or_heard');
  PERFORM pg_temp.chk('escalation v1 takes no pain / RPE input (no threshold exists)',
    (SELECT pronargs FROM pg_proc WHERE proname = 'c5_escalation_v1') = 3
    AND (SELECT prosrc NOT ILIKE '%pain_score%' AND prosrc NOT ILIKE '%rpe%' FROM pg_proc WHERE proname = 'c5_escalation_v1'));

  -- ================= morning timing (locked rule, re-asserted for E) =================
  PERFORM pg_temp.chk('timing: Mon 18:00-19:00 -> Tue 05:00',
    c5_morning_due_at('2026-01-05', '2026-01-05 19:00 America/New_York', v_tz, '05:00') = '2026-01-06 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('timing: Mon 23:30-Tue 00:30 -> Tue 05:00 (start-date anchored)',
    c5_morning_due_at('2026-01-05', '2026-01-06 00:30 America/New_York', v_tz, '05:00') = '2026-01-06 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('timing: Mon 08:00-Tue 18:00 -> Wed 05:00 (first reminder after closure)',
    c5_morning_due_at('2026-01-05', '2026-01-06 18:00 America/New_York', v_tz, '05:00') = '2026-01-07 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('timing: Mon 04:00-04:30 -> Tue 05:00',
    c5_morning_due_at('2026-01-05', '2026-01-05 04:30 America/New_York', v_tz, '05:00') = '2026-01-06 05:00 America/New_York'::timestamptz);
  PERFORM pg_temp.chk('timing: DST spring-forward night -> 05:00 EDT (09:00 UTC)',
    c5_morning_due_at('2026-03-07', '2026-03-07 21:00 America/New_York', v_tz, '05:00') = '2026-03-08 09:00+00'::timestamptz);

  -- ================= no obligation while STARTED =================
  s5 := pg_temp.session(v_patient, v_v, v_w, v_e, v_tz, 10);
  PERFORM pg_temp.chk('STARTED session has no immediate or morning obligation',
    NOT EXISTS (SELECT 1 FROM session_immediate_responses WHERE rehab_session_id = s5)
    AND NOT EXISTS (SELECT 1 FROM morning_responses WHERE rehab_session_id = s5));
  v_r := c5_submit_immediate_response(v_patient, s5, '{}');
  PERFORM pg_temp.chk('immediate submission for a STARTED session -> response_not_found', v_r->>'result' = 'response_not_found', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s5, '{"resolution": "unable_to_recall"}');
  PERFORM pg_temp.chk('morning submission for a STARTED session -> response_not_found (never due while STARTED)', v_r->>'result' = 'response_not_found', v_r::text);
  PERFORM c5_finish_session(v_patient, s5);
  UPDATE session_immediate_responses SET peak_session_pain = 1, overall_session_rpe = 1, sudden_or_sharp_pain = false,
    pop_felt_or_heard = false, new_functional_difficulty = false, resolved_at = now() WHERE rehab_session_id = s5;
  UPDATE morning_responses SET resolution = 'unable_to_recall', submitted_at = now() WHERE rehab_session_id = s5;

  -- ================= S1: immediate validation, zero, replay =================
  s1 := pg_temp.session(v_patient, v_v, v_w, v_e, v_tz, 9);
  v_r := c5_finish_session(v_patient, s1);
  PERFORM pg_temp.chk('closure creates exactly one immediate + one morning obligation',
    (SELECT count(*) FROM session_immediate_responses WHERE rehab_session_id = s1) = 1
    AND (SELECT count(*) FROM morning_responses WHERE rehab_session_id = s1) = 1);
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('gate: outstanding immediate response blocks a new Start', v_r->>'result' = 'immediate_response_required', v_r::text);

  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 11, "overall_session_rpe": 2, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('peak pain 11 refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 3.5, "overall_session_rpe": 2, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('peak pain 3.5 (non-integer) refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": "3", "overall_session_rpe": 2, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('peak pain as a string refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 2, "overall_session_rpe": -1, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('RPE -1 refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 2, "overall_session_rpe": 11, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('RPE 11 refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"overall_session_rpe": 2, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('unanswered peak pain is refused, never 0-filled', v_r->>'detail' = 'peak_pain_value_or_unable_to_recall_required', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 2, "peak_pain_unable_to_recall": true, "overall_session_rpe": 2, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('a value AND unable-to-recall together is refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_pain_unable_to_recall": true, "rpe_unable_to_recall": true}');
  PERFORM pg_temp.chk('unable-to-recall cannot resolve the safety questions', v_r->>'detail' = 'safety_answer_required', v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_pain_unable_to_recall": true, "rpe_unable_to_recall": true, "sudden_or_sharp_pain": false, "pop_felt_or_heard": "unable_to_recall", "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('a non-boolean safety answer is refused', v_r->>'detail' = 'safety_answer_required', v_r::text);
  PERFORM pg_temp.chk('every refusal left the obligation unresolved and unevaluated',
    (SELECT resolved_at IS NULL AND peak_session_pain IS NULL FROM session_immediate_responses WHERE rehab_session_id = s1)
    AND NOT EXISTS (SELECT 1 FROM escalation_evaluations WHERE rehab_session_id = s1));

  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 0, "overall_session_rpe": 0, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  SELECT * INTO v_sir FROM session_immediate_responses WHERE rehab_session_id = s1;
  PERFORM pg_temp.chk('numeric zero persists as zero (pain 0, RPE 0)',
    v_r->>'result' = 'submitted' AND v_sir.peak_session_pain = 0 AND v_sir.overall_session_rpe = 0
    AND NOT v_sir.peak_pain_unable_to_recall AND NOT v_sir.rpe_unable_to_recall AND v_sir.resolved_at IS NOT NULL, v_r::text);
  PERFORM pg_temp.chk('one escalation evaluation, Level 0, rule v1, from the C5 immediate response',
    (SELECT count(*) FROM escalation_evaluations WHERE rehab_session_id = s1) = 1
    AND (SELECT escalation_level = 0 AND rule_version = 'v1' AND inputs_snapshot->>'source' = 'c5_immediate_response' FROM escalation_evaluations WHERE rehab_session_id = s1));
  PERFORM pg_temp.chk('no categorical Difficulty for a C5 session; RPE not in set_outcomes',
    (SELECT difficulty IS NULL FROM rehab_sessions WHERE id = s1)
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'set_outcomes' AND column_name ILIKE '%rpe%')
    AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'session_immediate_responses' AND column_name ILIKE '%difficulty%' AND column_name <> 'new_functional_difficulty'));
  PERFORM pg_temp.chk('no anchor-word / category column stored for RPE',
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'session_immediate_responses'
                AND (column_name ILIKE '%anchor%' OR column_name ILIKE '%rpe_label%' OR column_name ILIKE '%rpe_category%')));
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 0, "overall_session_rpe": 0, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('identical retry -> submitted (replayed), no second evaluation',
    v_r->>'result' = 'submitted' AND (v_r->>'replayed')::boolean AND (SELECT count(*) FROM escalation_evaluations WHERE rehab_session_id = s1) = 1, v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s1, '{"peak_session_pain": 7, "overall_session_rpe": 9, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('a different retry -> already_submitted; the submitted observation is unchanged',
    v_r->>'result' = 'already_submitted' AND (SELECT peak_session_pain = 0 AND overall_session_rpe = 0 FROM session_immediate_responses WHERE rehab_session_id = s1), v_r::text);
  v_r := c5_submit_immediate_response(v_other, s1, '{"peak_session_pain": 1, "overall_session_rpe": 1, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('another patient cannot submit for this session', v_r->>'result' = 'response_not_found', v_r::text);

  -- ================= S1 morning: not due, then retrospective =================
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('gate: resolved immediate + not-yet-due morning -> eligible', v_r->>'result' = 'eligible', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 1, "next_morning_stiffness": 0}');
  PERFORM pg_temp.chk('morning submission before it is due -> morning_not_yet_due', v_r->>'result' = 'morning_not_yet_due', v_r::text);
  -- Fixture: this obligation became due two mornings ago (due instant and
  -- its reference morning moved back together), so today's submission is
  -- retrospective.
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '2 days',
    reference_local_date = ((now() - interval '2 days') AT TIME ZONE v_tz)::date WHERE rehab_session_id = s1;
  SELECT * INTO v_mr FROM morning_responses WHERE rehab_session_id = s1;
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('gate: due unresolved morning blocks a new Start', v_r->>'result' = 'morning_response_required', v_r::text);

  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 11, "next_morning_stiffness": 0}');
  PERFORM pg_temp.chk('morning pain 11 refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 1, "next_morning_stiffness": 10.5}');
  PERFORM pg_temp.chk('morning stiffness 10.5 refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 1}');
  PERFORM pg_temp.chk('answered without stiffness refused (never 0-filled)', v_r->>'detail' = 'pain_and_stiffness_required', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 1, "next_morning_stiffness": 3}');
  PERFORM pg_temp.chk('stiffness > 0 requires a duration', v_r->>'detail' = 'stiffness_duration_required', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 1, "next_morning_stiffness": 3, "stiffness_duration": "not_applicable"}');
  PERFORM pg_temp.chk('"not_applicable" is not a duration for stiffness > 0', v_r->>'detail' = 'stiffness_duration_required', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 1, "next_morning_stiffness": 0, "stiffness_duration": "lt_5_min"}');
  PERFORM pg_temp.chk('stiffness 0 with a duration refused', v_r->>'result' = 'invalid_response', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 0, "next_morning_stiffness": 0}');
  SELECT * INTO v_mr FROM morning_responses WHERE rehab_session_id = s1;
  PERFORM pg_temp.chk('morning pain 0 / stiffness 0 stored as zero; no fabricated duration',
    v_r->>'result' = 'submitted' AND v_mr.next_morning_pain = 0 AND v_mr.next_morning_stiffness = 0 AND v_mr.stiffness_duration IS NULL AND v_mr.resolution = 'answered', v_r::text);
  PERFORM pg_temp.chk('retrospective: reference_local_date kept (not rewritten to the submission date); submitted_at = actual time',
    v_mr.reference_local_date = ((now() - interval '2 days') AT TIME ZONE v_tz)::date
    AND v_mr.submitted_at = now() AND (v_r->>'reference_local_date')::date = v_mr.reference_local_date);
  PERFORM pg_temp.chk('delay is derivable: submitted 2 local days after the reference morning, after the due instant',
    (v_mr.submitted_at AT TIME ZONE v_tz)::date - v_mr.reference_local_date = 2 AND v_mr.submitted_at > v_mr.scheduled_eligible_at);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "answered", "next_morning_pain": 0, "next_morning_stiffness": 0}');
  PERFORM pg_temp.chk('identical morning retry -> replayed', v_r->>'result' = 'submitted' AND (v_r->>'replayed')::boolean, v_r::text);
  v_r := c5_submit_morning_response(v_patient, s1, '{"resolution": "unable_to_recall"}');
  PERFORM pg_temp.chk('a different morning retry -> already_submitted, nothing changed',
    v_r->>'result' = 'already_submitted' AND (SELECT resolution = 'answered' FROM morning_responses WHERE rehab_session_id = s1), v_r::text);
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('gate: resolving the morning response removes that gate', v_r->>'result' = 'eligible', v_r::text);

  -- ================= S2: unable to recall everywhere it is allowed =================
  s2 := pg_temp.session(v_patient, v_v, v_w, v_e, v_tz, 8);
  PERFORM c5_stop_session(v_patient, s2);
  v_r := c5_submit_immediate_response(v_patient, s2, '{"peak_pain_unable_to_recall": true, "rpe_unable_to_recall": true, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  SELECT * INTO v_sir FROM session_immediate_responses WHERE rehab_session_id = s2;
  PERFORM pg_temp.chk('immediate unable-to-recall: NULL values + explicit flags, obligation resolved',
    v_r->>'result' = 'submitted' AND v_sir.peak_session_pain IS NULL AND v_sir.overall_session_rpe IS NULL
    AND v_sir.peak_pain_unable_to_recall AND v_sir.rpe_unable_to_recall AND v_sir.resolved_at IS NOT NULL, v_r::text);
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '1 hour' WHERE rehab_session_id = s2;
  v_r := c5_submit_morning_response(v_patient, s2, '{"resolution": "unable_to_recall", "next_morning_pain": 2}');
  PERFORM pg_temp.chk('morning unable-to-recall with a value is refused', v_r->>'detail' = 'unable_to_recall_has_no_values', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s2, '{"resolution": "unable_to_recall"}');
  SELECT * INTO v_mr FROM morning_responses WHERE rehab_session_id = s2;
  PERFORM pg_temp.chk('morning "I don''t remember": all values NULL, resolution unable_to_recall, obligation resolved',
    v_r->>'result' = 'submitted' AND v_mr.resolution = 'unable_to_recall' AND v_mr.next_morning_pain IS NULL
    AND v_mr.next_morning_stiffness IS NULL AND v_mr.stiffness_duration IS NULL AND v_mr.submitted_at IS NOT NULL, v_r::text);

  -- ================= S3: high pain / RPE never invents a brake =================
  s3 := pg_temp.session(v_patient, v_v, v_w, v_e, v_tz, 7);
  PERFORM c5_finish_session(v_patient, s3);
  v_r := c5_submit_immediate_response(v_patient, s3, '{"peak_session_pain": 10, "overall_session_rpe": 10, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('pain 10 + RPE 10 with no safety fact -> Level 0', (v_r->>'escalation_level')::int = 0, v_r::text);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM reconcile_missing_acute_episodes(v_patient);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.chk('pain / RPE alone create no episode and no brake',
    NOT EXISTS (SELECT 1 FROM acute_safety_episodes WHERE user_id = v_patient)
    AND NOT EXISTS (SELECT 1 FROM get_patient_acute_brake_status(v_patient)));
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '1 hour' WHERE rehab_session_id = s3;
  v_r := c5_submit_morning_response(v_patient, s3, '{"resolution": "answered", "next_morning_pain": 4, "next_morning_stiffness": 6, "stiffness_duration": "min_5_15", "patient_note": "  a bit stiff  "}');
  SELECT * INTO v_mr FROM morning_responses WHERE rehab_session_id = s3;
  PERFORM pg_temp.chk('stiffness > 0 with duration + trimmed note stored',
    v_r->>'result' = 'submitted' AND v_mr.next_morning_stiffness = 6 AND v_mr.stiffness_duration = 'min_5_15' AND v_mr.patient_note = 'a bit stiff', v_r::text);
  v_r := c5_submit_morning_response(v_patient, s3, jsonb_build_object('resolution', 'unable_to_recall', 'patient_note', repeat('x', 501)));
  PERFORM pg_temp.chk('note over 500 characters refused (validation precedes replay)', v_r->>'detail' = 'note_too_long', v_r::text);

  -- ================= S4: Stop-sheet positive fact + established escalation =================
  s4 := pg_temp.session(v_patient, v_v, v_w, v_e, v_tz, 6);
  v_r := c5_stop_session(v_patient, s4, '{"pop_felt_or_heard": true}');
  PERFORM pg_temp.chk('fixture: acute Stop pre-filled pop = true', (SELECT pop_felt_or_heard FROM session_immediate_responses WHERE rehab_session_id = s4) IS TRUE, v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s4, '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('a recorded positive safety fact cannot be downgraded by the form',
    v_r->>'result' = 'recorded_safety_fact_conflict' AND v_r->>'item' = 'pop_felt_or_heard'
    AND (SELECT pop_felt_or_heard IS TRUE AND resolved_at IS NULL FROM session_immediate_responses WHERE rehab_session_id = s4), v_r::text);
  v_r := c5_submit_immediate_response(v_patient, s4, '{"peak_pain_unable_to_recall": true, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('the recorded fact is carried into the submission (pop stays TRUE)',
    v_r->>'result' = 'submitted' AND (SELECT pop_felt_or_heard IS TRUE AND resolved_at IS NOT NULL FROM session_immediate_responses WHERE rehab_session_id = s4), v_r::text);
  PERFORM pg_temp.chk('established rule: pop -> Level 5 evaluation recorded in the same transaction',
    (v_r->>'escalation_level')::int = 5 AND (SELECT count(*) FROM escalation_evaluations WHERE rehab_session_id = s4 AND escalation_level = 5) = 1);
  PERFORM pg_temp.chk('before reconciliation the C5 gate fails closed', c5_get_start_eligibility(v_patient)->>'result' = 'acute_safety_reconciliation_required');
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM reconcile_missing_acute_episodes(v_patient);
  PERFORM reconcile_missing_acute_episodes(v_patient);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.chk('reconciliation (separate step) creates exactly one Level 5 episode from the C5 facts',
    (SELECT count(*) FROM acute_safety_episodes WHERE user_id = v_patient) = 1
    AND (SELECT initial_level = 5 AND initial_pop_felt_or_heard AND NOT initial_sudden_or_sharp_pain FROM acute_safety_episodes WHERE user_id = v_patient));
  v_r := c5_submit_immediate_response(v_patient, s4, '{"peak_pain_unable_to_recall": true, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('lost-response retry: replayed, no second evaluation, no second episode',
    (v_r->>'replayed')::boolean AND (SELECT count(*) FROM escalation_evaluations WHERE rehab_session_id = s4) = 1
    AND (SELECT count(*) FROM acute_safety_episodes WHERE user_id = v_patient) = 1, v_r::text);
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '1 hour' WHERE rehab_session_id = s4;
  PERFORM c5_submit_morning_response(v_patient, s4, '{"resolution": "unable_to_recall"}');
  v_r := c5_get_start_eligibility(v_patient);
  PERFORM pg_temp.chk('with every response resolved, the safety brake still independently blocks training',
    v_r->>'result' = 'acute_safety_professional_review_required'
    AND NOT EXISTS (SELECT 1 FROM session_immediate_responses WHERE user_id = v_patient AND resolved_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM morning_responses WHERE user_id = v_patient AND submitted_at IS NULL), v_r::text);

  -- ================= immutability at the table (C5.6B guard, unchanged) =================
  BEGIN
    UPDATE session_immediate_responses SET pop_felt_or_heard = false WHERE rehab_session_id = s4;
    PERFORM pg_temp.chk('a resolved immediate response is immutable', false, 'update succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.chk('a resolved immediate response is immutable', SQLERRM LIKE '%C5_RESPONSE_RESOLVED_IMMUTABLE%', SQLERRM);
  END;
  BEGIN
    UPDATE morning_responses SET next_morning_pain = 9 WHERE rehab_session_id = s1;
    PERFORM pg_temp.chk('a submitted morning response is immutable', false, 'update succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.chk('a submitted morning response is immutable', SQLERRM LIKE '%C5_RESPONSE_RESOLVED_IMMUTABLE%', SQLERRM);
  END;

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%')
    INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES (format('=== C5.6E RESPONSE VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
