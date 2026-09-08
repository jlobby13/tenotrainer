-- =============================================================================
-- Bug fix, additive: create_rehab_session_if_allowed() was calling
-- record_blocked_loading_opportunity() (an INSERT) immediately before
-- RAISE EXCEPTION 'ACUTE_SAFETY_..._REQUIRED' in the SAME transaction.
-- PostgreSQL rolls back the ENTIRE transaction when a function raises an
-- uncaught exception — including that just-performed insert. The blocked-
-- opportunity fact was therefore never actually persisted, silently
-- defeating the >=3-blocked-opportunities Level 4 threshold entirely.
--
-- Fix: create_rehab_session_if_allowed() now ONLY reads brake status
-- (get_patient_acute_brake_status, no writes) before raising. Recording the
-- blocked attempt happens as a SEPARATE, independently-committed RPC call
-- from the Next.js route AFTER it catches the raised exception — see
-- web/app/api/patient/rehab-session/route.ts. This is the "safest
-- transactional design" called for when a single-transaction approach
-- can't work: the read-then-raise stays atomic and unbypassable inside the
-- gate; the write-a-durable-fact-about-being-blocked happens in its own
-- transaction, exactly once per distinct prescription instance (still
-- deduplicated via the same UNIQUE constraint + ON CONFLICT DO NOTHING).
--
-- New additive migration rather than editing 20260911000001/000002 in
-- place, both already applied to the linked development database.
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
  v_brake RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('create_rehab_session_if_allowed'), hashtext(v_user_id::text));

  -- 1. Existing legitimate session recovery wins first.
  SELECT * INTO v_existing
    FROM rehab_sessions
    WHERE (id = p_session_id OR prescription_instance_id = p_prescription_instance_id)
      AND user_id = v_user_id
    LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- 2. Acute safety brake (read-only here — see the header comment above
  -- for why recording the blocked opportunity happens OUTSIDE this
  -- transaction, from the calling Next.js route, not here).
  SELECT * INTO v_brake FROM get_patient_acute_brake_status(v_user_id);
  IF FOUND THEN
    IF v_brake.effective_level >= 4 THEN
      RAISE EXCEPTION 'ACUTE_SAFETY_PROFESSIONAL_REVIEW_REQUIRED' USING ERRCODE = 'P0005';
    ELSE
      RAISE EXCEPTION 'ACUTE_SAFETY_REVIEW_REQUIRED' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  -- 3. Unresolved PRIOR morning-response obligation blocks a genuinely NEW session.
  SELECT id INTO v_outstanding_session_id
    FROM rehab_sessions
    WHERE user_id = v_user_id
      AND status = 'awaiting_morning_response'
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'MORNING_RESPONSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 4. Resolve the patient's CURRENT prescription version (M5 Stage 1).
  SELECT id INTO v_prescription_version_id
    FROM prescription_versions
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESCRIPTION_VERSION_REQUIRED' USING ERRCODE = 'P0002';
  END IF;

  -- 5. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at,
    prescription_snapshot, prescription_version_id
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at,
    p_prescription_snapshot, v_prescription_version_id
  )
  RETURNING * INTO v_new;

  -- 6. Guidance handoff capture (M5 Stage 3) — unchanged. Safe here: these
  -- only ever run on the SUCCESS path, never followed by a later RAISE in
  -- the same transaction, so their inserts always commit with the session.
  PERFORM capture_session_guidance_context(v_new.id);

  -- 7. Cautious-return context capture — unchanged, same reasoning.
  PERFORM capture_cautious_return_context(v_new.id);

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
