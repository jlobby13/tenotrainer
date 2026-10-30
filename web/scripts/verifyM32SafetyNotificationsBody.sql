-- M3.2 — the safety-notification SQL checks (included by the pre-application
-- proof, after the verbatim migration, and by the post-application suite).
-- Runs inside the caller's transaction, which is always rolled back.
-- ============================================================ inventory / grants
DO $inventory$
DECLARE
  t TEXT; v_bad TEXT := '';
  v_tables TEXT[] := ARRAY['safety_notification_events', 'safety_acute_stop_notices', 'safety_notification_recipients',
    'safety_email_outbox', 'safety_email_attempts', 'safety_email_requeues', 'safety_notification_alerts', 'safety_notification_heartbeats'];
  v_server_fns TEXT[] := ARRAY['safety_notifications_sweep()', 'safety_email_claim(integer,integer,uuid[])',
    'safety_email_record_result(uuid,uuid,text,integer,text,text)', 'safety_email_requeue(uuid,uuid,text)',
    'safety_email_dispatch_heartbeat(boolean,text,jsonb)', 'safety_notification_inbox(uuid,integer)',
    'safety_notification_unread_count(uuid)', 'safety_notification_open(uuid,uuid,boolean)'];
  f RECORD; v_job RECORD;
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN v_bad := v_bad || t || ':rls '; END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t) THEN v_bad := v_bad || t || ':policy '; END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('anon', 'public.' || t, 'INSERT')
       OR has_table_privilege('anon', 'public.' || t, 'UPDATE') OR has_table_privilege('anon', 'public.' || t, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE') OR has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE') OR has_table_privilege('anon', 'public.' || t, 'TRUNCATE') THEN
      v_bad := v_bad || t || ':client_privilege ';
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || t, 'SELECT')
       OR has_table_privilege('service_role', 'public.' || t, 'INSERT') OR has_table_privilege('service_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || t, 'DELETE') OR has_table_privilege('service_role', 'public.' || t, 'TRUNCATE') THEN
      v_bad := v_bad || t || ':service_role_not_read_only ';
    END IF;
  END LOOP;
  PERFORM pg_temp.chk('inventory: 8 tables, RLS on, no policy, no anon/authenticated privilege, service_role read-only', v_bad = '', v_bad);
  PERFORM pg_temp.chk('inventory: health view readable by service_role only',
    has_table_privilege('service_role', 'public.safety_notification_health', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.safety_notification_health', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.safety_notification_health', 'SELECT'));

  v_bad := '';
  FOR f IN SELECT p.oid::regprocedure::text AS sig, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND (p.proname LIKE 'safety\_%' OR p.proname LIKE 'trg\_m32\_%') LOOP
    IF has_function_privilege('anon', f.sig, 'EXECUTE') OR has_function_privilege('authenticated', f.sig, 'EXECUTE') THEN
      v_bad := v_bad || f.sig || ':client ';
    END IF;
    IF has_function_privilege('service_role', f.sig, 'EXECUTE') <> (replace(f.sig, ' ', '') = ANY (v_server_fns)) THEN
      v_bad := v_bad || f.sig || ':service_role_mismatch ';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f.sig::regprocedure)
       AND f.proname NOT IN ('safety_notif_tier_rank', 'safety_email_retry_delay') THEN
      v_bad := v_bad || f.sig || ':not_definer ';
    END IF;
  END LOOP;
  PERFORM pg_temp.chk('inventory: no notifier function is client-executable; service_role executes exactly the 8 server RPCs; all writers SECURITY DEFINER', v_bad = '', v_bad);
  PERFORM pg_temp.chk('inventory: 23 M3.2 functions',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'safety\_%' OR p.proname LIKE 'trg\_m32\_%')) = 23,
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'safety\_%' OR p.proname LIKE 'trg\_m32\_%')));
  PERFORM pg_temp.chk('inventory: exactly ONE safety_email_claim signature (limit, lease, only_outbox_ids uuid[] DEFAULT NULL) — no stale overload',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'safety_email_claim') = 1
    AND (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'safety_email_claim') = 'p_limit integer, p_lease_seconds integer, p_only_outbox_ids uuid[]'
    AND (SELECT pronargdefaults FROM pg_proc WHERE proname = 'safety_email_claim') = 3);
  PERFORM pg_temp.chk('inventory: the 7 notify triggers + 6 history guards exist on the expected tables',
    (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\_m32\_%') = 13
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_acute_safety_episodes_notify' AND tgrelid = 'acute_safety_episodes'::regclass)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_blocked_loading_opportunities_notify' AND tgrelid = 'blocked_loading_opportunities'::regclass)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_acute_safety_reassessments_notify' AND tgrelid = 'acute_safety_reassessments'::regclass)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_acute_safety_releases_notify' AND tgrelid = 'acute_safety_releases'::regclass)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_session_immediate_responses_notify_insert' AND tgrelid = 'session_immediate_responses'::regclass)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_session_immediate_responses_notify_resolve' AND tgrelid = 'session_immediate_responses'::regclass)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_m32_supervisor_patients_notify' AND tgrelid = 'supervisor_patients'::regclass),
    (SELECT count(*)::text FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg\_m32\_%'));

  SELECT * INTO v_job FROM cron.job WHERE jobname = 'tenotrainer_m32_safety_notification_sweep';
  PERFORM pg_temp.chk('pg_cron: exactly one sweep job, every minute, the SQL sweep only, as postgres in this database',
    FOUND AND v_job.schedule = '* * * * *' AND v_job.command = 'SELECT public.safety_notifications_sweep()'
    AND v_job.username = 'postgres' AND v_job.database = current_database() AND v_job.active
    AND (SELECT count(*) FROM cron.job) = 1, to_jsonb(v_job)::text);
  PERFORM pg_temp.chk('pg_cron: the schedule carries no URL, secret or HTTP call',
    NOT EXISTS (SELECT 1 FROM cron.job WHERE command ILIKE '%http%' OR command ILIKE '%net.%' OR command ILIKE '%secret%' OR command ILIKE '%://%'));
  PERFORM pg_temp.chk('pg_net is not installed by this migration',
    NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net'));
  PERFORM pg_temp.chk('effective-level reuse: the evaluator calls acute_episode_review_state and contains no 48-hour / threshold / recurrence logic',
    (SELECT prosrc FROM pg_proc WHERE proname = 'safety_notif_evaluate_episode') LIKE '%acute_episode_review_state(%'
    AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND (p.proname LIKE 'safety\_%' OR p.proname LIKE 'trg\_m32\_%')
                      AND (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '48|recurrence_window|level4_recurrent|blocked_opportunity_count|count\(\*\)[^;]*blocked_loading')));
END
$inventory$;

-- ============================================================ fixtures
DO $fixtures$
DECLARE
  s TEXT := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_a UUID; v_b UUID; v_c UUID; v_ce UUID; v_key TEXT;
BEGIN
  INSERT INTO organizations (name, slug) VALUES ('M3.2 proof org A', 'm32-a-' || s) RETURNING id INTO v_a;
  INSERT INTO organizations (name, slug) VALUES ('M3.2 proof org B', 'm32-b-' || s) RETURNING id INTO v_b;
  INSERT INTO organizations (name, slug) VALUES ('M3.2 proof org C', 'm32-c-' || s) RETURNING id INTO v_c;
  INSERT INTO fx VALUES ('orgA', v_a), ('orgB', v_b), ('orgC', v_c);
  FOREACH v_key IN ARRAY ARRAY['c1', 'c2', 'c3', 'a1', 'super', 'cb', 'ab', 'cc',
                           'pL5', 'pL3', 'pBlk', 'pHold', 'pRec', 'pOrphan', 'pRel', 'pFb', 'pAmb', 'pNone', 'pNoAdmin', 'pFault'] LOOP
    INSERT INTO fx VALUES (v_key, pg_temp.mkuser(v_key));
  END LOOP;
  INSERT INTO organization_members (organization_id, user_id, role)
  SELECT v_a, fx.v, x.r FROM (VALUES ('c1', 'clinician'::org_role), ('c2', 'clinician'), ('c3', 'clinician'), ('a1', 'clinician_admin'), ('super', 'super_user')) x(key, r)
  JOIN fx ON fx.k = x.key;
  INSERT INTO organization_members (organization_id, user_id, role)
  SELECT v_b, fx.v, x.r FROM (VALUES ('cb', 'clinician'::org_role), ('ab', 'clinician_admin')) x(key, r) JOIN fx ON fx.k = x.key;
  INSERT INTO organization_members (organization_id, user_id, role) SELECT v_c, v, 'clinician' FROM fx WHERE fx.k = 'cc';
  -- Patients: org A, except pAmb (A and B), pNone (no organization), pNoAdmin (C: no clinician_admin).
  INSERT INTO organization_members (organization_id, user_id, role)
  SELECT v_a, v, 'member' FROM fx WHERE fx.k IN ('pL5', 'pL3', 'pBlk', 'pHold', 'pRec', 'pOrphan', 'pRel', 'pFb', 'pAmb', 'pFault');
  INSERT INTO organization_members (organization_id, user_id, role) SELECT v_b, v, 'member' FROM fx WHERE fx.k = 'pAmb';
  INSERT INTO organization_members (organization_id, user_id, role) SELECT v_c, v, 'member' FROM fx WHERE fx.k = 'pNoAdmin';

  -- Assignments: pL5 has c1 + c2 active and c3 ENDED; most others c1.
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id)
  SELECT v_a, (SELECT v FROM fx WHERE fx.k = c), (SELECT v FROM fx WHERE fx.k = p)
  FROM (VALUES ('c1', 'pL5'), ('c2', 'pL5'), ('c3', 'pL5'), ('c1', 'pL3'), ('c1', 'pBlk'), ('c1', 'pHold'), ('c1', 'pRec'),
               ('c1', 'pOrphan'), ('c1', 'pRel'), ('c1', 'pFault')) x(c, p);
  UPDATE supervisor_patients SET status = 'dismissed', dismissed_at = now()
  WHERE supervisor_id = (SELECT v FROM fx WHERE fx.k = 'c3') AND patient_id = (SELECT v FROM fx WHERE fx.k = 'pL5');

  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('M3.2 proof exercise ' || s, 'global', true) RETURNING id INTO v_ce;
  INSERT INTO fx VALUES ('ce', v_ce);
END
$fixtures$;

-- ============================================================ main
DO $verify$
DECLARE
  F JSONB;
  c1 UUID; c2 UUID; c3 UUID; a1 UUID; su UUID; cb UUID; ab UUID;
  pL5 UUID; pL3 UUID; pBlk UUID; pHold UUID; pRec UUID; pOrphan UUID; pRel UUID; pFb UUID; pAmb UUID; pNone UUID; pNoAdmin UUID; pFault UUID;
  v_orgA UUID; v_orgB UUID; v_ce UUID;
  rx JSONB; s1 UUID; s2 UUID; v_ep UUID; v_ep2 UUID; v_ev UUID; v_ev2 UUID; v_notice UUID; v_ob UUID; v_ob2 UUID;
  v_r JSONB; v_res RECORD; v_n INT; v_n2 INT; v_t TEXT; v_ok BOOLEAN; v_def TEXT; v_def2 TEXT; v_claim RECORD; v_tok UUID; v_key TEXT;
  v_rid UUID; v_pass INT; v_fail INT; v_eps UUID[]; v_sa UUID; v_sb UUID; v_ids UUID[];
  L3 CONSTANT JSONB := '{"peak_session_pain": 4, "overall_session_rpe": 5, "sudden_or_sharp_pain": true, "pop_felt_or_heard": false, "new_functional_difficulty": false}';
  L3_ACUTE CONSTANT JSONB := '{"sudden_or_sharp_pain": true}';
BEGIN
  SELECT jsonb_object_agg(fx.k, fx.v) INTO F FROM fx;
  c1 := F->>'c1'; c2 := F->>'c2'; c3 := F->>'c3'; a1 := F->>'a1'; su := F->>'super'; cb := F->>'cb'; ab := F->>'ab';
  pL5 := F->>'pL5'; pL3 := F->>'pL3'; pBlk := F->>'pBlk'; pHold := F->>'pHold'; pRec := F->>'pRec'; pOrphan := F->>'pOrphan';
  pRel := F->>'pRel'; pFb := F->>'pFb'; pAmb := F->>'pAmb'; pNone := F->>'pNone'; pNoAdmin := F->>'pNoAdmin'; pFault := F->>'pFault';
  v_orgA := F->>'orgA'; v_orgB := F->>'orgB'; v_ce := F->>'ce';

  -- ================= recipient resolution (pure) =================
  SELECT * INTO v_res FROM safety_notif_resolve_recipients(pL5);
  PERFORM pg_temp.chk('recipients: every ACTIVE assigned clinician (c1, c2); the ended assignment (c3) and other orgs excluded',
    v_res.o_resolution = 'assigned_clinicians' AND v_res.o_organization_id = v_orgA
    AND (SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') FROM jsonb_array_elements(v_res.o_recipients) x)
        = (SELECT array_agg(u ORDER BY u::text) FROM unnest(ARRAY[c1, c2]) u)
    AND NOT v_res.o_recipients::text LIKE '%' || c3::text || '%' AND NOT v_res.o_recipients::text LIKE '%' || cb::text || '%'
    AND (SELECT bool_and(x->>'basis' = 'assigned_clinician' AND x->>'supervisor_patient_id' IS NOT NULL) FROM jsonb_array_elements(v_res.o_recipients) x),
    v_res.o_recipients::text);
  SELECT * INTO v_res FROM safety_notif_resolve_recipients(pFb);
  PERFORM pg_temp.chk('recipients: no active clinician -> the clinician_admins of the patient''s single organization only (not super_user, not org B)',
    v_res.o_resolution = 'fallback_clinician_admins' AND jsonb_array_length(v_res.o_recipients) = 1
    AND (v_res.o_recipients->0->>'user_id')::uuid = a1 AND v_res.o_recipients->0->>'basis' = 'fallback_clinician_admin'
    AND (v_res.o_recipients->0->>'organization_id')::uuid = v_orgA, v_res.o_recipients::text);
  SELECT * INTO v_res FROM safety_notif_resolve_recipients(pAmb);
  PERFORM pg_temp.chk('recipients: two patient organizations and no assignment -> fail closed (no recipient, no org)',
    v_res.o_resolution = 'failed_ambiguous_patient_organization' AND v_res.o_organization_id IS NULL
    AND coalesce(jsonb_array_length(v_res.o_recipients), 0) = 0, row_to_json(v_res)::text);
  SELECT * INTO v_res FROM safety_notif_resolve_recipients(pNone);
  PERFORM pg_temp.chk('recipients: no patient organization -> failed_no_patient_organization',
    v_res.o_resolution = 'failed_no_patient_organization' AND coalesce(jsonb_array_length(v_res.o_recipients), 0) = 0);
  SELECT * INTO v_res FROM safety_notif_resolve_recipients(pNoAdmin);
  PERFORM pg_temp.chk('recipients: single organization without a clinician_admin -> no_eligible_recipients (the org clinician is not assigned, not notified)',
    v_res.o_resolution = 'no_eligible_recipients' AND jsonb_array_length(v_res.o_recipients) = 0);

  -- ================= L5 through the real acute Stop -> check-in -> reconcile path =================
  rx := pg_temp.rx(pL5, c1, v_ce);
  s1 := pg_temp.closed(pL5, rx, 3, '{"pop_felt_or_heard": true}', NULL);
  SELECT id INTO v_notice FROM safety_acute_stop_notices WHERE rehab_session_id = s1;
  PERFORM pg_temp.chk('D6: an acute Stop with a recorded safety fact opens ONE outstanding-check-in notice (transition hook)',
    v_notice IS NOT NULL AND (SELECT detected_by = 'transition' AND resolved_at IS NULL AND recipient_resolution = 'assigned_clinicians'
                              FROM safety_acute_stop_notices WHERE id = v_notice));
  PERFORM pg_temp.chk('D6: notice recipients are the assigned clinicians, in-app only (no outbox row)',
    (SELECT array_agg(recipient_user_id ORDER BY recipient_user_id::text) FROM safety_notification_recipients WHERE acute_stop_notice_id = v_notice)
      = (SELECT array_agg(u ORDER BY u::text) FROM unnest(ARRAY[c1, c2]) u)
    AND NOT EXISTS (SELECT 1 FROM safety_email_outbox o JOIN safety_notification_recipients r ON r.id = o.recipient_id WHERE r.acute_stop_notice_id = v_notice));
  PERFORM pg_temp.chk('D6: the notice classifies nothing — no evaluation, no episode, no episode event, gate semantics unchanged',
    NOT EXISTS (SELECT 1 FROM escalation_evaluations WHERE rehab_session_id = s1)
    AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes WHERE user_id = pL5)
    AND NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE patient_id = pL5)
    AND c5_get_start_eligibility(pL5)->>'result' = 'immediate_response_required');
  PERFORM c5_stop_session(pL5, s1, '{"pop_felt_or_heard": true}');
  PERFORM pg_temp.chk('D6: replaying the Stop creates no second notice', (SELECT count(*) FROM safety_acute_stop_notices WHERE patient_id = pL5) = 1);

  v_r := c5_submit_immediate_response(pL5, s1, '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('D6: submitting the check-in resolves the notice (check_in_submitted) in the same transaction',
    v_r->>'result' = 'submitted' AND (v_r->>'escalation_level')::int = 5
    AND (SELECT resolved_at IS NOT NULL AND resolution = 'check_in_submitted' AND superseded_by_event_id IS NULL FROM safety_acute_stop_notices WHERE id = v_notice), v_r::text);
  PERFORM pg_temp.chk('crash window (fact committed, not yet reconciled): no episode, no event; the gate fails closed as before',
    NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE patient_id = pL5)
    AND c5_get_start_eligibility(pL5)->>'result' = 'acute_safety_reconciliation_required');
  SELECT count(DISTINCT rs.user_id) INTO v_n FROM escalation_evaluations ee JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
   WHERE ee.escalation_level IN (3, 5) AND rs.user_id <> pL5
     AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes a WHERE a.source_escalation_evaluation_id = ee.id);
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('sweep grace: a fact younger than 2 minutes is left to the normal request path',
    NOT EXISTS (SELECT 1 FROM acute_safety_episodes WHERE user_id = pL5), v_r::text);
  PERFORM pg_temp.chk('sweep: every PRE-EXISTING development orphan L3/L5 fact (outside the fixtures) is reconciled by the first sweep',
    (v_r->>'orphan_patients_reconciled')::int = v_n AND (v_r->>'reconcile_failed')::int = 0, v_r::text);
  INSERT INTO verify_results(result) VALUES ('INFO: pre-existing development patients with an orphan L3/L5 fact reconciled by the first sweep: ' || v_n);

  PERFORM pg_temp.reconcile(pL5);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pL5;
  SELECT id INTO v_ev FROM safety_notification_events WHERE acute_safety_episode_id = v_ep;
  PERFORM pg_temp.chk('L5: reconcile creates the episode AND, atomically, one urgent_clinician_review event (email required)',
    (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 1
    AND (SELECT tier = 'urgent_clinician_review' AND email_required AND effective_level = 5 AND detected_by = 'transition'
              AND recipient_resolution = 'assigned_clinicians' AND organization_id = v_orgA AND resolved_at IS NULL
         FROM safety_notification_events WHERE id = v_ev));
  PERFORM pg_temp.chk('L5: recipients c1 + c2 (assigned_clinician, with assignment period); ended c3 not notified',
    (SELECT array_agg(recipient_user_id ORDER BY recipient_user_id::text) FROM safety_notification_recipients WHERE event_id = v_ev)
      = (SELECT array_agg(u ORDER BY u::text) FROM unnest(ARRAY[c1, c2]) u)
    AND (SELECT bool_and(basis = 'assigned_clinician' AND supervisor_patient_id IS NOT NULL AND read_at IS NULL) FROM safety_notification_recipients WHERE event_id = v_ev));
  PERFORM pg_temp.chk('L5: one pending outbox intent per recipient, stable generation-1 idempotency key, nothing attempted yet',
    (SELECT count(*) FROM safety_email_outbox WHERE event_id = v_ev) = 2
    AND (SELECT bool_and(status = 'pending' AND generation = 1 AND attempt_count = 0 AND tier = 'urgent_clinician_review'
                         AND idempotency_key = 'tenotrainer-safety-email/' || id::text || '/g1' AND provider_message_id IS NULL)
         FROM safety_email_outbox WHERE event_id = v_ev)
    AND NOT EXISTS (SELECT 1 FROM safety_email_attempts a JOIN safety_email_outbox o ON o.id = a.outbox_id WHERE o.event_id = v_ev));
  PERFORM pg_temp.chk('D6: the classified event supersedes the notice (explicit link, no unexplained duplicate)',
    (SELECT superseded_by_event_id = v_ev AND resolution = 'check_in_submitted' FROM safety_acute_stop_notices WHERE id = v_notice));
  v_n := pg_temp.reconcile(pL5);
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('duplicate reconciliation + sweep: no second episode, event, recipient or outbox row',
    v_n = 0 AND (SELECT count(*) FROM acute_safety_episodes WHERE user_id = pL5) = 1
    AND (SELECT count(*) FROM safety_notification_events WHERE patient_id = pL5) = 1
    AND (SELECT count(*) FROM safety_notification_recipients WHERE event_id = v_ev) = 2
    AND (SELECT count(*) FROM safety_email_outbox WHERE event_id = v_ev) = 2, v_r::text);

  -- ================= ordinary L3 -> >48 h (sweep, time-only transition) =================
  rx := pg_temp.rx(pL3, c1, v_ce);
  s1 := pg_temp.closed(pL3, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pL3);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pL3;
  SELECT id INTO v_ev FROM safety_notification_events WHERE acute_safety_episode_id = v_ep;
  PERFORM pg_temp.chk('L3: one safety_review event, in-app only (email not required, no outbox), no acute-stop notice (plain Stop)',
    (SELECT tier = 'safety_review' AND NOT email_required AND effective_level = 3 AND NOT professionally_held FROM safety_notification_events WHERE id = v_ev)
    AND (SELECT count(*) FROM safety_notification_recipients WHERE event_id = v_ev) = 1
    AND NOT EXISTS (SELECT 1 FROM safety_email_outbox WHERE event_id = v_ev)
    AND NOT EXISTS (SELECT 1 FROM safety_acute_stop_notices WHERE patient_id = pL3));
  UPDATE acute_safety_episodes SET confirmed_at = now() - interval '49 hours' WHERE id = v_ep;   -- time passes
  PERFORM pg_temp.chk('fixture: the authoritative derivation now reports effective 4 for > 48 h (no write happened)',
    (SELECT effective_level = 4 AND 'unresolved_over_48_hours' = ANY (level4_reasons) AND requires_clinician_release FROM acute_episode_review_state(v_ep)));
  PERFORM pg_temp.chk('> 48 h: before the sweep there is no clinician_review event (no hook exists for a pure time transition)',
    NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE acute_safety_episode_id = v_ep AND tier = 'clinician_review'));
  v_r := safety_notifications_sweep();
  SELECT id INTO v_ev2 FROM safety_notification_events WHERE acute_safety_episode_id = v_ep AND tier = 'clinician_review';
  PERFORM pg_temp.chk('> 48 h: the sweep detects it — clinician_review event (detected_by sweep, reason unresolved_over_48_hours, email)',
    v_ev2 IS NOT NULL AND (SELECT detected_by = 'sweep' AND email_required AND effective_level = 4
                                  AND review_reasons = ARRAY['unresolved_over_48_hours'] FROM safety_notification_events WHERE id = v_ev2)
    AND (SELECT count(*) FROM safety_email_outbox WHERE event_id = v_ev2) = 1, v_r::text);
  PERFORM pg_temp.chk('> 48 h: the lower event is kept as history and marked superseded (upward only)',
    (SELECT superseded_by_event_id = v_ev2 AND resolved_at IS NULL FROM safety_notification_events WHERE id = v_ev));
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('> 48 h: a second sweep changes nothing',
    (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 2
    AND (SELECT count(*) FROM safety_email_outbox WHERE event_id = v_ev2) = 1);

  -- ================= blocked loading opportunities -> effective 4 =================
  rx := pg_temp.rx(pBlk, c1, v_ce);
  PERFORM pg_temp.closed(pBlk, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pBlk);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pBlk;
  v_r := c5_record_first_performance(pBlk, gen_random_uuid(), (rx->>'v')::uuid, (rx->>'w')::uuid,
           jsonb_build_object('exercise_id', rx->>'e', 'unit_index', 0, 'outcome', 'completed', 'actual_reps', 8), '[]'::jsonb, NULL);
  PERFORM pg_temp.chk('blocked: a real Start attempt under the brake records blocked opportunity #1; still safety_review only',
    v_r->>'result' LIKE 'acute_safety_%' AND (SELECT count(*) FROM blocked_loading_opportunities WHERE acute_safety_episode_id = v_ep) = 1
    AND (SELECT array_agg(tier) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = ARRAY['safety_review'], v_r::text);
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level) VALUES (pBlk, v_ep, 'c5-day:m32-2', 3);
  PERFORM pg_temp.chk('blocked: #2 still no escalation', NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE acute_safety_episode_id = v_ep AND tier = 'clinician_review'));
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level) VALUES (pBlk, v_ep, 'c5-day:m32-3', 3);
  PERFORM pg_temp.chk('blocked: #3 escalates IN THE SAME TRANSACTION (transition hook) — clinician_review, reason three_blocked_opportunities',
    (SELECT detected_by = 'transition' AND email_required AND review_reasons = ARRAY['three_blocked_opportunities']
     FROM safety_notification_events WHERE acute_safety_episode_id = v_ep AND tier = 'clinician_review'));
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level)
  VALUES (pBlk, v_ep, 'c5-day:m32-3', 3) ON CONFLICT DO NOTHING;
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level) VALUES (pBlk, v_ep, 'c5-day:m32-4', 3);
  PERFORM pg_temp.chk('blocked: a duplicate-day opportunity and a 4th opportunity create nothing new',
    (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 2);

  -- ================= reassessment professional hold =================
  rx := pg_temp.rx(pHold, c1, v_ce);
  PERFORM pg_temp.closed(pHold, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pHold);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pHold;
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
  VALUES (v_ep, pHold, true, NULL, false, NULL);
  PERFORM pg_temp.chk('reassessment without a hold: no new notification', (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 1);
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
  VALUES (v_ep, pHold, false, NULL, true, false);
  PERFORM pg_temp.chk('reassessment hold (evaluated, not cleared): clinician_review in the same transaction, effective 3 + professional_hold, email',
    (SELECT detected_by = 'transition' AND effective_level = 3 AND professionally_held AND review_reasons = ARRAY['professional_hold'] AND email_required
     FROM safety_notification_events WHERE acute_safety_episode_id = v_ep AND tier = 'clinician_review'));
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
  VALUES (v_ep, pHold, false, NULL, true, false);
  PERFORM pg_temp.chk('reassessment while review is already required: no new notification',
    (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 2);

  -- ================= recurrence + multiple simultaneous open episodes =================
  rx := pg_temp.rx(pRec, c1, v_ce);
  FOR v_n IN 1..4 LOOP
    s1 := pg_temp.closed(pRec, rx, 10 - 2 * v_n, L3_ACUTE, L3);
    -- Distinct evaluation instants (now() is constant inside this transaction).
    UPDATE escalation_evaluations SET evaluated_at = now() - make_interval(mins => 50 - 10 * v_n) WHERE rehab_session_id = s1;
  END LOOP;
  PERFORM pg_temp.chk('fixture: four acute-stop notices, each resolved by its submitted check-in',
    (SELECT count(*) FILTER (WHERE resolution = 'check_in_submitted') FROM safety_acute_stop_notices WHERE patient_id = pRec) = 4);
  v_n := pg_temp.reconcile(pRec);
  SELECT array_agg(id ORDER BY recurrence_sequence_in_window) INTO v_eps FROM acute_safety_episodes WHERE user_id = pRec;
  PERFORM pg_temp.chk('recurrence: the 4th episode is born effective 4 -> ONE clinician_review event (no back-filled safety_review)',
    v_n = 4 AND (SELECT level4_recurrent FROM acute_safety_episodes WHERE id = v_eps[4])
    AND (SELECT array_agg(tier) FROM safety_notification_events WHERE acute_safety_episode_id = v_eps[4]) = ARRAY['clinician_review']
    AND (SELECT review_reasons = ARRAY['recurrent_level_3_episodes'] FROM safety_notification_events WHERE acute_safety_episode_id = v_eps[4]));
  PERFORM pg_temp.chk('multiple open episodes: episodes 1-3 each keep their own safety_review event; four independent events',
    (SELECT count(*) FROM safety_notification_events WHERE patient_id = pRec) = 4
    AND (SELECT bool_and(tier = 'safety_review') FROM safety_notification_events WHERE acute_safety_episode_id = ANY (v_eps[1:3])));
  PERFORM pg_temp.chk('D6 dedupe: every notice is linked to the classified event of its own session',
    (SELECT bool_and(n.superseded_by_event_id = e.id) FROM safety_acute_stop_notices n
       JOIN acute_safety_episodes ep ON ep.source_rehab_session_id = n.rehab_session_id
       JOIN safety_notification_events e ON e.acute_safety_episode_id = ep.id
      WHERE n.patient_id = pRec));

  -- ================= orphan fact repaired by the sweep (crash window), born > 48 h =================
  rx := pg_temp.rx(pOrphan, c1, v_ce);
  s1 := pg_temp.closed(pOrphan, rx, 3, NULL, L3);
  UPDATE escalation_evaluations SET evaluated_at = now() - interval '50 hours' WHERE rehab_session_id = s1;   -- the process died 50 h ago
  PERFORM pg_temp.chk('orphan: an L3 fact with no episode (process died before reconcile)',
    NOT EXISTS (SELECT 1 FROM acute_safety_episodes WHERE user_id = pOrphan));
  v_r := safety_notifications_sweep();
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pOrphan;
  PERFORM pg_temp.chk('orphan: the sweep reconciles it through the EXISTING reconcile function (confirmed_at = evaluated_at)',
    v_ep IS NOT NULL AND (v_r->>'orphan_patients_reconciled')::int = 1
    AND (SELECT confirmed_at = now() - interval '50 hours' FROM acute_safety_episodes WHERE id = v_ep), v_r::text);
  PERFORM pg_temp.chk('orphan: born effective 4 -> a single clinician_review event (no meaningless lower tier), email intent created',
    (SELECT array_agg(tier) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = ARRAY['clinician_review']
    AND (SELECT count(*) FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.acute_safety_episode_id = v_ep) = 1);
  PERFORM pg_temp.chk('orphan: recorded as a historical operational fact (orphan_fact_reconciled, already cleared)',
    EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'orphan_fact_reconciled' AND subject_key = 'patient:' || pOrphan::text AND cleared_at IS NOT NULL));
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('orphan: duplicate sweep reconciles nothing more', (v_r->>'orphan_patients_reconciled')::int = 0
    AND (SELECT count(*) FROM acute_safety_episodes WHERE user_id = pOrphan) = 1);

  -- ================= release =================
  rx := pg_temp.rx(pRel, c1, v_ce);
  PERFORM pg_temp.closed(pRel, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pRel);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pRel;
  INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path)
  VALUES (v_ep, pRel, 'self_resolved_no_evaluation');
  PERFORM pg_temp.chk('release (ordinary L3, patient path): no new notification; the event is resolved and kept',
    (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 1
    AND (SELECT resolved_at IS NOT NULL FROM safety_notification_events WHERE acute_safety_episode_id = v_ep));

  SELECT e.id INTO v_ep FROM acute_safety_episodes e WHERE e.user_id = pL5;
  SELECT id INTO v_ev FROM safety_notification_events WHERE acute_safety_episode_id = v_ep;
  v_r := clinician_release_acute_episode(v_ep, c1, 'Reviewed by phone; cleared to resume.');
  PERFORM pg_temp.chk('clinician release (L5): released by the existing M1 function; no new notification; event resolved',
    v_r->>'result' = 'released' AND (SELECT count(*) FROM safety_notification_events WHERE acute_safety_episode_id = v_ep) = 1
    AND (SELECT resolved_at IS NOT NULL FROM safety_notification_events WHERE id = v_ev), v_r::text);
  PERFORM pg_temp.chk('clinician release: unsent email intents become suppressed_episode_released (terminal, not failed)',
    (SELECT bool_and(status = 'suppressed_episode_released' AND terminal_at IS NOT NULL AND provider_message_id IS NULL) FROM safety_email_outbox WHERE event_id = v_ev));
  PERFORM pg_temp.chk('release: recipient history is kept', (SELECT count(*) FROM safety_notification_recipients WHERE event_id = v_ev) = 2);

  -- ================= fallback admins, then a late assignment (D2) =================
  rx := pg_temp.rx(pFb, a1, v_ce);
  PERFORM pg_temp.closed(pFb, rx, 2, NULL, '{"peak_session_pain": 7, "overall_session_rpe": 6, "sudden_or_sharp_pain": false, "pop_felt_or_heard": true, "new_functional_difficulty": false}');
  PERFORM pg_temp.reconcile(pFb);
  SELECT e.id INTO v_ev FROM safety_notification_events e WHERE e.patient_id = pFb;
  PERFORM pg_temp.chk('fallback: no assigned clinician -> clinician_admin a1 of the patient''s org (fallback basis, email for L5); no org B admin, no super_user',
    (SELECT recipient_resolution = 'fallback_clinician_admins' AND tier = 'urgent_clinician_review' FROM safety_notification_events WHERE id = v_ev)
    AND (SELECT array_agg(recipient_user_id) FROM safety_notification_recipients WHERE event_id = v_ev) = ARRAY[a1]
    AND (SELECT basis = 'fallback_clinician_admin' AND supervisor_patient_id IS NULL FROM safety_notification_recipients WHERE event_id = v_ev)
    AND (SELECT count(*) FROM safety_email_outbox WHERE event_id = v_ev) = 1);
  PERFORM pg_temp.chk('fallback: receiving the notification grants no clinical access (clinician_patient_access still false)',
    NOT clinician_patient_access(a1, pFb));
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (v_orgA, c2, pFb);
  PERFORM pg_temp.chk('D2: a clinician assigned while the event is open is added immediately (late_assignment, assignment period, email intent)',
    (SELECT basis = 'late_assignment' AND supervisor_patient_id IS NOT NULL FROM safety_notification_recipients WHERE event_id = v_ev AND recipient_user_id = c2)
    AND EXISTS (SELECT 1 FROM safety_email_outbox o JOIN safety_notification_recipients r ON r.id = o.recipient_id WHERE r.event_id = v_ev AND r.recipient_user_id = c2));
  PERFORM pg_temp.chk('D2: the fallback admin''s row remains (history is never retracted)',
    EXISTS (SELECT 1 FROM safety_notification_recipients WHERE event_id = v_ev AND recipient_user_id = a1));
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('D2: the sweep does not add the same late recipient twice',
    (SELECT count(*) FROM safety_notification_recipients WHERE event_id = v_ev) = 2);

  -- ================= ambiguous / missing organization fail closed (through real events) =================
  rx := pg_temp.rx(pAmb, cb, v_ce);
  PERFORM pg_temp.closed(pAmb, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pAmb);
  SELECT e.id INTO v_ev FROM safety_notification_events e WHERE e.patient_id = pAmb;
  PERFORM pg_temp.chk('ambiguous org: event recorded with failed_ambiguous_patient_organization, organization NULL, ZERO recipients',
    (SELECT recipient_resolution = 'failed_ambiguous_patient_organization' AND organization_id IS NULL FROM safety_notification_events WHERE id = v_ev)
    AND NOT EXISTS (SELECT 1 FROM safety_notification_recipients WHERE event_id = v_ev));
  PERFORM pg_temp.chk('ambiguous org: surfaced operationally (open recipient_resolution_failed alert)',
    EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'recipient_resolution_failed' AND subject_key = 'event:' || v_ev::text AND cleared_at IS NULL));
  rx := pg_temp.rx(pNone, c1, v_ce);
  PERFORM pg_temp.closed(pNone, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pNone);
  rx := pg_temp.rx(pNoAdmin, c1, v_ce);
  PERFORM pg_temp.closed(pNoAdmin, rx, 2, NULL, L3);
  PERFORM pg_temp.reconcile(pNoAdmin);
  PERFORM pg_temp.chk('no organization / no admin: recorded, zero recipients, alerts raised',
    (SELECT recipient_resolution FROM safety_notification_events WHERE patient_id = pNone) = 'failed_no_patient_organization'
    AND (SELECT recipient_resolution FROM safety_notification_events WHERE patient_id = pNoAdmin) = 'no_eligible_recipients'
    AND NOT EXISTS (SELECT 1 FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id WHERE e.patient_id IN (pNone, pNoAdmin))
    AND EXISTS (SELECT 1 FROM safety_notification_alerts a JOIN safety_notification_events e ON a.subject_key = 'event:' || e.id::text WHERE e.patient_id = pNoAdmin AND a.kind = 'no_eligible_recipients'));
  PERFORM pg_temp.chk('cross-organization isolation: no org B member and no super_user is a recipient of any org A patient',
    NOT EXISTS (SELECT 1 FROM safety_notification_recipients WHERE recipient_user_id IN (cb, ab, su)));

  -- ================= exception isolation =================
  rx := pg_temp.rx(pFault, c1, v_ce);
  v_def := pg_get_functiondef('safety_notif_evaluate_episode(uuid,text)'::regprocedure);
  v_def2 := pg_get_functiondef('safety_notif_sync_acute_stop_notice(uuid,text)'::regprocedure);
  EXECUTE $f$CREATE OR REPLACE FUNCTION public.safety_notif_evaluate_episode(p_episode_id UUID, p_source TEXT) RETURNS UUID
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $b$ BEGIN RAISE EXCEPTION 'injected notifier fault' USING ERRCODE = 'XX000'; END $b$$f$;
  EXECUTE $f$CREATE OR REPLACE FUNCTION public.safety_notif_sync_acute_stop_notice(p_response_id UUID, p_source TEXT) RETURNS UUID
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $b$ BEGIN RAISE EXCEPTION 'injected notifier fault' USING ERRCODE = 'XX000'; END $b$$f$;

  s1 := pg_temp.closed(pFault, rx, 4, L3_ACUTE, NULL);
  PERFORM pg_temp.chk('isolation: the acute Stop (immediate-response insert) commits when the notice hook fails',
    (SELECT training_status FROM rehab_sessions WHERE id = s1) = 'stopped_acute'
    AND EXISTS (SELECT 1 FROM session_immediate_responses WHERE rehab_session_id = s1 AND sudden_or_sharp_pain)
    AND NOT EXISTS (SELECT 1 FROM safety_acute_stop_notices WHERE rehab_session_id = s1)
    AND EXISTS (SELECT 1 FROM safety_notification_alerts a JOIN session_immediate_responses r ON a.subject_key = 'immediate_response:' || r.id::text
                WHERE r.rehab_session_id = s1 AND a.kind = 'notification_hook_failed' AND a.cleared_at IS NULL AND a.detail_code = 'XX000'));
  v_r := c5_submit_immediate_response(pFault, s1, L3);
  v_n := pg_temp.reconcile(pFault);
  SELECT id INTO v_ep FROM acute_safety_episodes WHERE user_id = pFault;
  PERFORM pg_temp.chk('isolation: the check-in commits and reconciliation creates the episode although the episode hook fails',
    v_r->>'result' = 'submitted' AND v_n = 1 AND v_ep IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE acute_safety_episode_id = v_ep), v_r::text);
  PERFORM pg_temp.chk('isolation: reconciliation is not stuck — the gate reports the brake, not acute_safety_reconciliation_required',
    c5_get_start_eligibility(pFault)->>'result' IN ('acute_safety_review_required', 'acute_safety_professional_review_required'));
  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level) VALUES (pFault, v_ep, 'c5-day:m32-f1', 3);
  INSERT INTO acute_safety_reassessments (acute_safety_episode_id, user_id, sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional)
  VALUES (v_ep, pFault, true, NULL, true, false);
  PERFORM pg_temp.chk('isolation: blocked opportunity and reassessment commit when the hook fails',
    (SELECT count(*) FROM blocked_loading_opportunities WHERE acute_safety_episode_id = v_ep) = 1
    AND (SELECT count(*) FROM acute_safety_reassessments WHERE acute_safety_episode_id = v_ep) = 1
    AND (SELECT occurrences >= 3 FROM safety_notification_alerts WHERE kind = 'notification_hook_failed' AND subject_key = 'episode:' || v_ep::text AND cleared_at IS NULL));
  v_r := clinician_release_acute_episode(v_ep, c1, 'Seen in clinic.');
  PERFORM pg_temp.chk('isolation: the clinician release commits when the hook fails',
    v_r->>'result' = 'released' AND EXISTS (SELECT 1 FROM acute_safety_releases WHERE acute_safety_episode_id = v_ep), v_r::text);

  EXECUTE v_def;    -- the notifier is fixed
  EXECUTE v_def2;
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('repair: the sweep resolves the released episode (no stale open event) and clears the hook alert',
    NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE acute_safety_episode_id = v_ep AND resolved_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'notification_hook_failed' AND subject_key = 'episode:' || v_ep::text AND cleared_at IS NULL), v_r::text);

  -- A second fault case left OPEN, so the sweep must create the missing event.
  EXECUTE $f$CREATE OR REPLACE FUNCTION public.safety_notif_evaluate_episode(p_episode_id UUID, p_source TEXT) RETURNS UUID
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $b$ BEGIN RAISE EXCEPTION 'injected notifier fault' USING ERRCODE = 'XX000'; END $b$$f$;
  PERFORM pg_temp.closed(pFault, rx, 1, NULL, L3);
  v_n := pg_temp.reconcile(pFault);
  SELECT e.id INTO v_ep2 FROM acute_safety_episodes e WHERE e.user_id = pFault AND e.id <> v_ep;
  EXECUTE v_def;
  PERFORM pg_temp.chk('repair: before the sweep the open episode has no event', NOT EXISTS (SELECT 1 FROM safety_notification_events WHERE acute_safety_episode_id = v_ep2));
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('repair: the sweep creates the missing event (detected_by sweep) with its recipients and clears the alert',
    (SELECT detected_by = 'sweep' FROM safety_notification_events WHERE acute_safety_episode_id = v_ep2)
    AND (SELECT count(*) FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id WHERE e.acute_safety_episode_id = v_ep2) = 1
    AND NOT EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'notification_hook_failed' AND subject_key = 'episode:' || v_ep2::text AND cleared_at IS NULL), v_r::text);
  PERFORM pg_temp.chk('isolation: the faulted functions were restored verbatim',
    pg_get_functiondef('safety_notif_evaluate_episode(uuid,text)'::regprocedure) = v_def
    AND pg_get_functiondef('safety_notif_sync_acute_stop_notice(uuid,text)'::regprocedure) = v_def2);

  -- ================= effective-level reuse across every fixture episode =================
  SELECT bool_and(
           (SELECT e.tier FROM safety_notification_events e WHERE e.acute_safety_episode_id = ep.id ORDER BY safety_notif_tier_rank(e.tier) DESC LIMIT 1)
           = CASE WHEN st.effective_level >= 5 THEN 'urgent_clinician_review' WHEN st.requires_clinician_release THEN 'clinician_review' ELSE 'safety_review' END),
         count(*)
    INTO v_ok, v_n
  FROM acute_safety_episodes ep, LATERAL acute_episode_review_state(ep.id) st
  WHERE ep.user_id IN (pL3, pBlk, pHold, pRec, pOrphan, pFb, pAmb, pNone, pNoAdmin) AND NOT st.released;
  PERFORM pg_temp.chk('reuse: for every open fixture episode the highest event tier equals the mapping of acute_episode_review_state', v_ok AND v_n >= 10, v_n::text);

  -- ================= ended assignment: hidden, never emailed, history kept =================
  rx := NULL;
  SELECT e.id INTO v_ev FROM safety_notification_events e WHERE e.patient_id = pL3 AND e.tier = 'clinician_review';
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (v_orgA, c2, pL3);
  PERFORM pg_temp.chk('late assignment on an open clinician_review event adds c2 with an email intent',
    EXISTS (SELECT 1 FROM safety_notification_recipients WHERE event_id = v_ev AND recipient_user_id = c2 AND basis = 'late_assignment'));
  SELECT r.id INTO v_rid FROM safety_notification_recipients r WHERE r.event_id = v_ev AND r.recipient_user_id = c2;
  UPDATE supervisor_patients SET status = 'dismissed', dismissed_at = now() WHERE supervisor_id = c2 AND patient_id = pL3 AND status = 'active';
  PERFORM pg_temp.chk('ended assignment: the row is no longer eligible and is absent from c2''s inbox, but the history row remains',
    NOT safety_notif_recipient_eligible(v_rid)
    AND NOT EXISTS (SELECT 1 FROM safety_notification_inbox(c2, 500) WHERE recipient_id = v_rid)
    AND EXISTS (SELECT 1 FROM safety_notification_recipients WHERE id = v_rid));
  PERFORM pg_temp.chk('ended assignment: opening it as the former clinician is refused (no clinical detail exposed)',
    safety_notification_open(v_rid, c2, true)->>'result' = 'not_found' AND (SELECT read_at IS NULL FROM safety_notification_recipients WHERE id = v_rid));

  -- ================= inbox / open / read_at =================
  SELECT r.id INTO v_rid FROM safety_notification_recipients r WHERE r.event_id = v_ev AND r.recipient_user_id = c1;
  PERFORM pg_temp.chk('inbox: c1 sees the open clinician_review notification with patient identity and episode link',
    EXISTS (SELECT 1 FROM safety_notification_inbox(c1, 500) i WHERE i.recipient_id = v_rid AND i.tier = 'clinician_review'
            AND i.patient_id = pL3 AND i.patient_name = 'M32 pL3' AND i.acute_safety_episode_id IS NOT NULL AND i.is_open AND i.read_at IS NULL));
  v_n := safety_notification_unread_count(c1);
  v_r := safety_notification_open(v_rid, c1, false);
  PERFORM pg_temp.chk('open without a mutation (maintenance): navigation target returned, read_at untouched',
    v_r->>'result' = 'ok' AND v_r->>'destination' = 'patient_safety' AND (v_r->>'patient_id')::uuid = pL3
    AND (SELECT read_at IS NULL FROM safety_notification_recipients WHERE id = v_rid), v_r::text);
  v_r := safety_notification_open(v_rid, c1, true);
  PERFORM pg_temp.chk('open: read_at recorded once; unread count drops by one',
    (SELECT read_at IS NOT NULL FROM safety_notification_recipients WHERE id = v_rid) AND safety_notification_unread_count(c1) = v_n - 1);
  PERFORM pg_temp.chk('open: another user (even an org clinician) cannot open someone else''s row',
    safety_notification_open(v_rid, c2, true)->>'result' = 'not_found' AND safety_notification_open(v_rid, cb, true)->>'result' = 'not_found');
  SELECT r.id INTO v_rid FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id
   WHERE e.patient_id = pFb AND r.recipient_user_id = a1;
  PERFORM pg_temp.chk('fallback inbox: the admin row carries no episode/session reference and routes to assignment',
    EXISTS (SELECT 1 FROM safety_notification_inbox(a1, 500) i WHERE i.recipient_id = v_rid AND i.acute_safety_episode_id IS NULL
            AND i.rehab_session_id IS NULL AND i.effective_level IS NULL AND i.basis = 'fallback_clinician_admin')
    AND safety_notification_open(v_rid, a1, false)->>'destination' = 'assign_clinician');

  -- ================= history immutability =================
  BEGIN
    UPDATE safety_notification_recipients SET recipient_user_id = c2 WHERE event_id = v_ev AND recipient_user_id = c1;
    PERFORM pg_temp.chk('history: a recipient row cannot be reassigned', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('history: a recipient row cannot be reassigned', SQLERRM LIKE '%SAFETY_NOTIFICATION_HISTORY_IMMUTABLE%', SQLERRM);
  END;
  BEGIN
    UPDATE safety_notification_recipients SET read_at = now() + interval '1 minute' WHERE event_id = v_ev AND recipient_user_id = c1;
    PERFORM pg_temp.chk('history: read_at is set once', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('history: read_at is set once', SQLERRM LIKE '%SAFETY_NOTIFICATION_HISTORY_IMMUTABLE%', SQLERRM);
  END;
  BEGIN
    DELETE FROM safety_notification_recipients WHERE event_id = v_ev;
    PERFORM pg_temp.chk('history: recipients cannot be deleted', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('history: recipients cannot be deleted', SQLERRM LIKE '%SAFETY_NOTIFICATION_HISTORY_IMMUTABLE%', SQLERRM);
  END;
  BEGIN
    UPDATE safety_notification_events SET tier = 'urgent_clinician_review' WHERE id = v_ev;
    PERFORM pg_temp.chk('history: an event cannot be rewritten', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('history: an event cannot be rewritten', SQLERRM ~ 'SAFETY_NOTIFICATION_HISTORY_IMMUTABLE|violates check constraint', SQLERRM);
  END;
  BEGIN
    DELETE FROM safety_email_outbox WHERE event_id = v_ev;
    PERFORM pg_temp.chk('history: outbox rows cannot be deleted', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('history: outbox rows cannot be deleted', SQLERRM LIKE '%SAFETY_NOTIFICATION_HISTORY_IMMUTABLE%', SQLERRM);
  END;

  -- ================= dispatch bookkeeping (SQL level; the worker is Phase B) =================
  -- Every claim below is scoped to the exact fixture intent under test.
  SELECT o.id INTO v_ob FROM safety_email_outbox o JOIN safety_notification_recipients r ON r.id = o.recipient_id
   WHERE o.event_id = v_ev AND r.recipient_user_id = c1;
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob]);
  PERFORM pg_temp.chk('claim: leases the due intent, returns only email + org name + opaque ids (no patient data), opens attempt 1',
    v_claim.outbox_id = v_ob AND v_claim.attempt_no = 1 AND v_claim.recipient_email LIKE 'm32-c1-%' AND v_claim.organization_name = 'M3.2 proof org A'
    AND v_claim.idempotency_key = 'tenotrainer-safety-email/' || v_ob::text || '/g1'
    AND (SELECT status = 'claimed' AND claim_token = v_claim.claim_token FROM safety_email_outbox WHERE id = v_ob)
    AND (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_ob AND finished_at IS NULL) = 1, row_to_json(v_claim)::text);
  PERFORM pg_temp.chk('claim: a second claim while the lease is held gets nothing (true concurrency: Phase B worker suite)', NOT EXISTS (SELECT 1 FROM safety_email_claim(10, 120, ARRAY[v_ob])));
  v_r := safety_email_record_result(v_ob, v_claim.claim_token, 'transient_error', 503, NULL, 'provider_unavailable');
  PERFORM pg_temp.chk('retry: a transient error schedules attempt 2 at +1 minute with the SAME key',
    v_r->>'status' = 'retry_scheduled'
    AND (SELECT next_attempt_at BETWEEN clock_timestamp() + interval '50 seconds' AND clock_timestamp() + interval '61 seconds'
                AND idempotency_key LIKE '%/g1' FROM safety_email_outbox WHERE id = v_ob), v_r::text);
  v_tok := v_claim.claim_token;
  v_r := safety_email_record_result(v_ob, v_tok, 'transient_error', 503, NULL, 'provider_unavailable');
  PERFORM pg_temp.chk('replay: re-recording a finished attempt is a stale no-op', v_r->>'result' = 'stale_claim', v_r::text);

  UPDATE safety_email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = v_ob;
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob]);
  UPDATE safety_email_outbox SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = v_ob;   -- the worker crashed
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob]);
  PERFORM pg_temp.chk('crash: an expired lease closes attempt 2 as abandoned and re-claims attempt 3 with the SAME idempotency key',
    v_claim.outbox_id = v_ob AND v_claim.attempt_no = 3 AND v_claim.idempotency_key LIKE '%/g1'
    AND (SELECT outcome FROM safety_email_attempts WHERE outbox_id = v_ob AND attempt_no = 2) = 'abandoned_lease_expired', row_to_json(v_claim)::text);
  v_r := safety_email_record_result(v_ob, (SELECT claim_token FROM safety_email_attempts WHERE outbox_id = v_ob AND attempt_no = 2), 'transient_error', NULL, NULL, 'timeout');
  PERFORM pg_temp.chk('crash: a late non-acceptance from the abandoned worker changes nothing', v_r->>'result' = 'stale_claim'
    AND (SELECT status = 'claimed' AND claim_token = v_claim.claim_token FROM safety_email_outbox WHERE id = v_ob), v_r::text);
  v_r := safety_email_record_result(v_ob, (SELECT claim_token FROM safety_email_attempts WHERE outbox_id = v_ob AND attempt_no = 2), 'provider_accepted', 200, 'prov-msg-1', NULL);
  PERFORM pg_temp.chk('crash: a late ACCEPTANCE from the abandoned worker is evidence — recorded (late_result) and the intent is provider_accepted',
    v_r->>'status' = 'provider_accepted'
    AND (SELECT status = 'provider_accepted' AND provider_message_id = 'prov-msg-1' AND claim_token IS NULL FROM safety_email_outbox WHERE id = v_ob)
    AND (SELECT outcome = 'provider_accepted' AND late_result FROM safety_email_attempts WHERE outbox_id = v_ob AND attempt_no = 2), v_r::text);
  v_r := safety_email_record_result(v_ob, v_claim.claim_token, 'provider_accepted', 200, 'prov-msg-1', NULL);
  PERFORM pg_temp.chk('crash: the live worker''s identical acceptance (provider idempotency) keeps one logical acceptance',
    v_r->>'status' = 'provider_accepted' AND (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_ob AND outcome = 'provider_accepted') = 2
    AND (SELECT provider_message_id FROM safety_email_outbox WHERE id = v_ob) = 'prov-msg-1');
  PERFORM pg_temp.chk('naming: no status, column or outcome claims delivery or reading',
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'safety\_%'
                AND column_name ~ '(^|_)(sent|delivered|opened|seen)(_|$)'));


  -- ================= scoped claim semantics (p_only_outbox_ids) =================
  SELECT o.id INTO v_sa FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = pBlk;
  SELECT o.id INTO v_sb FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = pHold;
  PERFORM pg_temp.chk('scope fixture: two due pending fixture intents',
    (SELECT count(*) FROM safety_email_outbox WHERE id IN (v_sa, v_sb) AND status = 'pending' AND next_attempt_at <= clock_timestamp()) = 2);
  PERFORM pg_temp.chk('scope: an EMPTY array claims nothing', (SELECT count(*) FROM safety_email_claim(10, 120, '{}'::uuid[])) = 0
    AND (SELECT count(*) FROM safety_email_outbox WHERE id IN (v_sa, v_sb) AND status = 'pending' AND attempt_count = 0) = 2);
  PERFORM pg_temp.chk('scope: unknown ids claim nothing', (SELECT count(*) FROM safety_email_claim(10, 120, ARRAY[gen_random_uuid(), gen_random_uuid()])) = 0
    AND (SELECT count(*) FROM safety_email_outbox WHERE id IN (v_sa, v_sb) AND status = 'pending' AND attempt_count = 0) = 2);
  SELECT count(*) INTO v_n FROM safety_email_claim(10, 120, ARRAY[v_sa, v_sa, v_sa]);
  PERFORM pg_temp.chk('scope: duplicate ids claim the intent once (one lease, one attempt)',
    v_n = 1 AND (SELECT status = 'claimed' AND attempt_count = 1 FROM safety_email_outbox WHERE id = v_sa)
    AND (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_sa) = 1, v_n::text);
  PERFORM pg_temp.chk('scope: an intent outside the scope is untouched (still pending, no attempt)',
    (SELECT status = 'pending' AND attempt_count = 0 FROM safety_email_outbox WHERE id = v_sb) AND NOT EXISTS (SELECT 1 FROM safety_email_attempts WHERE outbox_id = v_sb));
  SELECT array_agg(outbox_id) INTO v_ids FROM safety_email_claim(10, 120, ARRAY[v_sb]);
  PERFORM pg_temp.chk('scope: a disjoint scope claims only its own intent', v_ids = ARRAY[v_sb], v_ids::text);
  UPDATE safety_email_outbox SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = v_sa;   -- worker A crashed
  PERFORM count(*) FROM safety_email_claim(10, 120, ARRAY[v_sb]);
  PERFORM pg_temp.chk('scope: lease recovery is scoped too — an out-of-scope expired lease is not touched',
    (SELECT status = 'claimed' AND claimed_until < clock_timestamp() FROM safety_email_outbox WHERE id = v_sa)
    AND (SELECT finished_at IS NULL FROM safety_email_attempts WHERE outbox_id = v_sa AND attempt_no = 1));
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_sa]);
  PERFORM pg_temp.chk('scope: within its scope the expired lease is recovered (attempt 1 abandoned, attempt 2 same key)',
    v_claim.outbox_id = v_sa AND v_claim.attempt_no = 2 AND v_claim.idempotency_key LIKE '%/g1'
    AND (SELECT outcome FROM safety_email_attempts WHERE outbox_id = v_sa AND attempt_no = 1) = 'abandoned_lease_expired');
  v_r := safety_email_record_result(v_sa, v_claim.claim_token, 'transient_error', 503, NULL, 'provider_unavailable');
  PERFORM pg_temp.chk('scope never bypasses eligibility: a not-yet-due intent in scope is not claimed',
    (SELECT count(*) FROM safety_email_claim(10, 120, ARRAY[v_sa])) = 0 AND (SELECT status FROM safety_email_outbox WHERE id = v_sa) = 'retry_scheduled');
  SELECT o.id INTO v_ob FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = pL5 LIMIT 1;
  PERFORM pg_temp.chk('scope never bypasses eligibility: a released-episode (terminal) intent in scope is not claimed',
    (SELECT count(*) FROM safety_email_claim(10, 120, ARRAY[v_ob])) = 0 AND (SELECT status FROM safety_email_outbox WHERE id = v_ob) = 'suppressed_episode_released');
  -- NULL scope (production): every eligible due intent is considered. Run in a
  -- sub-transaction that is undone immediately, so no real row stays leased
  -- even inside this rolled-back transaction.
  -- Never touch a non-fixture intent (e.g. the real development L5): when one
  -- is due, the probe is skipped here (it is proven by the pre-application proof).
  SELECT count(*) INTO v_n FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id
   WHERE o.status IN ('pending', 'retry_scheduled', 'claimed') AND e.patient_id NOT IN (SELECT v FROM fx);
  IF v_n > 0 THEN
    INSERT INTO verify_results(result) VALUES ('INFO: NULL-scope probe skipped — ' || v_n || ' non-fixture in-flight intent(s) present (proven pre-application)');
  ELSE
  BEGIN
    SELECT count(*) INTO v_n FROM safety_email_outbox WHERE status IN ('pending', 'retry_scheduled') AND next_attempt_at <= clock_timestamp();
    SELECT count(*) INTO v_n2 FROM safety_email_claim(50, 120, NULL);
    v_ok := v_n >= 2 AND v_n <= 50
       AND NOT EXISTS (SELECT 1 FROM safety_email_outbox WHERE status IN ('pending', 'retry_scheduled') AND next_attempt_at <= clock_timestamp())
       AND v_n2 >= 1;
    v_t := v_n || ' due, ' || v_n2 || ' claimed';
    RAISE EXCEPTION 'm32_undo_null_scope_probe';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'm32_undo_null_scope_probe' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.chk('scope NULL (production): every eligible due intent is consumed (claimed, or suppressed when ineligible) — none left due', v_ok, v_t);
  END IF;
  PERFORM pg_temp.chk('scope NULL probe was undone (fixture intent still pending, no attempt)',
    (SELECT status = 'pending' AND attempt_count = 0 FROM safety_email_outbox WHERE id = (SELECT o.id FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id
       JOIN safety_notification_recipients r ON r.id = o.recipient_id WHERE e.patient_id = pFb AND r.recipient_user_id = a1)));

  -- exhaustion -> failed_permanent -> alert -> audited requeue (new generation)
  SELECT o.id INTO v_ob2 FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id
   WHERE e.patient_id = pOrphan;
  UPDATE safety_email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = v_ob2;
  FOR v_n IN 1..8 LOOP
    SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob2]);
    IF v_claim.outbox_id IS DISTINCT FROM v_ob2 THEN RAISE EXCEPTION 'unexpected claim %', row_to_json(v_claim); END IF;
    v_r := safety_email_record_result(v_ob2, v_claim.claim_token, 'timeout_ambiguous', NULL, NULL, 'timeout');
    IF v_n < 8 THEN
      IF NOT (SELECT next_attempt_at - clock_timestamp() BETWEEN safety_email_retry_delay(v_n) - interval '10 seconds' AND safety_email_retry_delay(v_n)
              FROM safety_email_outbox WHERE id = v_ob2) THEN
        PERFORM pg_temp.chk('retry schedule after attempt ' || v_n, false, (SELECT (next_attempt_at - clock_timestamp())::text FROM safety_email_outbox WHERE id = v_ob2));
      END IF;
      UPDATE safety_email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = v_ob2;
    END IF;
  END LOOP;
  PERFORM pg_temp.chk('retry: +1m +5m +15m +1h +3h +6h +8h, then the 8th ambiguous result is failed_permanent (attempts_exhausted), never silently dropped',
    (SELECT status = 'failed_permanent' AND attempt_count = 8 AND last_error_code = 'attempts_exhausted' AND terminal_at IS NOT NULL FROM safety_email_outbox WHERE id = v_ob2)
    AND (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_ob2) = 8
    AND EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'delivery_failed_permanent' AND subject_key = 'outbox:' || v_ob2::text AND cleared_at IS NULL));
  v_r := safety_email_requeue(v_ob2, c1, 'mailbox fixed');
  PERFORM pg_temp.chk('requeue: refused for a non-super-user', v_r->>'result' = 'not_authorized', v_r::text);
  v_r := safety_email_requeue(v_ob2, su, 'Provider outage resolved');
  PERFORM pg_temp.chk('requeue: super_user, audited, NEW idempotency generation, attempts reset, alert cleared',
    v_r->>'result' = 'requeued'
    AND (SELECT status = 'pending' AND generation = 2 AND attempt_count = 0 AND idempotency_key LIKE '%/g2' AND terminal_at IS NULL FROM safety_email_outbox WHERE id = v_ob2)
    AND (SELECT count(*) FROM safety_email_requeues WHERE outbox_id = v_ob2 AND requested_by = su AND previous_generation = 1 AND new_generation = 2) = 1
    AND NOT EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'delivery_failed_permanent' AND subject_key = 'outbox:' || v_ob2::text AND cleared_at IS NULL), v_r::text);
  PERFORM pg_temp.chk('requeue: history of generation 1 is preserved', (SELECT count(*) FROM safety_email_attempts WHERE outbox_id = v_ob2 AND generation = 1) = 8);

  -- permanent provider rejection
  UPDATE safety_email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = v_ob2;
  SELECT * INTO v_claim FROM safety_email_claim(10, 120, ARRAY[v_ob2]);
  v_r := safety_email_record_result(v_ob2, v_claim.claim_token, 'rejected_permanent', 422, NULL, 'invalid_recipient');
  PERFORM pg_temp.chk('permanent rejection: failed_permanent immediately with the provider code, alert raised',
    (SELECT status = 'failed_permanent' AND last_error_code = 'invalid_recipient' FROM safety_email_outbox WHERE id = v_ob2)
    AND EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'delivery_failed_permanent' AND subject_key = 'outbox:' || v_ob2::text AND cleared_at IS NULL));
  v_r := safety_email_record_result(v_ob2, v_claim.claim_token, 'provider_accepted', 200, NULL, NULL);
  PERFORM pg_temp.chk('record: acceptance without a provider message id is refused', v_r->>'result' = 'invalid_arguments');
  v_r := safety_email_record_result(v_ob2, v_claim.claim_token, 'transient_error', NULL, NULL, 'Patient Jane Doe');
  PERFORM pg_temp.chk('record: free-text error (possible PHI) is refused — codes only', v_r->>'result' = 'invalid_arguments');

  -- suppression at claim time: ended assignment
  SELECT o.id INTO v_ob FROM safety_email_outbox o JOIN safety_notification_recipients r ON r.id = o.recipient_id
   WHERE r.recipient_user_id = c2 AND o.event_id = v_ev;
  UPDATE safety_email_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = v_ob;
  PERFORM count(*) FROM safety_email_claim(10, 120, ARRAY[v_ob]);
  PERFORM pg_temp.chk('claim: a recipient whose assignment ended is never emailed (suppressed_recipient_ineligible, no attempt)',
    (SELECT status = 'suppressed_recipient_ineligible' AND attempt_count = 0 FROM safety_email_outbox WHERE id = v_ob)
    AND NOT EXISTS (SELECT 1 FROM safety_email_attempts WHERE outbox_id = v_ob));

  -- stalled urgent delivery
  SELECT o.id INTO v_ob FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id
   WHERE e.patient_id = pFb AND o.tier = 'urgent_clinician_review' LIMIT 1;
  UPDATE safety_email_outbox SET created_at = now() - interval '20 minutes' WHERE id = v_ob;
  v_r := safety_notifications_sweep();
  PERFORM pg_temp.chk('stalled L5: an urgent intent not provider-accepted 15 minutes after creation raises urgent_delivery_stalled',
    EXISTS (SELECT 1 FROM safety_notification_alerts WHERE kind = 'urgent_delivery_stalled' AND subject_key = 'outbox:' || v_ob::text AND cleared_at IS NULL), v_r::text);
  PERFORM pg_temp.chk('health view: counts, ages and codes only; reports the open alerts and the sweep heartbeat',
    (SELECT open_alerts >= 1 AND sweep_last_succeeded_at IS NOT NULL AND (open_alerts_by_kind ? 'urgent_delivery_stalled') FROM safety_notification_health));

  -- ================= adversarial: client roles (PostgREST-style) =================
  v_t := '';
  FOR v_res IN SELECT * FROM (VALUES
      ('authenticated', c1, 'SELECT count(*) FROM safety_notification_recipients'),
      ('authenticated', c1, 'SELECT count(*) FROM safety_notification_events'),
      ('authenticated', pL5, 'SELECT count(*) FROM safety_acute_stop_notices'),
      ('authenticated', c1, format('UPDATE safety_notification_recipients SET read_at = now() WHERE recipient_user_id = %L', c1)),
      ('authenticated', pL5, format('UPDATE safety_notification_recipients SET read_at = now() WHERE id = %L', v_rid)),
      ('authenticated', c1, format('INSERT INTO safety_notification_events (acute_safety_episode_id, patient_id, tier, email_required, effective_level, professionally_held, episode_confirmed_at, recipient_resolution, detected_by) VALUES (%L, %L, %L, false, 3, false, now(), %L, %L)', v_ep, pL3, 'safety_review', 'assigned_clinicians', 'sweep')),
      ('authenticated', c1, format('INSERT INTO safety_notification_recipients (event_id, recipient_user_id, organization_id, basis) VALUES (%L, %L, %L, %L)', v_ev, cb, v_orgB, 'fallback_clinician_admin')),
      ('authenticated', c1, 'UPDATE safety_email_outbox SET status = ''provider_accepted'''),
      ('authenticated', c1, 'INSERT INTO safety_email_attempts (outbox_id, generation, attempt_no, claim_token, idempotency_key) SELECT id, 1, 1, gen_random_uuid(), ''x'' FROM safety_email_outbox LIMIT 1'),
      ('authenticated', su, 'SELECT * FROM safety_notification_health'),
      ('authenticated', su, 'UPDATE safety_notification_alerts SET cleared_at = now()'),
      ('authenticated', c1, 'DELETE FROM safety_notification_events'),
      ('authenticated', c1, 'TRUNCATE safety_email_outbox'),
      ('anon', NULL, 'SELECT count(*) FROM safety_email_outbox'),
      ('authenticated', c1, 'SELECT safety_notifications_sweep()'),
      ('authenticated', c1, 'SELECT * FROM safety_email_claim(10, 120)'),
      ('authenticated', c1, format('SELECT safety_email_record_result(%L, gen_random_uuid(), %L, 200, %L, NULL)', v_ob, 'provider_accepted', 'forged')),
      ('authenticated', su, format('SELECT safety_email_requeue(%L, %L, %L)', v_ob2, su, 'x')),
      ('authenticated', c1, format('SELECT * FROM safety_notification_inbox(%L, 10)', c2)),
      ('authenticated', c2, format('SELECT safety_notification_open(%L, %L, true)', v_rid, a1)),
      ('authenticated', c1, format('SELECT safety_notification_unread_count(%L)', c2)),
      ('authenticated', c1, format('SELECT safety_notif_evaluate_episode(%L, %L)', v_ep, 'sweep')),
      ('authenticated', c1, format('SELECT * FROM safety_notif_resolve_recipients(%L)', pL5)),
      ('authenticated', c1, format('SELECT safety_notif_insert_recipients(%L, NULL, %L::jsonb, false)', v_ev, '[]')),
      ('anon', NULL, format('SELECT safety_notif_hook(%L, %L)', 'episode', v_ep)),
      ('anon', NULL, 'SELECT * FROM safety_email_claim(1, 60)'),
      ('authenticated', c1, format('SELECT * FROM safety_email_claim(10, 120, ARRAY[%L]::uuid[])', v_sb)),
      ('anon', NULL, 'SELECT * FROM safety_email_claim(1, 60, NULL::uuid[])')
    ) x(role, uid, sql) LOOP
    v_r := to_jsonb(pg_temp.as_role(v_res.role, v_res.uid, v_res.sql));
    IF v_r #>> '{}' <> '42501' THEN v_t := v_t || v_res.role || ' [' || left(v_res.sql, 60) || '] -> ' || (v_r #>> '{}') || '; '; END IF;
  END LOOP;
  PERFORM pg_temp.chk('adversarial: 28 client attempts (read, mark-read, forge event/recipient, alter delivery, attempt rows, health, alerts, delete, truncate, every RPC incl. scoped and unscoped claim) all 42501', v_t = '', v_t);
  v_t := pg_temp.as_role('service_role', NULL, 'UPDATE safety_email_outbox SET status = ''provider_accepted''');
  PERFORM pg_temp.chk('adversarial: even service_role cannot write delivery state directly (RPCs only)', v_t = '42501', v_t);
  v_t := pg_temp.as_role('service_role', NULL, 'SELECT count(*) FROM safety_notification_health');
  PERFORM pg_temp.chk('service_role: can read the health surface', v_t = 'OK', v_t);

  -- ================= clinical semantics untouched =================
  PERFORM pg_temp.chk('no clinical safety / C5 / assignment function was changed by the migration (15 definitions identical)',
    (SELECT count(*) FROM clinical_defs) = 15
    AND NOT EXISTS (SELECT 1 FROM clinical_defs d WHERE md5(pg_get_functiondef(d.sig::regprocedure)) <> d.h),
    (SELECT count(*)::text FROM clinical_defs));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END
$verify$;

