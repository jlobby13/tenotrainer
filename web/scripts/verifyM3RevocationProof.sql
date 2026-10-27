-- M3.1 — ROLLBACK-ONLY pre-application proof of the legacy authority
-- revocation migration. Nothing persists: the migration file itself is
-- included VERBATIM (runSqlSuite.mjs expands the @@include line and prints
-- its sha256) inside this transaction, every probe runs before it (must be
-- live) and after it (must be refused), preserved authority is exercised
-- functionally, and everything is rolled back.
--
-- This is a PRE-application proof: once the migration is applied the
-- "before" probes are refused, by design. Post-application proof is
-- verifyM3AdversarialSurface.mjs --expect-revoked.
--
-- Run (guarded): TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyM3RevocationProof.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);
GRANT ALL ON verify_results TO authenticated, anon, service_role;
GRANT ALL ON SEQUENCE verify_results_seq_seq TO authenticated, anon, service_role;

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

CREATE FUNCTION pg_temp.mkuser(p_email TEXT) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, '', now(), now(), now(), '{}', '{}');
  RETURN v_id;
END;
$$;

-- Runs p_sql as a PostgREST-style request: role + JWT claims. Returns the
-- SQLSTATE ('OK' on success).
CREATE FUNCTION pg_temp.as_role(p_role TEXT, p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_state TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', p_role)::text, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  -- OTHERS excludes assert_failure (P0004), which some legacy functions raise.
  EXCEPTION WHEN OTHERS OR assert_failure THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$$;

CREATE TEMP TABLE fx (k TEXT PRIMARY KEY, v UUID);
GRANT ALL ON fx TO authenticated, anon, service_role;

-- The ONE legacy authority probe set, run twice: before the proposed
-- migration (each probe must SUCCEED — proving it really exercises live
-- legacy authority, not a column-grant / schema accident) and after it
-- (each must be refused with 42501). Uses exactly the column grants the
-- legacy runtime used.
CREATE FUNCTION pg_temp.legacy_probes(p_patient UUID, p_legacy UUID, p_n INT) RETURNS TABLE (label TEXT, state TEXT) LANGUAGE plpgsql AS $$
BEGIN
  label := 'patient INSERT legacy rehab_sessions row';
  state := pg_temp.as_role('authenticated', p_patient, format(
    'INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, started_at, prescription_snapshot) VALUES (gen_random_uuid(), %L, %L, current_date - %s, now(), %L::jsonb)',
    p_patient, 'legacy:probe' || p_n || ':' || p_legacy, 10 + p_n, '[]')); RETURN NEXT;
  label := 'patient UPDATE own legacy rehab_sessions row';
  state := pg_temp.as_role('authenticated', p_patient, format('UPDATE rehab_sessions SET status = %L WHERE id = %L', 'exercises_complete', p_legacy)); RETURN NEXT;
  label := 'patient INSERT legacy set_outcomes';
  state := pg_temp.as_role('authenticated', p_patient, format(
    'INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, actual_reps, occurred_at) VALUES (%L, %L, 0, %s, %L, 8, now())', p_legacy, 'ex', p_n, 'completed')); RETURN NEXT;
  label := 'patient UPDATE legacy set_outcomes';
  state := pg_temp.as_role('authenticated', p_patient, format('UPDATE set_outcomes SET actual_reps = 9 WHERE rehab_session_id = %L', p_legacy)); RETURN NEXT;
  label := 'patient INSERT legacy session_events';
  state := pg_temp.as_role('authenticated', p_patient, format('INSERT INTO session_events (rehab_session_id, type, note, occurred_at) VALUES (%L, %L, %L, now())', p_legacy, 'other', 'probe' || p_n)); RETURN NEXT;
  label := 'patient INSERT legacy morning_responses';
  state := pg_temp.as_role('authenticated', p_patient, format(
    'INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at) SELECT %L, %L, now() WHERE NOT EXISTS (SELECT 1 FROM morning_responses WHERE rehab_session_id = %L)', p_legacy, p_patient, p_legacy)); RETURN NEXT;
  label := 'patient UPDATE legacy morning_responses';
  state := pg_temp.as_role('authenticated', p_patient, format('UPDATE morning_responses SET patient_note = %L WHERE rehab_session_id = %L', 'probe', p_legacy)); RETURN NEXT;
  label := 'patient INSERT daily_logs';
  state := pg_temp.as_role('authenticated', p_patient, format(
    'INSERT INTO daily_logs (user_id, pain_during, pain_after, next_day_pain, difficulty, confidence) VALUES (%L, 1, 1, 1, 1, 1)', p_patient)); RETURN NEXT;
  -- Functions: before = reaches the function body (any outcome but 42501).
  label := 'patient EXECUTE create_rehab_session_if_allowed';
  state := pg_temp.as_role('authenticated', p_patient, format(
    'SELECT create_rehab_session_if_allowed(gen_random_uuid(), NULL, %L, current_date - %s, now(), %L::jsonb)', 'legacy:fn' || p_n || ':' || p_legacy, 20 + p_n, '[]')); RETURN NEXT;
  label := 'patient EXECUTE capture_session_guidance_context';
  state := pg_temp.as_role('authenticated', p_patient, format('SELECT capture_session_guidance_context(%L)', p_legacy)); RETURN NEXT;
  label := 'patient EXECUTE capture_cautious_return_context';
  state := pg_temp.as_role('authenticated', p_patient, format('SELECT capture_cautious_return_context(%L)', p_legacy)); RETURN NEXT;
  label := 'patient EXECUTE record_blocked_loading_opportunity (self-escalation surface)';
  state := pg_temp.as_role('authenticated', p_patient, format('SELECT record_blocked_loading_opportunity(%L, %L, 5::smallint)', gen_random_uuid(), 'x')); RETURN NEXT;
  label := 'anon EXECUTE create_rehab_session_if_allowed';
  state := pg_temp.as_role('anon', NULL, format(
    'SELECT create_rehab_session_if_allowed(gen_random_uuid(), NULL, %L, current_date, now(), %L::jsonb)', 'legacy:anon' || p_n, '[]')); RETURN NEXT;
END;
$$;

DO $fixtures$
DECLARE
  s TEXT := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_org UUID; v_clin UUID; v_patient UUID; v_other UUID; v_super UUID; v_cadmin UUID; v_legacy UUID := gen_random_uuid();
  v_fav_ce UUID; v_st TEXT; p RECORD;
BEGIN
  INSERT INTO organizations (name, slug) VALUES ('M3.1 proof org', 'm31-proof-' || s) RETURNING id INTO v_org;
  v_clin := pg_temp.mkuser('m31-clin-' || s || '@example.invalid');
  v_patient := pg_temp.mkuser('m31-patient-' || s || '@example.invalid');
  v_other := pg_temp.mkuser('m31-other-' || s || '@example.invalid');
  v_super := pg_temp.mkuser('m31-super-' || s || '@example.invalid');
  v_cadmin := pg_temp.mkuser('m31-cadmin-' || s || '@example.invalid');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES
    (v_org, v_clin, 'clinician'), (v_org, v_patient, 'member'), (v_org, v_other, 'member'), (v_org, v_super, 'super_user'), (v_org, v_cadmin, 'clinician_admin');
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (v_org, v_clin, v_patient);
  UPDATE profiles SET timezone = 'America/New_York', morning_reminder_time = '07:00' WHERE id IN (v_patient, v_other);

  -- A legacy row owned by the patient (as legacy history would be).
  INSERT INTO rehab_sessions (id, user_id, prescription_instance_id, patient_local_date, status, started_at, prescription_snapshot)
  VALUES (v_legacy, v_patient, 'legacy:' || v_legacy, (now() AT TIME ZONE 'America/New_York')::date - 3, 'in_progress', now() - interval '3 days', '[]'::jsonb);

  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M3.1 fav probe ' || s, 'global', true) RETURNING id INTO v_fav_ce;
  INSERT INTO fx VALUES ('org', v_org), ('clin', v_clin), ('patient', v_patient), ('other', v_other), ('super', v_super), ('cadmin', v_cadmin), ('legacy', v_legacy), ('fav_ce', v_fav_ce);

  -- PRE: authenticated DELETE authority that the migration removes is live today.
  PERFORM pg_temp.chk('pre-revocation probe is live: authenticated holds DELETE on organizations, profiles, favorites and the 3 M6 tables',
    has_table_privilege('authenticated', 'public.organizations', 'DELETE') AND has_table_privilege('authenticated', 'public.profiles', 'DELETE')
    AND has_table_privilege('authenticated', 'public.clinician_exercise_favorites', 'DELETE') AND has_table_privilege('authenticated', 'public.m6_heuristics', 'DELETE')
    AND has_table_privilege('authenticated', 'public.m6_evidence_sources', 'DELETE') AND has_table_privilege('authenticated', 'public.m6_heuristic_evidence', 'DELETE'));
  INSERT INTO clinician_exercise_favorites (clinician_id, canonical_exercise_id) VALUES (v_clin, v_fav_ce);
  v_st := pg_temp.as_role('authenticated', v_clin, format('DELETE FROM clinician_exercise_favorites WHERE clinician_id = %L AND canonical_exercise_id = %L', v_clin, v_fav_ce));
  PERFORM pg_temp.chk('pre-revocation probe is live: a clinician can directly DELETE their own favorite today',
    v_st = 'OK' AND NOT EXISTS (SELECT 1 FROM clinician_exercise_favorites WHERE clinician_id = v_clin AND canonical_exercise_id = v_fav_ce), v_st);
  INSERT INTO clinician_exercise_favorites (clinician_id, canonical_exercise_id) VALUES (v_clin, v_fav_ce);

  -- PRE: the probes really exercise live legacy authority.
  FOR p IN SELECT * FROM pg_temp.legacy_probes(v_patient, v_legacy, 1) LOOP
    IF p.label LIKE '%EXECUTE%' THEN
      PERFORM pg_temp.chk('pre-revocation probe is live: ' || p.label || ' (reaches the function)', p.state <> '42501', p.state);
    ELSE
      PERFORM pg_temp.chk('pre-revocation probe is live: ' || p.label || ' (succeeds today)', p.state = 'OK', p.state);
    END IF;
  END LOOP;
END;
$fixtures$;

-- ===================== THE MIGRATION, VERBATIM =====================
-- @@include supabase/migrations/20261026000002_m3_1_revoke_legacy_patient_authority.sql
-- ================== END OF THE MIGRATION, VERBATIM ==================

DO $verify$
DECLARE
  s TEXT := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_org UUID := (SELECT v FROM fx WHERE k = 'org'); v_clin UUID := (SELECT v FROM fx WHERE k = 'clin');
  v_patient UUID := (SELECT v FROM fx WHERE k = 'patient'); v_other UUID := (SELECT v FROM fx WHERE k = 'other');
  v_super UUID := (SELECT v FROM fx WHERE k = 'super'); v_legacy UUID := (SELECT v FROM fx WHERE k = 'legacy');
  v_cadmin UUID := (SELECT v FROM fx WHERE k = 'cadmin'); v_fav_ce UUID := (SELECT v FROM fx WHERE k = 'fav_ce');
  v_draft UUID; v_rev BIGINT; v_ep UUID; v_h UUID; v_es UUID; v_rd1 UUID; v_rd2 UUID; v_gce UUID;
  v_ce UUID; v_pp UUID; v_v UUID; v_w UUID; v_e UUID; v_sess UUID; v_notice UUID; p RECORD;
  v_r JSONB; v_st TEXT; v_n INT;
  v_pass INT; v_fail INT;
BEGIN
  -- ================= legacy authority refused (same probes, after) =================
  FOR p IN SELECT * FROM pg_temp.legacy_probes(v_patient, v_legacy, 2) LOOP
    PERFORM pg_temp.chk('revoked: ' || p.label, p.state = '42501', p.state);
  END LOOP;
  FOR p IN SELECT t AS label FROM unnest(ARRAY['rehab_sessions','set_outcomes','morning_responses','session_events','daily_logs','onboarding_assessments','progression_decisions','rehab_plans','sessions','session_follow_ups','visa_a_responses','messages','schedule_overrides','tfa_codes','supervisor_alerts','supervisor_assessments','supervisor_case_notes','supervisor_session_comments','supervisor_audit_logs','exercises','knowledge_entries']) t LOOP
    PERFORM pg_temp.chk('revoked: no client INSERT/UPDATE/DELETE (table or column) and no write policy on ' || p.label,
      NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = p.label AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
      AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = p.label AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('INSERT', 'UPDATE'))
      AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = p.label AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')));
  END LOOP;
  PERFORM pg_temp.chk('revoked: RLS is still enabled on every legacy table (revocation never disables RLS)',
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
                AND c.relname IN ('rehab_sessions','set_outcomes','morning_responses','session_events','daily_logs','messages') AND NOT c.relrowsecurity));

  -- ================= anon / TRUNCATE hygiene =================
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'anon' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  PERFORM pg_temp.chk('hygiene: anon holds no INSERT/UPDATE/DELETE/TRUNCATE on any public table', v_n = 0, v_n::text);
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type = 'TRUNCATE';
  PERFORM pg_temp.chk('hygiene: authenticated holds TRUNCATE on no public table', v_n = 0, v_n::text);
  v_st := pg_temp.as_role('anon', NULL, format('INSERT INTO organizations (name, slug) VALUES (%L, %L)', 'x', 'anon-' || s));
  PERFORM pg_temp.chk('hygiene: anon INSERT refused (organizations)', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_patient, 'TRUNCATE notifications');
  PERFORM pg_temp.chk('hygiene: patient cannot TRUNCATE', v_st = '42501', v_st);
  PERFORM pg_temp.chk('revoked: the 10 retired supervisor / Stage-1 library policies no longer exist',
    NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname IN (
      'alerts: supervisor update (resolve)', 'sup_assessments: supervisor insert', 'sup_assessments: supervisor update',
      'case_notes: supervisor insert', 'sup_comments: supervisor write', 'sup_comments: supervisor update',
      'exercises: clinician_admin write', 'exercises: clinician_admin update', 'kb: clinician_admin write', 'kb: clinician_admin update')));
  PERFORM pg_temp.chk('hygiene: default privileges for new postgres-owned tables no longer grant anon writes or TRUNCATE',
    NOT EXISTS (SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
                WHERE n.nspname = 'public' AND pg_get_userbyid(d.defaclrole) = 'postgres' AND d.defaclobjtype = 'r'
                  AND (d.defaclacl::text ~ 'anon=[^/]*[awdD]' OR d.defaclacl::text ~ 'authenticated=[^/]*D')));

  -- ================= C5-required patient behaviour preserved =================
  v_st := pg_temp.as_role('authenticated', v_patient, format('UPDATE profiles SET timezone = %L, morning_reminder_time = %L WHERE id = %L', 'America/Chicago', '06:30', v_patient));
  PERFORM pg_temp.chk('preserved: patient updates own timezone + morning reminder (C5 settings)',
    v_st = 'OK' AND (SELECT timezone = 'America/Chicago' AND morning_reminder_time = '06:30' FROM profiles WHERE id = v_patient), v_st);
  v_st := pg_temp.as_role('authenticated', v_patient, format('UPDATE profiles SET timezone = %L WHERE id = %L', 'Europe/Paris', v_other));
  PERFORM pg_temp.chk('preserved: a patient still cannot change someone else''s profile', v_st = 'OK' AND (SELECT timezone FROM profiles WHERE id = v_other) = 'America/New_York', v_st);
  UPDATE profiles SET timezone = 'America/New_York' WHERE id = v_patient;
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M3.1 proof ' || s, 'global', true) RETURNING id INTO v_ce;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp;
  INSERT INTO prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_patient, 'clinician_change', v_pp, 1, now() - interval '30 days', v_clin, 'sequence', 3) RETURNING id INTO v_v;
  INSERT INTO prescription_workouts (prescription_version_id, label, order_index) VALUES (v_v, 'A', 0) RETURNING id INTO v_w;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status) VALUES (v_w, v_ce, 0, 'active') RETURNING id INTO v_e;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_e, 'repetition', 2, 'exact', 8, 'not_applicable');
  UPDATE patient_prescriptions SET current_prescription_version_id = v_v WHERE id = v_pp;
  INSERT INTO notifications (patient_id, type, prescription_version_id) VALUES (v_patient, 'prescription_published', v_v) RETURNING id INTO v_notice;
  v_st := pg_temp.as_role('authenticated', v_patient, format('UPDATE notifications SET read_at = now() WHERE id = %L', v_notice));
  PERFORM pg_temp.chk('preserved: patient acknowledges own program notice (read_at)', v_st = 'OK' AND (SELECT read_at IS NOT NULL FROM notifications WHERE id = v_notice), v_st);
  v_st := pg_temp.as_role('authenticated', v_patient, format('SELECT count(*) FROM prescription_versions WHERE user_id = %L', v_patient));
  PERFORM pg_temp.chk('preserved: patient reads own prescription data (RLS read)', v_st = 'OK', v_st);
  v_st := pg_temp.as_role('authenticated', v_patient, format('SELECT reconcile_missing_acute_episodes(%L)', v_patient));
  PERFORM pg_temp.chk('preserved: self reconciliation (read-path safety derivation) still executable', v_st = 'OK', v_st);

  -- ================= C5 / M1 / M2 authority preserved (service role) =================
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SET LOCAL ROLE service_role;
  v_r := c5_record_first_performance(v_patient, gen_random_uuid(), v_v, v_w,
    jsonb_build_object('exercise_id', v_e::text, 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 8), '[]'::jsonb, NULL);
  v_sess := (v_r->>'session_id')::uuid;
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' = 'started' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: C5 first performance (service role) starts the session');
  v_r := c5_record_performance(v_patient, v_sess, jsonb_build_object('exercise_id', v_e::text, 'unit_index', 1, 'outcome', 'completed', 'actual_reps', 8));
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' = 'recorded' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: C5 later performance');
  v_r := c5_finish_session(v_patient, v_sess);
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' = 'closed' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: C5 Finish');
  v_r := c5_submit_immediate_response(v_patient, v_sess, '{"peak_session_pain": 2, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}'::jsonb);
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' = 'submitted' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: C5 immediate response ' || coalesce(v_r->>'result', 'null'));
  PERFORM pause_prescription(v_pp, v_clin);
  PERFORM resume_prescription(v_pp, v_clin);
  INSERT INTO verify_results(result) VALUES ('PASS: preserved: clinician pause / resume (Postgres assignment authority, service role)');
  INSERT INTO verify_results(result) VALUES (CASE WHEN clinician_patient_access(v_clin, v_patient) AND NOT clinician_patient_access(v_clin, v_other) THEN 'PASS: ' ELSE 'FAIL: ' END
    || 'preserved: clinician authorization semantics (assigned yes, unassigned no)');
  v_r := create_patient_invitation(v_clin, v_org, 'm31-invitee-' || s || '@example.invalid', encode(sha256(convert_to('m31tok' || s, 'UTF8')), 'hex'));
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' = 'created' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: M2 patient invitation creation');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.chk('preserved: service role keeps every table privilege the server uses',
    has_table_privilege('service_role', 'public.rehab_sessions', 'INSERT') AND has_table_privilege('service_role', 'public.set_outcomes', 'UPDATE')
    AND has_table_privilege('service_role', 'public.notifications', 'UPDATE') AND has_table_privilege('service_role', 'public.supervisor_patients', 'INSERT'));
  PERFORM pg_temp.chk('preserved: patients still cannot call C5 lifecycle RPCs directly',
    NOT has_function_privilege('authenticated', 'c5_record_first_performance(uuid, uuid, uuid, uuid, jsonb, jsonb, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'c5_submit_immediate_response(uuid, uuid, jsonb)', 'EXECUTE'));

  -- ================= canonical exercise authority preserved =================
  v_st := pg_temp.as_role('authenticated', v_super, format('INSERT INTO canonical_exercises (name, visibility, active, created_by) VALUES (%L, %L, true, %L)', 'M3.1 super ' || s, 'global', v_super));
  PERFORM pg_temp.chk('preserved: platform super_user creates global canonical exercises', v_st = 'OK', v_st);
  v_st := pg_temp.as_role('authenticated', v_clin, format('INSERT INTO canonical_exercises (name, visibility, active, created_by) VALUES (%L, %L, true, %L)', 'M3.1 clin ' || s, 'global', v_clin));
  PERFORM pg_temp.chk('preserved: a regular clinician still cannot create global canonical exercises', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_clin, format('INSERT INTO clinician_exercise_favorites (clinician_id, canonical_exercise_id) VALUES (%L, %L)', v_clin, v_ce));
  PERFORM pg_temp.chk('preserved: clinician exercise favorites', v_st = 'OK', v_st);

  -- ================= existing protections still hold =================
  -- What the other patient can see is recorded into the temp table (as them), then checked.
  v_st := pg_temp.as_role('authenticated', v_other, format('INSERT INTO verify_results(result) SELECT %L FROM rehab_sessions WHERE id = %L', 'VISIBLE-TO-OTHER', v_sess));
  SELECT count(*) INTO v_n FROM verify_results WHERE result = 'VISIBLE-TO-OTHER';
  DELETE FROM verify_results WHERE result = 'VISIBLE-TO-OTHER';
  PERFORM pg_temp.chk('still: another patient cannot see the session (RLS)', v_st = 'OK' AND v_n = 0, v_st || '/' || v_n);
  v_st := pg_temp.as_role('authenticated', v_patient, format('INSERT INTO verify_results(result) SELECT %L FROM rehab_sessions WHERE id = %L', 'VISIBLE-TO-OWNER', v_sess));
  SELECT count(*) INTO v_n FROM verify_results WHERE result = 'VISIBLE-TO-OWNER';
  DELETE FROM verify_results WHERE result = 'VISIBLE-TO-OWNER';
  PERFORM pg_temp.chk('still: the owner can see their own session (RLS)', v_st = 'OK' AND v_n = 1, v_st || '/' || v_n);
  v_st := pg_temp.as_role('authenticated', v_patient, format('INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (%L, %L, %L)', v_org, v_clin, v_other));
  PERFORM pg_temp.chk('still: patients cannot create assignments', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_patient, format('INSERT INTO session_immediate_responses (rehab_session_id, user_id) VALUES (%L, %L)', v_sess, v_patient));
  PERFORM pg_temp.chk('still: patients cannot write C5 response tables directly', v_st = '42501', v_st);

  -- ================= authenticated DELETE: final inventory =================
  PERFORM pg_temp.chk('DELETE inventory: authenticated holds table DELETE ONLY on exercise_reference_dosage',
    (SELECT array_agg(table_name::text ORDER BY table_name) FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type = 'DELETE') = ARRAY['exercise_reference_dosage'],
    (SELECT string_agg(table_name::text, ',') FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type = 'DELETE'));
  v_st := pg_temp.as_role('authenticated', v_patient, format('DELETE FROM profiles WHERE id = %L', v_patient));
  PERFORM pg_temp.chk('DELETE revoked: patient cannot delete their profile (42501)', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_super, format('DELETE FROM organizations WHERE id = %L', v_org));
  PERFORM pg_temp.chk('DELETE revoked: even a super_user cannot delete an organization directly (42501)', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_clin, format('DELETE FROM clinician_exercise_favorites WHERE clinician_id = %L AND canonical_exercise_id = %L', v_clin, v_fav_ce));
  PERFORM pg_temp.chk('DELETE revoked: clinician direct DELETE of own favorite refused (42501)', v_st = '42501' AND EXISTS (SELECT 1 FROM clinician_exercise_favorites WHERE clinician_id = v_clin AND canonical_exercise_id = v_fav_ce), v_st);
  SET LOCAL ROLE service_role;
  DELETE FROM clinician_exercise_favorites WHERE clinician_id = v_clin AND canonical_exercise_id = v_fav_ce;
  INSERT INTO clinician_exercise_favorites (clinician_id, canonical_exercise_id) VALUES (v_clin, v_fav_ce);
  RESET ROLE;
  PERFORM pg_temp.chk('preserved: favorites through the service-role path (setExerciseFavorite: delete + upsert)',
    EXISTS (SELECT 1 FROM clinician_exercise_favorites WHERE clinician_id = v_clin AND canonical_exercise_id = v_fav_ce));

  -- ================= exercise_reference_dosage intended DELETE preserved =================
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M3.1 ref dosage ' || s, 'global', true) RETURNING id INTO v_gce;
  INSERT INTO exercise_reference_dosage (exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type) VALUES (v_gce, 'repetition', 3, 'exact', 10, 'not_applicable') RETURNING id INTO v_rd1;
  v_st := pg_temp.as_role('authenticated', v_clin, format('DELETE FROM exercise_reference_dosage WHERE id = %L', v_rd1));
  PERFORM pg_temp.chk('preserved scope: a regular clinician''s DELETE of a global reference dosage removes nothing (RLS)',
    v_st = 'OK' AND EXISTS (SELECT 1 FROM exercise_reference_dosage WHERE id = v_rd1), v_st);
  v_st := pg_temp.as_role('authenticated', v_super, format('DELETE FROM exercise_reference_dosage WHERE id = %L', v_rd1));
  PERFORM pg_temp.chk('preserved: platform super_user deletes a global exercise reference dosage (C5.3D)',
    v_st = 'OK' AND NOT EXISTS (SELECT 1 FROM exercise_reference_dosage WHERE id = v_rd1), v_st);
  v_st := pg_temp.as_role('anon', NULL, format('DELETE FROM exercise_reference_dosage WHERE exercise_id = %L', v_gce));
  PERFORM pg_temp.chk('anon cannot delete reference dosage (42501)', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_super, format('UPDATE canonical_exercises SET setup_instructions = %L, updated_by = %L WHERE id = %L', 'super edit', v_super, v_gce));
  PERFORM pg_temp.chk('preserved: super_user updates a global canonical exercise', v_st = 'OK' AND (SELECT setup_instructions FROM canonical_exercises WHERE id = v_gce) = 'super edit', v_st);

  -- ================= M6 catalog authoring preserved (CURRENT AUTHORITY — M6 AUTHORING) =================
  PERFORM pg_temp.chk('M6: all six authoring policies still exist',
    (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname IN (
      'm6_heuristics: clinician_admin write', 'm6_heuristics: clinician_admin update',
      'm6_evidence_sources: clinician_admin write', 'm6_evidence_sources: clinician_admin update',
      'm6_heuristic_evidence: clinician_admin write', 'm6_heuristic_evidence: clinician_admin update')) = 6);
  PERFORM pg_temp.chk('M6: authenticated keeps INSERT + UPDATE, loses DELETE + TRUNCATE on all 3 catalog tables',
    (SELECT bool_and(has_table_privilege('authenticated', 'public.' || t, 'INSERT') AND has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
                     AND NOT has_table_privilege('authenticated', 'public.' || t, 'DELETE') AND NOT has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE'))
       FROM unnest(ARRAY['m6_heuristics', 'm6_evidence_sources', 'm6_heuristic_evidence']) t));
  v_st := pg_temp.as_role('authenticated', v_cadmin, format('INSERT INTO m6_heuristics (heuristic_key, name, description, version_introduced, status) VALUES (%L, %L, %L, %L, %L)', 'm31_proof_' || s, 'M3.1 proof', 'proof', 'v-proof', 'proposed'));
  SELECT id INTO v_h FROM m6_heuristics WHERE heuristic_key = 'm31_proof_' || s;
  PERFORM pg_temp.chk('M6: clinician_admin INSERTs a heuristic', v_st = 'OK' AND v_h IS NOT NULL, v_st);
  v_st := pg_temp.as_role('authenticated', v_cadmin, format('UPDATE m6_heuristics SET rationale = %L WHERE id = %L', 'corrected', v_h));
  PERFORM pg_temp.chk('M6: clinician_admin UPDATEs a heuristic', v_st = 'OK' AND (SELECT rationale FROM m6_heuristics WHERE id = v_h) = 'corrected', v_st);
  v_st := pg_temp.as_role('authenticated', v_cadmin, format('INSERT INTO m6_evidence_sources (title, status, does_not_establish) VALUES (%L, %L, %L)', 'M3.1 proof ' || s, 'active', 'nothing'));
  SELECT id INTO v_es FROM m6_evidence_sources WHERE title = 'M3.1 proof ' || s;
  PERFORM pg_temp.chk('M6: clinician_admin INSERTs an evidence source', v_st = 'OK' AND v_es IS NOT NULL, v_st);
  v_st := pg_temp.as_role('authenticated', v_cadmin, format('UPDATE m6_evidence_sources SET relevant_findings = %L WHERE id = %L', 'noted', v_es));
  PERFORM pg_temp.chk('M6: clinician_admin UPDATEs an evidence source', v_st = 'OK' AND (SELECT relevant_findings FROM m6_evidence_sources WHERE id = v_es) = 'noted', v_st);
  v_st := pg_temp.as_role('authenticated', v_cadmin, format('INSERT INTO m6_heuristic_evidence (heuristic_id, evidence_source_id, notes) VALUES (%L, %L, %L)', v_h, v_es, 'link'));
  PERFORM pg_temp.chk('M6: clinician_admin links heuristic <-> evidence', v_st = 'OK' AND EXISTS (SELECT 1 FROM m6_heuristic_evidence WHERE heuristic_id = v_h AND evidence_source_id = v_es), v_st);
  v_st := pg_temp.as_role('authenticated', v_cadmin, format('UPDATE m6_heuristic_evidence SET notes = %L WHERE heuristic_id = %L', 'link2', v_h));
  PERFORM pg_temp.chk('M6: clinician_admin UPDATEs a heuristic <-> evidence link', v_st = 'OK' AND (SELECT notes FROM m6_heuristic_evidence WHERE heuristic_id = v_h) = 'link2', v_st);
  v_st := pg_temp.as_role('authenticated', v_patient, format('INSERT INTO m6_heuristics (heuristic_key, name, description, version_introduced) VALUES (%L, %L, %L, %L)', 'm31_forged_' || s, 'x', 'x', 'x'));
  PERFORM pg_temp.chk('M6: a plain member still cannot write the catalog', v_st = '42501', v_st);
  v_st := pg_temp.as_role('authenticated', v_clin, format('UPDATE m6_heuristics SET rationale = %L WHERE id = %L', 'clinician edit', v_h));
  PERFORM pg_temp.chk('M6: a regular clinician still cannot update the catalog (0 rows)', (SELECT rationale FROM m6_heuristics WHERE id = v_h) = 'corrected', v_st);
  FOR p IN SELECT t AS label FROM unnest(ARRAY['m6_heuristic_evidence', 'm6_evidence_sources', 'm6_heuristics']) t LOOP
    v_st := pg_temp.as_role('authenticated', v_cadmin, format('DELETE FROM %I WHERE true', p.label));
    PERFORM pg_temp.chk('M6: clinician_admin DELETE on ' || p.label || ' refused (42501)', v_st = '42501', v_st);
  END LOOP;
  v_st := pg_temp.as_role('anon', NULL, format('INSERT INTO m6_evidence_sources (title) VALUES (%L)', 'anon'));
  PERFORM pg_temp.chk('M6: anon cannot write the catalog (42501)', v_st = '42501', v_st);
  SET LOCAL ROLE service_role;
  DELETE FROM m6_heuristic_evidence WHERE heuristic_id = v_h;
  RESET ROLE;
  PERFORM pg_temp.chk('M6: service role keeps full catalog authority (DELETE)', NOT EXISTS (SELECT 1 FROM m6_heuristic_evidence WHERE heuristic_id = v_h));

  -- ================= remaining C5 / M1 / M2 authority (service role) =================
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SET LOCAL ROLE service_role;
  UPDATE morning_responses SET scheduled_eligible_at = now() - interval '1 hour' WHERE rehab_session_id = v_sess;
  v_r := c5_submit_morning_response(v_patient, v_sess, '{"resolution": "unable_to_recall"}'::jsonb);
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' = 'submitted' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: C5 morning response ' || coalesce(v_r->>'result', 'null'));
  INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot, evaluated_at)
    VALUES (v_sess, 5, 'pop_felt_or_heard', 'v1', '{"source": "c5_immediate_response", "popFeltOrHeard": true}'::jsonb, now() - interval '2 hours');
  PERFORM reconcile_missing_acute_episodes(v_patient);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = v_patient AND source_rehab_session_id = v_sess;
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_ep IS NOT NULL AND (SELECT confirmed_at = now() - interval '2 hours' FROM acute_safety_episodes WHERE id = v_ep) THEN 'PASS: ' ELSE 'FAIL: ' END
    || 'preserved: reconciliation creates the episode, confirmed_at anchored to evaluated_at');
  v_r := c5_get_start_eligibility(v_patient);
  INSERT INTO verify_results(result) VALUES (CASE WHEN v_r->>'result' <> 'eligible' THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: safety — the Level 5 brake blocks training (' || coalesce(v_r->>'result', 'null') || ')');
  v_r := clinician_release_acute_episode(v_ep, v_clin, 'M3.1 proof release');
  INSERT INTO verify_results(result) VALUES (CASE WHEN EXISTS (SELECT 1 FROM acute_safety_releases WHERE acute_safety_episode_id = v_ep AND released_by_clinician_id = v_clin) THEN 'PASS: ' ELSE 'FAIL: ' END
    || 'preserved: assigned clinician professional-review release');
  v_draft := create_prescription_draft(v_patient, v_clin, 'clone_active', v_v, NULL);
  v_rev := (SELECT get_prescription_draft_revision(v_draft));
  v_r := to_jsonb(publish_prescription_draft(v_draft, v_clin, v_rev));
  INSERT INTO verify_results(result) VALUES (CASE WHEN (SELECT count(*) FROM prescription_versions WHERE user_id = v_patient) = 2 THEN 'PASS: ' ELSE 'FAIL: ' END
    || 'preserved: prescription draft create + publish (version 2 published)');
  PERFORM admin_add_assignment(v_super, v_org, v_clin, v_other);
  INSERT INTO verify_results(result) VALUES (CASE WHEN clinician_patient_access(v_clin, v_other) THEN 'PASS: ' ELSE 'FAIL: ' END || 'preserved: admin assignment (M2)');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  -- ================= default privileges: a future postgres-owned table =================
  CREATE TABLE public.m31_future_probe (id INT);
  PERFORM pg_temp.chk('default privileges: a new table grants anon no writes, authenticated no DELETE/TRUNCATE',
    NOT has_table_privilege('anon', 'public.m31_future_probe', 'INSERT') AND NOT has_table_privilege('anon', 'public.m31_future_probe', 'UPDATE')
    AND NOT has_table_privilege('anon', 'public.m31_future_probe', 'DELETE') AND NOT has_table_privilege('anon', 'public.m31_future_probe', 'TRUNCATE')
    AND NOT has_table_privilege('authenticated', 'public.m31_future_probe', 'DELETE') AND NOT has_table_privilege('authenticated', 'public.m31_future_probe', 'TRUNCATE'));
  PERFORM pg_temp.chk('default privileges: a new table still grants authenticated SELECT/INSERT/UPDATE and service_role everything (unchanged)',
    has_table_privilege('authenticated', 'public.m31_future_probe', 'SELECT') AND has_table_privilege('authenticated', 'public.m31_future_probe', 'INSERT')
    AND has_table_privilege('authenticated', 'public.m31_future_probe', 'UPDATE')
    AND has_table_privilege('service_role', 'public.m31_future_probe', 'DELETE') AND has_table_privilege('service_role', 'public.m31_future_probe', 'TRUNCATE'));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END;
$verify$;

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
