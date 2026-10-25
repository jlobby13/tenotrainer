-- M1 verification: set-edit provenance, the authoritative professional-
-- review state, the >=4 clinician-release invariant (database-enforced),
-- clinician release provenance/idempotency/authorization and multiple
-- simultaneously open episodes. One transaction, ROLLBACK'd — nothing
-- persists. Uses one pre-existing auth.users id with no prescription /
-- session / safety state purely for FKs (same convention as the C5.6 suites).
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyM1ClinicianReview.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

-- A C5 session that started p_days_ago days ago (patient-local date in
-- p_tz) with one completed unit; closed with p_status (NULL = still started).
CREATE FUNCTION pg_temp.session_ago(p_user UUID, p_version UUID, p_workout UUID, p_ex UUID, p_tz TEXT, p_days_ago INT, p_status TEXT)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid(); v_start TIMESTAMPTZ := now() - make_interval(days => p_days_ago) - interval '2 hours';
BEGIN
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_id, p_user, 'c5:' || v_id::text, (v_start AT TIME ZONE p_tz)::date, NULL, 'started', v_start,
    c5_build_session_snapshot(p_version, p_workout), p_version, p_workout, p_tz, gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_id, p_ex::text, 0, 0, 'completed', 8, v_start);
  IF p_status IS NOT NULL THEN
    UPDATE rehab_sessions SET training_status = p_status, training_closed_at = v_start + interval '30 minutes' WHERE id = v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- A safety episode raised from p_session's escalation at p_level, evaluated
-- p_hours_ago hours ago, through the real reconciliation path.
CREATE FUNCTION pg_temp.episode(p_user UUID, p_session UUID, p_level SMALLINT, p_hours_ago INT)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_eval UUID; v_ep UUID;
BEGIN
  INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
  VALUES (p_session, p_level, CASE WHEN p_level = 5 THEN 'pop_felt_or_heard' ELSE 'sudden_or_sharp_pain' END, 'v1',
    jsonb_build_object('source', 'c5_immediate_response', 'suddenOrSharpPain', p_level = 3, 'popFeltOrHeard', p_level = 5, 'newFunctionalDifficulty', false),
    now() - make_interval(hours => p_hours_ago))
  RETURNING id INTO v_eval;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM reconcile_missing_acute_episodes(p_user);
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE source_escalation_evaluation_id = v_eval;
  RETURN v_ep;
END;
$$;

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_other_clinician UUID;
  v_tz TEXT := 'America/New_York';
  v_patient UUID;
  v_pp UUID; v_ce UUID; v_v UUID; v_w UUID; v_e UUID;
  s UUID; s2 UUID; s3 UUID; s4 UUID; s5 UUID; s6 UUID;
  ep3 UUID; ep5 UUID; ep_old UUID; ep_blocked UUID; ep_held UUID;
  v_r JSONB; v_r2 JSONB;
  v_st RECORD;
  v_n INT;
  v_err TEXT;
  v_set set_outcomes;
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
    AND NOT EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.supervisor_id = u.id OR sp.patient_id = u.id)
  ORDER BY u.created_at, u.id LIMIT 1;
  IF v_patient IS NULL THEN RAISE EXCEPTION 'M1 verify setup: need an auth.users row with a profile and no prescription/session/safety state'; END IF;
  -- Any other existing user, never assigned to this patient: the unrelated clinician.
  SELECT u.id INTO v_other_clinician FROM auth.users u WHERE u.id NOT IN (v_clinician, v_patient) ORDER BY u.created_at LIMIT 1;

  UPDATE profiles SET timezone = v_tz, morning_reminder_time = '05:00' WHERE id = v_patient;
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M1 verify exercise', 'global', true) RETURNING id INTO v_ce;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_patient, 'clinician_change', v_pp, 1, now() - interval '60 days', v_clinician, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, v_ce, 0, 'active') RETURNING id INTO v_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
    VALUES (v_e, 'repetition', 3, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;

  -- ================= set-edit provenance =================
  s := pg_temp.session_ago(v_patient, v_v, v_w, v_e, v_tz, 0, NULL);
  v_r := c5_edit_performance(v_patient, s, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 10));
  SELECT * INTO v_set FROM set_outcomes WHERE rehab_session_id = s AND set_index = 0;
  PERFORM pg_temp.chk('edit: result edited; set row holds the corrected value and was_edited',
    v_r->>'result' = 'edited' AND v_set.actual_reps = 10 AND v_set.was_edited, v_r::text);
  PERFORM pg_temp.chk('edit: history preserves OLD -> NEW with server-derived identity',
    (SELECT count(*) = 1 AND bool_and(e.previous_actual_reps = 8 AND e.new_actual_reps = 10 AND e.previous_outcome = 'completed'
       AND e.new_outcome = 'completed' AND e.user_id = v_patient AND e.rehab_session_id = s AND e.set_outcome_id = v_set.id AND e.edited_at IS NOT NULL)
     FROM set_outcome_edits e WHERE e.rehab_session_id = s));
  v_r := c5_edit_performance(v_patient, s, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 10));
  PERFORM pg_temp.chk('edit: identical-value retry returns edited and adds no history',
    v_r->>'result' = 'edited' AND (SELECT count(*) FROM set_outcome_edits WHERE rehab_session_id = s) = 1);
  v_r := c5_edit_performance(v_patient, s, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 9));
  PERFORM pg_temp.chk('edit: a second correction appends (10 -> 9); first record unchanged',
    (SELECT count(*) FROM set_outcome_edits WHERE rehab_session_id = s) = 2
    AND EXISTS (SELECT 1 FROM set_outcome_edits WHERE rehab_session_id = s AND previous_actual_reps = 8 AND new_actual_reps = 10)
    AND EXISTS (SELECT 1 FROM set_outcome_edits WHERE rehab_session_id = s AND previous_actual_reps = 10 AND new_actual_reps = 9));
  v_r := c5_edit_performance(v_patient, s, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'skipped'));
  PERFORM pg_temp.chk('edit: completed -> skipped still refused (no void), no history',
    v_r->>'detail' = 'completed_cannot_become_skipped' AND (SELECT count(*) FROM set_outcome_edits WHERE rehab_session_id = s) = 2, v_r::text);
  v_r := c5_edit_performance(v_other_clinician, s, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 1));
  PERFORM pg_temp.chk('edit: another identity cannot edit this patient''s set (no history, value unchanged)',
    v_r->>'result' <> 'edited' AND (SELECT actual_reps FROM set_outcomes WHERE id = v_set.id) = 9
    AND (SELECT count(*) FROM set_outcome_edits WHERE rehab_session_id = s) = 2, v_r::text);
  BEGIN
    UPDATE set_outcome_edits SET new_actual_reps = 99 WHERE rehab_session_id = s;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('edit history is immutable (UPDATE refused)', v_err = 'SET_OUTCOME_EDIT_IMMUTABLE', v_err);
  UPDATE rehab_sessions SET training_status = 'finished', training_closed_at = now() WHERE id = s;
  v_r := c5_edit_performance(v_patient, s, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 7));
  PERFORM pg_temp.chk('edit: no post-closure correction (closed session refused, no history)',
    v_r->>'result' <> 'edited' AND (SELECT count(*) FROM set_outcome_edits WHERE rehab_session_id = s) = 2, v_r::text);
  PERFORM pg_temp.chk('grants: authenticated may read but never write set_outcome_edits',
    has_table_privilege('authenticated', 'set_outcome_edits', 'SELECT') AND NOT has_table_privilege('authenticated', 'set_outcome_edits', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'set_outcome_edits', 'UPDATE') AND NOT has_table_privilege('anon', 'set_outcome_edits', 'SELECT'));

  -- ================= authoritative review state =================
  s2 := pg_temp.session_ago(v_patient, v_v, v_w, v_e, v_tz, 2, 'stopped_acute');
  -- Episodes are evaluated at distinct past hours so the recurrence window
  -- sequence stays below 4 for the Level 3 episodes under test.
  ep3 := pg_temp.episode(v_patient, s2, 3::smallint, 5);
  SELECT * INTO v_st FROM acute_episode_review_state(ep3);
  PERFORM pg_temp.chk('ordinary Level 3 (fresh): effective 3, no clinician release required',
    v_st.effective_level = 3 AND NOT v_st.requires_clinician_release AND NOT v_st.professionally_held, row_to_json(v_st)::text);
  PERFORM pg_temp.chk('brake status reads the same derivation (parity)',
    (SELECT effective_level FROM get_patient_acute_brake_status(v_patient)) = v_st.effective_level
    AND (SELECT episode_id FROM get_patient_acute_brake_status(v_patient)) = ep3);

  v_r := clinician_release_acute_episode(ep3, v_clinician, 'Reviewed');
  PERFORM pg_temp.chk('ordinary Level 3: clinician_release_not_required (patient-resolution rules apply)',
    v_r->>'result' = 'clinician_release_not_required' AND NOT EXISTS (SELECT 1 FROM acute_safety_releases WHERE acute_safety_episode_id = ep3), v_r::text);

  -- Ordinary Level 3: patient path still releases (self-resolution).
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
    VALUES (ep3, v_patient, true, NULL, false, NULL);
  BEGIN
    INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, source_reassessment_id)
      SELECT ep3, v_patient, 'self_resolved_no_evaluation', id FROM acute_safety_reassessments WHERE acute_safety_episode_id = ep3;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('13. ordinary Level 3 self-resolution release still accepted', v_err IS NULL AND (SELECT released FROM acute_episode_review_state(ep3)), v_err);
  PERFORM pg_temp.chk('brake clears after the ordinary Level 3 release', NOT EXISTS (SELECT 1 FROM get_patient_acute_brake_status(v_patient)));
  v_r := clinician_release_acute_episode(ep3, v_clinician, 'not needed');
  PERFORM pg_temp.chk('clinician release of an already-released episode returns already_released (no second row)',
    v_r->>'result' = 'already_released' AND (SELECT count(*) FROM acute_safety_releases WHERE acute_safety_episode_id = ep3) = 1, v_r::text);

  -- Effective Level 4 by time (> 48 h unresolved).
  s3 := pg_temp.session_ago(v_patient, v_v, v_w, v_e, v_tz, 4, 'stopped_acute');
  ep_old := pg_temp.episode(v_patient, s3, 3::smallint, 72);
  SELECT * INTO v_st FROM acute_episode_review_state(ep_old);
  PERFORM pg_temp.chk('Level 3 unresolved > 48 h: effective 4, clinician release required',
    v_st.effective_level = 4 AND v_st.requires_clinician_release AND 'unresolved_over_48_hours' = ANY (v_st.level4_reasons), row_to_json(v_st)::text);
  BEGIN
    INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
      VALUES (ep_old, v_patient, true, NULL, false, NULL);
    INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, source_reassessment_id)
      SELECT ep_old, v_patient, 'self_resolved_no_evaluation', max(id::text)::uuid FROM acute_safety_reassessments WHERE acute_safety_episode_id = ep_old;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('14. effective >=4: patient-style release refused by the database (service role too)', v_err = 'ACUTE_RELEASE_REQUIRES_CLINICIAN', v_err);
  PERFORM pg_temp.chk('21. effective >=4: brake still active before clinician release',
    (SELECT episode_id FROM get_patient_acute_brake_status(v_patient)) = ep_old
    AND (SELECT o_code FROM c5_acute_gate(v_patient)) = 'acute_safety_professional_review_required');

  -- Effective Level 4 by blocked opportunities.
  s4 := pg_temp.session_ago(v_patient, v_v, v_w, v_e, v_tz, 6, 'stopped_acute');
  ep_blocked := pg_temp.episode(v_patient, s4, 3::smallint, 4);
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level)
    SELECT v_patient, ep_blocked, 'm1-verify-' || g, 3 FROM generate_series(1, 3) g;
  PERFORM pg_temp.chk('Level 3 with 3 blocked opportunities: effective 4, clinician release required',
    (SELECT effective_level = 4 AND requires_clinician_release FROM acute_episode_review_state(ep_blocked)));

  -- Professional hold (evaluated, not cleared) on an otherwise ordinary Level 3.
  s5 := pg_temp.session_ago(v_patient, v_v, v_w, v_e, v_tz, 8, 'stopped_acute');
  ep_held := pg_temp.episode(v_patient, s5, 3::smallint, 3);
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
    VALUES (ep_held, v_patient, NULL, NULL, true, false);
  SELECT * INTO v_st FROM acute_episode_review_state(ep_held);
  PERFORM pg_temp.chk('Level 3 professional hold: effective 3 but clinician release required',
    v_st.effective_level = 3 AND v_st.professionally_held AND v_st.requires_clinician_release, row_to_json(v_st)::text);
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
    VALUES (ep_held, v_patient, NULL, NULL, true, true);
  BEGIN
    INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, source_reassessment_id)
      SELECT ep_held, v_patient, 'professional_clearance', id FROM acute_safety_reassessments WHERE acute_safety_episode_id = ep_held AND cleared_by_professional;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('professional hold: a later patient "cleared" report cannot release', v_err = 'ACUTE_RELEASE_REQUIRES_CLINICIAN', v_err);

  -- Level 5.
  s6 := pg_temp.session_ago(v_patient, v_v, v_w, v_e, v_tz, 10, 'stopped_acute');
  ep5 := pg_temp.episode(v_patient, s6, 5::smallint, 2);
  SELECT * INTO v_st FROM acute_episode_review_state(ep5);
  PERFORM pg_temp.chk('Level 5: effective 5, clinician release required', v_st.effective_level = 5 AND v_st.requires_clinician_release, row_to_json(v_st)::text);
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
    VALUES (ep5, v_patient, NULL, NULL, true, true);
  BEGIN
    INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, source_reassessment_id, source_prescription_version_id)
      SELECT ep5, v_patient, 'professional_clearance_with_prescription', id, v_v FROM acute_safety_reassessments WHERE acute_safety_episode_id = ep5;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('15. Level 5: patient reassessment + newer version cannot release (the old M5 path is refused)', v_err = 'ACUTE_RELEASE_REQUIRES_CLINICIAN', v_err);
  PERFORM pg_temp.chk('Level 5 never reads as a lower level after reassessment', (SELECT effective_level FROM acute_episode_review_state(ep5)) = 5);

  -- Patient mismatch is refused even on the clinician path.
  BEGIN
    INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, released_by_clinician_id, release_note)
      VALUES (ep5, v_clinician, 'clinician_release', v_clinician, 'x');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('release row must name the episode''s own patient', v_err = 'ACUTE_RELEASE_PATIENT_MISMATCH', v_err);
  BEGIN
    INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, released_by_clinician_id)
      VALUES (ep5, v_patient, 'clinician_release', v_clinician);
    v_err := NULL;
  EXCEPTION WHEN check_violation THEN v_err := 'check_violation';
  END;
  PERFORM pg_temp.chk('a clinician release without a note violates the provenance CHECK', v_err = 'check_violation', v_err);

  -- ================= clinician release =================
  v_r := clinician_release_acute_episode(ep5, v_other_clinician, 'Reviewed');
  PERFORM pg_temp.chk('17. an unrelated (unassigned) clinician cannot release', v_r->>'result' = 'not_authorized', v_r::text);
  v_r := clinician_release_acute_episode(ep5, v_clinician, '   ');
  PERFORM pg_temp.chk('note required: blank note refused', v_r->>'result' = 'invalid_note', v_r::text);
  v_r := clinician_release_acute_episode(ep5, v_clinician, repeat('x', 1001));
  PERFORM pg_temp.chk('note limit: 1001 characters refused', v_r->>'result' = 'invalid_note', v_r::text);
  v_r := clinician_release_acute_episode(gen_random_uuid(), v_clinician, 'Reviewed');
  PERFORM pg_temp.chk('unknown episode: episode_not_found', v_r->>'result' = 'episode_not_found', v_r::text);
  PERFORM pg_temp.chk('no release row was written by any refused attempt', NOT EXISTS (SELECT 1 FROM acute_safety_releases WHERE acute_safety_episode_id = ep5));

  -- Multiple open episodes: ep_old (eff 4), ep_blocked (eff 4), ep_held, ep5 (5).
  SELECT count(*) INTO v_n FROM acute_safety_episodes e
    WHERE e.user_id = v_patient AND NOT EXISTS (SELECT 1 FROM acute_safety_releases r WHERE r.acute_safety_episode_id = e.id);
  PERFORM pg_temp.chk('23. four episodes open simultaneously; brake shows the newest', v_n = 4
    AND (SELECT episode_id FROM get_patient_acute_brake_status(v_patient)) = ep5, v_n::text);

  v_r := clinician_release_acute_episode(ep5, v_clinician, '  Reviewed in clinic; cleared to resume.  ');
  PERFORM pg_temp.chk('16/20. assigned clinician release: provenance (clinician, trimmed note, database time, no reassessment)',
    v_r->>'result' = 'released'
    AND (SELECT r.release_path = 'clinician_release' AND r.released_by_clinician_id = v_clinician AND r.release_note = 'Reviewed in clinic; cleared to resume.'
           AND r.released_at = now() AND r.source_reassessment_id IS NULL AND r.user_id = v_patient
         FROM acute_safety_releases r WHERE r.acute_safety_episode_id = ep5), v_r::text);
  v_r2 := clinician_release_acute_episode(ep5, v_clinician, 'again');
  PERFORM pg_temp.chk('19. duplicate release is idempotent (same release returned, one row, note unchanged)',
    v_r2->>'result' = 'already_released' AND v_r2->'release'->>'id' = v_r->'release'->>'id'
    AND (SELECT count(*) FROM acute_safety_releases WHERE acute_safety_episode_id = ep5) = 1
    AND (SELECT release_note FROM acute_safety_releases WHERE acute_safety_episode_id = ep5) = 'Reviewed in clinic; cleared to resume.', v_r2::text);
  BEGIN
    UPDATE acute_safety_releases SET release_note = 'changed' WHERE acute_safety_episode_id = ep5;
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('20. release provenance is immutable (UPDATE refused)', v_err = 'ACUTE_RELEASE_IMMUTABLE', v_err);

  PERFORM pg_temp.chk('23. releasing one episode leaves the others open and visible',
    (SELECT count(*) FROM acute_safety_episodes e WHERE e.user_id = v_patient
       AND NOT EXISTS (SELECT 1 FROM acute_safety_releases r WHERE r.acute_safety_episode_id = e.id)) = 3
    AND (SELECT count(*) FROM acute_safety_episodes WHERE user_id = v_patient) = 5
    AND EXISTS (SELECT 1 FROM get_patient_acute_brake_status(v_patient)));
  PERFORM pg_temp.chk('training still blocked while any professional-review episode is open',
    (SELECT o_code FROM c5_acute_gate(v_patient)) = 'acute_safety_professional_review_required');

  v_r := clinician_release_acute_episode(ep_held, v_clinician, 'Cleared after review.');
  v_r2 := clinician_release_acute_episode(ep_blocked, v_clinician, 'Cleared after review.');
  PERFORM pg_temp.chk('each remaining episode is released independently', v_r->>'result' = 'released' AND v_r2->>'result' = 'released');
  PERFORM pg_temp.chk('brake moves to the next open episode (ep_old)', (SELECT episode_id FROM get_patient_acute_brake_status(v_patient)) = ep_old);
  v_r := clinician_release_acute_episode(ep_old, v_clinician, 'Cleared after review.');
  PERFORM pg_temp.chk('22. after the last valid clinician release the brake clears and the C5 acute gate opens',
    v_r->>'result' = 'released' AND NOT EXISTS (SELECT 1 FROM get_patient_acute_brake_status(v_patient))
    AND (SELECT o_code FROM c5_acute_gate(v_patient)) IS NULL, v_r::text);

  PERFORM pg_temp.chk('18. grants: authenticated/anon cannot execute clinician release; service_role can',
    NOT has_function_privilege('authenticated', 'clinician_release_acute_episode(uuid, uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'clinician_release_acute_episode(uuid, uuid, text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'clinician_release_acute_episode(uuid, uuid, text)', 'EXECUTE'));
  PERFORM pg_temp.chk('grants: authenticated cannot write releases; brake status keeps its grants',
    NOT has_table_privilege('authenticated', 'acute_safety_releases', 'INSERT')
    AND has_function_privilege('authenticated', 'get_patient_acute_brake_status(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'get_patient_acute_brake_status(uuid)', 'EXECUTE'));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END;
$verify$;

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
