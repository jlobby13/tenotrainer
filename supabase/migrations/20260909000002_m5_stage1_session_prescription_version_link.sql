-- =============================================================================
-- Milestone 5, Stage 1: link rehab_sessions to an immutable prescription
-- version, and make create_rehab_session_if_allowed() the authoritative
-- point where that link is established for new sessions.
--
-- rehab_sessions.plan_id (legacy FastAPI rehab_plans.id, un-FK'd) is
-- PRESERVED unchanged for transitional compatibility/traceability — it is
-- not dropped and new sessions continue to receive it exactly as before.
-- prescription_version_id is the new, real, immutable-FK'd identity
-- authoritative for prescription-version comparison going forward.
--
-- NULL on prescription_version_id means "legacy / unresolved prescription
-- version" for a session created before this migration. It must never be
-- read as "same as whatever is current now" — see
-- web/lib/prescriptionVersionsServer.ts and web/lib/guidance.ts, which treat
-- a null version identity as an explicit UNKNOWN, never inferred from
-- prescription_snapshot similarity, nearest timestamp, or current plan.
-- Historical rows are intentionally left NULL here — no backfill, no guess.
-- =============================================================================

ALTER TABLE rehab_sessions
  ADD COLUMN prescription_version_id UUID REFERENCES prescription_versions(id);

COMMENT ON COLUMN rehab_sessions.prescription_version_id IS
  'Immutable prescription-version identity (M5 Stage 1). NULL on rows created before this migration means legacy/unresolved — never inferred as "same as current". Authoritative for prescription-version comparison; rehab_sessions.plan_id (legacy, un-FK''d) and prescription_snapshot (exact exercise/dosage exposure) remain unchanged and serve their existing, distinct purposes.';

CREATE INDEX idx_rehab_sessions_prescription_version
  ON rehab_sessions (prescription_version_id);

-- Extends the m3_insert_grant_fix column-level INSERT grant (rehab_sessions
-- INSERT only ever happens through this SECURITY INVOKER RPC, which runs
-- with the calling patient's own privileges — so the grant must include any
-- new column the RPC writes, exactly as that migration's own comment
-- explains).
REVOKE INSERT ON rehab_sessions FROM authenticated;
GRANT INSERT (
  id, user_id, plan_id, prescription_instance_id, patient_local_date,
  started_at, prescription_snapshot, prescription_version_id
) ON rehab_sessions TO authenticated;

-- ---------------------------------------------------------------------------
-- create_rehab_session_if_allowed(): now also resolves and requires a
-- current prescription version for a genuinely NEW session (step 3 below).
--
-- LOCKED invariant (M5 Stage 1): this function must NEVER create a
-- prescription_versions row. Prescription versions are created only by
-- explicit prescription events (onboarding, legacy bootstrap, and future
-- clinician-change/system-progression paths) — never opportunistically at
-- session-start. If a patient reaches this function with no prescription
-- version on file at all, that is a data-integrity/configuration failure,
-- not a clinical decision this function is entitled to make: it raises
-- PRESCRIPTION_VERSION_REQUIRED rather than inventing one.
--
-- "Current" version = the latest prescription_versions row for this patient
-- by created_at — no is_current flag exists to read instead. This mirrors
-- exactly how rehab_plans' "current plan" is already derived on the FastAPI
-- side (ORDER BY created_at DESC LIMIT 1).
--
-- Ordering inside the transaction is otherwise UNCHANGED from
-- 20260907000001_m4_stage3_atomic_session_gate.sql (still locked, do not
-- reorder): existing-session recovery wins first (a resumed/retried session
-- already has whatever prescription_version_id it was created with — it is
-- never re-derived or overwritten on recovery), then the outstanding
-- morning-response gate, then — only for a genuinely new insert — the
-- prescription-version resolution added here.
-- =============================================================================

CREATE OR REPLACE FUNCTION create_rehab_session_if_allowed(
  p_session_id UUID,
  p_plan_id TEXT,
  p_prescription_instance_id TEXT,
  p_patient_local_date DATE,
  p_started_at TIMESTAMPTZ,
  p_prescription_snapshot JSONB
)
RETURNS rehab_sessions
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing rehab_sessions;
  v_outstanding_session_id UUID;
  v_prescription_version_id UUID;
  v_new rehab_sessions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('create_rehab_session_if_allowed'), hashtext(v_user_id::text));

  -- 1. Existing legitimate session recovery wins first — see ordering note above.
  SELECT * INTO v_existing
    FROM rehab_sessions
    WHERE (id = p_session_id OR prescription_instance_id = p_prescription_instance_id)
      AND user_id = v_user_id
    LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- 2. Unresolved PRIOR morning-response obligation blocks a genuinely NEW session.
  SELECT id INTO v_outstanding_session_id
    FROM rehab_sessions
    WHERE user_id = v_user_id
      AND status = 'awaiting_morning_response'
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'MORNING_RESPONSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Resolve the patient's CURRENT prescription version (M5 Stage 1).
  -- Never created here — see the locked-invariant note above.
  SELECT id INTO v_prescription_version_id
    FROM prescription_versions
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESCRIPTION_VERSION_REQUIRED' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at,
    prescription_snapshot, prescription_version_id
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at,
    p_prescription_snapshot, v_prescription_version_id
  )
  RETURNING * INTO v_new;

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
