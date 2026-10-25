-- =============================================================================
-- M2 — Native onboarding, assignment authority & clinician controls.
--
-- Postgres `supervisor_patients` becomes THE clinician–patient assignment
-- authority (legacy SQLite is no longer consulted; the FastAPI -> Postgres
-- sync writer is retired in the same milestone).
--
--  1. supervisor_patients: organization + provenance columns; one row per
--     assignment PERIOD (dismiss + later re-add = a new row); active-only
--     uniqueness per (organization, clinician, patient) — several clinicians
--     of the same organization may be active for one patient (founder D1).
--  2. Assignment invariant (trigger): an ACTIVE row's clinician holds a
--     clinician/clinician_admin membership in the row's organization, and the
--     patient (when a member anywhere) is a patient-role member of it. A
--     membership change that would break an active row is refused. Because of
--     this invariant every existing in-transaction "active row exists" check
--     (create/publish/pause/resume/release RPCs, RLS policies) is also an
--     organization-membership check — those functions are not redefined.
--  3. clinician_patient_access(): the single server authorization primitive.
--  4. invitations: SHA-256 token hash only (plaintext column dropped), role
--     fixed by invitation type (closes the clinician_admin -> super_user
--     escalation), direct table writes removed.
--  5. Server-only RPCs: create/cancel/accept patient invitation, admin
--     add/end assignment.
--  6. Grant hardening on the identity tables.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. supervisor_patients
-- -----------------------------------------------------------------------------
ALTER TABLE supervisor_patients
  ADD COLUMN organization_id      UUID REFERENCES organizations(id),
  ADD COLUMN created_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN source_invitation_id UUID REFERENCES invitations(id) ON DELETE SET NULL;

-- Backfill: the one organization the clinician belongs to that the patient
-- also belongs to (or, for a patient with no membership, the clinician's one
-- organization). Ambiguity or no candidate aborts the migration — an
-- assignment's organization is never guessed.
DO $$
DECLARE v_bad INT;
BEGIN
  WITH candidates AS (
    SELECT sp.id, sm.organization_id
    FROM supervisor_patients sp
    JOIN organization_members sm ON sm.user_id = sp.supervisor_id
    WHERE NOT EXISTS (SELECT 1 FROM organization_members pm WHERE pm.user_id = sp.patient_id)
       OR EXISTS (SELECT 1 FROM organization_members pm WHERE pm.user_id = sp.patient_id AND pm.organization_id = sm.organization_id)
  ), counted AS (
    SELECT id, count(*) AS n, min(organization_id::text)::uuid AS organization_id FROM candidates GROUP BY id
  )
  UPDATE supervisor_patients sp SET organization_id = c.organization_id
  FROM counted c WHERE c.id = sp.id AND c.n = 1;

  SELECT count(*) INTO v_bad FROM supervisor_patients WHERE organization_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'M2 backfill: % supervisor_patients row(s) have no unambiguous organization', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM supervisor_patients WHERE status NOT IN ('active', 'dismissed')
     OR (status = 'dismissed') <> (dismissed_at IS NOT NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'M2 backfill: % supervisor_patients row(s) have an unknown status or inconsistent dismissal', v_bad;
  END IF;
END $$;

ALTER TABLE supervisor_patients ALTER COLUMN organization_id SET NOT NULL;

-- Period rows: the pair-uniqueness that forced re-assignment to overwrite the
-- previous period is replaced by active-only uniqueness.
ALTER TABLE supervisor_patients DROP CONSTRAINT supervisor_patients_supervisor_id_patient_id_key;
CREATE UNIQUE INDEX supervisor_patients_one_active_period
  ON supervisor_patients (organization_id, supervisor_id, patient_id) WHERE status = 'active';
CREATE INDEX supervisor_patients_org_patient ON supervisor_patients (organization_id, patient_id);

ALTER TABLE supervisor_patients
  ADD CONSTRAINT supervisor_patients_status_check CHECK (status IN ('active', 'dismissed')),
  ADD CONSTRAINT supervisor_patients_dismissal_consistency CHECK ((status = 'dismissed') = (dismissed_at IS NOT NULL)),
  ADD CONSTRAINT supervisor_patients_not_self CHECK (supervisor_id <> patient_id);

-- A deleted dismisser keeps the historical row (provenance becomes NULL)
-- rather than blocking the account deletion.
ALTER TABLE supervisor_patients DROP CONSTRAINT supervisor_patients_dismissed_by_fkey;
ALTER TABLE supervisor_patients ADD CONSTRAINT supervisor_patients_dismissed_by_fkey
  FOREIGN KEY (dismissed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON TABLE supervisor_patients IS
  'M2: the authoritative clinician–patient assignment. One row per assignment period; active-only unique per (organization, clinician, patient); several active clinicians per patient allowed. Written only by the M2 server-only RPCs (accept_patient_invitation, admin_add_assignment, end_assignment). Rows are never reactivated or deleted by the product.';

-- -----------------------------------------------------------------------------
-- 2. Assignment invariant
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION m2_supervisor_patients_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID; v_n INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Service-role writers that predate M2 (test fixtures) omit the
    -- organization: derive it only when the clinician has exactly one
    -- clinician-role organization. Never guessed otherwise.
    IF NEW.organization_id IS NULL THEN
      SELECT count(*), min(organization_id::text)::uuid INTO v_n, v_org
      FROM organization_members WHERE user_id = NEW.supervisor_id AND role IN ('clinician', 'clinician_admin');
      IF v_n = 1 THEN NEW.organization_id := v_org; END IF;
    END IF;
    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'ASSIGNMENT_ORGANIZATION_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'active' OR NEW.dismissed_at IS NOT NULL OR NEW.dismissed_by IS NOT NULL OR NEW.dismissed_reason IS NOT NULL THEN
      RAISE EXCEPTION 'ASSIGNMENT_MUST_START_ACTIVE' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Identity and provenance are immutable; the only permitted change is
    -- an ON DELETE SET NULL of created_by / source_invitation_id.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
       OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
       OR (NEW.source_invitation_id IS DISTINCT FROM OLD.source_invitation_id AND NEW.source_invitation_id IS NOT NULL) THEN
      RAISE EXCEPTION 'ASSIGNMENT_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    -- An ended period stays ended: re-assignment is a NEW row. Only the
    -- ON DELETE SET NULL provenance updates may touch a dismissed row.
    IF OLD.status = 'dismissed' AND (NEW.status <> 'dismissed'
       OR NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at
       OR NEW.dismissed_reason IS DISTINCT FROM OLD.dismissed_reason
       OR (NEW.dismissed_by IS DISTINCT FROM OLD.dismissed_by AND NEW.dismissed_by IS NOT NULL)) THEN
      RAISE EXCEPTION 'ASSIGNMENT_ENDED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM organization_members m
      WHERE m.user_id = NEW.supervisor_id AND m.organization_id = NEW.organization_id AND m.role IN ('clinician', 'clinician_admin')
    ) THEN
      RAISE EXCEPTION 'ASSIGNMENT_CLINICIAN_NOT_IN_ORGANIZATION' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = NEW.patient_id)
       AND NOT EXISTS (
         SELECT 1 FROM organization_members m
         WHERE m.user_id = NEW.patient_id AND m.organization_id = NEW.organization_id AND m.role IN ('member', 'tester')
       ) THEN
      RAISE EXCEPTION 'ASSIGNMENT_PATIENT_NOT_IN_ORGANIZATION' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION m2_supervisor_patients_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_m2_supervisor_patients_guard
  BEFORE INSERT OR UPDATE ON supervisor_patients
  FOR EACH ROW EXECUTE FUNCTION m2_supervisor_patients_guard();

-- A membership change may not silently invalidate an active assignment:
-- end the assignments first. Account deletion (auth.users cascade) is
-- exempt — the assignment rows cascade away with the account.
CREATE OR REPLACE FUNCTION m2_organization_members_assignment_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN RETURN OLD; END IF;
  ELSIF NEW.organization_id = OLD.organization_id AND NEW.user_id = OLD.user_id
        AND ((OLD.role IN ('clinician', 'clinician_admin')) = (NEW.role IN ('clinician', 'clinician_admin')))
        AND ((OLD.role IN ('member', 'tester')) = (NEW.role IN ('member', 'tester'))) THEN
    RETURN NEW;
  END IF;

  IF OLD.role IN ('clinician', 'clinician_admin') AND EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.supervisor_id = OLD.user_id AND sp.organization_id = OLD.organization_id AND sp.status = 'active'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_HAS_ACTIVE_ASSIGNMENTS' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.role IN ('member', 'tester') AND EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.patient_id = OLD.user_id AND sp.organization_id = OLD.organization_id AND sp.status = 'active'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_HAS_ACTIVE_ASSIGNMENTS' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION m2_organization_members_assignment_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_m2_organization_members_assignment_guard
  BEFORE UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION m2_organization_members_assignment_guard();

-- -----------------------------------------------------------------------------
-- 3. The authorization primitive
-- -----------------------------------------------------------------------------
-- TRUE only for: an ACTIVE assignment of this clinician to this patient, in an
-- organization where the clinician holds a clinician/clinician_admin role.
-- (super_user alone never grants clinical access — C1A lock.)
CREATE OR REPLACE FUNCTION clinician_patient_access(p_clinician_id UUID, p_patient_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM supervisor_patients sp
    JOIN organization_members m
      ON m.user_id = sp.supervisor_id AND m.organization_id = sp.organization_id
    WHERE sp.supervisor_id = p_clinician_id
      AND sp.patient_id = p_patient_id
      AND sp.status = 'active'
      AND m.role IN ('clinician', 'clinician_admin')
  );
$$;
REVOKE ALL ON FUNCTION clinician_patient_access(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION clinician_patient_access(UUID, UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. invitations
-- -----------------------------------------------------------------------------
ALTER TABLE invitations ADD COLUMN token_hash TEXT;
UPDATE invitations SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex');
ALTER TABLE invitations ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
-- Plaintext tokens are no longer stored (existing rows keep working through
-- their backfilled hash).
DROP INDEX IF EXISTS idx_invitations_token;
ALTER TABLE invitations DROP COLUMN token;

-- The granted role is a function of the invitation type — never a free
-- choice. This is what makes "invite someone as super_user" impossible.
ALTER TABLE invitations ADD CONSTRAINT invitations_role_matches_type CHECK (
  (invitation_type::text, granted_role::text) IN (
    ('USER_TESTER', 'tester'),
    ('CLINICIAN_ADMIN_TESTER', 'clinician_admin'),
    ('PATIENT', 'member')
  )
);
CREATE INDEX invitations_pending_by_inviter ON invitations (organization_id, invited_by) WHERE status = 'pending';

-- Direct table writes (and reads) by clinician_admin are removed: every
-- invitation write goes through the server (service role) and, for patient
-- invitations, the RPCs below.
DROP POLICY IF EXISTS "invitations: clinician_admin insert" ON invitations;
DROP POLICY IF EXISTS "invitations: clinician_admin update (cancel)" ON invitations;
DROP POLICY IF EXISTS "invitations: clinician_admin read" ON invitations;
REVOKE ALL ON invitations FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Server-only RPCs (service role; the caller identity is always the
--    authenticated session user resolved by the server, never the browser).
-- -----------------------------------------------------------------------------

-- 5a. Clinician creates (or re-sends) a patient invitation. The raw token
-- never reaches the database — only its SHA-256 hash.
CREATE OR REPLACE FUNCTION create_patient_invitation(
  p_clinician_id UUID, p_organization_id UUID, p_email TEXT, p_token_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT := lower(btrim(coalesce(p_email, '')));
  v_user UUID;
  v_id UUID;
  v_expires TIMESTAMPTZ := now() + interval '7 days';
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_TOKEN_HASH' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = p_clinician_id AND m.organization_id = p_organization_id AND m.role IN ('clinician', 'clinician_admin')
  ) THEN
    RETURN jsonb_build_object('result', 'not_authorized');
  END IF;
  IF length(v_email) > 254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN jsonb_build_object('result', 'invalid_email');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('m2_patient_invitation:' || p_organization_id::text || ':' || v_email));

  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email LIMIT 1;
  IF v_user IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM organization_members m
      WHERE m.user_id = v_user AND m.organization_id = p_organization_id AND m.role IN ('clinician', 'clinician_admin', 'super_user')
    ) THEN
      RETURN jsonb_build_object('result', 'staff_account');
    END IF;
    IF clinician_patient_access(p_clinician_id, v_user) THEN
      RETURN jsonb_build_object('result', 'already_assigned');
    END IF;
  END IF;

  -- Re-sending replaces this clinician's previous pending invitation to the
  -- same address: only the newest link works.
  UPDATE invitations SET status = 'cancelled'
  WHERE organization_id = p_organization_id AND invited_by = p_clinician_id
    AND lower(email) = v_email AND invitation_type = 'PATIENT' AND status = 'pending';

  INSERT INTO invitations (organization_id, invited_by, email, invitation_type, granted_role, token_hash, expires_at)
  VALUES (p_organization_id, p_clinician_id, v_email, 'PATIENT', 'member', p_token_hash, v_expires)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('result', 'created', 'invitation_id', v_id, 'expires_at', v_expires);
END;
$$;
REVOKE ALL ON FUNCTION create_patient_invitation(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_patient_invitation(UUID, UUID, TEXT, TEXT) TO service_role;

-- 5b. Cancel a pending patient invitation: its inviting clinician, or a
-- clinician_admin / super_user of the organization. Anything else is
-- indistinguishable from "not found".
CREATE OR REPLACE FUNCTION cancel_patient_invitation(p_actor_id UUID, p_invitation_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inv invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR v_inv.invitation_type <> 'PATIENT' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF NOT (
    (v_inv.invited_by = p_actor_id AND EXISTS (
      SELECT 1 FROM organization_members m
      WHERE m.user_id = p_actor_id AND m.organization_id = v_inv.organization_id AND m.role IN ('clinician', 'clinician_admin')))
    OR EXISTS (
      SELECT 1 FROM organization_members m
      WHERE m.user_id = p_actor_id AND m.organization_id = v_inv.organization_id AND m.role IN ('clinician_admin', 'super_user'))
  ) THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status <> 'pending' THEN
    RETURN jsonb_build_object('result', 'not_pending');
  END IF;
  UPDATE invitations SET status = 'cancelled' WHERE id = p_invitation_id;
  RETURN jsonb_build_object('result', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION cancel_patient_invitation(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cancel_patient_invitation(UUID, UUID) TO service_role;

-- 5c. Accept a patient invitation. ONE transaction establishes, together:
-- the patient-role membership, the clinician–patient assignment and the
-- accepted state. Any refusal writes nothing and leaves the invitation
-- retryable. The invitation row lock serializes concurrent acceptance.
CREATE OR REPLACE FUNCTION accept_patient_invitation(p_token_hash TEXT, p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inv invitations%ROWTYPE;
  v_email TEXT;
  v_assignment UUID;
  v_created BOOLEAN := false;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid');
  END IF;
  SELECT * INTO v_inv FROM invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_inv.invitation_type <> 'PATIENT' THEN
    RETURN jsonb_build_object('result', 'invalid');
  END IF;

  IF v_inv.status = 'accepted' THEN
    IF v_inv.accepted_by = p_user_id THEN
      RETURN jsonb_build_object('result', 'already_accepted', 'organization_id', v_inv.organization_id);
    END IF;
    RETURN jsonb_build_object('result', 'already_used');
  END IF;
  IF v_inv.status = 'cancelled' THEN RETURN jsonb_build_object('result', 'cancelled'); END IF;
  IF v_inv.status <> 'pending' OR v_inv.expires_at <= now() THEN RETURN jsonb_build_object('result', 'expired'); END IF;

  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  IF v_email IS NULL OR v_email <> lower(v_inv.email) THEN
    RETURN jsonb_build_object('result', 'wrong_account');
  END IF;

  -- Staff accounts are never turned into patients.
  IF EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = p_user_id AND m.role IN ('clinician', 'clinician_admin', 'super_user')) THEN
    RETURN jsonb_build_object('result', 'staff_account');
  END IF;
  -- Never an automatic cross-organization relationship or transfer (D2).
  IF EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = p_user_id AND m.organization_id = v_inv.organization_id) THEN
    RETURN jsonb_build_object('result', 'other_organization');
  END IF;
  -- The inviting clinician must still be a clinician of the organization.
  IF v_inv.invited_by IS NULL OR NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = v_inv.invited_by AND m.organization_id = v_inv.organization_id AND m.role IN ('clinician', 'clinician_admin')
  ) THEN
    RETURN jsonb_build_object('result', 'inviter_unavailable');
  END IF;

  INSERT INTO organization_members (organization_id, user_id, role)
  VALUES (v_inv.organization_id, p_user_id, 'member')
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  -- Adds a clinician; never dismisses or replaces another one (D2). The
  -- exact active (organization, clinician, patient) row is never duplicated.
  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id, status, created_by, source_invitation_id)
  VALUES (v_inv.organization_id, v_inv.invited_by, p_user_id, 'active', p_user_id, v_inv.id)
  ON CONFLICT (organization_id, supervisor_id, patient_id) WHERE status = 'active' DO NOTHING
  RETURNING id INTO v_assignment;
  IF v_assignment IS NULL THEN
    SELECT id INTO v_assignment FROM supervisor_patients
    WHERE organization_id = v_inv.organization_id AND supervisor_id = v_inv.invited_by AND patient_id = p_user_id AND status = 'active';
  ELSE
    v_created := true;
  END IF;

  UPDATE invitations SET status = 'accepted', accepted_at = now(), accepted_by = p_user_id WHERE id = v_inv.id;

  RETURN jsonb_build_object(
    'result', 'accepted',
    'organization_id', v_inv.organization_id,
    'assignment_id', v_assignment,
    'assignment_created', v_created
  );
END;
$$;
REVOKE ALL ON FUNCTION accept_patient_invitation(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_patient_invitation(TEXT, UUID) TO service_role;

-- 5d. clinician_admin / super_user adds a clinician to a patient within the
-- organization. Never removes anyone; never crosses organizations.
CREATE OR REPLACE FUNCTION admin_add_assignment(
  p_actor_id UUID, p_organization_id UUID, p_clinician_id UUID, p_patient_id UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = p_actor_id AND m.organization_id = p_organization_id AND m.role IN ('clinician_admin', 'super_user')
  ) THEN
    RETURN jsonb_build_object('result', 'not_authorized');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = p_clinician_id AND m.organization_id = p_organization_id AND m.role IN ('clinician', 'clinician_admin')
  ) THEN
    RETURN jsonb_build_object('result', 'clinician_not_in_organization');
  END IF;
  IF p_clinician_id = p_patient_id OR NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = p_patient_id AND m.organization_id = p_organization_id AND m.role IN ('member', 'tester')
  ) OR EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = p_patient_id AND m.role IN ('clinician', 'clinician_admin', 'super_user')
  ) THEN
    RETURN jsonb_build_object('result', 'patient_not_in_organization');
  END IF;

  INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id, status, created_by)
  VALUES (p_organization_id, p_clinician_id, p_patient_id, 'active', p_actor_id)
  ON CONFLICT (organization_id, supervisor_id, patient_id) WHERE status = 'active' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('result', 'already_active'); END IF;
  RETURN jsonb_build_object('result', 'added', 'assignment_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION admin_add_assignment(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_add_assignment(UUID, UUID, UUID, UUID) TO service_role;

-- 5e. clinician_admin / super_user ends one assignment period with a reason.
-- The clinician loses access immediately (every check requires an active
-- row); the clinical record is untouched; the row is kept as history.
CREATE OR REPLACE FUNCTION end_assignment(p_actor_id UUID, p_assignment_id UUID, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row supervisor_patients%ROWTYPE; v_reason TEXT := btrim(coalesce(p_reason, ''));
BEGIN
  SELECT * INTO v_row FROM supervisor_patients WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = p_actor_id AND m.organization_id = v_row.organization_id AND m.role IN ('clinician_admin', 'super_user')
  ) THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF length(v_reason) < 1 OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('result', 'reason_required');
  END IF;
  IF v_row.status <> 'active' THEN
    RETURN jsonb_build_object('result', 'already_ended');
  END IF;
  UPDATE supervisor_patients
  SET status = 'dismissed', dismissed_at = now(), dismissed_by = p_actor_id, dismissed_reason = v_reason
  WHERE id = p_assignment_id;
  RETURN jsonb_build_object('result', 'ended');
END;
$$;
REVOKE ALL ON FUNCTION end_assignment(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION end_assignment(UUID, UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 6. Grant hardening on the identity tables. RLS already had no write
--    policies on these; the grants are removed so a future permissive policy
--    cannot reopen a write path. Reads (RLS-filtered) are unchanged; a
--    profile's own update is unchanged.
-- -----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON supervisor_patients FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON organization_members FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON organizations FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON profiles FROM anon;
