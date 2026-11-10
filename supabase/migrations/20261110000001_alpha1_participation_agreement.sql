-- =============================================================================
-- Alpha 1 — Participation Agreement acceptance (migration 68)
-- =============================================================================
-- Records that an invited patient accepted the TenoTrainer Alpha 1
-- Participation Agreement, in the SAME transaction as the invitation
-- acceptance itself.
--
--   public.participation_agreement_acceptances   one row per (user, agreement, version)
--   public.accept_patient_invitation_with_agreement(token_hash, user_id, key, version, sha256)
--
-- The wrapper calls the existing, unchanged public.accept_patient_invitation
-- (row lock, status / expiry / replay, email match, staff and
-- other-organization refusals, inviter check) and records the agreement only
-- when THIS call accepted the invitation (result 'accepted'). An
-- 'already_accepted' replay records nothing, so an invitation accepted before
-- the agreement existed (or by any earlier path) can never gain a
-- retrospective acknowledgment; a retry or concurrent duplicate of a
-- successful acceptance finds the record its winning call already wrote.
-- Every refusal writes nothing. The user id, key, version and hash come from
-- the server (the key
-- and version are application constants, the hash is computed from the
-- constant agreement text); the timestamp is the database's now(), which is
-- the same instant as invitations.accepted_at.
--
-- The agreement is required at the database boundary: EXECUTE on
-- accept_patient_invitation is revoked from service_role, so the wrapper
-- (SECURITY DEFINER, owned by the migration owner) is the only way to accept
-- a patient invitation. Rollback of the application code to a version that
-- calls the original function therefore needs:
--   GRANT EXECUTE ON FUNCTION public.accept_patient_invitation(TEXT, UUID) TO service_role;
--
-- Retention: an acceptance row lives as long as the account and is deleted
-- with it (ON DELETE CASCADE). invitation_id is informational and becomes
-- NULL if the invitation row is ever deleted.
--
-- Access: RLS enabled with no policies; no grant to anon or authenticated;
-- service_role may only SELECT (only the wrapper writes).
-- Touches no clinical, safety, authorization-rule or cron object.
-- =============================================================================

CREATE TABLE public.participation_agreement_acceptances (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agreement_key     TEXT        NOT NULL CHECK (agreement_key = 'alpha1_participation'),
  agreement_version TEXT        NOT NULL CHECK (agreement_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  agreement_sha256  TEXT        NOT NULL CHECK (agreement_sha256 ~ '^[0-9a-f]{64}$'),
  invitation_id     UUID        REFERENCES public.invitations(id) ON DELETE SET NULL,
  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT participation_agreement_acceptances_once UNIQUE (user_id, agreement_key, agreement_version)
);

COMMENT ON TABLE public.participation_agreement_acceptances IS
  'Alpha 1: acceptance of a versioned participation agreement (key, version, SHA-256 of the exact text), written only by accept_patient_invitation_with_agreement in the invitation-acceptance transaction. Deleted with the account. Server-only.';

ALTER TABLE public.participation_agreement_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.participation_agreement_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.participation_agreement_acceptances TO service_role;

CREATE FUNCTION public.accept_patient_invitation_with_agreement(
  p_token_hash TEXT,
  p_user_id UUID,
  p_agreement_key TEXT,
  p_agreement_version TEXT,
  p_agreement_sha256 TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
  v_invitation UUID;
BEGIN
  IF p_agreement_key IS DISTINCT FROM 'alpha1_participation'
     OR p_agreement_version IS NULL OR p_agreement_version !~ '^[0-9]{1,3}\.[0-9]{1,3}$'
     OR p_agreement_sha256 IS NULL OR p_agreement_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN pg_catalog.jsonb_build_object('result', 'agreement_invalid');
  END IF;

  -- The authoritative acceptance: all of its checks and its row lock apply.
  v_result := public.accept_patient_invitation(p_token_hash, p_user_id);

  -- Only the call that performs the acceptance records the agreement.
  IF v_result->>'result' = 'accepted' THEN
    SELECT i.id INTO v_invitation FROM public.invitations i WHERE i.token_hash = p_token_hash;
    INSERT INTO public.participation_agreement_acceptances
      (user_id, agreement_key, agreement_version, agreement_sha256, invitation_id)
    VALUES (p_user_id, p_agreement_key, p_agreement_version, p_agreement_sha256, v_invitation)
    ON CONFLICT ON CONSTRAINT participation_agreement_acceptances_once DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.accept_patient_invitation_with_agreement(TEXT, UUID, TEXT, TEXT, TEXT) IS
  'Alpha 1: accept a patient invitation and record the participation agreement in one transaction. Delegates every invitation rule to accept_patient_invitation; records only when this call accepted the invitation (never on already_accepted). service_role only.';

REVOKE ALL ON FUNCTION public.accept_patient_invitation_with_agreement(TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_patient_invitation_with_agreement(TEXT, UUID, TEXT, TEXT, TEXT) TO service_role;

-- The wrapper is now the only server path that accepts a patient invitation.
REVOKE EXECUTE ON FUNCTION public.accept_patient_invitation(TEXT, UUID) FROM service_role;
