-- M3.2 — shared helpers for the safety-notification SQL suites (included by
-- verifyM32SafetyNotificationsProof.sql and verifyM32SafetyNotifications.sql).
CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);
GRANT ALL ON verify_results TO authenticated, anon, service_role;
GRANT ALL ON SEQUENCE verify_results_seq_seq TO authenticated, anon, service_role;

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

CREATE FUNCTION pg_temp.mkuser(p_label TEXT) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm32-' || p_label || '-' || v_id || '@example.invalid', '', now(), now(), now(), '{}', '{}');
  UPDATE profiles SET timezone = 'America/New_York', morning_reminder_time = '05:00', name = 'M32 ' || p_label WHERE id = v_id;
  RETURN v_id;
END;
$$;

-- PostgREST-style request (role + JWT claims); returns the SQLSTATE or 'OK'.
CREATE FUNCTION pg_temp.as_role(p_role TEXT, p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_state TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS OR assert_failure THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$$;

-- A C5 program (published version, one workout, one exercise).
CREATE FUNCTION pg_temp.rx(p_patient UUID, p_clinician UUID, p_ce UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_pp UUID; v_v UUID; v_w UUID; v_e UUID;
BEGIN
  INSERT INTO patient_prescriptions (patient_id) VALUES (p_patient) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (p_patient, 'clinician_change', v_pp, 1, now() - interval '30 days', p_clinician, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, p_ce, 0, 'active') RETURNING id INTO v_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
    VALUES (v_e, 'repetition', 4, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;
  RETURN jsonb_build_object('v', v_v, 'w', v_w, 'e', v_e);
END;
$$;

-- A Started C5 session with one completed unit (C5.6E fixture shape).
CREATE FUNCTION pg_temp.session(p_user UUID, p_rx JSONB, p_days_ago INT) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid(); v_v UUID := (p_rx->>'v')::uuid; v_w UUID := (p_rx->>'w')::uuid;
BEGIN
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_id, p_user, 'c5:' || v_id::text, ((now() - make_interval(days => p_days_ago)) AT TIME ZONE 'America/New_York')::date, NULL, 'started',
    now() - make_interval(days => p_days_ago), c5_build_session_snapshot(v_v, v_w), v_v, v_w, 'America/New_York', gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_id, p_rx->>'e', 0, 0, 'completed', 8, now() - make_interval(days => p_days_ago));
  RETURN v_id;
END;
$$;

-- Stop (optionally with an in-session acute report) and, optionally,
-- submit the immediate check-in through the real C5.6E RPC.
CREATE FUNCTION pg_temp.closed(p_user UUID, p_rx JSONB, p_days_ago INT, p_acute JSONB, p_response JSONB) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE s UUID; r JSONB;
BEGIN
  s := pg_temp.session(p_user, p_rx, p_days_ago);
  r := c5_stop_session(p_user, s, p_acute);
  IF r->>'result' <> 'closed' THEN RAISE EXCEPTION 'fixture stop failed: %', r; END IF;
  IF p_response IS NOT NULL THEN
    r := c5_submit_immediate_response(p_user, s, p_response);
    IF r->>'result' <> 'submitted' THEN RAISE EXCEPTION 'fixture submit failed: %', r; END IF;
  END IF;
  RETURN s;
END;
$$;

-- The trusted server's reconcile call (service_role identity, as the C5 API does).
CREATE FUNCTION pg_temp.reconcile(p_user UUID) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SELECT count(*) INTO n FROM reconcile_missing_acute_episodes(p_user);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN n;
END;
$$;

CREATE TEMP TABLE fx (k TEXT PRIMARY KEY, v UUID);
GRANT ALL ON fx TO authenticated, anon, service_role;

-- Fingerprints of the clinical safety functions the migration must NOT touch.
CREATE TEMP TABLE clinical_defs AS
  SELECT p.oid::regprocedure::text AS sig, md5(pg_get_functiondef(p.oid)) AS h
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('acute_episode_review_state', 'c5_acute_gate', 'reconcile_missing_acute_episodes',
    'clinician_release_acute_episode', 'c5_submit_immediate_response', 'c5_submit_morning_response', 'c5_close_session_internal',
    'c5_start_eligibility_internal', 'c5_record_first_performance', 'get_patient_acute_brake_status', 'trg_acute_safety_releases_guard',
    'c5_create_response_obligations', 'clinician_patient_access', 'm2_supervisor_patients_guard', 'c5_escalation_v1');

