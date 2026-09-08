-- =============================================================================
-- Bug fix, additive: 20260911000004 reintroduced the EXACT transaction-
-- rollback bug already fixed once in 20260911000003, in a new place.
--
-- create_rehab_session_if_allowed() called PERFORM reconcile_missing_acute_episodes()
-- (an INSERT) and THEN, within the SAME transaction, raised
-- 'ACUTE_SAFETY_REVIEW_REQUIRED'/'..._PROFESSIONAL_REVIEW_REQUIRED' once it
-- saw the newly-reconciled episode made a brake active. PostgreSQL rolls
-- back the ENTIRE transaction on a raised exception — including the
-- reconciliation insert that only just happened. The episode was silently
-- discarded every time reconciliation actually mattered (i.e., exactly
-- when a brake should have activated), which is the worst possible
-- failure mode for a safety fail-safe.
--
-- Fix: reconciliation now happens as its OWN separately-committed RPC call
-- — reconcile_missing_acute_episodes() is unchanged in what it does, but is
-- no longer invoked from inside create_rehab_session_if_allowed(). Instead,
-- the calling Next.js route (web/app/api/patient/rehab-session/route.ts)
-- calls it FIRST, as an independent transaction, before ever calling
-- create_rehab_session_if_allowed() — so any reconciled episode is durably
-- committed before the gate's own (unchanged, read-only) brake check runs.
-- If that separate reconciliation call itself errors, the route fails
-- closed: it does not attempt session creation at all.
--
-- create_rehab_session_if_allowed() is restored to exactly its
-- 20260911000003 form (read-only brake check only) — the fail-closed
-- residual-orphan check moves INTO reconcile_missing_acute_episodes()
-- itself, where raising it is safe: that function's own inserts for
-- already-resolved orphans in the same call commit normally when it
-- returns without raising, and it is never chained with a second,
-- unrelated exception the way the gate was.
-- =============================================================================

CREATE OR REPLACE FUNCTION reconcile_missing_acute_episodes(p_user_id UUID)
RETURNS SETOF acute_safety_episodes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orphan RECORD;
  v_prior acute_safety_episodes;
  v_effective_anchor_id UUID;
  v_anchor_confirmed_at TIMESTAMPTZ;
  v_anchor_id UUID;
  v_sequence SMALLINT;
  v_level4_recurrent BOOLEAN;
  v_new acute_safety_episodes;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  FOR v_orphan IN
    SELECT ee.id AS escalation_id, ee.escalation_level, ee.evaluated_at,
           rs.id AS session_id, rs.sudden_or_sharp_pain, rs.new_functional_difficulty, rs.pop_felt_or_heard
    FROM escalation_evaluations ee
    JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    WHERE rs.user_id = p_user_id
      AND ee.escalation_level IN (3, 5)
      AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes ase WHERE ase.source_escalation_evaluation_id = ee.id)
    ORDER BY ee.evaluated_at ASC
  LOOP
    SELECT * INTO v_prior FROM acute_safety_episodes
      WHERE user_id = p_user_id
      ORDER BY confirmed_at DESC
      LIMIT 1;

    IF NOT FOUND THEN
      v_anchor_id := NULL;
      v_sequence := 1;
    ELSE
      v_effective_anchor_id := COALESCE(v_prior.recurrence_window_anchor_id, v_prior.id);
      SELECT confirmed_at INTO v_anchor_confirmed_at FROM acute_safety_episodes WHERE id = v_effective_anchor_id;
      IF v_orphan.evaluated_at <= v_anchor_confirmed_at + INTERVAL '14 days' THEN
        v_anchor_id := v_effective_anchor_id;
        v_sequence := v_prior.recurrence_sequence_in_window + 1;
      ELSE
        v_anchor_id := NULL;
        v_sequence := 1;
      END IF;
    END IF;

    v_level4_recurrent := v_sequence >= 4;

    INSERT INTO acute_safety_episodes (
      user_id, source_rehab_session_id, source_escalation_evaluation_id, initial_level,
      initial_sudden_or_sharp_pain, initial_new_functional_difficulty, initial_pop_felt_or_heard,
      recurrence_window_anchor_id, recurrence_sequence_in_window, level4_recurrent, confirmed_at
    ) VALUES (
      p_user_id, v_orphan.session_id, v_orphan.escalation_id, v_orphan.escalation_level,
      COALESCE(v_orphan.sudden_or_sharp_pain, false), COALESCE(v_orphan.new_functional_difficulty, false), COALESCE(v_orphan.pop_felt_or_heard, false),
      v_anchor_id, v_sequence, v_level4_recurrent, v_orphan.evaluated_at
    )
    ON CONFLICT (source_escalation_evaluation_id) DO NOTHING
    RETURNING * INTO v_new;

    IF v_new.id IS NOT NULL THEN
      RETURN NEXT v_new;
    END IF;
  END LOOP;

  -- Fail-closed residual check lives HERE now, not in the session-creation
  -- gate: if any orphan still exists after the loop above (should be
  -- unreachable given the COALESCE-defended INSERT), raising here is safe
  -- — this function's own successfully-reconciled rows from earlier in
  -- THIS SAME call are the only ones at risk, and only in a scenario that
  -- indicates a genuine data inconsistency worth surfacing loudly rather
  -- than silently leaving a gap.
  IF EXISTS (
    SELECT 1
    FROM escalation_evaluations ee
    JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    WHERE rs.user_id = p_user_id
      AND ee.escalation_level IN (3, 5)
      AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes ase WHERE ase.source_escalation_evaluation_id = ee.id)
  ) THEN
    RAISE EXCEPTION 'ACUTE_SAFETY_RECONCILIATION_FAILED' USING ERRCODE = 'P0007';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) TO authenticated;

-- Restored to exactly the 20260911000003 form — no inline reconciliation,
-- no inline fail-closed check. The gate's own read-only brake check is
-- ALWAYS correct now because the caller guarantees reconciliation already
-- committed, in its own transaction, before this function is ever called.
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

  -- 2. Acute safety brake (read-only). Correct by construction: the caller
  -- (web/app/api/patient/rehab-session/route.ts) always calls
  -- reconcile_missing_acute_episodes() as a separate, already-committed
  -- transaction immediately before invoking this function — see that
  -- route and this migration's header comment for why reconciliation
  -- cannot safely happen inside THIS transaction.
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

  -- 6. Guidance handoff capture (M5 Stage 3) — unchanged.
  PERFORM capture_session_guidance_context(v_new.id);

  -- 7. Cautious-return context capture — unchanged.
  PERFORM capture_cautious_return_context(v_new.id);

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
