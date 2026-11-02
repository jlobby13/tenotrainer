-- =============================================================================
-- M3.4a — corrective forward migration (founder-approved): restore the
-- accepted definition of create_rehab_session_if_allowed() in a database
-- built from the migrations in version order.
--
-- Root cause: 20260909000003_m5_stage4_rehab_schedule_eligibility.sql (the
-- M5 Stage 4 schedule gate, REHAB_NOT_SCHEDULED_TODAY) was authored after
-- the 20260910*/20260911* migrations but numbered before them. The
-- development project applied it last, so it has the gate; a fresh database
-- applies the later-numbered files after it, and their older redefinitions
-- of this function drop the gate. Found by the M3.4a fresh-database drift
-- check. Historical migrations are immutable and are not renumbered.
--
-- The function below is the development project's current definition,
-- verbatim (pg_get_functiondef): same signature, return type, language,
-- SECURITY INVOKER, no search_path setting, volatility VOLATILE, PARALLEL
-- UNSAFE. On the development project this migration is a no-op. The
-- privilege statements restate the current state (M3.1: no client-role
-- EXECUTE; service_role keeps it) and are idempotent.
--
-- The function is reachable only through the legacy development route
-- /api/patient/rehab-session (410 outside development); C5 does not use it.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_rehab_session_if_allowed(p_session_id uuid, p_plan_id text, p_prescription_instance_id text, p_patient_local_date date, p_started_at timestamp with time zone, p_prescription_snapshot jsonb)
 RETURNS rehab_sessions
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing rehab_sessions;
  v_outstanding_session_id UUID;
  v_prescription_version_id UUID;
  v_rehab_days_of_week SMALLINT[];
  v_eligibility TEXT;
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

  -- 2. Resolve the patient's CURRENT prescription version (M5 Stage 1) —
  -- moved ahead of the acute/M4 gates (from its prior position as step 4)
  -- so its rehab_days_of_week is available for the schedule check below.
  SELECT id, rehab_days_of_week INTO v_prescription_version_id, v_rehab_days_of_week
    FROM prescription_versions
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESCRIPTION_VERSION_REQUIRED' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Prescription schedule eligibility (Stage 4 closure patch). Only an
  -- explicit 'not_scheduled' blocks — 'unknown' and 'scheduled' both
  -- proceed to the higher-priority safety/obligation gates below.
  v_eligibility := derive_rehab_day_eligibility(v_rehab_days_of_week, p_patient_local_date);
  IF v_eligibility = 'not_scheduled' THEN
    RAISE EXCEPTION 'REHAB_NOT_SCHEDULED_TODAY' USING ERRCODE = 'P0008';
  END IF;

  -- 4. Acute safety brake (read-only). Correct by construction: the caller
  -- (web/app/api/patient/rehab-session/route.ts) always calls
  -- reconcile_missing_acute_episodes() as a separate, already-committed
  -- transaction immediately before invoking this function.
  SELECT * INTO v_brake FROM get_patient_acute_brake_status(v_user_id);
  IF FOUND THEN
    IF v_brake.effective_level >= 4 THEN
      RAISE EXCEPTION 'ACUTE_SAFETY_PROFESSIONAL_REVIEW_REQUIRED' USING ERRCODE = 'P0005';
    ELSE
      RAISE EXCEPTION 'ACUTE_SAFETY_REVIEW_REQUIRED' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  -- 5. Unresolved PRIOR morning-response obligation blocks a genuinely NEW session.
  SELECT id INTO v_outstanding_session_id
    FROM rehab_sessions
    WHERE user_id = v_user_id
      AND status = 'awaiting_morning_response'
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'MORNING_RESPONSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at,
    prescription_snapshot, prescription_version_id
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at,
    p_prescription_snapshot, v_prescription_version_id
  )
  RETURNING * INTO v_new;

  -- 7. Guidance handoff capture (M5 Stage 3) — unchanged.
  PERFORM capture_session_guidance_context(v_new.id);

  -- 8. Cautious-return context capture — unchanged.
  PERFORM capture_cautious_return_context(v_new.id);

  RETURN v_new;
END;
$function$;

REVOKE EXECUTE ON FUNCTION create_rehab_session_if_allowed(uuid, text, text, date, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(uuid, text, text, date, timestamptz, jsonb) TO service_role;
