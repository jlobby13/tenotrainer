-- M3.2 — checks for the guarded development fixture purge (included by the
-- rollback-only purge proofs; runs inside the caller's transaction, which
-- is always rolled back). Requires the helpers, the M3.2 schema and
-- web/scripts/lib/m32FixturePurge.sql (pg_temp.m32_fixture_purge).

-- Fingerprint of everything that is NOT this run's fixture, taken before any
-- fixture exists: after the purge every one must be byte-identical.
CREATE TEMP TABLE purge_fp (tbl TEXT PRIMARY KEY, n BIGINT, h TEXT);
CREATE FUNCTION pg_temp.fingerprint() RETURNS TABLE (tbl TEXT, n BIGINT, h TEXT) LANGUAGE plpgsql AS $fp$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.safety_notification_events', 'public.safety_acute_stop_notices', 'public.safety_notification_recipients',
    'public.safety_email_outbox', 'public.safety_email_attempts', 'public.safety_email_requeues', 'public.safety_notification_alerts',
    'public.safety_notification_heartbeats', 'public.acute_safety_episodes', 'public.escalation_evaluations', 'public.rehab_sessions',
    'public.session_immediate_responses', 'public.blocked_loading_opportunities', 'public.acute_safety_reassessments', 'public.acute_safety_releases',
    'public.organizations', 'public.organization_members', 'public.supervisor_patients', 'public.canonical_exercises', 'public.notifications',
    'public.patient_prescriptions', 'public.prescription_versions', 'public.profiles', 'auth.users'] LOOP
    tbl := t;
    EXECUTE format('SELECT count(*), md5(coalesce(string_agg(x::text, ''|'' ORDER BY x::text), '''')) FROM %s x', t) INTO n, h;
    RETURN NEXT;
  END LOOP;
END
$fp$;
INSERT INTO purge_fp SELECT * FROM pg_temp.fingerprint();

DO $purgeproof$
DECLARE
  REAL_ORG CONSTANT UUID := '07f342fd-075c-42b5-a885-30ca64953d46';
  s TEXT := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_start TIMESTAMPTZ := now() - interval '1 minute';
  v_orgF UUID; pA UUID; pB UUID; cA UUID; cB UUID; sU UUID; pC UUID; pOld UUID; pReal UUID; pOut UUID;
  v_ce UUID; rx JSONB; s1 UUID; v_ob UUID; v_claim RECORD; v_r JSONB; v_ep UUID; v_n BIGINT; v_t TEXT; v_ok BOOLEAN;
  v_users UUID[]; v_before JSONB; v_after JSONB; v_res JSONB; v_tbl TEXT;
  v_guard_names TEXT[] := ARRAY['trg_m32_safety_notification_events_guard', 'trg_m32_safety_acute_stop_notices_guard',
    'trg_m32_safety_notification_recipients_guard', 'trg_m32_safety_email_attempts_guard', 'trg_m32_safety_email_requeues_guard',
    'trg_m32_safety_email_outbox_no_delete'];
  v_pass INT; v_fail INT;
BEGIN
  -- ================= a full synthetic fixture graph for this run =================
  INSERT INTO organizations (name, slug) VALUES ('M3.2 purge fixture org', 'm32-purge-' || s) RETURNING id INTO v_orgF;
  pA := pg_temp.mkuser('purge-pA'); pB := pg_temp.mkuser('purge-pB'); cA := pg_temp.mkuser('purge-cA');
  cB := pg_temp.mkuser('purge-cB'); sU := pg_temp.mkuser('purge-super');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES
    (REAL_ORG, pA, 'member'), (REAL_ORG, cA, 'clinician'), (v_orgF, pB, 'member'), (v_orgF, cB, 'clinician'), (v_orgF, sU, 'super_user');
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (REAL_ORG, cA, pA), (v_orgF, cB, pB);
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M3.2 purge exercise ' || s, 'global', true) RETURNING id INTO v_ce;

  -- pA: acute Stop (notice) -> L5 check-in -> reconcile (urgent event, outbox) ->
  -- blocked opportunity, reassessment, claim/attempts, rejection, requeue, alert, program notice.
  rx := pg_temp.rx(pA, cA, v_ce);
  s1 := pg_temp.closed(pA, rx, 3, '{"pop_felt_or_heard": true}', NULL);
  PERFORM c5_submit_immediate_response(pA, s1, '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.reconcile(pA);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pA;
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level) VALUES (pA, v_ep, 'c5-day:purge', 5);
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
  VALUES (v_ep, pA, NULL, NULL, false, NULL);
  SELECT o.id INTO v_ob FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = pA;
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob]);
  PERFORM safety_email_record_result(v_ob, v_claim.claim_token, 'rejected_permanent', 422, NULL, 'invalid_recipient');
  PERFORM safety_email_requeue(v_ob, sU, 'purge fixture requeue');
  PERFORM safety_notif_raise_alert('urgent_delivery_stalled', 'outbox:' || v_ob::text, NULL);
  INSERT INTO notifications (patient_id, type, patient_prescription_id) SELECT pA, 'prescription_paused', id FROM patient_prescriptions WHERE patient_id = pA;
  -- pB: ordinary L3 in the disposable org, patient-path release.
  rx := pg_temp.rx(pB, cB, v_ce);
  PERFORM pg_temp.closed(pB, rx, 2, NULL, '{"peak_session_pain": 4, "overall_session_rpe": 5, "sudden_or_sharp_pain": true, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.reconcile(pB);
  INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path)
  SELECT id, pB, 'self_resolved_no_evaluation' FROM acute_safety_episodes WHERE user_id = pB;
  v_users := ARRAY[pA, pB, cA, cB, sU];

  SELECT jsonb_object_agg(t, n) INTO v_before FROM (VALUES
    ('events', (SELECT count(*) FROM safety_notification_events WHERE patient_id = ANY (v_users))),
    ('notices', (SELECT count(*) FROM safety_acute_stop_notices WHERE patient_id = ANY (v_users))),
    ('recipients', (SELECT count(*) FROM safety_notification_recipients WHERE recipient_user_id = ANY (v_users))),
    ('outbox', (SELECT count(*) FROM safety_email_outbox WHERE id = v_ob)),
    ('attempts', (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_ob)),
    ('requeues', (SELECT count(*) FROM safety_email_requeues WHERE outbox_id = v_ob)),
    ('alerts', (SELECT count(*) FROM safety_notification_alerts WHERE subject_key = 'outbox:' || v_ob::text)),
    ('episodes', (SELECT count(*) FROM acute_safety_episodes WHERE user_id = ANY (v_users))),
    ('sessions', (SELECT count(*) FROM rehab_sessions WHERE user_id = ANY (v_users))),
    ('users', (SELECT count(*) FROM auth.users WHERE id = ANY (v_users)))) x(t, n);
  PERFORM pg_temp.chk('purge fixture: the graph spans every M3.2 table plus the clinical graph',
    NOT EXISTS (SELECT 1 FROM jsonb_each_text(v_before) WHERE value::int = 0), v_before::text);

  -- ================= refusals (the whole call is undone; nothing changes) =================
  pReal := (SELECT rs.user_id FROM escalation_evaluations ee JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
            JOIN auth.users u ON u.id = rs.user_id WHERE u.email NOT LIKE '%@example.invalid' ORDER BY ee.evaluated_at LIMIT 1);
  pOld := pg_temp.mkuser('purge-old');
  UPDATE auth.users SET created_at = now() - interval '2 days' WHERE id = pOld;
  pOut := pg_temp.mkuser('purge-outsider');
  FOR v_t, v_res IN SELECT * FROM (VALUES
      ('a real (non-synthetic) account', to_jsonb(ARRAY[pA, coalesce(pReal, gen_random_uuid())])),
      ('a synthetic account created before this run', to_jsonb(ARRAY[pA, pOld])),
      ('an id that is not a user', to_jsonb(ARRAY[pA, gen_random_uuid()]))) x(l, u) LOOP
    BEGIN
      PERFORM pg_temp.m32_fixture_purge(ARRAY(SELECT jsonb_array_elements_text(v_res))::uuid[], ARRAY[v_orgF], ARRAY[v_ce], v_start);
      PERFORM pg_temp.chk('purge refuses ' || v_t, false, 'purge ran');
    EXCEPTION WHEN raise_exception THEN
      PERFORM pg_temp.chk('purge refuses ' || v_t, SQLERRM LIKE 'PURGE_REFUSED%', SQLERRM);
    END;
  END LOOP;
  BEGIN
    PERFORM pg_temp.m32_fixture_purge(v_users, ARRAY[v_orgF, REAL_ORG], ARRAY[v_ce], v_start);
    PERFORM pg_temp.chk('purge refuses REAL_ORG as a disposable organization', false);
  EXCEPTION WHEN raise_exception THEN
    PERFORM pg_temp.chk('purge refuses REAL_ORG as a disposable organization', SQLERRM LIKE 'PURGE_REFUSED%REAL_ORG%', SQLERRM);
  END;
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (REAL_ORG, pOut, 'member');
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (REAL_ORG, cA, pOut);
  BEGIN
    PERFORM pg_temp.m32_fixture_purge(v_users, ARRAY[v_orgF], ARRAY[v_ce], v_start);
    PERFORM pg_temp.chk('purge refuses a fixture clinician coupled to a NON-fixture patient', false);
  EXCEPTION WHEN raise_exception THEN
    PERFORM pg_temp.chk('purge refuses a fixture clinician coupled to a NON-fixture patient', SQLERRM LIKE 'PURGE_REFUSED%assignment%', SQLERRM);
  END;
  DELETE FROM supervisor_patients WHERE patient_id = pOut;
  DELETE FROM organization_members WHERE user_id = pOut;
  DELETE FROM auth.users WHERE id IN (pOut, pOld);

  -- ================= induced mid-cleanup failure: complete rollback =================
  FOREACH v_t IN ARRAY ARRAY['recipients', 'episodes', 'verification'] LOOP
    BEGIN
      PERFORM pg_temp.m32_fixture_purge(v_users, ARRAY[v_orgF], ARRAY[v_ce], v_start, v_t);
      PERFORM pg_temp.chk('induced failure after ' || v_t || ' aborts the purge', false);
    EXCEPTION WHEN raise_exception THEN
      SELECT jsonb_object_agg(t, n) INTO v_after FROM (VALUES
        ('events', (SELECT count(*) FROM safety_notification_events WHERE patient_id = ANY (v_users))),
        ('notices', (SELECT count(*) FROM safety_acute_stop_notices WHERE patient_id = ANY (v_users))),
        ('recipients', (SELECT count(*) FROM safety_notification_recipients WHERE recipient_user_id = ANY (v_users))),
        ('outbox', (SELECT count(*) FROM safety_email_outbox WHERE id = v_ob)),
        ('attempts', (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_ob)),
        ('requeues', (SELECT count(*) FROM safety_email_requeues WHERE outbox_id = v_ob)),
        ('alerts', (SELECT count(*) FROM safety_notification_alerts WHERE subject_key = 'outbox:' || v_ob::text)),
        ('episodes', (SELECT count(*) FROM acute_safety_episodes WHERE user_id = ANY (v_users))),
        ('sessions', (SELECT count(*) FROM rehab_sessions WHERE user_id = ANY (v_users))),
        ('users', (SELECT count(*) FROM auth.users WHERE id = ANY (v_users)))) x(t, n);
      PERFORM pg_temp.chk('induced failure after ' || v_t || ': ALL fixture history intact (no partial deletion), guards enabled',
        SQLERRM LIKE 'PURGE_INDUCED_FAILURE%' AND v_after = v_before
        AND (SELECT count(*) FROM pg_trigger WHERE tgname = ANY (v_guard_names) AND tgenabled = 'O') = 6
        AND EXISTS (SELECT 1 FROM organizations WHERE id = v_orgF) AND EXISTS (SELECT 1 FROM canonical_exercises WHERE id = v_ce),
        SQLERRM || ' ' || v_after::text);
    END;
  END LOOP;

  -- ================= the real purge =================
  v_res := pg_temp.m32_fixture_purge(v_users, ARRAY[v_orgF], ARRAY[v_ce], v_start);
  PERFORM pg_temp.chk('purge: completes and reports zero residue', v_res->>'result' = 'purged' AND (v_res->>'residue')::int = 0, v_res::text);
  PERFORM pg_temp.chk('purge: every fixture row is gone (users, org, exercise, sessions, episodes, all M3.2 rows)',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = ANY (v_users)) AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_orgF)
    AND NOT EXISTS (SELECT 1 FROM canonical_exercises WHERE id = v_ce) AND NOT EXISTS (SELECT 1 FROM rehab_sessions WHERE user_id = ANY (v_users))
    AND NOT EXISTS (SELECT 1 FROM safety_email_outbox WHERE id = v_ob) AND NOT EXISTS (SELECT 1 FROM safety_email_attempts WHERE outbox_id = v_ob)
    AND NOT EXISTS (SELECT 1 FROM safety_notification_recipients WHERE recipient_user_id = ANY (v_users))
    AND NOT EXISTS (SELECT 1 FROM safety_notification_alerts WHERE subject_key = 'outbox:' || v_ob::text));
  PERFORM pg_temp.chk('purge: guards re-enabled before commit', (SELECT count(*) FROM pg_trigger WHERE tgname = ANY (v_guard_names) AND tgenabled = 'O') = 6);
  PERFORM pg_temp.chk('purge: REAL_ORG remains', EXISTS (SELECT 1 FROM organizations WHERE id = REAL_ORG));
  SELECT string_agg(f.tbl || ' ' || f.n || '->' || g.n, '; ') INTO v_t
  FROM purge_fp f JOIN pg_temp.fingerprint() g ON g.tbl = f.tbl WHERE g.h IS DISTINCT FROM f.h;
  PERFORM pg_temp.chk('purge: the database is byte-identical to its pre-test state in all 24 fingerprinted tables (pre-existing development data, incl. the September L5, untouched)',
    v_t IS NULL, v_t);

  -- ================= immutability for normal authority after the purge =================
  -- A fresh history graph (rows in all six history tables) to attack.
  pC := pg_temp.mkuser('purge-pC'); sU := pg_temp.mkuser('purge-super2');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (REAL_ORG, pC, 'member'), (REAL_ORG, sU, 'super_user');
  cB := pg_temp.mkuser('purge-cC');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (REAL_ORG, cB, 'clinician');
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (REAL_ORG, cB, pC);
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M3.2 purge exercise C ' || s, 'global', true) RETURNING id INTO v_ce;
  rx := pg_temp.rx(pC, cB, v_ce);
  s1 := pg_temp.closed(pC, rx, 3, '{"pop_felt_or_heard": true}', NULL);
  PERFORM c5_submit_immediate_response(pC, s1, '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.reconcile(pC);
  SELECT o.id INTO v_ob FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = pC;
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob]);
  PERFORM safety_email_record_result(v_ob, v_claim.claim_token, 'rejected_permanent', 422, NULL, 'invalid_recipient');
  PERFORM safety_email_requeue(v_ob, sU, 'immutability probe');
  PERFORM pg_temp.chk('immutability fixture: rows exist in all six history tables',
    EXISTS (SELECT 1 FROM safety_notification_events WHERE patient_id = pC) AND EXISTS (SELECT 1 FROM safety_acute_stop_notices WHERE patient_id = pC)
    AND EXISTS (SELECT 1 FROM safety_notification_recipients WHERE recipient_user_id = cB) AND EXISTS (SELECT 1 FROM safety_email_attempts WHERE outbox_id = v_ob)
    AND EXISTS (SELECT 1 FROM safety_email_requeues WHERE outbox_id = v_ob));
  v_ok := true; v_t := '';
  FOREACH v_tbl IN ARRAY ARRAY['safety_notification_events', 'safety_notification_recipients', 'safety_email_outbox',
                               'safety_email_attempts', 'safety_email_requeues', 'safety_acute_stop_notices'] LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I', v_tbl);
      v_ok := false; v_t := v_t || v_tbl || ' was deleted by the owner; ';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE '%SAFETY_NOTIFICATION_HISTORY_IMMUTABLE%' THEN v_ok := false; v_t := v_t || v_tbl || ': ' || SQLERRM || '; '; END IF;
    END;
    IF pg_temp.as_role('service_role', NULL, format('DELETE FROM public.%I', v_tbl)) <> '42501'
       OR pg_temp.as_role('authenticated', pC, format('DELETE FROM public.%I', v_tbl)) <> '42501' THEN
      v_ok := false; v_t := v_t || v_tbl || ': client delete not refused; ';
    END IF;
  END LOOP;
  PERFORM pg_temp.chk('after the purge: owner DELETE on the 6 history tables is refused by the guard; service_role and authenticated get 42501', v_ok, v_t);
  PERFORM pg_temp.chk('after the purge: no persistent purge authority exists (no public/auth function, no grant)',
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg_temp%' AND p.proname ILIKE '%purge%' AND n.nspname IN ('public', 'auth')));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END
$purgeproof$;
