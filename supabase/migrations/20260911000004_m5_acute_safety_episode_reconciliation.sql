-- =============================================================================
-- Founder-acceptance patch: close the missed-episode safety gap.
--
-- Prior debt: confirmAcuteSafetyEpisode() (TypeScript, called from the M3
-- finalize route) could fail AFTER escalation_evaluations already recorded
-- a Level 3/5 finding, leaving no acute_safety_episodes row and therefore
-- no enforced brake — a qualifying authoritative safety fact with silently
-- no consequence.
--
-- Fix: reconciliation, not full atomicity. Inspected making episode
-- creation atomic with the M3 finalize write itself; that write happens
-- across several sequential service-role calls in a Route Handler (missing-
-- field validation, escalation insert, session status update, M4 obligation
-- creation) with its own established idempotency contract — collapsing all
-- of that into one SQL transaction was judged a materially larger, riskier
-- change than this fix warrants. Instead, create_rehab_session_if_allowed()
-- — the ONE authoritative gate every new session must pass through — now
-- deterministically reconciles any orphaned Level 3/5 escalation into its
-- missing episode BEFORE deciding whether a brake is active, and FAILS
-- CLOSED if any orphan still exists afterward (which should be
-- unreachable in practice, but is never silently ignored). This directly
-- satisfies "runs before or as part of authoritative acute-brake/
-- session-start evaluation" and "does not rely only on a periodic
-- background job" — there is no background job at all; every session
-- attempt is itself the reconciliation trigger.
--
-- New additive migration; 20260911000001-000003 are already applied to the
-- linked development database.
-- =============================================================================

-- Structural invariant: at most one episode per triggering escalation —
-- makes reconciliation's ON CONFLICT DO NOTHING idempotency guarantee
-- unconditional, not just a convention the write path happens to follow.
ALTER TABLE acute_safety_episodes
  ADD CONSTRAINT acute_safety_episodes_source_escalation_unique UNIQUE (source_escalation_evaluation_id);

-- ---------------------------------------------------------------------------
-- reconcile_missing_acute_episodes(p_user_id): derives and inserts an
-- episode for every Level 3/5 escalation_evaluations row belonging to this
-- patient that has no matching acute_safety_episodes row yet — deriving
-- EVERY field from already-persisted authoritative facts (escalation_evaluations
-- + the source session's own sudden_or_sharp_pain/new_functional_difficulty/
-- pop_felt_or_heard columns), never inventing a Level 3/5 event that wasn't
-- already recorded. Processes orphans in chronological order (evaluated_at
-- ASC) so the anchored 14-day recurrence-window algorithm (identical to
-- computeRecurrenceWindow() in web/lib/acuteSafety.ts — see that module's
-- tests for the exact behavior being mirrored here) sees them in the same
-- order they would have been confirmed in originally, preserving
-- chronology. confirmed_at is set to the ORIGINAL escalation's evaluated_at
-- — never "now" — so a late-reconciled episode still reports its true
-- historical confirmation instant.
--
-- Idempotent: the UNIQUE constraint above + ON CONFLICT DO NOTHING mean
-- calling this any number of times, including concurrently, creates each
-- missing episode at most once.
--
-- SECURITY DEFINER (same reasoning as capture_session_guidance_context):
-- authenticated has no INSERT grant on acute_safety_episodes. Ownership is
-- verified explicitly since, unlike the read-only get_patient_acute_brake_status,
-- this function performs writes.
-- ---------------------------------------------------------------------------
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
    -- Re-derive the currently-active anchor fresh each iteration — this
    -- correctly sees any episode reconciled earlier in THIS SAME loop
    -- (INSERTs are visible to subsequent statements within one function
    -- invocation), exactly mirroring how the normal write path always
    -- reads the patient's latest episode before computing the next one.
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

  RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- create_rehab_session_if_allowed(): reconcile BEFORE checking brake status,
-- then FAIL CLOSED (raise, never silently permit normal session creation)
-- if any orphan somehow still exists afterward — this should be
-- unreachable given reconcile_missing_acute_episodes' own logic, but a
-- residual orphan must never be treated as "no active brake." Ordering
-- otherwise unchanged from the transaction-fix migration (000003).
-- ---------------------------------------------------------------------------
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

  -- 2a. Reconcile any orphaned Level 3/5 escalation into its missing
  -- episode BEFORE deciding brake state (founder-acceptance patch).
  PERFORM reconcile_missing_acute_episodes(v_user_id);

  -- 2b. Fail closed: a qualifying authoritative escalation must never
  -- silently permit a new session merely because reconciliation could not
  -- (for whatever reason) resolve it into an episode.
  IF EXISTS (
    SELECT 1
    FROM escalation_evaluations ee
    JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    WHERE rs.user_id = v_user_id
      AND ee.escalation_level IN (3, 5)
      AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes ase WHERE ase.source_escalation_evaluation_id = ee.id)
  ) THEN
    RAISE EXCEPTION 'ACUTE_SAFETY_RECONCILIATION_FAILED' USING ERRCODE = 'P0007';
  END IF;

  -- 2c. Acute safety brake (read-only — recording a blocked attempt still
  -- happens OUTSIDE this transaction, from the calling route, per 000003).
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
