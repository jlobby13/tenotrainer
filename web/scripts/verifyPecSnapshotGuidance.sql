-- PEC verification: session snapshot version 2 (frozen patient exercise
-- guidance). One transaction, ROLLBACK'd — nothing persists. Throwaway
-- in-transaction patient; real lifecycle RPCs for Start / performance.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyPecSnapshotGuidance.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

CREATE FUNCTION pg_temp.perf(p_ex UUID, p_idx INT, p_reps NUMERIC) RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object('exercise_id', p_ex::text, 'unit_index', p_idx, 'outcome', 'completed', 'actual_reps', p_reps);
$$;

DO $verify$
DECLARE
  v_tz TEXT := 'America/New_York';
  v_patient UUID := gen_random_uuid();
  v_clinician UUID := gen_random_uuid();
  v_ce_full UUID; v_ce_empty UUID;
  v_pp UUID; v_v UUID; v_w UUID; v_e_full UUID; v_e_empty UUID;
  v_snap JSONB; v_stored JSONB; v_later JSONB;
  g JSONB; g2 JSONB;
  v_r JSONB; v_sess UUID; v_v1_sess UUID := gen_random_uuid();
  v_v1_snap JSONB;
  v_n INT;
  v_pass INT; v_fail INT;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_patient, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-' || v_patient || '@example.invalid', '', now(), now(), now(), '{}', '{}'),
         (v_clinician, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-' || v_clinician || '@example.invalid', '', now(), now(), now(), '{}', '{}');
  UPDATE profiles SET timezone = v_tz, morning_reminder_time = '05:00' WHERE id = v_patient;
  INSERT INTO organization_members (organization_id, user_id, role) VALUES ('07f342fd-075c-42b5-a885-30ca64953d46', v_clinician, 'clinician');
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');

  INSERT INTO canonical_exercises (name, visibility, active, patient_facing_explanation, setup_instructions, execution_cues, common_compensations,
      contraindications_or_cautions, clinician_notes, media_url)
    VALUES ('PEC verify full', 'global', true, '  Builds calf capacity.  ', 'Stand on a step.', ARRAY['Rise slowly', '', 'Lower for 3 seconds'],
      ARRAY['Bending the knee', 'Rushing'], 'CLINICIAN-ONLY-CAUTION-MARKER', 'CLINICIAN-ONLY-NOTE-MARKER', NULL)
    RETURNING id INTO v_ce_full;
  INSERT INTO canonical_exercises (name, visibility, active, patient_facing_explanation, setup_instructions, execution_cues, common_compensations, media_url)
    VALUES ('PEC verify empty', 'global', true, '   ', NULL, NULL, '{}', '  ')
    RETURNING id INTO v_ce_empty;

  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_patient, 'clinician_change', v_pp, 1, now() - interval '30 days', v_clinician, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status, additional_instructions)
    VALUES (v_w, v_ce_full, 0, 'active', 'Use the wall for balance.') RETURNING id INTO v_e_full;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, v_ce_empty, 1, 'active') RETURNING id INTO v_e_empty;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, rest_seconds)
    VALUES (v_e_full, 'repetition', 3, 'exact', 10, 'not_applicable', 90), (v_e_empty, 'repetition', 2, 'exact', 8, 'not_applicable', NULL);
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;

  -- ================= builder output =================
  v_snap := c5_build_session_snapshot(v_v, v_w);
  g := v_snap->'exercises'->0->'patient_guidance';
  g2 := v_snap->'exercises'->1->'patient_guidance';
  PERFORM pg_temp.chk('v2: snapshot_version = 2', (v_snap->>'snapshot_version')::int = 2, v_snap->>'snapshot_version');
  PERFORM pg_temp.chk('v2: every version-1 key is still present and unchanged in shape',
    v_snap ?& ARRAY['prescription_version_id','version_number','scheduling_mode','target_sessions_per_week','recovery_days','workout','exercises']
    AND (v_snap->'exercises'->0) ?& ARRAY['exercise_id','canonical_exercise_id','name','order_index','additional_instructions','dosage']
    AND v_snap->'exercises'->0->'dosage'->>'sets' = '3' AND v_snap->'exercises'->0->'dosage'->>'rest_seconds' = '90'
    AND v_snap->'exercises'->0->>'additional_instructions' = 'Use the wall for balance.');
  PERFORM pg_temp.chk('v2: structured patient_guidance object with exactly the five approved keys',
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(g) k) = ARRAY['cues','explanation','media_url','setup','watch_for']);
  PERFORM pg_temp.chk('v2: guidance copied correctly (trimmed explanation, setup, ordered cues without blanks, watch_for)',
    g->>'explanation' = 'Builds calf capacity.' AND g->>'setup' = 'Stand on a step.'
    AND g->'cues' = '["Rise slowly", "Lower for 3 seconds"]'::jsonb AND g->'watch_for' = '["Bending the knee", "Rushing"]'::jsonb, g::text);
  PERFORM pg_temp.chk('v2: clinician-only library content is never copied',
    v_snap::text NOT LIKE '%CLINICIAN-ONLY-CAUTION-MARKER%' AND v_snap::text NOT LIKE '%CLINICIAN-ONLY-NOTE-MARKER%'
    AND v_snap::text NOT LIKE '%contraindications%' AND v_snap::text NOT LIKE '%clinician_notes%');
  PERFORM pg_temp.chk('v2: null media_url stays JSON null', g ? 'media_url' AND jsonb_typeof(g->'media_url') = 'null');
  PERFORM pg_temp.chk('v2: empty / blank / null guidance fields become null or [] (never blank strings)',
    jsonb_typeof(g2->'explanation') = 'null' AND jsonb_typeof(g2->'setup') = 'null' AND g2->'cues' = '[]'::jsonb
    AND g2->'watch_for' = '[]'::jsonb AND jsonb_typeof(g2->'media_url') = 'null', g2::text);

  -- ================= frozen at first confirmed performance =================
  v_r := c5_record_first_performance(v_patient, gen_random_uuid(), v_v, v_w, pg_temp.perf(v_e_full, 0, 10), '[]'::jsonb, NULL);
  v_sess := (v_r->>'session_id')::uuid;
  SELECT prescription_snapshot INTO v_stored FROM rehab_sessions WHERE id = v_sess;
  PERFORM pg_temp.chk('Start freezes a version-2 snapshot with the guidance', v_r->>'result' = 'started'
    AND (v_stored->>'snapshot_version')::int = 2 AND v_stored->'exercises'->0->'patient_guidance'->>'setup' = 'Stand on a step.', v_r::text);

  UPDATE canonical_exercises SET setup_instructions = 'EDITED setup', execution_cues = ARRAY['EDITED cue'], media_url = 'https://media.example/heel.mp4'
  WHERE id = v_ce_full;
  PERFORM pg_temp.chk('a canonical library edit does NOT mutate the stored Started snapshot',
    (SELECT prescription_snapshot FROM rehab_sessions WHERE id = v_sess) = v_stored);
  v_r := c5_record_performance(v_patient, v_sess, pg_temp.perf(v_e_full, 1, 10));
  PERFORM pg_temp.chk('the Started session keeps recording against its frozen snapshot',
    v_r->>'result' = 'recorded' AND (SELECT prescription_snapshot FROM rehab_sessions WHERE id = v_sess) = v_stored, v_r::text);
  v_later := c5_build_session_snapshot(v_v, v_w);
  PERFORM pg_temp.chk('a later-built snapshot sees the new canonical content (incl. media_url)',
    v_later->'exercises'->0->'patient_guidance'->>'setup' = 'EDITED setup'
    AND v_later->'exercises'->0->'patient_guidance'->'cues' = '["EDITED cue"]'::jsonb
    AND v_later->'exercises'->0->'patient_guidance'->>'media_url' = 'https://media.example/heel.mp4');

  -- ================= version-1 historical snapshots =================
  v_v1_snap := (v_snap - 'snapshot_version') || jsonb_build_object('snapshot_version', 1);
  v_v1_snap := jsonb_set(v_v1_snap, '{exercises}', (SELECT jsonb_agg(e - 'patient_guidance') FROM jsonb_array_elements(v_v1_snap->'exercises') e));
  UPDATE rehab_sessions SET training_status = 'finished', training_closed_at = now() WHERE id = v_sess;
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone, client_request_id)
  VALUES (v_v1_sess, v_patient, 'c5:' || v_v1_sess::text, ((now() AT TIME ZONE v_tz)::date - 1), NULL, 'started', now() - interval '1 day',
    v_v1_snap, v_v, v_w, v_tz, gen_random_uuid());
  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at)
    VALUES (v_v1_sess, v_e_full::text, 0, 0, 'completed', 9, now() - interval '1 day');
  PERFORM pg_temp.chk('v1 snapshot: performance validation still accepts it (no guidance needed)',
    c5_performance_error(v_v1_snap, pg_temp.perf(v_e_full, 1, 10)) IS NULL AND c5_performance_error(v_v1_snap, pg_temp.perf(v_e_empty, 0, 8)) IS NULL);
  v_r := c5_record_performance(v_patient, v_v1_sess, pg_temp.perf(v_e_full, 1, 10));
  PERFORM pg_temp.chk('v1 snapshot: a Started v1 session keeps recording; stays v1 with no guidance (no backfill)',
    v_r->>'result' = 'recorded'
    AND (SELECT (prescription_snapshot->>'snapshot_version')::int = 1 AND NOT (prescription_snapshot->'exercises'->0 ? 'patient_guidance') FROM rehab_sessions WHERE id = v_v1_sess), v_r::text);

  -- ================= current library compatibility =================
  SELECT count(*) INTO v_n FROM canonical_exercises ce
  WHERE ce.active AND ce.visibility = 'global'
    AND NOT (jsonb_typeof(to_jsonb(ce.execution_cues)) IN ('array', 'null') AND jsonb_typeof(to_jsonb(ce.common_compensations)) IN ('array', 'null'));
  PERFORM pg_temp.chk('every active global library row is compatible (array cues / compensations)', v_n = 0, v_n::text);
  PERFORM pg_temp.chk('all 47+ active global exercises yield explanation, setup and cues through the builder logic',
    (SELECT count(*) FROM canonical_exercises WHERE active AND visibility = 'global'
       AND NULLIF(btrim(patient_facing_explanation), '') IS NOT NULL AND NULLIF(btrim(setup_instructions), '') IS NOT NULL
       AND coalesce(array_length(execution_cues, 1), 0) > 0 AND name NOT LIKE 'PEC verify%') >= 47);
  PERFORM pg_temp.chk('builder keeps SECURITY DEFINER, fixed search_path and service-role-only execution',
    (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%' FROM pg_proc WHERE proname = 'c5_build_session_snapshot')
    AND NOT has_function_privilege('authenticated', 'c5_build_session_snapshot(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'c5_build_session_snapshot(uuid, uuid)', 'EXECUTE'));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END;
$verify$;

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
