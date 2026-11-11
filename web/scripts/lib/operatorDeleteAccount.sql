-- Alpha 1 — OPERATOR-ONLY participant account deletion / closure (NOT product
-- code). Defines TEMPORARY functions that exist only in the operator's own
-- database session (dropped with it): never a migration, never granted,
-- never reachable over PostgREST, an API route, a server action or the UI.
-- Run only by web/scripts/operatorDeleteAccount.mjs, inside ONE transaction
-- (dry run: ROLLBACK; apply: COMMIT), as the migration owner (postgres).
--
-- Outcomes for ONE explicitly identified patient account:
--   delete  no protected safety history: the account and every record whose
--           subject is the account are removed in dependency order; every
--           reference to the account is re-checked to be zero.
--   close   protected safety history exists: the safety / audit records are
--           kept (their protections are never disabled); the account is
--           closed (sign-in blocked, sessions revoked) and its identity
--           fields de-identified. This is NOT complete deletion.
--   refused anything else (unknown account, email mismatch, staff or other
--           non-patient role, records the account authored about OTHER
--           people, already closed and still intact). Nothing is changed.
--
-- A closed account is addressed by its placeholder email
-- (closed+<id>@deleted.invalid). Re-checking it after the participant's last
-- access token has expired (at most one hour) reports whether the closure is
-- still intact; if anything was changed in the meantime (e.g. the profile was
-- edited with a still-valid token), the outcome is "close" again (re-close),
-- which re-applies the same de-identification.
--
-- Safety: no trigger is ever disabled (the trigger state is compared before
-- and after and must be identical); no TRUNCATE; cascades only those the
-- schema defines from the account's OWN parent rows, all inventoried; the
-- apply recomputes the inventory under a row lock and refuses unless its
-- plan hash equals the one the operator approved from the dry run.

-- Every public column that references auth.users, classified.
--   subject     the row is ABOUT this account (user_id / patient_id / profiles.id,
--               and invitations.accepted_by = the account's own acceptance)
--   authorship  the account acted on / owns the row (created_by, supervisor_id,
--               invited_by, published_by, recipient_user_id, ...) — counted only
--               where the row's own subject is not this account
CREATE FUNCTION pg_temp.oda_refs() RETURNS TABLE (tbl TEXT, col TEXT, kind TEXT, subject_col TEXT) LANGUAGE sql AS $$
  SELECT format('%I.%I', n.nspname, cl.relname), a.attname::text,
         CASE WHEN a.attname IN ('user_id', 'patient_id')
                OR (n.nspname = 'public' AND cl.relname = 'profiles' AND a.attname = 'id')
                OR (n.nspname = 'public' AND cl.relname = 'invitations' AND a.attname = 'accepted_by') THEN 'subject'
              ELSE 'authorship' END,
         (SELECT x.attname::text FROM pg_attribute x
           WHERE x.attrelid = c.conrelid AND x.attname IN ('user_id', 'patient_id') AND NOT x.attisdropped
           ORDER BY x.attname = 'patient_id' DESC LIMIT 1)
  FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass AND n.nspname = 'public'
  ORDER BY 1, 2;
$$;

-- Protected safety history (subject tables). Their presence selects "close".
CREATE FUNCTION pg_temp.oda_protected_tables() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['public.acute_safety_episodes.user_id', 'public.acute_safety_reassessments.user_id',
               'public.acute_safety_releases.user_id', 'public.blocked_loading_opportunities.user_id',
               'public.safety_notification_events.patient_id', 'public.safety_acute_stop_notices.patient_id'];
$$;

-- Every non-internal trigger on public / auth tables with its enabled state.
CREATE FUNCTION pg_temp.oda_trigger_state() RETURNS TEXT LANGUAGE sql AS $$
  SELECT coalesce(string_agg(format('%s.%s:%s', t.tgrelid::regclass::text, t.tgname, t.tgenabled), ',' ORDER BY 1), '')
  FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE NOT t.tgisinternal AND n.nspname IN ('public', 'auth');
$$;

CREATE FUNCTION pg_temp.oda_child_counts(p_parent TEXT, p_ids UUID[]) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_n BIGINT; v_out JSONB := '{}';
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) = 0 THEN RETURN v_out; END IF;
  FOR r IN
    SELECT format('%I.%I', n.nspname, cl.relname) AS tbl, a.attname::text AS col
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = p_parent::regclass AND c.conrelid <> p_parent::regclass ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = ANY ($1)', r.tbl, r.col) INTO v_n USING p_ids;
    IF v_n > 0 THEN v_out := v_out || jsonb_build_object(r.tbl || '.' || r.col, v_n); END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE FUNCTION pg_temp.oda_inventory(p_user UUID, p_email TEXT, p_project TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_email TEXT; v_refusals TEXT[] := '{}'; v_roles TEXT[]; r RECORD; v_n BIGINT;
  v_subject JSONB := '{}'; v_author JSONB := '{}'; v_protected JSONB := '{}'; v_children JSONB := '{}';
  v_retained JSONB := '{}'; v_outcome TEXT; v_canon TEXT; v_drift TEXT[] := '{}'; v_closed BOOLEAN;
  v_sessions UUID[]; v_pp UUID[]; v_versions UUID[]; v_events UUID[];
BEGIN
  IF p_project IS NULL OR p_project !~ '^[a-z]{20}$' THEN RAISE EXCEPTION 'ODA_BAD_ARGUMENT: project ref'; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'refusals', jsonb_build_array('account_not_found'));
  END IF;
  -- An identity mismatch reveals nothing else about the account.
  IF lower(coalesce(v_email, '')) <> lower(btrim(coalesce(p_email, ''))) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'refusals', jsonb_build_array('email_does_not_match_account'));
  END IF;
  v_closed := v_email = 'closed+' || p_user::text || '@deleted.invalid';
  IF v_closed THEN
    -- Is the closure still intact? (A token issued before the closure stays
    -- valid for up to an hour and can still edit the participant's own profile.)
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user AND encrypted_password = '' AND raw_user_meta_data = '{}'::jsonb
                     AND phone IS NULL AND banned_until > now() + interval '100 years') THEN v_drift := v_drift || 'auth_account'::text; END IF;
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = p_user) OR EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id = p_user::text) THEN
      v_drift := v_drift || 'sessions'::text; END IF;
    IF EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_user AND email IS DISTINCT FROM v_email) THEN v_drift := v_drift || 'identity'::text; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND name = 'Closed participant' AND phone IS NULL AND age IS NULL AND sex IS NULL
                     AND gender IS NULL AND height_cm IS NULL AND weight_kg IS NULL AND affected_side IS NULL AND activity_level IS NULL
                     AND sports IS NULL AND condition_timeline IS NULL AND injury_sides IS NULL AND previous_history IS NULL
                     AND seen_by_provider_notes IS NULL AND timezone IS NULL) THEN v_drift := v_drift || 'profile'::text; END IF;
    IF EXISTS (SELECT 1 FROM public.supervisor_patients WHERE patient_id = p_user AND status = 'active') THEN v_drift := v_drift || 'assignment'::text; END IF;
    IF cardinality(v_drift) = 0 THEN v_refusals := v_refusals || 'already_closed'::text; END IF;
  END IF;
  SELECT array_agg(DISTINCT m.role::text ORDER BY m.role::text) INTO v_roles FROM public.organization_members m WHERE m.user_id = p_user;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(v_roles, '{}')) x WHERE x <> 'member') THEN
    v_refusals := v_refusals || ('non_patient_role:' || array_to_string(v_roles, '+'));
  END IF;

  FOR r IN SELECT * FROM pg_temp.oda_refs() LOOP
    IF r.kind = 'authorship' THEN
      EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = $1%s', r.tbl, r.col,
                     CASE WHEN r.subject_col IS NULL THEN '' ELSE format(' AND t.%I IS DISTINCT FROM $1', r.subject_col) END)
        INTO v_n USING p_user;
      IF v_n > 0 THEN v_author := v_author || jsonb_build_object(r.tbl || '.' || r.col, v_n); END IF;
    ELSE
      EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = $1', r.tbl, r.col) INTO v_n USING p_user;
      IF v_n > 0 THEN v_subject := v_subject || jsonb_build_object(r.tbl || '.' || r.col, v_n); END IF;
      IF v_n > 0 AND (r.tbl || '.' || r.col) = ANY (pg_temp.oda_protected_tables()) THEN
        v_protected := v_protected || jsonb_build_object(r.tbl || '.' || r.col, v_n);
      END IF;
    END IF;
  END LOOP;
  IF v_author <> '{}' THEN v_refusals := v_refusals || 'authored_or_owns_records_about_others'::text; END IF;

  -- Records hanging off the account's own parent rows (deleted by the
  -- schema's cascades with their parent; listed so nothing is implicit).
  SELECT coalesce(array_agg(id), '{}') INTO v_sessions FROM public.rehab_sessions WHERE user_id = p_user;
  SELECT coalesce(array_agg(id), '{}') INTO v_pp FROM public.patient_prescriptions WHERE patient_id = p_user;
  SELECT coalesce(array_agg(id), '{}') INTO v_versions FROM public.prescription_versions WHERE user_id = p_user;
  SELECT coalesce(array_agg(id), '{}') INTO v_events FROM public.safety_notification_events WHERE patient_id = p_user;
  v_children := pg_temp.oda_child_counts('public.rehab_sessions', v_sessions)
             || pg_temp.oda_child_counts('public.patient_prescriptions', v_pp)
             || pg_temp.oda_child_counts('public.prescription_versions', v_versions)
             || pg_temp.oda_child_counts('public.safety_notification_events', v_events);
  v_n := (SELECT count(*) FROM public.invitations i WHERE lower(i.email) = lower(v_email) AND i.accepted_by IS DISTINCT FROM p_user);
  IF v_n > 0 THEN v_subject := v_subject || jsonb_build_object('public.invitations.email', v_n); END IF;

  -- Free text and identifiers that a closure cannot remove (reported only).
  v_retained := jsonb_build_object(
    'morning_check_in_notes', (SELECT count(*) FROM public.morning_responses WHERE user_id = p_user AND patient_note IS NOT NULL AND btrim(patient_note) <> ''),
    'session_event_notes', (SELECT count(*) FROM public.session_events WHERE rehab_session_id = ANY (v_sessions) AND note IS NOT NULL AND btrim(note) <> ''),
    'clinician_release_notes', (SELECT count(*) FROM public.acute_safety_releases WHERE user_id = p_user AND release_note IS NOT NULL),
    'session_other_contributor_text', (SELECT count(*) FROM public.rehab_sessions WHERE user_id = p_user AND contributor_other_text IS NOT NULL AND btrim(contributor_other_text) <> ''),
    'session_timezones', (SELECT count(DISTINCT patient_timezone) FROM public.rehab_sessions WHERE user_id = p_user AND patient_timezone IS NOT NULL),
    'auth_audit_log_entries', (SELECT count(*) FROM auth.audit_log_entries e
                                WHERE e.payload->>'actor_id' = p_user::text OR e.payload->'traits'->>'user_id' = p_user::text
                                   OR lower(e.payload->>'actor_username') = lower(v_email) OR lower(e.payload->'traits'->>'user_email') = lower(v_email)));

  v_outcome := CASE WHEN cardinality(v_refusals) > 0 THEN 'refused' WHEN v_protected <> '{}' OR v_closed THEN 'close' ELSE 'delete' END;
  v_canon := concat_ws('|', 'oda-v1', p_project, p_user::text, lower(v_email), v_outcome,
    (SELECT string_agg(k || '=' || v, ',' ORDER BY k) FROM jsonb_each_text(v_subject) AS e(k, v)),
    (SELECT string_agg(k || '=' || v, ',' ORDER BY k) FROM jsonb_each_text(v_children) AS e(k, v)),
    (SELECT string_agg(k || '=' || v, ',' ORDER BY k) FROM jsonb_each_text(v_author) AS e(k, v)),
    array_to_string(v_refusals, ','), array_to_string(v_drift, ','));
  RETURN jsonb_build_object(
    'outcome', v_outcome, 'refusals', to_jsonb(v_refusals), 'roles', to_jsonb(coalesce(v_roles, '{}')),
    'subject_records', v_subject, 'dependent_records', v_children, 'protected_safety_records', v_protected,
    'authored_records_about_others', v_author, 'retained_if_closed', v_retained,
    'reclose', v_closed AND cardinality(v_drift) > 0, 'closure_drift', to_jsonb(v_drift),
    'plan_hash', encode(sha256(convert_to(v_canon, 'UTF8')), 'hex'));
END;
$$;

CREATE FUNCTION pg_temp.oda_apply(p_user UUID, p_email TEXT, p_project TEXT, p_plan_hash TEXT, p_fail_at TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_inv JSONB; v_triggers TEXT; v_email TEXT; v_placeholder TEXT; v_n BIGINT; v_done JSONB := '{}'; r RECORD;
  v_sessions UUID[]; v_pp UUID[]; v_versions UUID[];
BEGIN
  IF p_fail_at IS NOT NULL AND p_fail_at NOT IN ('after_lock', 'mid_change', 'before_verify') THEN
    RAISE EXCEPTION 'ODA_BAD_ARGUMENT: unknown fail point';
  END IF;
  -- Serialize with any concurrent change to this account, then re-derive the plan.
  PERFORM 1 FROM auth.users WHERE id = p_user FOR UPDATE;
  v_inv := pg_temp.oda_inventory(p_user, p_email, p_project);
  IF v_inv->>'outcome' = 'refused' THEN RAISE EXCEPTION 'ODA_REFUSED: %', v_inv->'refusals'; END IF;
  IF p_plan_hash IS DISTINCT FROM v_inv->>'plan_hash' THEN
    RAISE EXCEPTION 'ODA_PLAN_STALE: the approved plan hash does not match the account as it is now; run a new dry run';
  END IF;
  IF p_fail_at = 'after_lock' THEN RAISE EXCEPTION 'ODA_INJECTED_FAILURE: after_lock'; END IF;
  v_triggers := pg_temp.oda_trigger_state();
  SELECT email INTO v_email FROM auth.users WHERE id = p_user;

  IF v_inv->>'outcome' = 'delete' THEN
    SELECT coalesce(array_agg(id), '{}') INTO v_sessions FROM public.rehab_sessions WHERE user_id = p_user;
    SELECT coalesce(array_agg(id), '{}') INTO v_pp FROM public.patient_prescriptions WHERE patient_id = p_user;
    SELECT coalesce(array_agg(id), '{}') INTO v_versions FROM public.prescription_versions WHERE user_id = p_user;
    -- Dependency order (the schema's NO ACTION references first).
    DELETE FROM public.m6_longitudinal_interpretations WHERE user_id = p_user;        GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('m6_longitudinal_interpretations', v_n);
    DELETE FROM public.c5_recovery_decisions WHERE user_id = p_user;                  GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('c5_recovery_decisions', v_n);
    DELETE FROM public.session_guidance_contexts
      WHERE rehab_session_id = ANY (v_sessions) OR source_rehab_session_id = ANY (v_sessions)
         OR session_prescription_version_id = ANY (v_versions) OR source_prescription_version_id = ANY (v_versions);
                                                                                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('session_guidance_contexts', v_n);
    DELETE FROM public.morning_responses WHERE user_id = p_user;                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('morning_responses', v_n);
    DELETE FROM public.rehab_sessions WHERE user_id = p_user;                         GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('rehab_sessions', v_n);
    IF p_fail_at = 'mid_change' THEN RAISE EXCEPTION 'ODA_INJECTED_FAILURE: mid_change'; END IF;
    DELETE FROM public.notifications
      WHERE patient_id = p_user OR patient_prescription_id = ANY (v_pp) OR prescription_version_id = ANY (v_versions);
                                                                                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('notifications', v_n);
    DELETE FROM public.prescription_drafts WHERE patient_prescription_id = ANY (v_pp); GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('prescription_drafts', v_n);
    DELETE FROM public.prescription_pause_periods WHERE patient_prescription_id = ANY (v_pp);
                                                                                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('prescription_pause_periods', v_n);
    UPDATE public.patient_prescriptions SET current_prescription_version_id = NULL WHERE id = ANY (v_pp);
    DELETE FROM public.prescription_versions WHERE user_id = p_user;                  GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('prescription_versions', v_n);
    DELETE FROM public.patient_prescriptions WHERE patient_id = p_user;               GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('patient_prescriptions', v_n);
    DELETE FROM public.participation_agreement_acceptances WHERE user_id = p_user;    GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('participation_agreement_acceptances', v_n);
    DELETE FROM public.supervisor_patients WHERE patient_id = p_user;                 GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('supervisor_patients', v_n);
    DELETE FROM public.invitations WHERE accepted_by = p_user OR lower(email) = lower(v_email);
                                                                                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('invitations', v_n);
    DELETE FROM public.organization_members WHERE user_id = p_user;                   GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('organization_members', v_n);
    -- Any remaining subject rows (legacy tables), explicitly, never via TRUNCATE.
    FOR r IN SELECT * FROM pg_temp.oda_refs() WHERE kind = 'subject' AND tbl <> 'public.profiles' LOOP
      EXECUTE format('DELETE FROM %s t WHERE t.%I = $1', r.tbl, r.col) USING p_user;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN v_done := v_done || jsonb_build_object(r.tbl || '.' || r.col, v_n); END IF;
    END LOOP;
    DELETE FROM public.profiles WHERE id = p_user;                                    GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('profiles', v_n);
    DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;
    DELETE FROM auth.users WHERE id = p_user;                                         GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('auth_users', v_n);
  ELSE
    v_placeholder := 'closed+' || p_user::text || '@deleted.invalid';
    UPDATE public.supervisor_patients SET status = 'dismissed', dismissed_at = now(), dismissed_reason = 'Participant account closed (operator)'
      WHERE patient_id = p_user AND status = 'active';                                GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('assignments_ended', v_n);
    IF p_fail_at = 'mid_change' THEN RAISE EXCEPTION 'ODA_INJECTED_FAILURE: mid_change'; END IF;
    UPDATE public.invitations SET status = 'cancelled' WHERE lower(email) = lower(v_email) AND status = 'pending';
                                                                                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('pending_invitations_cancelled', v_n);
    UPDATE public.invitations SET email = v_placeholder WHERE accepted_by = p_user OR lower(email) = lower(v_email);
                                                                                      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('invitation_emails_deidentified', v_n);
    UPDATE public.profiles SET name = 'Closed participant', phone = NULL, age = NULL, sex = NULL, gender = NULL, height_cm = NULL,
      weight_kg = NULL, affected_side = NULL, activity_level = NULL, sports = NULL, condition_timeline = NULL, injury_sides = NULL,
      previous_history = NULL, seen_by_provider_notes = NULL, timezone = NULL WHERE id = p_user;      GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('profile_deidentified', v_n);
    DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;                     GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('refresh_tokens_revoked', v_n);
    DELETE FROM auth.sessions WHERE user_id = p_user;                                 GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('sessions_revoked', v_n);
    DELETE FROM auth.one_time_tokens WHERE user_id = p_user;
    DELETE FROM auth.mfa_factors WHERE user_id = p_user;
    UPDATE auth.identities SET identity_data = jsonb_build_object('sub', p_user::text, 'email', v_placeholder, 'email_verified', false)
      WHERE user_id = p_user;                                                         GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('identities_deidentified', v_n);
    UPDATE auth.users SET email = v_placeholder, raw_user_meta_data = '{}'::jsonb, phone = NULL, encrypted_password = '',
      banned_until = '2999-12-31T00:00:00Z', confirmation_token = '', recovery_token = '', email_change = '', email_change_token_new = '',
      email_change_token_current = '', phone_change = '', phone_change_token = '', reauthentication_token = '', updated_at = now()
      WHERE id = p_user;                                                              GET DIAGNOSTICS v_n = ROW_COUNT; v_done := v_done || jsonb_build_object('account_closed', v_n);
  END IF;

  IF p_fail_at = 'before_verify' THEN RAISE EXCEPTION 'ODA_INJECTED_FAILURE: before_verify'; END IF;

  -- ---------------------------------------------------------------- verification (inside the transaction)
  IF pg_temp.oda_trigger_state() IS DISTINCT FROM v_triggers THEN
    RAISE EXCEPTION 'ODA_VERIFY: trigger state changed during the operation';
  END IF;
  IF v_inv->>'outcome' = 'delete' THEN
    IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_user) THEN RAISE EXCEPTION 'ODA_VERIFY: account still exists'; END IF;
    FOR r IN SELECT * FROM pg_temp.oda_refs() LOOP
      EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = $1', r.tbl, r.col) INTO v_n USING p_user;
      IF v_n > 0 THEN RAISE EXCEPTION 'ODA_VERIFY: %.% still references the account (% rows)', r.tbl, r.col, v_n; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.invitations WHERE lower(email) = lower(v_email)) THEN RAISE EXCEPTION 'ODA_VERIFY: invitation for the address remains'; END IF;
    IF EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_user) OR EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = p_user) THEN
      RAISE EXCEPTION 'ODA_VERIFY: auth identity or session remains';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user AND email = v_placeholder AND banned_until > now() + interval '100 years'
                     AND encrypted_password = '' AND raw_user_meta_data = '{}'::jsonb) THEN
      RAISE EXCEPTION 'ODA_VERIFY: account not closed / de-identified';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = p_user) OR EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id = p_user::text) THEN
      RAISE EXCEPTION 'ODA_VERIFY: a session survived';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_user AND (email IS DISTINCT FROM v_placeholder)) THEN
      RAISE EXCEPTION 'ODA_VERIFY: identity email not de-identified';
    END IF;
    IF EXISTS (SELECT 1 FROM public.supervisor_patients WHERE patient_id = p_user AND status = 'active') THEN
      RAISE EXCEPTION 'ODA_VERIFY: an assignment is still active';
    END IF;
    IF v_email <> v_placeholder AND EXISTS (SELECT 1 FROM public.invitations WHERE lower(email) = lower(v_email)) THEN
      RAISE EXCEPTION 'ODA_VERIFY: invitation email not de-identified';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user AND (name <> 'Closed participant' OR timezone IS NOT NULL OR phone IS NOT NULL)) THEN
      RAISE EXCEPTION 'ODA_VERIFY: profile not de-identified';
    END IF;
    -- The protected history is exactly as it was.
    FOR r IN SELECT key, value FROM jsonb_each_text(v_inv->'protected_safety_records') LOOP
      EXECUTE format('SELECT count(*) FROM %s t WHERE t.%I = $1',
                     substring(r.key from '^(.*)\.[^.]+$'), substring(r.key from '\.([^.]+)$')) INTO v_n USING p_user;
      IF v_n::text <> r.value THEN RAISE EXCEPTION 'ODA_VERIFY: protected record count changed for %', r.key; END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('outcome', v_inv->>'outcome', 'plan_hash', v_inv->>'plan_hash', 'changes', v_done,
                            'retained_if_closed', CASE WHEN v_inv->>'outcome' = 'close' THEN v_inv->'retained_if_closed' END,
                            'protected_safety_records', v_inv->'protected_safety_records', 'verified', true);
END;
$$;
