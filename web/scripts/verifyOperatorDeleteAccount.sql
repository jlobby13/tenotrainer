-- Alpha 1 — operator-only account deletion / closure: rollback-only proof.
-- One transaction, ROLLBACK'd — nothing persists. Builds a realistic synthetic
-- graph with the M3.2 helpers (real C5 sessions, an acute Stop reconciled
-- into a protected safety event, recipients and outbox, a published program,
-- an invitation accepted with the Participation Agreement) and exercises the
-- real pg_temp.oda_inventory / pg_temp.oda_apply.
--
-- Run (guarded): TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyOperatorDeleteAccount.sql
BEGIN;

-- @@include web/scripts/verifyM32SafetyNotificationsHelpers.sql

-- @@include web/scripts/lib/operatorDeleteAccount.sql

-- Everything that must survive an operation on p_target, fingerprinted with
-- the target's own rows excluded.
CREATE FUNCTION pg_temp.oda_fp(p_target UUID, p_email TEXT) RETURNS TEXT LANGUAGE plpgsql AS $fp$
DECLARE v TEXT := ''; t TEXT; q TEXT;
BEGIN
  FOREACH q IN ARRAY ARRAY[
    'SELECT x::text FROM auth.users x WHERE id <> $1',
    'SELECT x::text FROM auth.identities x WHERE user_id <> $1',
    'SELECT x::text FROM public.profiles x WHERE id <> $1',
    'SELECT x::text FROM public.organizations x',
    'SELECT x::text FROM public.organization_members x WHERE user_id <> $1',
    'SELECT x::text FROM public.supervisor_patients x WHERE patient_id <> $1',
    'SELECT x::text FROM public.invitations x WHERE lower(email) <> lower($2) AND accepted_by IS DISTINCT FROM $1',
    'SELECT x::text FROM public.participation_agreement_acceptances x WHERE user_id <> $1',
    'SELECT x::text FROM public.patient_prescriptions x WHERE patient_id <> $1',
    'SELECT x::text FROM public.prescription_versions x WHERE user_id <> $1',
    'SELECT x::text FROM public.rehab_sessions x WHERE user_id <> $1',
    'SELECT x::text FROM public.set_outcomes x WHERE rehab_session_id IN (SELECT id FROM public.rehab_sessions WHERE user_id <> $1)',
    'SELECT x::text FROM public.morning_responses x WHERE user_id <> $1',
    'SELECT x::text FROM public.notifications x WHERE patient_id <> $1',
    'SELECT x::text FROM public.acute_safety_episodes x WHERE user_id <> $1',
    'SELECT x::text FROM public.safety_notification_events x WHERE patient_id <> $1',
    'SELECT x::text FROM public.safety_notification_recipients x',
    'SELECT x::text FROM public.safety_email_outbox x',
    'SELECT x::text FROM public.canonical_exercises x'] LOOP
    EXECUTE format('SELECT md5(coalesce(string_agg(r, ''|'' ORDER BY r), '''')) FROM (%s) s(r)', q) INTO t USING p_target, p_email;
    v := v || t;
  END LOOP;
  RETURN md5(v);
END
$fp$;

CREATE FUNCTION pg_temp.h(p TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

CREATE FUNCTION pg_temp.try_apply(p_user UUID, p_email TEXT, p_hash TEXT, p_fail TEXT DEFAULT NULL) RETURNS TEXT LANGUAGE plpgsql AS $t$
BEGIN
  PERFORM pg_temp.oda_apply(p_user, p_email, 'kpdxlzqtvueiytwjamiw', p_hash, p_fail);
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END
$t$;

DO $oda$
DECLARE
  P CONSTANT TEXT := 'kpdxlzqtvueiytwjamiw';
  A_KEY CONSTANT TEXT := 'alpha1_participation';
  A_SHA CONSTANT TEXT := 'f58f56599a1e91e28fde7fbf11dddacb10593cfea9ff80cf0c4b77d43985a90d';
  s TEXT := substr(md5(random()::text), 1, 8);
  v_org UUID; v_ce UUID; cA UUID; sU UUID; p1 UUID; p2 UUID; p3 UUID; p4 UUID;
  e1 TEXT; e2 TEXT; e3 TEXT; e4 TEXT; rx JSONB; v_r JSONB; v_inv JSONB; v_inv2 JSONB; v_err TEXT; v_fp TEXT; v_fp2 TEXT;
  v_trg TEXT; v_sid UUID; v_n BIGINT; v_pass INT; v_fail INT; v_t TEXT;
BEGIN
  -- ================= fixtures =================
  INSERT INTO organizations (name, slug) VALUES ('ODA fixture org ' || s, 'oda-' || s) RETURNING id INTO v_org;
  cA := pg_temp.mkuser('oda-clin'); sU := pg_temp.mkuser('oda-super');
  p1 := pg_temp.mkuser('oda-p1'); p2 := pg_temp.mkuser('oda-p2'); p3 := pg_temp.mkuser('oda-p3'); p4 := pg_temp.mkuser('oda-p4');
  SELECT email INTO e1 FROM auth.users WHERE id = p1; SELECT email INTO e2 FROM auth.users WHERE id = p2;
  SELECT email INTO e3 FROM auth.users WHERE id = p3; SELECT email INTO e4 FROM auth.users WHERE id = p4;
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (v_org, cA, 'clinician'), (v_org, sU, 'super_user');
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('ODA exercise ' || s, 'global', true) RETURNING id INTO v_ce;
  -- p1, p2, p4: real invitation + acceptance with the Participation Agreement.
  PERFORM create_patient_invitation(cA, v_org, e1, pg_temp.h('oda-1-' || s));
  PERFORM create_patient_invitation(cA, v_org, e2, pg_temp.h('oda-2-' || s));
  PERFORM create_patient_invitation(cA, v_org, e4, pg_temp.h('oda-4-' || s));
  PERFORM pg_temp.chk('fixture: three patients accepted with the agreement',
    public.accept_patient_invitation_with_agreement(pg_temp.h('oda-1-' || s), p1, A_KEY, '1.0', A_SHA)->>'result' = 'accepted'
    AND public.accept_patient_invitation_with_agreement(pg_temp.h('oda-2-' || s), p2, A_KEY, '1.0', A_SHA)->>'result' = 'accepted'
    AND public.accept_patient_invitation_with_agreement(pg_temp.h('oda-4-' || s), p4, A_KEY, '1.0', A_SHA)->>'result' = 'accepted');
  -- p1: program + two closed sessions (no acute signal) + notification + auth session.
  rx := pg_temp.rx(p1, cA, v_ce);
  PERFORM pg_temp.closed(p1, rx, 3, NULL, '{"peak_session_pain": 2, "overall_session_rpe": 4, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.closed(p1, rx, 1, NULL, '{"peak_session_pain": 3, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  INSERT INTO notifications (patient_id, type, patient_prescription_id) SELECT p1, 'prescription_paused', id FROM patient_prescriptions WHERE patient_id = p1;
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), p1, now(), now());
  -- p2: acute Stop (pop) -> immediate check-in -> reconcile -> protected safety history + auth session/refresh token.
  rx := pg_temp.rx(p2, cA, v_ce);
  PERFORM pg_temp.closed(p2, rx, 2, '{"pop_felt_or_heard": true}', '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.reconcile(p2);
  v_sid := gen_random_uuid();
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (v_sid, p2, now(), now());
  INSERT INTO auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
    VALUES ('00000000-0000-0000-0000-000000000000', 'oda-' || s, p2::text, false, now(), now(), v_sid);
  -- p3: a patient-role account that authored a record about others (owns a catalog exercise).
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (v_org, p3, 'member');
  INSERT INTO canonical_exercises (name, visibility, active, created_by) VALUES ('ODA p3-authored ' || s, 'global', true, p3);
  -- p4: an unrelated patient of the same clinician (must be untouched): one session.
  rx := pg_temp.rx(p4, cA, v_ce);
  PERFORM pg_temp.closed(p4, rx, 1, NULL, '{"peak_session_pain": 1, "overall_session_rpe": 3, "sudden_or_sharp_pain": false, "pop_felt_or_heard": false, "new_functional_difficulty": false}');
  PERFORM pg_temp.chk('fixture: p2 has protected safety history (episode + event); p1 and p4 have none',
    EXISTS (SELECT 1 FROM acute_safety_episodes WHERE user_id = p2) AND EXISTS (SELECT 1 FROM safety_notification_events WHERE patient_id = p2)
    AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes WHERE user_id IN (p1, p4)));

  -- ================= 4/3/5/6: refusals =================
  v_r := pg_temp.oda_inventory(cA, (SELECT email FROM auth.users WHERE id = cA), P);
  PERFORM pg_temp.chk('4. a clinician account is refused (non-patient role + records about others)',
    v_r->>'outcome' = 'refused' AND v_r->'refusals' ? 'non_patient_role:clinician' AND v_r->'refusals' ? 'authored_or_owns_records_about_others', v_r::text);
  v_r := pg_temp.oda_inventory(sU, (SELECT email FROM auth.users WHERE id = sU), P);
  PERFORM pg_temp.chk('4. a super_user / administrator account is refused', v_r->>'outcome' = 'refused' AND v_r->'refusals' ? 'non_patient_role:super_user', v_r::text);
  v_r := pg_temp.oda_inventory(p3, e3, P);
  PERFORM pg_temp.chk('3. a patient-role account that authored records about others is refused',
    v_r->>'outcome' = 'refused' AND v_r->'refusals' ? 'authored_or_owns_records_about_others'
    AND (v_r->'authored_records_about_others'->>'public.canonical_exercises.created_by')::int = 1, v_r::text);
  v_r := pg_temp.oda_inventory(p1, e2, P);
  PERFORM pg_temp.chk('5. an email that does not match the UUID is refused and reveals nothing else',
    v_r = jsonb_build_object('outcome', 'refused', 'refusals', jsonb_build_array('email_does_not_match_account')), v_r::text);
  v_r := pg_temp.oda_inventory(gen_random_uuid(), e1, P);
  PERFORM pg_temp.chk('5. an unknown UUID is refused', v_r->'refusals' ? 'account_not_found', v_r::text);
  BEGIN
    PERFORM pg_temp.oda_inventory(p1, e1, 'not-a-ref');
    PERFORM pg_temp.chk('6. a malformed project identity is rejected', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.chk('6. a malformed project identity is rejected', SQLERRM LIKE 'ODA_BAD_ARGUMENT%', SQLERRM);
  END;
  v_err := pg_temp.try_apply(cA, (SELECT email FROM auth.users WHERE id = cA), repeat('a', 64));
  PERFORM pg_temp.chk('4. apply on a clinician is refused (nothing changed)', v_err LIKE 'ODA_REFUSED%' AND EXISTS (SELECT 1 FROM auth.users WHERE id = cA), v_err);

  -- ================= 7: dry run (inventory) changes nothing =================
  v_fp := pg_temp.oda_fp(gen_random_uuid(), 'nobody@example.invalid');
  v_inv := pg_temp.oda_inventory(p1, e1, P);
  v_inv2 := pg_temp.oda_inventory(p1, upper(e1), P);
  PERFORM pg_temp.chk('7. dry run changes nothing anywhere (full fingerprint identical)', pg_temp.oda_fp(gen_random_uuid(), 'nobody@example.invalid') = v_fp);
  PERFORM pg_temp.chk('7. the inventory is deterministic (same plan hash; email case-insensitive)', v_inv->>'plan_hash' = v_inv2->>'plan_hash' AND v_inv->>'plan_hash' ~ '^[0-9a-f]{64}$');
  PERFORM pg_temp.chk('1. p1 inventory: outcome DELETE, lists sessions, program, agreement, invitation, assignment, membership, profile',
    v_inv->>'outcome' = 'delete' AND v_inv->'refusals' = '[]'::jsonb
    AND (v_inv->'subject_records'->>'public.rehab_sessions.user_id')::int = 2
    AND (v_inv->'subject_records'->>'public.participation_agreement_acceptances.user_id')::int = 1
    AND (v_inv->'subject_records'->>'public.invitations.accepted_by')::int = 1
    AND (v_inv->'subject_records'->>'public.supervisor_patients.patient_id')::int = 1
    AND (v_inv->'subject_records'->>'public.organization_members.user_id')::int = 1
    AND (v_inv->'subject_records'->>'public.profiles.id')::int = 1
    AND (v_inv->'subject_records'->>'public.prescription_versions.user_id')::int = 1
    AND (v_inv->'dependent_records'->>'public.set_outcomes.rehab_session_id')::int = 2
    AND v_inv->'protected_safety_records' = '{}'::jsonb, v_inv::text);

  -- ================= 8: invalid / stale plan hash =================
  v_err := pg_temp.try_apply(p1, e1, repeat('0', 64));
  PERFORM pg_temp.chk('8. a wrong plan hash is refused (nothing changed)', v_err LIKE 'ODA_PLAN_STALE%' AND EXISTS (SELECT 1 FROM auth.users WHERE id = p1), v_err);
  INSERT INTO notifications (patient_id, type, patient_prescription_id) SELECT p1, 'prescription_resumed', id FROM patient_prescriptions WHERE patient_id = p1;
  v_err := pg_temp.try_apply(p1, e1, v_inv->>'plan_hash');
  PERFORM pg_temp.chk('8. a plan made stale by a later change is refused', v_err LIKE 'ODA_PLAN_STALE%', v_err);
  v_inv := pg_temp.oda_inventory(p1, e1, P);

  -- ================= 10: injected failures roll everything back =================
  v_fp := pg_temp.oda_fp(gen_random_uuid(), 'nobody@example.invalid');
  FOREACH v_t IN ARRAY ARRAY['after_lock', 'mid_change', 'before_verify'] LOOP
    v_err := pg_temp.try_apply(p1, e1, v_inv->>'plan_hash', v_t);
    PERFORM pg_temp.chk('10. failure at ' || v_t || ' rolls back completely (fingerprint identical, account intact)',
      v_err LIKE 'ODA_INJECTED_FAILURE%' AND pg_temp.oda_fp(gen_random_uuid(), 'nobody@example.invalid') = v_fp
      AND EXISTS (SELECT 1 FROM auth.users WHERE id = p1) AND EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = p1), v_err);
  END LOOP;

  -- ================= 1/11/12: DELETE outcome =================
  v_fp := pg_temp.oda_fp(p1, e1);
  v_trg := pg_temp.oda_trigger_state();
  v_r := pg_temp.oda_apply(p1, e1, P, v_inv->>'plan_hash');
  PERFORM pg_temp.chk('1. delete: completes, verified in-transaction', v_r->>'outcome' = 'delete' AND (v_r->>'verified')::boolean, v_r::text);
  PERFORM pg_temp.chk('1. delete: no reference to the account remains in any table (catalog-driven)',
    NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p1) AND NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p1)
    AND NOT EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = p1) AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = p1)
    AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = p1)
    AND NOT EXISTS (SELECT 1 FROM invitations WHERE lower(email) = lower(e1)) AND NOT EXISTS (SELECT 1 FROM rehab_sessions WHERE user_id = p1)
    AND NOT EXISTS (SELECT 1 FROM prescription_versions WHERE user_id = p1) AND NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = p1));
  PERFORM pg_temp.chk('11. delete: every unrelated record is byte-identical (other patients, clinician, org, safety history, catalog)', pg_temp.oda_fp(p1, e1) = v_fp);
  PERFORM pg_temp.chk('12. delete: trigger state identical; no safety/audit guard disabled',
    pg_temp.oda_trigger_state() = v_trg AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE (tgname LIKE 'trg_m32_%' OR tgname LIKE '%immutable%' OR tgname LIKE '%guard%') AND tgenabled = 'D'));
  -- ================= 9: repeated execution =================
  PERFORM pg_temp.chk('9. a repeated dry run after deletion reports account_not_found', pg_temp.oda_inventory(p1, e1, P)->'refusals' ? 'account_not_found');
  v_err := pg_temp.try_apply(p1, e1, v_inv->>'plan_hash');
  PERFORM pg_temp.chk('9. a repeated apply is refused (nothing to do)', v_err LIKE 'ODA_REFUSED%account_not_found%', v_err);

  -- ================= 2: CLOSE outcome (protected safety history) =================
  v_inv := pg_temp.oda_inventory(p2, e2, P);
  PERFORM pg_temp.chk('2. p2 inventory: outcome CLOSE, protected records listed, retained data reported',
    v_inv->>'outcome' = 'close' AND (v_inv->'protected_safety_records'->>'public.acute_safety_episodes.user_id')::int >= 1
    AND (v_inv->'protected_safety_records'->>'public.safety_notification_events.patient_id')::int >= 1
    AND v_inv->'retained_if_closed' ? 'auth_audit_log_entries', v_inv::text);
  SELECT jsonb_build_object('episodes', (SELECT count(*) FROM acute_safety_episodes WHERE user_id = p2),
    'events', (SELECT count(*) FROM safety_notification_events WHERE patient_id = p2),
    'recipients', (SELECT count(*) FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id WHERE e.patient_id = p2),
    'outbox', (SELECT count(*) FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = p2),
    'sessions', (SELECT count(*) FROM rehab_sessions WHERE user_id = p2)) INTO v_inv2;
  v_fp := pg_temp.oda_fp(p2, e2);
  v_r := pg_temp.oda_apply(p2, e2, P, v_inv->>'plan_hash');
  PERFORM pg_temp.chk('2. close: completes, verified, NOT reported as deletion', v_r->>'outcome' = 'close' AND (v_r->>'verified')::boolean, v_r::text);
  PERFORM pg_temp.chk('2. close: sign-in blocked (no password, banned), identity de-identified, metadata cleared',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p2 AND email = 'closed+' || p2 || '@deleted.invalid' AND encrypted_password = ''
            AND banned_until > now() + interval '100 years' AND raw_user_meta_data = '{}'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p2 AND email IS DISTINCT FROM 'closed+' || p2 || '@deleted.invalid'));
  PERFORM pg_temp.chk('2. close: sessions and refresh tokens revoked',
    NOT EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = p2) AND NOT EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id = p2::text));
  PERFORM pg_temp.chk('2. close: profile (incl. timezone) and invitation email de-identified; assignment ended (clinician access removed)',
    (SELECT name FROM profiles WHERE id = p2) = 'Closed participant' AND (SELECT timezone FROM profiles WHERE id = p2) IS NULL AND NOT EXISTS (SELECT 1 FROM invitations WHERE lower(email) = lower(e2))
    AND NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = p2 AND status = 'active')
    AND EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = p2 AND status = 'dismissed' AND dismissed_reason LIKE 'Participant account closed%'));
  PERFORM pg_temp.chk('2. close: protected safety history and clinical records retained exactly',
    jsonb_build_object('episodes', (SELECT count(*) FROM acute_safety_episodes WHERE user_id = p2),
      'events', (SELECT count(*) FROM safety_notification_events WHERE patient_id = p2),
      'recipients', (SELECT count(*) FROM safety_notification_recipients r JOIN safety_notification_events e ON e.id = r.event_id WHERE e.patient_id = p2),
      'outbox', (SELECT count(*) FROM safety_email_outbox o JOIN safety_notification_events e ON e.id = o.event_id WHERE e.patient_id = p2),
      'sessions', (SELECT count(*) FROM rehab_sessions WHERE user_id = p2)) = v_inv2, v_inv2::text);
  PERFORM pg_temp.chk('11. close: every unrelated record is byte-identical', pg_temp.oda_fp(p2, e2) = v_fp);
  PERFORM pg_temp.chk('12. close: trigger state identical', pg_temp.oda_trigger_state() = v_trg);
  v_r := pg_temp.oda_inventory(p2, 'closed+' || p2 || '@deleted.invalid', P);
  PERFORM pg_temp.chk('9. a repeated run on a closed account is refused (already_closed); the old address no longer matches',
    v_r->'refusals' ? 'already_closed' AND pg_temp.oda_inventory(p2, e2, P)->'refusals' ? 'email_does_not_match_account', v_r::text);

  -- ================= closure re-check after the token lifetime =================
  -- A token issued before the closure can still edit the participant's own
  -- profile (RLS own-update) for up to an hour: simulate exactly that path.
  v_err := pg_temp.as_role('authenticated', p2, format('UPDATE public.profiles SET name = %L, timezone = %L WHERE id = %L', 'Re-identified', 'America/Denver', p2));
  PERFORM pg_temp.chk('residual: a still-valid participant token can edit its own profile (RLS own-update) — the reason for the re-check',
    v_err = 'OK' AND (SELECT name FROM profiles WHERE id = p2) = 'Re-identified', v_err);
  v_inv := pg_temp.oda_inventory(p2, 'closed+' || p2 || '@deleted.invalid', P);
  PERFORM pg_temp.chk('re-check: the dry run detects the changed profile and offers a re-close',
    v_inv->>'outcome' = 'close' AND (v_inv->>'reclose')::boolean AND v_inv->'closure_drift' ? 'profile' AND NOT (v_inv->'refusals' ? 'already_closed'), v_inv::text);
  v_r := pg_temp.oda_apply(p2, 'closed+' || p2 || '@deleted.invalid', P, v_inv->>'plan_hash');
  PERFORM pg_temp.chk('re-close: re-applies the de-identification (verified), protected records still unchanged',
    v_r->>'outcome' = 'close' AND (v_r->>'verified')::boolean AND (SELECT name FROM profiles WHERE id = p2) = 'Closed participant'
    AND (SELECT timezone FROM profiles WHERE id = p2) IS NULL
    AND (SELECT count(*) FROM safety_notification_events WHERE patient_id = p2) = (v_inv2->>'events')::bigint, v_r::text);
  PERFORM pg_temp.chk('re-check: an intact closure is refused as already_closed (nothing to do)',
    pg_temp.oda_inventory(p2, 'closed+' || p2 || '@deleted.invalid', P)->'refusals' ? 'already_closed');

  -- ================= 11: the unrelated patient and clinician are intact =================
  PERFORM pg_temp.chk('11. the unrelated patient (same clinician) keeps account, agreement, assignment, sessions',
    EXISTS (SELECT 1 FROM auth.users WHERE id = p4 AND email = e4) AND EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = p4)
    AND EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = p4 AND supervisor_id = cA AND status = 'active')
    AND EXISTS (SELECT 1 FROM rehab_sessions WHERE user_id = p4) AND EXISTS (SELECT 1 FROM invitations WHERE lower(email) = lower(e4)));
  PERFORM pg_temp.chk('11. the clinician, super user, organization and catalog exercises are intact',
    EXISTS (SELECT 1 FROM organization_members WHERE user_id = cA AND role = 'clinician') AND EXISTS (SELECT 1 FROM organization_members WHERE user_id = sU)
    AND EXISTS (SELECT 1 FROM organizations WHERE id = v_org) AND (SELECT count(*) FROM canonical_exercises WHERE name LIKE 'ODA %' || s) = 2);

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END;
$oda$;

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
