-- M2 verification: native patient invitation + atomic acceptance, the
-- Postgres assignment authority (period rows, multi-clinician, organization
-- invariant), admin add/end, the invitation role-escalation fix, token
-- hashing, and the identity-table grant hardening. One transaction,
-- ROLLBACK'd — nothing persists. Creates its own throwaway auth users and
-- organizations inside the transaction.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyM2NativeOnboarding.sql
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);
GRANT ALL ON verify_results TO authenticated;
GRANT ALL ON SEQUENCE verify_results_seq_seq TO authenticated;

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

-- Runs p_sql as an authenticated user (RLS + grants apply); returns the
-- error code, or 'OK'.
CREATE FUNCTION pg_temp.as_user(p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_state TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    v_state := 'OK';
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$$;

DO $verify$
DECLARE
  s TEXT := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_orgA UUID; v_orgB UUID;
  cA1 UUID; cA2 UUID; cA3 UUID; cA4 UUID; adminA UUID; suA UUID; cB UUID;
  pNew UUID; pExisting UUID; pOther UUID; pX UUID; pLater UUID;
  v_r JSONB; v_r2 JSONB;
  v_id UUID; v_inv UUID; v_sp UUID; v_pp UUID;
  v_n INT;
  v_err TEXT;
  v_pass INT; v_fail INT;
BEGIN
  INSERT INTO organizations (name, slug) VALUES ('M2 Verify Org A', 'm2-verify-a-' || s) RETURNING id INTO v_orgA;
  INSERT INTO organizations (name, slug) VALUES ('M2 Verify Org B', 'm2-verify-b-' || s) RETURNING id INTO v_orgB;
  cA1 := pg_temp.mkuser('m2-ca1-' || s || '@example.invalid');
  cA2 := pg_temp.mkuser('m2-ca2-' || s || '@example.invalid');
  cA3 := pg_temp.mkuser('m2-ca3-' || s || '@example.invalid');
  cA4 := pg_temp.mkuser('m2-ca4-' || s || '@example.invalid');
  adminA := pg_temp.mkuser('m2-admina-' || s || '@example.invalid');
  suA := pg_temp.mkuser('m2-sua-' || s || '@example.invalid');
  cB := pg_temp.mkuser('m2-cb-' || s || '@example.invalid');
  pNew := pg_temp.mkuser('m2-pnew-' || s || '@example.invalid');
  pExisting := pg_temp.mkuser('m2-pexisting-' || s || '@example.invalid');
  pOther := pg_temp.mkuser('m2-pother-' || s || '@example.invalid');
  pX := pg_temp.mkuser('m2-px-' || s || '@example.invalid');
  pLater := pg_temp.mkuser('m2-plater-' || s || '@example.invalid');
  INSERT INTO organization_members (organization_id, user_id, role) VALUES
    (v_orgA, cA1, 'clinician'), (v_orgA, cA2, 'clinician'), (v_orgA, cA3, 'clinician'), (v_orgA, cA4, 'clinician'),
    (v_orgA, adminA, 'clinician_admin'), (v_orgA, suA, 'super_user'),
    (v_orgB, cB, 'clinician'), (v_orgA, pExisting, 'member'), (v_orgB, pOther, 'member');

  -- ================= schema =================
  PERFORM pg_temp.chk('schema: invitations has no plaintext token column; token_hash is NOT NULL',
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'token')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'token_hash' AND is_nullable = 'NO'));
  PERFORM pg_temp.chk('schema: every existing invitation has a well-formed hash',
    NOT EXISTS (SELECT 1 FROM invitations WHERE token_hash !~ '^[0-9a-f]{64}$'));
  PERFORM pg_temp.chk('schema: every assignment row has an organization and a known status',
    NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE organization_id IS NULL OR status NOT IN ('active', 'dismissed')));
  PERFORM pg_temp.chk('schema: pair-uniqueness replaced by active-only (organization, clinician, patient) uniqueness',
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supervisor_patients_supervisor_id_patient_id_key')
    AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'supervisor_patients_one_active_period' AND indexdef LIKE '%(organization_id, supervisor_id, patient_id) WHERE (status = ''active''::text)%'));

  -- ================= 1. clinician creates a patient invitation =================
  v_r := create_patient_invitation(cA1, v_orgA, '  M2-PNEW-' || s || '@EXAMPLE.invalid ', pg_temp.h('tok-pnew-1-' || s));
  SELECT * INTO v_inv FROM (SELECT id FROM invitations WHERE id = (v_r->>'invitation_id')::uuid) x;
  PERFORM pg_temp.chk('1. clinician creates a patient invitation (type PATIENT, role member, hash only, normalized email, 7-day expiry)',
    v_r->>'result' = 'created' AND EXISTS (
      SELECT 1 FROM invitations i WHERE i.id = v_inv AND i.invitation_type = 'PATIENT' AND i.granted_role = 'member'
        AND i.token_hash = pg_temp.h('tok-pnew-1-' || s) AND i.invited_by = cA1 AND i.status = 'pending'
        AND i.email = 'm2-pnew-' || s || '@example.invalid'
        AND i.expires_at BETWEEN now() + interval '6 days 23 hours' AND now() + interval '7 days 1 minute'), v_r::text);
  v_r := create_patient_invitation(cA1, v_orgA, 'm2-pnew-' || s || '@example.invalid', pg_temp.h('tok-pnew-2-' || s));
  PERFORM pg_temp.chk('1b. re-sending replaces the previous pending invitation (only the newest link works)',
    v_r->>'result' = 'created' AND (SELECT status FROM invitations WHERE id = v_inv) = 'cancelled'
    AND (SELECT count(*) FROM invitations WHERE organization_id = v_orgA AND email = 'm2-pnew-' || s || '@example.invalid' AND status = 'pending') = 1, v_r::text);
  PERFORM pg_temp.chk('1c. invalid email refused',
    create_patient_invitation(cA1, v_orgA, 'not-an-email', pg_temp.h('x1' || s))->>'result' = 'invalid_email');
  PERFORM pg_temp.chk('1d. non-clinician / other-organization clinician / super_user-only cannot create a patient invitation',
    create_patient_invitation(pExisting, v_orgA, 'a' || s || '@example.invalid', pg_temp.h('x2' || s))->>'result' = 'not_authorized'
    AND create_patient_invitation(cB, v_orgA, 'a' || s || '@example.invalid', pg_temp.h('x3' || s))->>'result' = 'not_authorized'
    AND create_patient_invitation(suA, v_orgA, 'a' || s || '@example.invalid', pg_temp.h('x4' || s))->>'result' = 'not_authorized');
  PERFORM pg_temp.chk('13a. inviting an address that is staff in the organization is refused at creation',
    create_patient_invitation(cA1, v_orgA, 'm2-ca2-' || s || '@example.invalid', pg_temp.h('x5' || s))->>'result' = 'staff_account'
    AND create_patient_invitation(cA1, v_orgA, 'm2-admina-' || s || '@example.invalid', pg_temp.h('x6' || s))->>'result' = 'staff_account');

  -- ================= 2/4. new patient accepts (account created before the transaction) =================
  v_r := accept_patient_invitation(pg_temp.h('tok-pnew-1-' || s), pNew);
  PERFORM pg_temp.chk('10b. the superseded (cancelled) link is refused and writes nothing',
    v_r->>'result' = 'cancelled' AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pNew), v_r::text);
  v_r := accept_patient_invitation(pg_temp.h('tok-pnew-2-' || s), pNew);
  PERFORM pg_temp.chk('2/4. new patient accepts: membership(member) + active assignment + accepted state commit together',
    v_r->>'result' = 'accepted' AND (v_r->>'assignment_created')::boolean
    AND EXISTS (SELECT 1 FROM organization_members WHERE user_id = pNew AND organization_id = v_orgA AND role = 'member')
    AND EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.id = (v_r->>'assignment_id')::uuid AND sp.organization_id = v_orgA
                  AND sp.supervisor_id = cA1 AND sp.patient_id = pNew AND sp.status = 'active' AND sp.created_by = pNew
                  AND sp.source_invitation_id = (SELECT id FROM invitations WHERE token_hash = pg_temp.h('tok-pnew-2-' || s)))
    AND EXISTS (SELECT 1 FROM invitations WHERE token_hash = pg_temp.h('tok-pnew-2-' || s) AND status = 'accepted' AND accepted_by = pNew AND accepted_at IS NOT NULL), v_r::text);
  PERFORM pg_temp.chk('19. the inviting clinician now has access', clinician_patient_access(cA1, pNew));

  -- ================= 5/11. replay =================
  v_r := accept_patient_invitation(pg_temp.h('tok-pnew-2-' || s), pNew);
  PERFORM pg_temp.chk('5. same-user replay is an idempotent success and creates no duplicate',
    v_r->>'result' = 'already_accepted'
    AND (SELECT count(*) FROM supervisor_patients WHERE supervisor_id = cA1 AND patient_id = pNew) = 1, v_r::text);
  v_r := accept_patient_invitation(pg_temp.h('tok-pnew-2-' || s), pX);
  PERFORM pg_temp.chk('11. a consumed invitation cannot be claimed by another user',
    v_r->>'result' = 'already_used' AND NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = pX)
    AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pX), v_r::text);
  PERFORM pg_temp.chk('5b. inviting an already-assigned patient again is reported, not duplicated',
    create_patient_invitation(cA1, v_orgA, 'm2-pnew-' || s || '@example.invalid', pg_temp.h('x7' || s))->>'result' = 'already_assigned');
  PERFORM pg_temp.chk('invalid / unknown tokens are refused',
    accept_patient_invitation(pg_temp.h('never-issued' || s), pNew)->>'result' = 'invalid'
    AND accept_patient_invitation('not-a-hash', pNew)->>'result' = 'invalid');

  -- ================= 3. existing patient account accepts =================
  v_r := create_patient_invitation(cA1, v_orgA, 'm2-pexisting-' || s || '@example.invalid', pg_temp.h('tok-pexisting-' || s));
  v_r := accept_patient_invitation(pg_temp.h('tok-pexisting-' || s), pExisting);
  PERFORM pg_temp.chk('3. existing patient account (already a member) accepts; membership unchanged; assignment created',
    v_r->>'result' = 'accepted' AND clinician_patient_access(cA1, pExisting)
    AND (SELECT count(*) FROM organization_members WHERE user_id = pExisting) = 1
    AND (SELECT role FROM organization_members WHERE user_id = pExisting) = 'member', v_r::text);

  -- ================= 6/7/41. second clinician in the same organization =================
  v_r := create_patient_invitation(cA2, v_orgA, 'm2-pnew-' || s || '@example.invalid', pg_temp.h('tok-pnew-ca2-' || s));
  v_r := accept_patient_invitation(pg_temp.h('tok-pnew-ca2-' || s), pNew);
  PERFORM pg_temp.chk('6. a second clinician in the SAME organization is added on acceptance',
    v_r->>'result' = 'accepted' AND clinician_patient_access(cA2, pNew), v_r::text);
  PERFORM pg_temp.chk('7/41. the existing clinician remains active; both clinicians have access',
    clinician_patient_access(cA1, pNew) AND clinician_patient_access(cA2, pNew)
    AND (SELECT count(*) FROM supervisor_patients WHERE patient_id = pNew AND status = 'active') = 2);

  -- ================= 8. different organization =================
  v_r := create_patient_invitation(cB, v_orgB, 'm2-pnew-' || s || '@example.invalid', pg_temp.h('tok-pnew-cb-' || s));
  PERFORM pg_temp.chk('8a. creating an invitation never reveals another organization''s patient', v_r->>'result' = 'created', v_r::text);
  v_r := accept_patient_invitation(pg_temp.h('tok-pnew-cb-' || s), pNew);
  PERFORM pg_temp.chk('8. a different-organization invitation does not auto-transfer or add a cross-org relationship',
    v_r->>'result' = 'other_organization'
    AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pNew AND organization_id = v_orgB)
    AND NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = pNew AND organization_id = v_orgB)
    AND (SELECT status FROM invitations WHERE token_hash = pg_temp.h('tok-pnew-cb-' || s)) = 'pending'
    AND clinician_patient_access(cA1, pNew) AND clinician_patient_access(cA2, pNew), v_r::text);

  -- ================= 9/10/12/13. refusals leave the invitation retryable =================
  v_r := create_patient_invitation(cA1, v_orgA, 'm2-plater-' || s || '@example.invalid', pg_temp.h('tok-exp-' || s));
  UPDATE invitations SET expires_at = now() - interval '1 second' WHERE token_hash = pg_temp.h('tok-exp-' || s);
  v_r := accept_patient_invitation(pg_temp.h('tok-exp-' || s), pLater);
  PERFORM pg_temp.chk('9. expired invitation refused; nothing written',
    v_r->>'result' = 'expired' AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pLater)
    AND NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE patient_id = pLater), v_r::text);

  v_r := create_patient_invitation(cA1, v_orgA, 'm2-plater-' || s || '@example.invalid', pg_temp.h('tok-cancel-' || s));
  v_inv := (v_r->>'invitation_id')::uuid;
  PERFORM pg_temp.chk('cancel: another regular clinician cannot cancel it (indistinguishable from not found)',
    cancel_patient_invitation(cA2, v_inv)->>'result' = 'not_found' AND cancel_patient_invitation(cB, v_inv)->>'result' = 'not_found');
  PERFORM pg_temp.chk('cancel: the inviting clinician cancels; a second cancel reports not_pending',
    cancel_patient_invitation(cA1, v_inv)->>'result' = 'cancelled' AND cancel_patient_invitation(cA1, v_inv)->>'result' = 'not_pending');
  v_r := accept_patient_invitation(pg_temp.h('tok-cancel-' || s), pLater);
  PERFORM pg_temp.chk('10. cancelled invitation refused; nothing written',
    v_r->>'result' = 'cancelled' AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pLater), v_r::text);
  v_r := create_patient_invitation(cA1, v_orgA, 'm2-plater-' || s || '@example.invalid', pg_temp.h('tok-admincancel-' || s));
  PERFORM pg_temp.chk('cancel: a clinician_admin of the organization may cancel a clinician''s invitation',
    cancel_patient_invitation(adminA, (v_r->>'invitation_id')::uuid)->>'result' = 'cancelled');

  v_r := create_patient_invitation(cA1, v_orgA, 'm2-plater-' || s || '@example.invalid', pg_temp.h('tok-later-' || s));
  v_r := accept_patient_invitation(pg_temp.h('tok-later-' || s), pX);
  PERFORM pg_temp.chk('12. wrong authenticated account refused; invitation stays pending',
    v_r->>'result' = 'wrong_account' AND (SELECT status FROM invitations WHERE token_hash = pg_temp.h('tok-later-' || s)) = 'pending'
    AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pX), v_r::text);
  v_r := accept_patient_invitation(pg_temp.h('tok-later-' || s), pLater);
  PERFORM pg_temp.chk('retry after a refusal succeeds (invitation was left retryable)', v_r->>'result' = 'accepted', v_r::text);

  v_r := create_patient_invitation(cA1, v_orgA, 'm2-cb-' || s || '@example.invalid', pg_temp.h('tok-staff-' || s));
  v_r2 := accept_patient_invitation(pg_temp.h('tok-staff-' || s), cB);
  PERFORM pg_temp.chk('13. a staff account (staff elsewhere) cannot accept a patient invitation; no role change',
    v_r->>'result' = 'created' AND v_r2->>'result' = 'staff_account'
    AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = cB AND organization_id = v_orgA)
    AND (SELECT role FROM organization_members WHERE user_id = cB) = 'clinician', v_r2::text);

  v_r := create_patient_invitation(cA3, v_orgA, 'm2-px-' || s || '@example.invalid', pg_temp.h('tok-inviter-' || s));
  UPDATE organization_members SET role = 'member' WHERE user_id = cA3 AND organization_id = v_orgA;
  v_r := accept_patient_invitation(pg_temp.h('tok-inviter-' || s), pX);
  PERFORM pg_temp.chk('an invitation from a clinician who is no longer a clinician is refused (inviter_unavailable)',
    v_r->>'result' = 'inviter_unavailable' AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pX), v_r::text);
  UPDATE organization_members SET role = 'clinician' WHERE user_id = cA3 AND organization_id = v_orgA;

  -- ================= 15/16/17. direct writes and escalation =================
  v_err := pg_temp.as_user(pX, format('INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (%L, %L, %L)', v_orgA, cA1, pX));
  PERFORM pg_temp.chk('15. a patient cannot self-assign (direct INSERT refused)', v_err = '42501', v_err);
  v_err := pg_temp.as_user(pNew, format('UPDATE supervisor_patients SET status = ''active'' WHERE patient_id = %L', pNew));
  PERFORM pg_temp.chk('15b. a patient cannot modify their assignment rows', v_err = '42501', v_err);
  v_err := pg_temp.as_user(pX, format('INSERT INTO organization_members (organization_id, user_id, role) VALUES (%L, %L, ''super_user'')', v_orgA, pX));
  PERFORM pg_temp.chk('16. a patient cannot forge a membership/role (INSERT refused)', v_err = '42501', v_err);
  v_err := pg_temp.as_user(pNew, format('UPDATE organization_members SET role = ''clinician'' WHERE user_id = %L', pNew));
  PERFORM pg_temp.chk('16b. a patient cannot change their own role (UPDATE refused)', v_err = '42501', v_err);
  v_err := pg_temp.as_user(adminA, format(
    'INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at) VALUES (%L, %L, %L, ''CLINICIAN_ADMIN_TESTER'', ''super_user'', %L, now() + interval ''7 days'')',
    v_orgA, adminA, 'esc-' || s || '@example.invalid', pg_temp.h('esc1' || s)));
  PERFORM pg_temp.chk('17. clinician_admin cannot insert an invitation directly (no super_user escalation path)', v_err = '42501', v_err);
  v_err := pg_temp.as_user(adminA, format('UPDATE invitations SET granted_role = ''super_user'' WHERE organization_id = %L', v_orgA));
  PERFORM pg_temp.chk('17b. clinician_admin cannot rewrite an invitation''s role', v_err = '42501', v_err);
  v_err := pg_temp.as_user(adminA, 'SELECT count(*) FROM invitations');
  PERFORM pg_temp.chk('17c. invitations are not readable by clients at all (no token material through ordinary reads)', v_err = '42501', v_err);
  BEGIN
    INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at)
    VALUES (v_orgA, adminA, 'esc2-' || s || '@example.invalid', 'CLINICIAN_ADMIN_TESTER', 'super_user', pg_temp.h('esc2' || s), now() + interval '7 days');
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE;
  END;
  PERFORM pg_temp.chk('17d. even a privileged writer cannot store a super_user invitation (role is fixed by type)', v_err = '23514', v_err);
  BEGIN
    INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at)
    VALUES (v_orgA, cA1, 'esc3-' || s || '@example.invalid', 'PATIENT', 'clinician_admin', pg_temp.h('esc3' || s), now() + interval '7 days');
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE;
  END;
  PERFORM pg_temp.chk('17e. a PATIENT invitation can only ever grant member', v_err = '23514', v_err);
  INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at)
  VALUES (v_orgA, adminA, 'm2-px-' || s || '@example.invalid', 'CLINICIAN_ADMIN_TESTER', 'clinician_admin', pg_temp.h('admin-type' || s), now() + interval '7 days');
  PERFORM pg_temp.chk('17f. the patient acceptance path refuses non-patient invitation types',
    accept_patient_invitation(pg_temp.h('admin-type' || s), pX)->>'result' = 'invalid'
    AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = pX));

  -- ================= 18/19/20/21/40. access, end, history =================
  INSERT INTO patient_prescriptions (patient_id) VALUES (pNew) RETURNING id INTO v_pp;
  PERFORM pg_temp.chk('18. an unrelated clinician (other organization) has no access', NOT clinician_patient_access(cB, pNew));
  PERFORM pg_temp.chk('18b. an unassigned clinician of the same organization has no access', NOT clinician_patient_access(cA3, pNew));
  PERFORM pg_temp.chk('18c. a super_user / clinician_admin is not granted clinical access by role alone',
    NOT clinician_patient_access(suA, pNew) AND NOT clinician_patient_access(adminA, pNew));
  BEGIN
    PERFORM pause_prescription(v_pp, cB);
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('18d. the in-transaction pause check refuses an unrelated clinician', v_err = 'PATIENT_NOT_AUTHORIZED', v_err);

  SELECT id INTO v_sp FROM supervisor_patients WHERE supervisor_id = cA1 AND patient_id = pNew AND status = 'active';
  PERFORM pg_temp.chk('admin end: a regular clinician cannot end another clinician''s assignment',
    end_assignment(cA2, v_sp, 'not mine')->>'result' = 'not_found');
  PERFORM pg_temp.chk('admin end: another organization''s admin cannot see it', end_assignment(cB, v_sp, 'x')->>'result' = 'not_found');
  PERFORM pg_temp.chk('admin end: a reason is required', end_assignment(adminA, v_sp, '   ')->>'result' = 'reason_required');
  v_r := end_assignment(adminA, v_sp, 'Patient moved to another clinician');
  PERFORM pg_temp.chk('20. ended assignment loses access immediately; provenance recorded',
    v_r->>'result' = 'ended' AND NOT clinician_patient_access(cA1, pNew)
    AND EXISTS (SELECT 1 FROM supervisor_patients WHERE id = v_sp AND status = 'dismissed' AND dismissed_by = adminA
                AND dismissed_reason = 'Patient moved to another clinician' AND dismissed_at IS NOT NULL), v_r::text);
  BEGIN
    PERFORM pause_prescription(v_pp, cA1);
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('20b. the ended clinician is refused by the in-transaction pause check', v_err = 'PATIENT_NOT_AUTHORIZED', v_err);
  PERFORM pg_temp.chk('20c. ending one clinician leaves the other active', clinician_patient_access(cA2, pNew));
  PERFORM pg_temp.chk('20d. ending twice reports already_ended', end_assignment(adminA, v_sp, 'again')->>'result' = 'already_ended');

  PERFORM pause_prescription(v_pp, cA2);
  PERFORM pg_temp.chk('21. a remaining clinician acts on the existing program (pause) — record unchanged by assignment changes',
    (SELECT operational_status FROM patient_prescriptions WHERE id = v_pp) = 'paused'
    AND (SELECT paused_by FROM patient_prescriptions WHERE id = v_pp) = cA2
    AND (SELECT count(*) FROM patient_prescriptions WHERE patient_id = pNew) = 1
    AND EXISTS (SELECT 1 FROM notifications WHERE patient_id = pNew AND type = 'prescription_paused' AND patient_prescription_id = v_pp AND read_at IS NULL));

  v_r := admin_add_assignment(adminA, v_orgA, cA1, pNew);
  PERFORM pg_temp.chk('40. re-adding creates a NEW period row; the ended row is preserved unchanged',
    v_r->>'result' = 'added' AND (v_r->>'assignment_id')::uuid <> v_sp AND clinician_patient_access(cA1, pNew)
    AND (SELECT count(*) FROM supervisor_patients WHERE supervisor_id = cA1 AND patient_id = pNew) = 2
    AND EXISTS (SELECT 1 FROM supervisor_patients WHERE id = v_sp AND status = 'dismissed' AND dismissed_reason = 'Patient moved to another clinician')
    AND EXISTS (SELECT 1 FROM supervisor_patients WHERE id = (v_r->>'assignment_id')::uuid AND created_by = adminA AND source_invitation_id IS NULL), v_r::text);
  PERFORM resume_prescription(v_pp, cA1);
  PERFORM pg_temp.chk('40b. the re-added clinician acts on the same program (resume); pause history is kept',
    (SELECT operational_status FROM patient_prescriptions WHERE id = v_pp) = 'active'
    AND (SELECT count(*) FROM prescription_pause_periods WHERE patient_prescription_id = v_pp AND resumed_by = cA1 AND paused_by = cA2) = 1);
  PERFORM pg_temp.chk('admin add: adding an already-active clinician is idempotent', admin_add_assignment(adminA, v_orgA, cA1, pNew)->>'result' = 'already_active');
  PERFORM pg_temp.chk('admin add: a super_user of the organization may add', admin_add_assignment(suA, v_orgA, cA3, pNew)->>'result' = 'added');
  PERFORM pg_temp.chk('admin add: a regular clinician may not add', admin_add_assignment(cA1, v_orgA, cA4, pNew)->>'result' = 'not_authorized');
  PERFORM pg_temp.chk('42. admin add never crosses organizations (clinician or patient from another org)',
    admin_add_assignment(adminA, v_orgA, cB, pNew)->>'result' = 'clinician_not_in_organization'
    AND admin_add_assignment(adminA, v_orgA, cA1, pOther)->>'result' = 'patient_not_in_organization'
    AND admin_add_assignment(adminA, v_orgB, cB, pNew)->>'result' = 'not_authorized');
  PERFORM pg_temp.chk('admin add: a staff account is never assigned as a patient',
    admin_add_assignment(adminA, v_orgA, cA1, cA2)->>'result' = 'patient_not_in_organization');

  -- ================= 39. assignment invariant / legacy writer =================
  BEGIN
    UPDATE supervisor_patients SET status = 'active', dismissed_at = NULL, dismissed_by = NULL, dismissed_reason = NULL WHERE id = v_sp;
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('39a. an ended period can never be reactivated (legacy "reinstate" overwrite refused)', v_err = 'ASSIGNMENT_ENDED', v_err);
  BEGIN
    UPDATE supervisor_patients SET supervisor_id = cA4 WHERE supervisor_id = cA2 AND patient_id = pNew;
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('39b. assignment identity is immutable', v_err = 'ASSIGNMENT_IMMUTABLE', v_err);
  BEGIN
    INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (cA4, pNew, 'active')
    ON CONFLICT (supervisor_id, patient_id) DO UPDATE SET status = EXCLUDED.status;
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE;
  END;
  PERFORM pg_temp.chk('39c. the legacy sync upsert (ON CONFLICT supervisor_id,patient_id) can no longer run', v_err = '42P10', v_err);
  BEGIN
    INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id, status, dismissed_at) VALUES (v_orgA, cA4, pNew, 'dismissed', now());
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('39d. rows can only be created active', v_err = 'ASSIGNMENT_MUST_START_ACTIVE', v_err);
  BEGIN
    INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (v_orgB, cB, pNew);
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('42b. a direct cross-organization assignment is refused (patient not in that organization)', v_err = 'ASSIGNMENT_PATIENT_NOT_IN_ORGANIZATION', v_err);
  BEGIN
    INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (v_orgA, cB, pNew);
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('42c. an assignment to a clinician outside the organization is refused', v_err = 'ASSIGNMENT_CLINICIAN_NOT_IN_ORGANIZATION', v_err);
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (v_orgB, cA4, 'clinician');
  BEGIN
    INSERT INTO supervisor_patients (supervisor_id, patient_id) VALUES (cA4, pExisting);
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('39e. an organization is never guessed for a clinician of several organizations', v_err = 'ASSIGNMENT_ORGANIZATION_REQUIRED', v_err);
  DELETE FROM organization_members WHERE user_id = cA4 AND organization_id = v_orgB;
  INSERT INTO supervisor_patients (supervisor_id, patient_id) VALUES (cA4, pExisting) RETURNING organization_id INTO v_id;
  PERFORM pg_temp.chk('39f. an organization-less service-role insert is derived only from the single clinician organization', v_id = v_orgA);

  BEGIN
    UPDATE organization_members SET role = 'member' WHERE user_id = cA2 AND organization_id = v_orgA;
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('membership guard: a clinician with active assignments cannot be demoted silently', v_err = 'MEMBERSHIP_HAS_ACTIVE_ASSIGNMENTS', v_err);
  BEGIN
    DELETE FROM organization_members WHERE user_id = cA2 AND organization_id = v_orgA;
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('membership guard: ... or removed from the organization', v_err = 'MEMBERSHIP_HAS_ACTIVE_ASSIGNMENTS', v_err);
  BEGIN
    UPDATE organization_members SET role = 'clinician' WHERE user_id = pNew AND organization_id = v_orgA;
    v_err := 'OK';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.chk('membership guard: an assigned patient cannot be turned into staff', v_err = 'MEMBERSHIP_HAS_ACTIVE_ASSIGNMENTS', v_err);
  UPDATE organization_members SET role = 'clinician_admin' WHERE user_id = cA2 AND organization_id = v_orgA;
  PERFORM pg_temp.chk('membership guard: clinician -> clinician_admin keeps access', clinician_patient_access(cA2, pNew));
  DELETE FROM auth.users WHERE id = cA4;
  PERFORM pg_temp.chk('account deletion still cascades (guard exempts it)',
    NOT EXISTS (SELECT 1 FROM supervisor_patients WHERE supervisor_id = cA4) AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = cA4));

  -- ================= 27/28/29 + grants =================
  PERFORM pg_temp.chk('27/28/29. patients (authenticated/anon) cannot execute pause, resume or clinician release',
    NOT has_function_privilege('authenticated', 'pause_prescription(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'resume_prescription(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'clinician_release_acute_episode(uuid, uuid, text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'pause_prescription(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'resume_prescription(uuid, uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'clinician_release_acute_episode(uuid, uuid, text)', 'EXECUTE'));
  PERFORM pg_temp.chk('grants: the M2 RPCs and the access primitive are service-role only',
    (SELECT bool_and(NOT has_function_privilege('authenticated', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
                     AND has_function_privilege('service_role', f, 'EXECUTE'))
     FROM unnest(ARRAY['clinician_patient_access(uuid, uuid)', 'create_patient_invitation(uuid, uuid, text, text)',
       'cancel_patient_invitation(uuid, uuid)', 'accept_patient_invitation(text, uuid)',
       'admin_add_assignment(uuid, uuid, uuid, uuid)', 'end_assignment(uuid, uuid, text)']) f));
  PERFORM pg_temp.chk('grants: no client write grant remains on assignment, membership or invitation tables',
    NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE table_schema = 'public' AND table_name IN ('supervisor_patients', 'organization_members', 'invitations')
                  AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')));
  v_err := pg_temp.as_user(pNew, format('SELECT count(*) FROM supervisor_patients WHERE patient_id = %L', pNew));
  PERFORM pg_temp.chk('grants: a patient still reads their own assignment rows (RLS read unchanged)', v_err = 'OK', v_err);
  v_err := pg_temp.as_user(pNew, format('UPDATE profiles SET name = ''Renamed'' WHERE id = %L', pNew));
  PERFORM pg_temp.chk('grants: own profile update unchanged', v_err = 'OK' AND (SELECT name FROM profiles WHERE id = pNew) = 'Renamed', v_err);

  SELECT count(*) FILTER (WHERE result LIKE 'PASS:%'), count(*) FILTER (WHERE result LIKE 'FAIL:%') INTO v_pass, v_fail FROM verify_results;
  INSERT INTO verify_results(result) VALUES ('TOTAL: ' || v_pass || ' passed, ' || v_fail || ' failed');
END;
$verify$;

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
