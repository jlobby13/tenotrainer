-- C5.6F verification: weekly target progress, advisory recovery guidance
-- (founder-locked semantics) and the Take Recovery Day / Continue record.
-- One transaction, ROLLBACK'd — nothing persists. Uses one pre-existing
-- auth.users id with no prescription/session state purely for FKs (same
-- convention as the C5.6C/E suites). now() is fixed for the transaction.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage6fFrequencyRecovery.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

-- A C5 session that STARTED at p_local (patient-local wall time) and closed
-- with p_status (NULL = still started) and one performed unit.
CREATE FUNCTION pg_temp.session_at(p_user UUID, p_version UUID, p_workout UUID, p_ex UUID, p_tz TEXT, p_local TIMESTAMP, p_status TEXT, p_close_after INTERVAL DEFAULT '30 minutes')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid(); v_start TIMESTAMPTZ := p_local AT TIME ZONE p_tz;
BEGIN
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_id, p_user, 'c5:' || v_id::text, p_local::date, NULL, 'started', v_start,
    c5_build_session_snapshot(p_version, p_workout), p_version, p_workout, p_tz, gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_id, p_ex::text, 0, 0, 'completed', 8, v_start);
  IF p_status IS NOT NULL THEN
    UPDATE rehab_sessions SET training_status = p_status, training_closed_at = v_start + p_close_after WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Resolve both response obligations of a closed session (C5.6E is not under test here).
CREATE FUNCTION pg_temp.resolve(p_session UUID) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO session_immediate_responses (rehab_session_id, user_id, peak_session_pain, overall_session_rpe, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty, resolved_at)
    SELECT id, user_id, 1, 3, false, false, false, now() FROM rehab_sessions WHERE id = p_session
  ON CONFLICT (rehab_session_id) DO UPDATE SET peak_session_pain = 1, overall_session_rpe = 3, sudden_or_sharp_pain = false,
    pop_felt_or_heard = false, new_functional_difficulty = false, resolved_at = now();
  INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date, resolution, submitted_at)
    SELECT id, user_id, now() - interval '1 hour', patient_local_date + 1, 'unable_to_recall', now() FROM rehab_sessions WHERE id = p_session
  ON CONFLICT (rehab_session_id) DO UPDATE SET resolution = 'unable_to_recall', submitted_at = now();
$$;

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_tz TEXT := 'America/New_York';
  v_patient UUID;
  v_pp UUID; v_ce UUID;
  v_v0 UUID; v_v1 UUID; v_v2 UUID; v_vc UUID;
  v_w0 UUID; v_w1 UUID; v_e0 UUID; v_e1 UUID;
  v_old_w UUID; v_old_e UUID; v_cw UUID; v_ce0 UUID; v_cw2 UUID; v_ce2 UUID;
  v_today DATE;
  v_d DATE;
  v_rg JSONB;
  v_mon DATE := '2026-06-08';
  s UUID; s_anchor UUID;
  v_r JSONB; v_g JSONB;
  v_n INT;
  v_seq JSONB;
  v_dec c5_recovery_decisions;
  v_req UUID := gen_random_uuid();
  v_pass INT; v_fail INT;
BEGIN
  -- M2: throwaway in-transaction user(s) (rolled back). An assignment's patient
  -- must never be a staff account, and an assignment's clinician must hold a
  -- clinician role in its organization; the shared project has no spare real
  -- non-staff account to borrow.
  v_patient := gen_random_uuid();
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_patient, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-' || v_patient || '@example.invalid', '', now(), now(), now(), '{}', '{}');
  IF v_patient IS NULL THEN RAISE EXCEPTION 'C5.6F verify setup: need an auth.users row with a profile and no prescription/session state'; END IF;

  UPDATE profiles SET timezone = v_tz, morning_reminder_time = '05:00' WHERE id = v_patient;
  v_today := (now() AT TIME ZONE v_tz)::date;
  -- M2: an assignment requires the clinician's clinician-role membership in its organization.
  INSERT INTO organization_members (organization_id, user_id, role) VALUES ('07f342fd-075c-42b5-a885-30ca64953d46', v_clinician, 'clinician') ON CONFLICT (organization_id, user_id) DO NOTHING;
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('C5.6F verify exercise', 'global', true) RETURNING id INTO v_ce;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;

  -- V0: an older Sequence version (recovery never authored = NULL).
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week, recovery_days)
    VALUES (v_patient, 'clinician_change', v_pp, 1, now() - interval '400 days', v_clinician, 'sequence', 3, NULL) RETURNING id INTO v_v0;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v0, 'A', 0) RETURNING id INTO v_old_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_old_w, v_ce, 0, 'active') RETURNING id INTO v_old_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_old_e, 'repetition', 3, 'exact', 8, 'not_applicable');

  -- V1: current Sequence version, target 2, recovery 1 day, workouts A/B.
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week, recovery_days)
    VALUES (v_patient, 'clinician_change', v_pp, 2, now() - interval '300 days', v_clinician, 'sequence', 2, 1) RETURNING id INTO v_v1;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v1, 'A', 0) RETURNING id INTO v_w0;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v1, 'B', 1) RETURNING id INTO v_w1;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w0, v_ce, 0, 'active') RETURNING id INTO v_e0;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w1, v_ce, 0, 'active') RETURNING id INTO v_e1;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
    VALUES (v_e0, 'repetition', 3, 'exact', 8, 'not_applicable'), (v_e1, 'repetition', 3, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v1 WHERE id = v_pp;

  -- ================= weekly target (fixed 2026 dates) =================
  PERFORM pg_temp.chk('fixture: 2026-06-08 is a Monday', EXTRACT(ISODOW FROM v_mon) = 1);
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon - 1) + time '10:00', 'finished');        -- previous Sunday
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, v_mon + time '10:00', 'finished');              -- Monday
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 1) + time '10:00', 'stopped_early');    -- Tuesday
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 2) + time '10:00', 'stopped_pause');    -- Wednesday
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 3) + time '10:00', 'stopped_acute');    -- Thursday
  s := pg_temp.session_at(v_patient, v_v0, v_old_w, v_old_e, v_tz, (v_mon + 4) + time '10:00', 'finished');   -- Friday, OLD version
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 6) + time '23:30', 'finished', '2 hours'); -- Sunday 23:30 -> Mon 01:30
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 7) + time '10:00', 'finished');        -- next Monday
  v_r := c5_weekly_progress(v_patient, v_v1, v_mon + 2);
  PERFORM pg_temp.chk('week is Monday..Sunday (patient-local)', v_r->>'week_start' = v_mon::text AND v_r->>'week_end' = (v_mon + 6)::text, v_r::text);
  PERFORM pg_temp.chk('only FINISHED count: Mon + Fri(old version) + Sun = 3; stopped_early / pause / acute excluded; neighbouring weeks excluded',
    (v_r->>'finished_sessions')::int = 3, v_r::text);
  PERFORM pg_temp.chk('a session counts on its start date (Sun 23:30 closing Monday counts in the Sunday week)',
    (c5_weekly_progress(v_patient, v_v1, v_mon + 7)->>'finished_sessions')::int = 1);
  PERFORM pg_temp.chk('numerator may exceed the target (3 of 2), target_reached, not capped',
    (v_r->>'target')::int = 2 AND (v_r->>'target_reached')::boolean AND (v_r->>'finished_sessions')::int > (v_r->>'target')::int);
  PERFORM pg_temp.chk('the same date in any week day returns the same week', c5_weekly_progress(v_patient, v_v1, v_mon + 6) = c5_weekly_progress(v_patient, v_v1, v_mon));
  -- A STARTED, unresolved session doesn't count.
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 5) + time '10:00', NULL);
  PERFORM pg_temp.chk('a STARTED unresolved session does not count', (c5_weekly_progress(v_patient, v_v1, v_mon)->>'finished_sessions')::int = 3);
  UPDATE rehab_sessions SET training_status = 'stopped_early', training_closed_at = started_at + interval '5 minutes' WHERE id = s;

  -- ================= recovery guidance (pure; fixed dates) =================
  -- Anchor = latest closed exposure = next Monday (v_mon + 7), finished.
  v_r := c5_recovery_guidance(v_patient, v_v1, v_mon + 8);
  PERFORM pg_temp.chk('N=1, anchor Monday: Tuesday is the recovery day (guidance applies), earliest = Wednesday',
    (v_r->>'applies')::boolean AND v_r->>'earliest_recommended_date' = (v_mon + 9)::text AND v_r->>'anchor_start_local_date' = (v_mon + 7)::text
    AND (v_r->>'rest_days_completed')::int = 0, v_r::text);
  PERFORM pg_temp.chk('N=1: Wednesday meets the recommendation (no guidance)', NOT (c5_recovery_guidance(v_patient, v_v1, v_mon + 9)->>'applies')::boolean);
  UPDATE prescription_versions SET recovery_days = 2 WHERE id = v_v1;
  PERFORM pg_temp.chk('N=2: Wednesday still applies, Thursday is the earliest date',
    (c5_recovery_guidance(v_patient, v_v1, v_mon + 9)->>'applies')::boolean
    AND (c5_recovery_guidance(v_patient, v_v1, v_mon + 9)->>'rest_days_completed')::int = 1
    AND NOT (c5_recovery_guidance(v_patient, v_v1, v_mon + 10)->>'applies')::boolean);
  UPDATE prescription_versions SET recovery_days = 0 WHERE id = v_v1;
  v_r := c5_recovery_guidance(v_patient, v_v1, v_mon + 8);
  PERFORM pg_temp.chk('N=0 (None authored): no guidance', NOT (v_r->>'applies')::boolean AND (v_r->>'recommended_recovery_days')::int = 0, v_r::text);
  v_r := c5_recovery_guidance(v_patient, v_v0, v_mon + 8);
  PERFORM pg_temp.chk('N=NULL (never authored) behaves as None and stays NULL',
    NOT (v_r->>'applies')::boolean AND v_r ? 'recommended_recovery_days' AND v_r->'recommended_recovery_days' = 'null'::jsonb
    AND (SELECT recovery_days IS NULL FROM prescription_versions WHERE id = v_v0), v_r::text);
  UPDATE prescription_versions SET recovery_days = 1 WHERE id = v_v1;

  -- Anchor = start date, even when the session closes after midnight.
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 14) + time '23:30', 'finished', '1 hour');
  v_r := c5_recovery_guidance(v_patient, v_v1, v_mon + 15);
  PERFORM pg_temp.chk('Mon 23:30 -> Tue 00:30 belongs to Monday: Tuesday recovery, Wednesday earliest',
    v_r->>'anchor_start_local_date' = (v_mon + 14)::text AND v_r->>'earliest_recommended_date' = (v_mon + 16)::text AND (v_r->>'applies')::boolean, v_r::text);
  -- A stopped_acute exposure anchors recovery too; and an older-version exposure.
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 21) + time '10:00', 'stopped_acute');
  PERFORM pg_temp.chk('a STOPPED_ACUTE exposure anchors recovery (real loading occurred)',
    c5_recovery_guidance(v_patient, v_v1, v_mon + 22)->>'anchor_session_id' = s::text);
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 28) + time '10:00', 'stopped_early');
  PERFORM pg_temp.chk('a STOPPED_EARLY exposure anchors recovery', c5_recovery_guidance(v_patient, v_v1, v_mon + 29)->>'anchor_session_id' = s::text);
  s := pg_temp.session_at(v_patient, v_v0, v_old_w, v_old_e, v_tz, (v_mon + 35) + time '10:00', 'finished');
  PERFORM pg_temp.chk('an exposure from an older prescription version anchors recovery',
    c5_recovery_guidance(v_patient, v_v1, v_mon + 36)->>'anchor_session_id' = s::text AND (c5_recovery_guidance(v_patient, v_v1, v_mon + 36)->>'applies')::boolean);
  s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_mon + 42) + time '10:00', NULL);
  PERFORM pg_temp.chk('a STARTED (unclosed) session never anchors recovery',
    c5_recovery_guidance(v_patient, v_v1, v_mon + 43)->>'anchor_start_local_date' = (v_mon + 35)::text);
  DELETE FROM set_outcomes WHERE rehab_session_id = s;
  DELETE FROM rehab_sessions WHERE id = s;

  -- ===== weekly target x recovery on EVERY weekday (fixed dates; no wall clock) =====
  -- Week of 2026-08-17. Each simulated patient-local today d (Mon..Sun) gets a
  -- fresh history, so the outcome never depends on the day the suite runs.
  PERFORM pg_temp.chk('fixture: 2026-08-17 is a Monday', EXTRACT(ISODOW FROM v_mon + 70) = 1);
  UPDATE prescription_versions SET target_sessions_per_week = 1, recovery_days = 2 WHERE id = v_v1;
  FOR i IN 0..6 LOOP
    v_d := v_mon + 70 + i;
    -- Combined: target 1 reached by yesterday's finished session, N=2 unmet.
    s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_d - 1) + time '10:00', 'finished');
    v_r := c5_weekly_progress(v_patient, v_v1, v_d);
    v_rg := c5_recovery_guidance(v_patient, v_v1, v_d);
    PERFORM pg_temp.chk('ISO weekday ' || (i + 1) || ': trained yesterday, target 1, N=2 -> '
        || CASE WHEN i = 0 THEN 'Monday: yesterday is last week (not reached), recovery applies' ELSE 'target reached AND recovery unmet (combined)' END,
      (v_rg->>'applies')::boolean AND v_rg->>'earliest_recommended_date' = (v_d + 2)::text AND v_rg->>'anchor_session_id' = s::text
      AND (v_r->>'target_reached')::boolean = (i >= 1) AND (v_r->>'finished_sessions')::int = CASE WHEN i >= 1 THEN 1 ELSE 0 END,
      v_r::text || ' ' || v_rg::text);
    DELETE FROM set_outcomes WHERE rehab_session_id = s;
    DELETE FROM rehab_sessions WHERE id = s;
  END LOOP;
  UPDATE prescription_versions SET recovery_days = 1 WHERE id = v_v1;
  FOR i IN 0..6 LOOP
    v_d := v_mon + 70 + i;
    -- Reached + MET: finished two days ago, N=1 -> no guidance (reachable Wed..Sun).
    s := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, (v_d - 2) + time '10:00', 'finished');
    v_r := c5_weekly_progress(v_patient, v_v1, v_d);
    v_rg := c5_recovery_guidance(v_patient, v_v1, v_d);
    PERFORM pg_temp.chk('ISO weekday ' || (i + 1) || ': trained 2 days ago, target 1, N=1 -> recovery met (no guidance)'
        || CASE WHEN i >= 2 THEN ', target reached' ELSE ', session was last week (not reached)' END,
      NOT (v_rg->>'applies')::boolean AND (v_rg->>'rest_days_completed')::int = 1
      AND (v_r->>'target_reached')::boolean = (i >= 2),
      v_r::text || ' ' || v_rg::text);
    DELETE FROM set_outcomes WHERE rehab_session_id = s;
    DELETE FROM rehab_sessions WHERE id = s;
  END LOOP;
  UPDATE prescription_versions SET target_sessions_per_week = 2 WHERE id = v_v1;

  -- Remove the fixed-date history so the live (today) scenarios start clean.
  DELETE FROM rehab_sessions WHERE user_id = v_patient;

  -- ================= live guidance + precedence (today-relative) =================
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('no exposure yet: eligible, no recovery guidance, weekly 0 of 2',
    v_g->'eligibility'->>'result' = 'eligible' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb)
    AND (v_g->'weekly'->>'finished_sessions')::int = 0 AND (v_g->'weekly'->>'target')::int = 2, v_g::text);

  s_anchor := pg_temp.session_at(v_patient, v_v1, v_w0, v_e0, v_tz, ((now() AT TIME ZONE v_tz) - interval '1 day')::timestamp, NULL);
  UPDATE rehab_sessions SET training_status = 'finished', training_closed_at = started_at + interval '30 minutes' WHERE id = s_anchor;
  PERFORM c5_create_response_obligations(s_anchor, NULL);
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('immediate-response gate wins: no recovery choice offered',
    v_g->'eligibility'->>'result' = 'immediate_response_required' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb), v_g::text);
  v_r := c5_record_recovery_decision(v_patient, gen_random_uuid(), 'continue');
  PERFORM pg_temp.chk('a decision under a hard gate is refused with that gate', v_r->>'result' = 'immediate_response_required', v_r::text);
  UPDATE session_immediate_responses SET peak_session_pain = 1, overall_session_rpe = 3, sudden_or_sharp_pain = false, pop_felt_or_heard = false, new_functional_difficulty = false, resolved_at = now() WHERE rehab_session_id = s_anchor;
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '1 hour' WHERE rehab_session_id = s_anchor;
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('due morning-response gate wins: no recovery choice offered',
    v_g->'eligibility'->>'result' = 'morning_response_required' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb), v_g::text);
  UPDATE morning_responses SET resolution = 'unable_to_recall', submitted_at = now() WHERE rehab_session_id = s_anchor;

  v_seq := c5_sequence_state(v_patient, v_v1);
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('trained yesterday + N=1: eligible AND recovery guidance applies (earliest = tomorrow)',
    v_g->'eligibility'->>'result' = 'eligible' AND (v_g->'recovery'->>'applies')::boolean
    AND v_g->'recovery'->>'earliest_recommended_date' = (v_today + 1)::text AND v_g->'recovery'->'todays_decision' = 'null'::jsonb, v_g::text);
  PERFORM pg_temp.chk('recovery guidance does not change which workout is next (Sequence = B)',
    v_g->'eligibility'->'sequence'->>'workout_id' = v_w1::text);
  PERFORM pg_temp.chk('weekly: target 2, guidance remains advisory (eligibility unchanged)', v_g->'weekly'->>'target' = '2');

  -- Take Recovery Day.
  v_r := c5_record_recovery_decision(v_patient, v_req, 'take_recovery_day');
  SELECT * INTO v_dec FROM c5_recovery_decisions WHERE client_request_id = v_req;
  PERFORM pg_temp.chk('Take Recovery Day recorded with the values actually used',
    v_r->>'result' = 'recorded' AND v_dec.decision = 'take_recovery_day' AND v_dec.prescription_version_id = v_v1
    AND v_dec.recommended_recovery_days = 1 AND v_dec.anchor_session_id = s_anchor AND v_dec.anchor_start_local_date = v_today - 1
    AND v_dec.earliest_recommended_date = v_today + 1 AND v_dec.decision_local_date = v_today AND v_dec.rest_days_completed = 0
    AND v_dec.patient_timezone = v_tz, v_r::text);
  PERFORM pg_temp.chk('Take Recovery Day creates no session, no obligation, consumes no day, moves no Sequence',
    (SELECT count(*) FROM rehab_sessions WHERE user_id = v_patient) = 1
    AND (SELECT count(*) FROM session_immediate_responses WHERE user_id = v_patient) = 1
    AND c5_get_start_eligibility(v_patient)->>'result' = 'eligible'
    AND c5_sequence_state(v_patient, v_v1) = v_seq);
  v_r := c5_record_recovery_decision(v_patient, v_req, 'continue');
  PERFORM pg_temp.chk('a retried decision (same request id) is a replay of the original', (v_r->>'replayed')::boolean AND v_r->>'decision' = 'take_recovery_day', v_r::text);
  PERFORM pg_temp.chk('today''s decision is reported back (take_recovery_day)', c5_get_training_guidance(v_patient)->'recovery'->>'todays_decision' = 'take_recovery_day');
  v_r := c5_record_recovery_decision(v_patient, gen_random_uuid(), 'continue');
  PERFORM pg_temp.chk('Continue recorded; still no session (first performance remains the Start boundary)',
    v_r->>'result' = 'recorded' AND (SELECT count(*) FROM rehab_sessions WHERE user_id = v_patient) = 1
    AND c5_get_training_guidance(v_patient)->'recovery'->>'todays_decision' = 'continue', v_r::text);
  v_r := c5_record_recovery_decision(v_patient, gen_random_uuid(), 'override');
  PERFORM pg_temp.chk('only take_recovery_day / continue are accepted', v_r->>'result' = 'invalid_decision', v_r::text);

  -- Continue -> first performance starts normally.
  v_r := c5_record_first_performance(v_patient, gen_random_uuid(), v_v1, v_w1,
    jsonb_build_object('exercise_id', v_e1::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 8));
  PERFORM pg_temp.chk('after Continue, the first confirmed performance Starts the session normally', v_r->>'result' = 'started', v_r::text);
  PERFORM pg_temp.chk('the Continue decision is linkable to that session by patient + local date (one session per date)',
    EXISTS (SELECT 1 FROM c5_recovery_decisions d JOIN rehab_sessions rs ON rs.user_id = d.user_id AND rs.patient_local_date = d.decision_local_date
            WHERE d.user_id = v_patient AND d.decision = 'continue' AND rs.id = (v_r->>'session_id')::uuid));
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('an open session: resume, no recovery choice', v_g->'eligibility'->>'result' = 'resume_existing_session' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb));
  PERFORM c5_finish_session(v_patient, (v_r->>'session_id')::uuid);
  PERFORM pg_temp.resolve((v_r->>'session_id')::uuid);
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('same-day restriction stays authoritative (no recovery choice)', v_g->'eligibility'->>'result' = 'already_trained_today' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb), v_g::text);
  PERFORM pg_temp.chk('weekly counts the finished sessions in this local week',
    (v_g->'weekly'->>'finished_sessions')::int = (SELECT count(*) FROM rehab_sessions WHERE user_id = v_patient AND training_status = 'finished'
       AND patient_local_date >= v_today - (EXTRACT(ISODOW FROM v_today)::int - 1)));

  -- Provenance: a new version with None does not rewrite the recorded decision.
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week, recovery_days)
    VALUES (v_patient, 'clinician_change', v_pp, 3, now(), v_clinician, 'sequence', 3, 0) RETURNING id INTO v_v2;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v2, 'A', 0);
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v2 WHERE id = v_pp;
  PERFORM pg_temp.chk('a new version does not rewrite recorded decisions (still N=1 on V1)',
    (SELECT bool_and(recommended_recovery_days = 1 AND prescription_version_id = v_v1) FROM c5_recovery_decisions WHERE user_id = v_patient));
  PERFORM pg_temp.chk('the current version''s recommendation is what applies now (None)',
    NOT (c5_recovery_guidance(v_patient, v_v2, v_today + 1)->>'applies')::boolean);
  BEGIN
    UPDATE c5_recovery_decisions SET recommended_recovery_days = 2 WHERE user_id = v_patient;
    PERFORM pg_temp.chk('decision records are append-only', false, 'update succeeded');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.chk('decision records are append-only', SQLERRM LIKE '%C5_RECOVERY_DECISION_IMMUTABLE%', SQLERRM);
  END;

  -- ================= Calendar: never against a scheduled day; make-ups only =================
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, recovery_days)
    VALUES (v_patient, 'clinician_change', v_pp, 4, now() - interval '30 days', v_clinician, 'calendar', 2) RETURNING id INTO v_vc;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index, days_of_week)
    VALUES (v_vc, 'A', 0, ARRAY[EXTRACT(DOW FROM v_today)::smallint]) RETURNING id INTO v_cw;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_cw, v_ce, 0, 'active') RETURNING id INTO v_ce0;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_ce0, 'repetition', 3, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_vc WHERE id = v_pp;
  -- Remove today's session so today is open again; yesterday's exposure remains the anchor.
  DELETE FROM rehab_sessions WHERE user_id = v_patient AND patient_local_date = v_today;
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('Calendar scheduled day within the recovery interval: NO guidance (never warns against the schedule); no weekly X / Y',
    v_g->'eligibility'->'calendar'->>'state' = 'scheduled_today' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb)
    AND (v_g->'weekly' IS NULL OR v_g->'weekly' = 'null'::jsonb), v_g::text);
  v_r := c5_record_recovery_decision(v_patient, gen_random_uuid(), 'take_recovery_day');
  PERFORM pg_temp.chk('no decision can be recorded against a scheduled Calendar day', v_r->>'result' = 'recovery_guidance_not_applicable', v_r::text);
  -- Make-up: schedule only the weekday two days ago (missed); yesterday's
  -- exposure is still the recovery anchor.
  UPDATE prescription_workouts SET days_of_week = ARRAY[EXTRACT(DOW FROM v_today - 2)::smallint] WHERE id = v_cw;
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('Calendar make-up within the recovery interval: guidance applies, schedule unchanged',
    v_g->'eligibility'->'calendar'->>'state' = 'make_up' AND (v_g->'recovery'->>'applies')::boolean
    AND v_g->'eligibility'->'calendar'->>'calendar_scheduled_date' = (v_today - 2)::text, v_g::text);
  v_r := c5_record_recovery_decision(v_patient, gen_random_uuid(), 'take_recovery_day');
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('Take Recovery Day on a make-up does not shift or consume the Calendar opportunity',
    v_r->>'result' = 'recorded' AND v_g->'eligibility'->'calendar'->>'state' = 'make_up'
    AND v_g->'eligibility'->'calendar'->>'calendar_scheduled_date' = (v_today - 2)::text, v_g::text);

  -- ================= other hard gates suppress the choice =================
  PERFORM pause_prescription(v_pp, v_clinician);
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('pause (no open session) wins: no recovery choice', v_g->'eligibility'->>'result' = 'prescription_paused' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb));
  PERFORM resume_prescription(v_pp, v_clinician);
  INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot)
    VALUES (s_anchor, 5, 'pop_felt_or_heard', 'v1', '{}');
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM reconcile_missing_acute_episodes(v_patient);
  PERFORM set_config('request.jwt.claims', '', true);
  v_g := c5_get_training_guidance(v_patient);
  PERFORM pg_temp.chk('acute brake wins: no recovery choice', v_g->'eligibility'->>'result' LIKE 'acute_safety_%' AND (v_g->'recovery' IS NULL OR v_g->'recovery' = 'null'::jsonb), v_g::text);
  v_r := c5_record_recovery_decision(v_patient, gen_random_uuid(), 'continue');
  PERFORM pg_temp.chk('a Continue under the brake is refused with the brake result', v_r->>'result' LIKE 'acute_safety_%', v_r::text);

  -- ================= grants / no prescription change =================
  PERFORM pg_temp.chk('grants: guidance + decision RPCs are service_role only; table is read-only to patients',
    has_function_privilege('service_role', 'c5_get_training_guidance(uuid)', 'EXECUTE')
    AND has_function_privilege('service_role', 'c5_record_recovery_decision(uuid, uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_get_training_guidance(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_record_recovery_decision(uuid, uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_recovery_guidance(uuid, uuid, date)', 'EXECUTE')
    AND NOT has_table_privilege('authenticated', 'c5_recovery_decisions', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'c5_recovery_decisions', 'UPDATE'));
  PERFORM pg_temp.chk('no C5.6F function writes prescription content',
    (SELECT bool_and(prosrc NOT ILIKE '%UPDATE prescription_%' AND prosrc NOT ILIKE '%INSERT INTO prescription_%' AND prosrc NOT ILIKE '%UPDATE rehab_sessions%' AND prosrc NOT ILIKE '%INSERT INTO rehab_sessions%')
     FROM pg_proc WHERE proname IN ('c5_weekly_progress', 'c5_recovery_guidance', 'c5_training_guidance_internal', 'c5_get_training_guidance', 'c5_record_recovery_decision')));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%')
    INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES (format('=== C5.6F FREQUENCY/RECOVERY VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
