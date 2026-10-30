-- M3.2 — DEVELOPMENT TEST-HARNESS fixture purge (NOT product code).
--
-- Defines pg_temp.m32_fixture_purge(): a TEMPORARY function that exists only
-- in the guarded CLI session that runs it (dropped with the session). It is
-- never part of a migration, never granted, never callable over PostgREST,
-- an API route, a server action or any UI. It is run ONLY by
-- web/scripts/lib/safetyFixturePurge.mjs after the M3.1 guard
-- (TENOTRAINER_MODE=development + allow-listed project), and included
-- verbatim by the rollback-only purge proofs.
--
-- Scope: the EXACT fixture user ids created by the current harness run.
-- Each must be synthetic (@example.invalid — necessary, never sufficient)
-- AND created at or after the run start. Organizations / canonical
-- exercises are deleted only when passed explicitly and verified as this
-- run's disposable fixtures; REAL_ORG is never deletable. Any coupling of a
-- fixture actor to NON-fixture data (or any history older than the run)
-- aborts the whole purge. The M3.2 history guards are disabled only inside
-- the caller's transaction and re-enabled before it can commit; any error
-- rolls everything back (including the guard state).
CREATE FUNCTION pg_temp.m32_fixture_purge(
  p_users UUID[], p_organizations UUID[], p_exercises UUID[], p_run_started TIMESTAMPTZ, p_fail_after TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql AS $purge$
DECLARE
  REAL_ORG CONSTANT UUID := '07f342fd-075c-42b5-a885-30ca64953d46';
  v_window CONSTANT INTERVAL := INTERVAL '10 minutes';
  v_bad TEXT;
  v_n BIGINT;
  v_summary JSONB := '{}'::jsonb;
  v_fk RECORD;
  v_guard TEXT;
  v_guards CONSTANT TEXT[][] := ARRAY[
    ARRAY['safety_notification_events', 'trg_m32_safety_notification_events_guard'],
    ARRAY['safety_acute_stop_notices', 'trg_m32_safety_acute_stop_notices_guard'],
    ARRAY['safety_notification_recipients', 'trg_m32_safety_notification_recipients_guard'],
    ARRAY['safety_email_attempts', 'trg_m32_safety_email_attempts_guard'],
    ARRAY['safety_email_requeues', 'trg_m32_safety_email_requeues_guard'],
    ARRAY['safety_email_outbox', 'trg_m32_safety_email_outbox_no_delete']];
  i INT;
BEGIN
  IF p_run_started IS NULL OR p_run_started > clock_timestamp() OR p_run_started < clock_timestamp() - INTERVAL '1 day' THEN
    RAISE EXCEPTION 'PURGE_REFUSED: run start must be a recent instant';
  END IF;
  IF coalesce(array_length(p_users, 1), 0) = 0 THEN
    RAISE EXCEPTION 'PURGE_REFUSED: no fixture user ids';
  END IF;
  IF REAL_ORG = ANY (coalesce(p_organizations, '{}')) THEN
    RAISE EXCEPTION 'PURGE_REFUSED: REAL_ORG is never a disposable fixture';
  END IF;

  -- ---------------------------------------------------------------- identity
  CREATE TEMP TABLE m32p_u ON COMMIT DROP AS SELECT DISTINCT unnest(p_users) AS id;
  CREATE TEMP TABLE m32p_o ON COMMIT DROP AS SELECT DISTINCT unnest(coalesce(p_organizations, '{}')) AS id;
  CREATE TEMP TABLE m32p_x ON COMMIT DROP AS SELECT DISTINCT unnest(coalesce(p_exercises, '{}')) AS id;

  SELECT string_agg(p.id::text, ',') INTO v_bad FROM m32p_u p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE u.id IS NULL OR u.email IS NULL OR u.email NOT LIKE '%@example.invalid' OR u.created_at < p_run_started - v_window;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'PURGE_REFUSED: not a synthetic user of this run: %', v_bad; END IF;

  SELECT string_agg(p.id::text, ',') INTO v_bad FROM m32p_o p LEFT JOIN organizations o ON o.id = p.id
  WHERE o.id IS NULL OR o.created_at < p_run_started - v_window
     OR EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = p.id AND m.user_id NOT IN (SELECT id FROM m32p_u));
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'PURGE_REFUSED: organization is not a disposable fixture of this run: %', v_bad; END IF;

  SELECT string_agg(p.id::text, ',') INTO v_bad FROM m32p_x p LEFT JOIN canonical_exercises c ON c.id = p.id
  WHERE c.id IS NULL OR c.created_at < p_run_started - v_window
     OR EXISTS (SELECT 1 FROM prescription_exercises pe JOIN prescription_workouts w ON w.id = pe.prescription_workout_id
                LEFT JOIN prescription_versions v ON v.id = w.prescription_version_id
                LEFT JOIN prescription_drafts d ON d.id = w.prescription_draft_id
                LEFT JOIN patient_prescriptions pp ON pp.id = d.patient_prescription_id
                WHERE pe.canonical_exercise_id = p.id AND coalesce(v.user_id, pp.patient_id) NOT IN (SELECT id FROM m32p_u))
     OR EXISTS (SELECT 1 FROM template_exercises te WHERE te.canonical_exercise_id = p.id);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'PURGE_REFUSED: exercise is not a disposable fixture of this run: %', v_bad; END IF;

  -- ------------------------------------------------- derived fixture graph
  CREATE TEMP TABLE m32p_s ON COMMIT DROP AS SELECT id FROM rehab_sessions WHERE user_id IN (SELECT id FROM m32p_u);
  CREATE TEMP TABLE m32p_ep ON COMMIT DROP AS SELECT id FROM acute_safety_episodes WHERE user_id IN (SELECT id FROM m32p_u);
  CREATE TEMP TABLE m32p_pp ON COMMIT DROP AS SELECT id FROM patient_prescriptions WHERE patient_id IN (SELECT id FROM m32p_u);
  CREATE TEMP TABLE m32p_ev ON COMMIT DROP AS SELECT id FROM safety_notification_events WHERE patient_id IN (SELECT id FROM m32p_u);
  CREATE TEMP TABLE m32p_n ON COMMIT DROP AS SELECT id FROM safety_acute_stop_notices WHERE patient_id IN (SELECT id FROM m32p_u);
  CREATE TEMP TABLE m32p_r ON COMMIT DROP AS SELECT id FROM safety_notification_recipients
    WHERE event_id IN (SELECT id FROM m32p_ev) OR acute_stop_notice_id IN (SELECT id FROM m32p_n);
  CREATE TEMP TABLE m32p_ob ON COMMIT DROP AS SELECT id FROM safety_email_outbox
    WHERE recipient_id IN (SELECT id FROM m32p_r) OR event_id IN (SELECT id FROM m32p_ev);
  CREATE TEMP TABLE m32p_sir ON COMMIT DROP AS SELECT id FROM session_immediate_responses WHERE rehab_session_id IN (SELECT id FROM m32p_s);

  -- ------------------------------------- refuse anything that is not ours
  -- History older than this run (e.g. pre-existing development safety
  -- facts) is never part of a fixture graph.
  SELECT count(*) INTO v_n FROM acute_safety_episodes WHERE id IN (SELECT id FROM m32p_ep) AND created_at < p_run_started - v_window;
  IF v_n > 0 THEN RAISE EXCEPTION 'PURGE_REFUSED: % episode(s) predate this run', v_n; END IF;
  SELECT count(*) INTO v_n FROM safety_notification_events WHERE id IN (SELECT id FROM m32p_ev) AND detected_at < p_run_started - v_window;
  IF v_n > 0 THEN RAISE EXCEPTION 'PURGE_REFUSED: % notification event(s) predate this run', v_n; END IF;
  SELECT count(*) INTO v_n FROM rehab_sessions WHERE id IN (SELECT id FROM m32p_s) AND created_at < p_run_started - v_window;
  IF v_n > 0 THEN RAISE EXCEPTION 'PURGE_REFUSED: % session(s) predate this run', v_n; END IF;
  -- A fixture user acting on NON-fixture data aborts (that history is real).
  SELECT string_agg(x, ', ') INTO v_bad FROM (
    SELECT 'recipient_row_on_non_fixture_subject' AS x FROM safety_notification_recipients
      WHERE recipient_user_id IN (SELECT id FROM m32p_u) AND id NOT IN (SELECT id FROM m32p_r)
    UNION ALL SELECT 'requeue_by_fixture_on_non_fixture_outbox' FROM safety_email_requeues
      WHERE requested_by IN (SELECT id FROM m32p_u) AND outbox_id NOT IN (SELECT id FROM m32p_ob)
    UNION ALL SELECT 'assignment_by_or_of_fixture_on_non_fixture_patient' FROM supervisor_patients
      WHERE patient_id NOT IN (SELECT id FROM m32p_u)
        AND (supervisor_id IN (SELECT id FROM m32p_u) OR created_by IN (SELECT id FROM m32p_u) OR dismissed_by IN (SELECT id FROM m32p_u))
    UNION ALL SELECT 'prescription_version_published_by_fixture_for_non_fixture' FROM prescription_versions
      WHERE published_by IN (SELECT id FROM m32p_u) AND user_id NOT IN (SELECT id FROM m32p_u)
    UNION ALL SELECT 'prescription_actor_on_non_fixture' FROM patient_prescriptions
      WHERE patient_id NOT IN (SELECT id FROM m32p_u) AND (paused_by IN (SELECT id FROM m32p_u) OR resumed_by IN (SELECT id FROM m32p_u))
    UNION ALL SELECT 'draft_actor_on_non_fixture' FROM prescription_drafts d
      WHERE d.patient_prescription_id NOT IN (SELECT id FROM m32p_pp)
        AND (d.created_by IN (SELECT id FROM m32p_u) OR d.updated_by IN (SELECT id FROM m32p_u) OR d.editing_clinician_id IN (SELECT id FROM m32p_u))
    UNION ALL SELECT 'pause_actor_on_non_fixture' FROM prescription_pause_periods
      WHERE patient_prescription_id NOT IN (SELECT id FROM m32p_pp) AND (paused_by IN (SELECT id FROM m32p_u) OR resumed_by IN (SELECT id FROM m32p_u))
    UNION ALL SELECT 'release_by_fixture_on_non_fixture' FROM acute_safety_releases
      WHERE released_by_clinician_id IN (SELECT id FROM m32p_u) AND acute_safety_episode_id NOT IN (SELECT id FROM m32p_ep)
    UNION ALL SELECT 'canonical_exercise_attributed_to_fixture_not_listed' FROM canonical_exercises
      WHERE id NOT IN (SELECT id FROM m32p_x)
        AND (created_by IN (SELECT id FROM m32p_u) OR updated_by IN (SELECT id FROM m32p_u) OR owner_clinician_id IN (SELECT id FROM m32p_u))
    UNION ALL SELECT 'template_owned_by_fixture' FROM prescription_templates WHERE owner_clinician_id IN (SELECT id FROM m32p_u)
    UNION ALL SELECT 'classification_by_fixture_of_non_fixture' FROM clinical_classifications
      WHERE classified_by IN (SELECT id FROM m32p_u) AND patient_id NOT IN (SELECT id FROM m32p_u)
    UNION ALL SELECT 'legacy_supervisor_history_by_fixture' FROM supervisor_assessments
      WHERE supervisor_id IN (SELECT id FROM m32p_u) AND patient_id NOT IN (SELECT id FROM m32p_u)
    UNION ALL SELECT 'legacy_case_note_by_fixture' FROM supervisor_case_notes
      WHERE supervisor_id IN (SELECT id FROM m32p_u) AND patient_id NOT IN (SELECT id FROM m32p_u)
    UNION ALL SELECT 'legacy_audit_log_of_fixture' FROM supervisor_audit_logs
      WHERE user_id IN (SELECT id FROM m32p_u) OR target_patient_id IN (SELECT id FROM m32p_u)
  ) c;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'PURGE_REFUSED: fixture coupled to non-fixture data: %', v_bad; END IF;

  -- ------------------------------------------------ bypass history guards
  FOR i IN 1 .. array_length(v_guards, 1) LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', v_guards[i][1], v_guards[i][2]);
  END LOOP;

  -- ------------------------------------------------- deletes (FK order)
  DELETE FROM safety_notification_alerts WHERE subject_key IN (
    SELECT 'episode:' || id FROM m32p_ep UNION SELECT 'event:' || id FROM m32p_ev UNION SELECT 'notice:' || id FROM m32p_n
    UNION SELECT 'outbox:' || id FROM m32p_ob UNION SELECT 'patient:' || id FROM m32p_u UNION SELECT 'immediate_response:' || id FROM m32p_sir);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_notification_alerts', v_n);
  DELETE FROM safety_email_attempts WHERE outbox_id IN (SELECT id FROM m32p_ob);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_email_attempts', v_n);
  DELETE FROM safety_email_requeues WHERE outbox_id IN (SELECT id FROM m32p_ob);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_email_requeues', v_n);
  DELETE FROM safety_email_outbox WHERE id IN (SELECT id FROM m32p_ob);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_email_outbox', v_n);
  DELETE FROM safety_notification_recipients WHERE id IN (SELECT id FROM m32p_r);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_notification_recipients', v_n);
  IF p_fail_after = 'recipients' THEN RAISE EXCEPTION 'PURGE_INDUCED_FAILURE after recipients'; END IF;
  DELETE FROM safety_acute_stop_notices WHERE id IN (SELECT id FROM m32p_n);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_acute_stop_notices', v_n);
  DELETE FROM safety_notification_events WHERE id IN (SELECT id FROM m32p_ev);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('safety_notification_events', v_n);

  DELETE FROM cautious_return_contexts WHERE acute_safety_episode_id IN (SELECT id FROM m32p_ep) OR rehab_session_id IN (SELECT id FROM m32p_s);
  DELETE FROM blocked_loading_opportunities WHERE acute_safety_episode_id IN (SELECT id FROM m32p_ep) OR user_id IN (SELECT id FROM m32p_u);
  DELETE FROM acute_safety_releases WHERE acute_safety_episode_id IN (SELECT id FROM m32p_ep);
  DELETE FROM acute_safety_reassessments WHERE acute_safety_episode_id IN (SELECT id FROM m32p_ep) OR user_id IN (SELECT id FROM m32p_u);
  DELETE FROM acute_safety_episodes WHERE id IN (SELECT id FROM m32p_ep);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('acute_safety_episodes', v_n);
  IF p_fail_after = 'episodes' THEN RAISE EXCEPTION 'PURGE_INDUCED_FAILURE after episodes'; END IF;
  DELETE FROM c5_recovery_decisions WHERE user_id IN (SELECT id FROM m32p_u);
  DELETE FROM m6_longitudinal_interpretations WHERE user_id IN (SELECT id FROM m32p_u);
  DELETE FROM session_guidance_contexts WHERE rehab_session_id IN (SELECT id FROM m32p_s) OR source_rehab_session_id IN (SELECT id FROM m32p_s);
  DELETE FROM rehab_sessions WHERE id IN (SELECT id FROM m32p_s);   -- cascades set_outcomes, responses, evaluations, events, observations, edits
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('rehab_sessions', v_n);
  DELETE FROM notifications WHERE patient_id IN (SELECT id FROM m32p_u) OR patient_prescription_id IN (SELECT id FROM m32p_pp);
  UPDATE patient_prescriptions SET current_prescription_version_id = NULL WHERE id IN (SELECT id FROM m32p_pp);
  DELETE FROM prescription_drafts WHERE patient_prescription_id IN (SELECT id FROM m32p_pp);
  DELETE FROM prescription_pause_periods WHERE patient_prescription_id IN (SELECT id FROM m32p_pp);
  DELETE FROM prescription_versions WHERE user_id IN (SELECT id FROM m32p_u);
  DELETE FROM patient_prescriptions WHERE id IN (SELECT id FROM m32p_pp);
  DELETE FROM invitations WHERE invited_by IN (SELECT id FROM m32p_u) OR accepted_by IN (SELECT id FROM m32p_u)
     OR organization_id IN (SELECT id FROM m32p_o)
     OR lower(email) IN (SELECT lower(u.email) FROM auth.users u WHERE u.id IN (SELECT id FROM m32p_u));
  DELETE FROM supervisor_patients WHERE patient_id IN (SELECT id FROM m32p_u) OR supervisor_id IN (SELECT id FROM m32p_u);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('supervisor_patients', v_n);
  DELETE FROM canonical_exercises WHERE id IN (SELECT id FROM m32p_x);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('canonical_exercises', v_n);
  DELETE FROM organization_members WHERE user_id IN (SELECT id FROM m32p_u);
  DELETE FROM auth.users WHERE id IN (SELECT id FROM m32p_u);   -- cascades profiles, identities and the CASCADE tables
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('auth_users', v_n);
  DELETE FROM organizations WHERE id IN (SELECT id FROM m32p_o);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('organizations', v_n);

  -- --------------------------------------------- restore history guards
  FOR i IN 1 .. array_length(v_guards, 1) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', v_guards[i][1], v_guards[i][2]);
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_trigger WHERE tgname = ANY (ARRAY(SELECT v_guards[g.k][2] FROM generate_subscripts(v_guards, 1) AS g(k))) AND tgenabled = 'O';
  IF v_n <> array_length(v_guards, 1) THEN RAISE EXCEPTION 'PURGE_GUARDS_NOT_RESTORED (% of %)', v_n, array_length(v_guards, 1); END IF;

  -- -------------------------------------------- zero-residue verification
  -- Every public column that references auth.users (catalog-driven) holds
  -- none of the fixture ids, and every M3.2 table holds no fixture row.
  FOR v_fk IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND n.nspname = 'public' AND c.confrelid = 'auth.users'::regclass
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = ANY ($1)', v_fk.tbl, v_fk.col) INTO v_n USING p_users;
    IF v_n > 0 THEN RAISE EXCEPTION 'PURGE_RESIDUE: %.% still references a fixture user (% rows)', v_fk.tbl, v_fk.col, v_n; END IF;
  END LOOP;
  SELECT (SELECT count(*) FROM safety_notification_events WHERE id IN (SELECT id FROM m32p_ev) OR patient_id = ANY (p_users))
       + (SELECT count(*) FROM safety_acute_stop_notices WHERE id IN (SELECT id FROM m32p_n) OR patient_id = ANY (p_users))
       + (SELECT count(*) FROM safety_notification_recipients WHERE id IN (SELECT id FROM m32p_r) OR recipient_user_id = ANY (p_users))
       + (SELECT count(*) FROM safety_email_outbox WHERE id IN (SELECT id FROM m32p_ob))
       + (SELECT count(*) FROM safety_email_attempts WHERE outbox_id IN (SELECT id FROM m32p_ob))
       + (SELECT count(*) FROM safety_email_requeues WHERE outbox_id IN (SELECT id FROM m32p_ob) OR requested_by = ANY (p_users))
       + (SELECT count(*) FROM safety_notification_alerts WHERE subject_key IN (
           SELECT 'episode:' || id FROM m32p_ep UNION SELECT 'event:' || id FROM m32p_ev UNION SELECT 'notice:' || id FROM m32p_n
           UNION SELECT 'outbox:' || id FROM m32p_ob UNION SELECT 'patient:' || id FROM m32p_u UNION SELECT 'immediate_response:' || id FROM m32p_sir))
       + (SELECT count(*) FROM acute_safety_episodes WHERE id IN (SELECT id FROM m32p_ep))
       + (SELECT count(*) FROM rehab_sessions WHERE id IN (SELECT id FROM m32p_s))
       + (SELECT count(*) FROM organizations WHERE id IN (SELECT id FROM m32p_o))
       + (SELECT count(*) FROM canonical_exercises WHERE id IN (SELECT id FROM m32p_x))
    INTO v_n;
  IF v_n > 0 THEN RAISE EXCEPTION 'PURGE_RESIDUE: % fixture row(s) remain', v_n; END IF;

  IF p_fail_after = 'verification' THEN RAISE EXCEPTION 'PURGE_INDUCED_FAILURE after verification'; END IF;
  RETURN jsonb_build_object('result', 'purged', 'fixture_users', array_length(p_users, 1), 'deleted', v_summary, 'residue', 0);
END
$purge$;
