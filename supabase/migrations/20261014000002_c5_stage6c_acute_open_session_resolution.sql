-- =============================================================================
-- C5.6C (founder review correction) — active acute brake + existing STARTED
-- session.
--
-- Founder-locked behaviour: an active acute-safety brake blocks new Starts
-- and blocks additional performance (unchanged: c5_lock_started_session),
-- blocks ordinary Finish (unchanged: c5_close_session_internal), and leaves
-- the acute Stop pathway -> STOPPED_ACUTE available (unchanged). What this
-- migration changes: eligibility must not hide the open exposure behind the
-- generic training-blocked result. When a STARTED session exists under an
-- active brake, eligibility now returns the distinct result
-- 'acute_resolution_required' carrying the session id (plus the underlying
-- acute gate code, episode and level), instead of a bare acute_safety_*.
--
-- No acute_safety_* code is returned in that case, so c5_record_first_performance
-- (which records a blocked loading opportunity only for acute_safety_*) does
-- not record one for an already-open exposure — the day's exposure exists;
-- no new loading opportunity was blocked. The session snapshot, version and
-- response obligations are untouched.
--
-- Forward-only: CREATE OR REPLACE of c5_start_eligibility_internal only.
-- =============================================================================

-- 9g. THE Start-eligibility path. Read-only. Callers that intend to create
--     a session must hold patient_prescriptions FOR UPDATE first.
--     Gate order (first failure wins):
--       no_active_prescription
--       prescription_paused          (only when no STARTED session exists —
--                                     pause never hides an existing session)
--       acute_resolution_required    (STARTED session + active brake:
--                                     the open exposure stays identified
--                                     for acute Stop; no resume, no
--                                     further performance, no Finish)
--       acute_safety_*               (no STARTED session — new Start blocked)
--       resume_existing_session
--       immediate_response_required
--       morning_response_required    (due and unresolved)
--       timezone_required
--       already_trained_today
--       not_scheduled_today          (Calendar)
--       eligible                     (+ Sequence / Calendar options)
CREATE OR REPLACE FUNCTION c5_start_eligibility_internal(p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pp RECORD;
  v_version RECORD;
  v_started RECORD;
  v_acute RECORD;
  v_tz TEXT;
  v_today DATE;
  v_seq JSONB;
  v_cal JSONB;
BEGIN
  SELECT * INTO v_pp FROM patient_prescriptions WHERE patient_id = p_user_id;
  IF NOT FOUND OR v_pp.current_prescription_version_id IS NULL THEN
    RETURN jsonb_build_object('result', 'no_active_prescription');
  END IF;
  SELECT * INTO v_version FROM prescription_versions WHERE id = v_pp.current_prescription_version_id;

  SELECT id, prescription_version_id INTO v_started FROM rehab_sessions
  WHERE user_id = p_user_id AND training_status = 'started';

  IF v_pp.operational_status = 'paused' AND v_started.id IS NULL THEN
    RETURN jsonb_build_object('result', 'prescription_paused');
  END IF;

  SELECT * INTO v_acute FROM c5_acute_gate(p_user_id);
  IF v_acute.o_code IS NOT NULL AND v_started.id IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'acute_resolution_required', 'session_id', v_started.id,
      'prescription_version_id', v_started.prescription_version_id,
      'acute_gate', v_acute.o_code, 'acute_safety_episode_id', v_acute.o_episode_id, 'brake_level', v_acute.o_level,
      'prescription_paused', v_pp.operational_status = 'paused');
  END IF;
  IF v_acute.o_code IS NOT NULL THEN
    RETURN jsonb_build_object('result', v_acute.o_code, 'acute_safety_episode_id', v_acute.o_episode_id, 'brake_level', v_acute.o_level);
  END IF;

  IF v_started.id IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'resume_existing_session', 'session_id', v_started.id,
      'prescription_version_id', v_started.prescription_version_id,
      'prescription_paused', v_pp.operational_status = 'paused');
  END IF;

  IF EXISTS (SELECT 1 FROM session_immediate_responses WHERE user_id = p_user_id AND resolved_at IS NULL) THEN
    RETURN jsonb_build_object('result', 'immediate_response_required');
  END IF;

  IF EXISTS (
    SELECT 1 FROM morning_responses mr JOIN rehab_sessions rs ON rs.id = mr.rehab_session_id
    WHERE mr.user_id = p_user_id AND rs.training_status IS NOT NULL
      AND mr.submitted_at IS NULL AND mr.scheduled_eligible_at <= now()
  ) THEN
    RETURN jsonb_build_object('result', 'morning_response_required');
  END IF;

  SELECT timezone INTO v_tz FROM profiles WHERE id = p_user_id;
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    RETURN jsonb_build_object('result', 'timezone_required');
  END IF;
  v_today := (now() AT TIME ZONE v_tz)::date;

  IF EXISTS (SELECT 1 FROM rehab_sessions WHERE user_id = p_user_id AND training_status IS NOT NULL AND patient_local_date = v_today) THEN
    RETURN jsonb_build_object('result', 'already_trained_today', 'patient_local_date', v_today);
  END IF;

  IF v_version.scheduling_mode = 'sequence' THEN
    v_seq := c5_sequence_state(p_user_id, v_version.id);
    RETURN jsonb_build_object('result', 'eligible', 'scheduling_mode', 'sequence',
      'prescription_version_id', v_version.id, 'patient_local_date', v_today, 'patient_timezone', v_tz, 'sequence', v_seq);
  END IF;

  v_cal := c5_calendar_opportunity(p_user_id, v_pp.id, v_version.id, v_today, v_tz);
  IF v_cal->>'state' = 'not_scheduled' THEN
    RETURN jsonb_build_object('result', 'not_scheduled_today', 'patient_local_date', v_today);
  END IF;
  RETURN jsonb_build_object('result', 'eligible', 'scheduling_mode', 'calendar',
    'prescription_version_id', v_version.id, 'patient_local_date', v_today, 'patient_timezone', v_tz, 'calendar', v_cal);
END;
$$;
REVOKE ALL ON FUNCTION c5_start_eligibility_internal(UUID) FROM PUBLIC, anon, authenticated;
