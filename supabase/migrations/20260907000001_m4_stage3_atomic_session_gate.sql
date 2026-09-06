-- =============================================================================
-- Milestone 4, Stage 3: atomic "create or recover a rehab session, if
-- clinically allowed" operation.
--
-- Why an RPC rather than app-code check-then-insert: two near-simultaneous
-- session-creation attempts for the same patient must not both observe "no
-- outstanding obligation" and both succeed. A transaction-scoped advisory
-- lock, keyed per-patient, serializes concurrent attempts for that patient
-- only (never a broad table lock, never cross-patient contention) — the
-- lock is released automatically at transaction end (COMMIT or ROLLBACK),
-- no explicit unlock needed. This was chosen over a check -> insert ->
-- recheck -> delete compensation pattern specifically because a
-- successfully-created clinical row must never be deleted as concurrency
-- cleanup — serializing the *check* is the correct fix, not undoing a write.
--
-- Ordering inside the transaction (locked, do not reorder):
--   1. Recover an already-existing session for this exact id OR prescription
--      instance FIRST — a retry/resume/M3-bootstrap call for an ALREADY-
--      LEGITIMATE session must never be blocked by a since-discovered
--      unrelated outstanding obligation.
--   2. Only if no existing session was found: check for ANY other rehab
--      session belonging to this patient still in
--      status = 'awaiting_morning_response'. This is the direct, most
--      authoritative signal — checking rehab_sessions.status here (rather
--      than joining through morning_responses) means this gate does not
--      depend on morning_responses backfill having already run for that
--      row; it works correctly even for a pre-M4 session nobody has viewed
--      yet.
--   3. Only if neither of the above applies: insert the new session.
--
-- SECURITY INVOKER (the default) is deliberate: this function runs with the
-- CALLING patient's own privileges, so the existing column-level INSERT
-- grant from 20260905000002_m3_insert_grant_fix.sql still fully governs what
-- can be written — no new grant, no privilege escalation, no service-role
-- bypass. RLS's existing SELECT policy also still applies to every read
-- inside this function; the explicit user_id filters below are
-- documentation of intent, not a substitute for RLS.
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
  v_new rehab_sessions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  -- Transaction-scoped, patient-scoped serialization. hashtext() collapses
  -- the namespace string and the UUID into the two int4 keys
  -- pg_advisory_xact_lock(int,int) takes; collisions across different
  -- patients are irrelevant here since we WANT this to be a no-op for any
  -- patient other than the caller, and hashtext's low collision rate across
  -- a UUID keyspace makes an accidental same-patient false-collision with a
  -- different lock namespace practically impossible.
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

  -- 3. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at, prescription_snapshot
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at, p_prescription_snapshot
  )
  RETURNING * INTO v_new;

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
