-- Alpha 1 — Participation Agreement verification (migration 20261110000001).
-- One transaction, ROLLBACK'd — nothing persists. Creates its own throwaway
-- auth users, organization and invitations inside the transaction.
--
-- Two ways to run:
--   * migration already applied:  supabase db query --linked --file web/scripts/verifyAlpha1Agreement.sql
--   * BEFORE applying (nonpersistent): run "BEGIN;" + the migration file + this
--     file without its first BEGIN and last ROLLBACK + "ROLLBACK;" as ONE batch.
-- Must run as the migration owner (postgres).
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

CREATE FUNCTION pg_temp.chk(p_label TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO verify_results(result)
  VALUES (CASE WHEN p_ok IS TRUE THEN 'PASS: ' ELSE 'FAIL: ' END || p_label
          || CASE WHEN p_ok IS TRUE OR p_detail IS NULL THEN '' ELSE ' [' || p_detail || ']' END);
$$;

CREATE FUNCTION pg_temp.mkuser(p_email TEXT) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, '', now(), now(), now(), '{}', jsonb_build_object('name', split_part(p_email, '@', 1)));
  RETURN v_id;
END;
$$;

CREATE FUNCTION pg_temp.h(p TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- Runs p_sql under p_role (grants and RLS apply); returns 'OK' or the SQLSTATE.
CREATE FUNCTION pg_temp.as_role(p_role TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_state TEXT := 'OK';
BEGIN
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  RESET ROLE;
  RETURN v_state;
END;
$$;

-- Calls the wrapper exactly as the server does (as service_role).
CREATE FUNCTION pg_temp.accept_as_server(p_hash TEXT, p_user UUID, p_key TEXT, p_version TEXT, p_sha TEXT) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v JSONB;
BEGIN
  SET LOCAL ROLE service_role;
  BEGIN
    v := public.accept_patient_invitation_with_agreement(p_hash, p_user, p_key, p_version, p_sha);
  EXCEPTION WHEN OTHERS THEN
    v := jsonb_build_object('result', 'EXCEPTION', 'sqlstate', SQLSTATE, 'message', SQLERRM);
  END;
  RESET ROLE;
  RETURN v;
END;
$$;

DO $verify$
DECLARE
  s TEXT := substr(md5(random()::text), 1, 8);
  v_org UUID;
  cA UUID; pNew UUID; pOther UUID; pDup UUID; pDel UUID; staff UUID;
  v_r JSONB; v_r2 JSONB;
  v_inv UUID;
  v_err TEXT;
  v_n INT;
  v_pass INT; v_fail INT;
  k CONSTANT TEXT := 'alpha1_participation';
  ver CONSTANT TEXT := '1.0';
  sha CONSTANT TEXT := 'f58f56599a1e91e28fde7fbf11dddacb10593cfea9ff80cf0c4b77d43985a90d';
BEGIN
  -- ================= fixtures (inside the transaction) =================
  INSERT INTO organizations (name, slug) VALUES ('A1 Agreement Org ' || s, 'a1-agree-' || s) RETURNING id INTO v_org;
  cA := pg_temp.mkuser('a1-clin-' || s || '@example.invalid');
  pNew := pg_temp.mkuser('a1-pnew-' || s || '@example.invalid');
  pOther := pg_temp.mkuser('a1-pother-' || s || '@example.invalid');
  pDup := pg_temp.mkuser('a1-pdup-' || s || '@example.invalid');
  pDel := pg_temp.mkuser('a1-pdel-' || s || '@example.invalid');
  staff := pg_temp.mkuser('a1-staff-' || s || '@example.invalid');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (v_org, cA, 'clinician'), (v_org, staff, 'clinician');

  -- ================= schema, RLS, grants, ownership =================
  PERFORM pg_temp.chk('schema: table with the required columns',
    (SELECT array_agg(column_name::text ORDER BY column_name::text) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'participation_agreement_acceptances')
    = ARRAY['accepted_at', 'agreement_key', 'agreement_sha256', 'agreement_version', 'id', 'invitation_id', 'user_id']);
  PERFORM pg_temp.chk('schema: unique (user_id, agreement_key, agreement_version)',
    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'participation_agreement_acceptances_once' AND contype = 'u'));
  PERFORM pg_temp.chk('schema: accepted_at defaults to now() and is NOT NULL',
    (SELECT column_default = 'now()' AND is_nullable = 'NO' FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'participation_agreement_acceptances' AND column_name = 'accepted_at'));
  PERFORM pg_temp.chk('schema: user_id -> auth.users ON DELETE CASCADE; invitation_id -> invitations ON DELETE SET NULL',
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.participation_agreement_acceptances'::regclass AND contype = 'f'
              AND confrelid = 'auth.users'::regclass AND confdeltype = 'c')
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.participation_agreement_acceptances'::regclass AND contype = 'f'
              AND confrelid = 'public.invitations'::regclass AND confdeltype = 'n'));
  PERFORM pg_temp.chk('RLS: enabled, no policies',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.participation_agreement_acceptances'::regclass)
    AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'participation_agreement_acceptances'));
  PERFORM pg_temp.chk('grants: anon and authenticated have no table privilege; service_role has SELECT only',
    NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public'
                  AND table_name = 'participation_agreement_acceptances' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
    AND (SELECT array_agg(privilege_type::text ORDER BY privilege_type::text) FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = 'participation_agreement_acceptances' AND grantee = 'service_role') = ARRAY['SELECT']);
  PERFORM pg_temp.chk('function: SECURITY DEFINER, search_path empty, same owner as accept_patient_invitation',
    (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""']
            AND p.proowner = (SELECT proowner FROM pg_proc WHERE oid = 'public.accept_patient_invitation(text, uuid)'::regprocedure)
     FROM pg_proc p WHERE p.oid = 'public.accept_patient_invitation_with_agreement(text, uuid, text, text, text)'::regprocedure));
  PERFORM pg_temp.chk('grants: the wrapper is executable by service_role only',
    has_function_privilege('service_role', 'public.accept_patient_invitation_with_agreement(text, uuid, text, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.accept_patient_invitation_with_agreement(text, uuid, text, text, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.accept_patient_invitation_with_agreement(text, uuid, text, text, text)', 'EXECUTE'));
  PERFORM pg_temp.chk('grants: the original accept_patient_invitation is no longer executable by service_role, anon or authenticated',
    NOT has_function_privilege('service_role', 'public.accept_patient_invitation(text, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.accept_patient_invitation(text, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.accept_patient_invitation(text, uuid)', 'EXECUTE'));

  -- ================= invalid arguments write nothing =================
  v_r := create_patient_invitation(cA, v_org, 'a1-pnew-' || s || '@example.invalid', pg_temp.h('tok-new-' || s));
  v_inv := (v_r->>'invitation_id')::uuid;
  PERFORM pg_temp.chk('fixture: patient invitation created', v_r->>'result' = 'created', v_r::text);
  PERFORM pg_temp.chk('invalid: wrong key / malformed version / malformed hash / NULLs -> agreement_invalid',
    pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, 'other_agreement', ver, sha)->>'result' = 'agreement_invalid'
    AND pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, k, 'v1', sha)->>'result' = 'agreement_invalid'
    AND pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, k, ver, 'NOT-A-HASH')->>'result' = 'agreement_invalid'
    AND pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, NULL, ver, sha)->>'result' = 'agreement_invalid'
    AND pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, k, NULL, sha)->>'result' = 'agreement_invalid'
    AND pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, k, ver, NULL)->>'result' = 'agreement_invalid');
  PERFORM pg_temp.chk('invalid: the invitation is untouched and no acceptance row exists',
    (SELECT status FROM invitations WHERE id = v_inv) = 'pending'
    AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pNew)
    AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pNew));
  PERFORM pg_temp.chk('invalid: unknown / malformed token hash -> invalid, nothing written',
    pg_temp.accept_as_server(pg_temp.h('never-issued-' || s), pNew, k, ver, sha)->>'result' = 'invalid'
    AND pg_temp.accept_as_server('not-a-hash', pNew, k, ver, sha)->>'result' = 'invalid'
    AND pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), NULL, k, ver, sha)->>'result' = 'invalid'
    AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pNew));

  -- ================= successful acceptance =================
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, k, ver, sha);
  PERFORM pg_temp.chk('accept: result accepted (service_role path)', v_r->>'result' = 'accepted', v_r::text);
  PERFORM pg_temp.chk('accept: exactly one acceptance row with the server-supplied key, version, hash and invitation',
    (SELECT count(*) FROM participation_agreement_acceptances WHERE user_id = pNew) = 1
    AND EXISTS (SELECT 1 FROM participation_agreement_acceptances a WHERE a.user_id = pNew AND a.agreement_key = k
                  AND a.agreement_version = ver AND a.agreement_sha256 = sha AND a.invitation_id = v_inv));
  PERFORM pg_temp.chk('accept: timestamp is the database''s, identical to invitations.accepted_at (same transaction)',
    (SELECT a.accepted_at FROM participation_agreement_acceptances a WHERE a.user_id = pNew)
      = (SELECT accepted_at FROM invitations WHERE id = v_inv)
    AND (SELECT a.accepted_at FROM participation_agreement_acceptances a WHERE a.user_id = pNew) = now());
  PERFORM pg_temp.chk('accept: the existing M2 effects are unchanged (member membership, active assignment, accepted_by)',
    (SELECT role FROM organization_members WHERE user_id = pNew AND organization_id = v_org) = 'member'
    AND EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = pNew AND supervisor_id = cA AND status = 'active' AND source_invitation_id = v_inv)
    AND (SELECT accepted_by FROM invitations WHERE id = v_inv) = pNew);

  -- ================= replay, duplicates, other users =================
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pNew, k, ver, sha);
  PERFORM pg_temp.chk('duplicate: same-user replay -> already_accepted, still exactly one acceptance row and one assignment',
    v_r->>'result' = 'already_accepted'
    AND (SELECT count(*) FROM participation_agreement_acceptances WHERE user_id = pNew) = 1
    AND (SELECT count(*) FROM supervisor_patients WHERE patient_id = pNew AND status = 'active') = 1, v_r::text);
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-new-' || s), pOther, k, ver, sha);
  PERFORM pg_temp.chk('replay: another user with the consumed token -> already_used, no row for them',
    v_r->>'result' = 'already_used' AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pOther), v_r::text);

  -- An invitation accepted BEFORE the agreement existed (pre-migration path,
  -- as postgres; e.g. the existing synthetic patient) must never gain a
  -- retrospective acknowledgment through the wrapper.
  v_r := create_patient_invitation(cA, v_org, 'a1-pdup-' || s || '@example.invalid', pg_temp.h('tok-dup-' || s));
  v_r := public.accept_patient_invitation(pg_temp.h('tok-dup-' || s), pDup);
  v_r2 := pg_temp.accept_as_server(pg_temp.h('tok-dup-' || s), pDup, k, ver, sha);
  PERFORM pg_temp.chk('no retrospective acknowledgment: replaying a pre-agreement acceptance -> already_accepted, NO record',
    v_r->>'result' = 'accepted' AND v_r2->>'result' = 'already_accepted'
    AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pDup), v_r2::text);
  v_r2 := pg_temp.accept_as_server(pg_temp.h('tok-dup-' || s), pDup, k, ver, sha);
  PERFORM pg_temp.chk('no retrospective acknowledgment: repeated replays still record nothing',
    NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pDup));
  PERFORM pg_temp.chk('every acceptance row was written at the moment its invitation was accepted (accepted_at = invitations.accepted_at)',
    NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances a JOIN invitations i ON i.id = a.invitation_id
                WHERE a.accepted_at IS DISTINCT FROM i.accepted_at));

  -- ================= every refusal writes nothing =================
  v_r := create_patient_invitation(cA, v_org, 'a1-pother-' || s || '@example.invalid', pg_temp.h('tok-exp-' || s));
  UPDATE invitations SET expires_at = now() - interval '1 second' WHERE token_hash = pg_temp.h('tok-exp-' || s);
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-exp-' || s), pOther, k, ver, sha);
  PERFORM pg_temp.chk('refusal: expired -> expired, no row, invitation still pending',
    v_r->>'result' = 'expired' AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pOther)
    AND (SELECT status FROM invitations WHERE token_hash = pg_temp.h('tok-exp-' || s)) = 'pending', v_r::text);

  v_r := create_patient_invitation(cA, v_org, 'a1-pother-' || s || '@example.invalid', pg_temp.h('tok-can-' || s));
  v_r := cancel_patient_invitation(cA, (v_r->>'invitation_id')::uuid);
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-can-' || s), pOther, k, ver, sha);
  PERFORM pg_temp.chk('refusal: cancelled -> cancelled, no row',
    v_r->>'result' = 'cancelled' AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pOther), v_r::text);

  v_r := create_patient_invitation(cA, v_org, 'a1-pother-' || s || '@example.invalid', pg_temp.h('tok-wrong-' || s));
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-wrong-' || s), pDel, k, ver, sha);
  PERFORM pg_temp.chk('refusal: wrong account (email mismatch) -> wrong_account, no row for either user',
    v_r->>'result' = 'wrong_account'
    AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id IN (pDel, pOther))
    AND (SELECT status FROM invitations WHERE token_hash = pg_temp.h('tok-wrong-' || s)) = 'pending', v_r::text);

  -- A staff address cannot be invited (refused at creation), so build the row
  -- directly to prove the staff refusal still fires through the wrapper.
  INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at)
  VALUES (v_org, cA, 'a1-staff-' || s || '@example.invalid', 'PATIENT', 'member', pg_temp.h('tok-staff-' || s), now() + interval '1 day');
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-staff-' || s), staff, k, ver, sha);
  PERFORM pg_temp.chk('refusal: staff account -> staff_account, no row, role unchanged',
    v_r->>'result' = 'staff_account' AND NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = staff)
    AND (SELECT role FROM organization_members WHERE user_id = staff) = 'clinician', v_r::text);

  -- ================= access control =================
  v_err := pg_temp.as_role('service_role', format('SELECT public.accept_patient_invitation(%L, %L::uuid)', pg_temp.h('tok-wrong-' || s), pOther));
  PERFORM pg_temp.chk('bypass: service_role cannot call the original accept_patient_invitation (42501)', v_err = '42501', v_err);
  v_err := pg_temp.as_role('authenticated', format('SELECT public.accept_patient_invitation_with_agreement(%L, %L::uuid, %L, %L, %L)', pg_temp.h('tok-wrong-' || s), pOther, k, ver, sha));
  PERFORM pg_temp.chk('authenticated cannot call the wrapper (42501)', v_err = '42501', v_err);
  v_err := pg_temp.as_role('anon', format('SELECT public.accept_patient_invitation_with_agreement(%L, %L::uuid, %L, %L, %L)', pg_temp.h('tok-wrong-' || s), pOther, k, ver, sha));
  PERFORM pg_temp.chk('anon cannot call the wrapper (42501)', v_err = '42501', v_err);
  PERFORM pg_temp.chk('anon / authenticated cannot read or write the table (42501)',
    pg_temp.as_role('authenticated', 'SELECT count(*) FROM public.participation_agreement_acceptances') = '42501'
    AND pg_temp.as_role('anon', 'SELECT count(*) FROM public.participation_agreement_acceptances') = '42501'
    AND pg_temp.as_role('authenticated', format('INSERT INTO public.participation_agreement_acceptances (user_id, agreement_key, agreement_version, agreement_sha256) VALUES (%L, %L, %L, %L)', pOther, k, ver, sha)) = '42501');
  PERFORM pg_temp.chk('service_role can read but cannot insert, update or delete (forged rows impossible)',
    pg_temp.as_role('service_role', 'SELECT count(*) FROM public.participation_agreement_acceptances') = 'OK'
    AND pg_temp.as_role('service_role', format('INSERT INTO public.participation_agreement_acceptances (user_id, agreement_key, agreement_version, agreement_sha256, accepted_at) VALUES (%L, %L, %L, %L, %L)', pOther, k, ver, sha, '2000-01-01')) = '42501'
    AND pg_temp.as_role('service_role', 'UPDATE public.participation_agreement_acceptances SET accepted_at = now()') = '42501'
    AND pg_temp.as_role('service_role', 'DELETE FROM public.participation_agreement_acceptances') = '42501');
  PERFORM pg_temp.chk('constraints reject malformed rows even for the owner',
    pg_temp.as_role('postgres', format('INSERT INTO public.participation_agreement_acceptances (user_id, agreement_key, agreement_version, agreement_sha256) VALUES (%L, %L, %L, %L)', pOther, 'x', ver, sha)) = '23514'
    AND pg_temp.as_role('postgres', format('INSERT INTO public.participation_agreement_acceptances (user_id, agreement_key, agreement_version, agreement_sha256) VALUES (%L, %L, %L, %L)', pOther, k, ver, 'abc')) = '23514');

  -- ================= retention =================
  v_r := create_patient_invitation(cA, v_org, 'a1-pdel-' || s || '@example.invalid', pg_temp.h('tok-del-' || s));
  v_r := pg_temp.accept_as_server(pg_temp.h('tok-del-' || s), pDel, k, ver, sha);
  PERFORM pg_temp.chk('fixture: retention user accepted with a record',
    v_r->>'result' = 'accepted' AND (SELECT count(*) FROM participation_agreement_acceptances WHERE user_id = pDel) = 1, v_r::text);
  DELETE FROM invitations WHERE id = (SELECT invitation_id FROM participation_agreement_acceptances WHERE user_id = pDel);
  PERFORM pg_temp.chk('retention: deleting the invitation keeps the acceptance and clears invitation_id (fixture-purge order)',
    (SELECT invitation_id IS NULL FROM participation_agreement_acceptances WHERE user_id = pDel));
  DELETE FROM supervisor_patients WHERE patient_id = pDel;
  DELETE FROM organization_members WHERE user_id = pDel;
  DELETE FROM auth.users WHERE id = pDel;
  PERFORM pg_temp.chk('retention: deleting the account deletes its acceptance (ON DELETE CASCADE)',
    NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances WHERE user_id = pDel));
  PERFORM pg_temp.chk('association: every acceptance row belongs to the user whose invitation was accepted',
    NOT EXISTS (SELECT 1 FROM participation_agreement_acceptances a JOIN invitations i ON i.id = a.invitation_id
                WHERE i.accepted_by IS DISTINCT FROM a.user_id));

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END;
$verify$;

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
