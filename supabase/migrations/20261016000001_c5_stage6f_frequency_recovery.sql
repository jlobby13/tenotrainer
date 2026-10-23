-- =============================================================================
-- C5.6F — weekly target progress, advisory recovery guidance and the
-- objective record of the patient's Take Recovery Day / Continue decision.
--
-- Forward-only. Adds one table and four functions; no existing table,
-- constraint, gate or closed function is changed. Nothing here can block,
-- start or close a session, choose a workout, or alter a prescription.
--
-- Founder-locked semantics (2026-10-15):
--   WEEKLY TARGET  Sequence mode only (Calendar versions have no target).
--     Week = Monday..Sunday of the patient-local date. Numerator = FINISHED
--     C5 sessions whose patient_local_date (the start date / training day)
--     falls in that week, from any prescription version; never capped.
--     Denominator = the CURRENT version's target_sessions_per_week.
--     Informational only — never an eligibility input.
--   RECOVERY  N = recovery_days of the CURRENT published version (NULL and 0
--     both mean no guidance; NULL is never rewritten). Anchor = the most
--     recent CLOSED C5 session (finished or any stopped_*) with at least one
--     performed unit, from any version, at its patient_local_date (start
--     date — never the closure date).
--       earliest_recommended_date = anchor_start_local_date + N + 1
--     Guidance applies when today (patient-local) < that date, and ONLY when
--     the Start check already says `eligible` (every hard gate passed). In
--     Calendar mode it applies only to a patient-chosen make-up, never to a
--     clinician-scheduled day.
--   DECISION  Take Recovery Day / Continue are recorded append-only with the
--     values actually used, so a later publish never reinterprets them. A
--     decision never creates a session or consumes a training day. A session
--     started after Continue is the patient's session on the same
--     decision_local_date (one C5 session per patient-local date).
-- =============================================================================

CREATE TABLE c5_recovery_decisions (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         UUID NOT NULL REFERENCES auth.users(id),
  client_request_id               UUID NOT NULL UNIQUE,
  decision                        TEXT NOT NULL CHECK (decision IN ('take_recovery_day', 'continue')),
  -- clock_timestamp(): strictly ordered even within one transaction.
  decided_at                      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decision_local_date             DATE NOT NULL,
  patient_timezone                TEXT NOT NULL,
  -- The guidance actually presented (current version at decision time).
  prescription_version_id         UUID NOT NULL REFERENCES prescription_versions(id),
  recommended_recovery_days       SMALLINT NOT NULL CHECK (recommended_recovery_days BETWEEN 1 AND 14),
  anchor_session_id               UUID NOT NULL REFERENCES rehab_sessions(id),
  anchor_start_local_date         DATE NOT NULL,
  earliest_recommended_date       DATE NOT NULL,
  -- Whole patient-local dates between the anchor and the decision date.
  rest_days_completed             SMALLINT NOT NULL CHECK (rest_days_completed >= 0),
  -- Weekly context shown with the guidance (NULL when the version has no target).
  weekly_target                   SMALLINT NULL,
  weekly_finished_sessions        SMALLINT NULL,
  CONSTRAINT c5_recovery_decisions_dates CHECK (
    earliest_recommended_date = anchor_start_local_date + recommended_recovery_days + 1
    AND decision_local_date < earliest_recommended_date
    AND rest_days_completed = decision_local_date - anchor_start_local_date - 1
  )
);

CREATE INDEX idx_c5_recovery_decisions_user_date ON c5_recovery_decisions (user_id, decision_local_date, decided_at DESC);

COMMENT ON TABLE c5_recovery_decisions IS
  'C5.6F objective record of the patient''s response to ADVISORY recovery guidance (Take Recovery Day / Continue), with the recommendation, anchor exposure and dates actually used. Append-only facts — never a compliance/adherence label. Never creates a session.';

ALTER TABLE c5_recovery_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON c5_recovery_decisions FROM anon, authenticated;
GRANT SELECT ON c5_recovery_decisions TO authenticated;

CREATE POLICY "c5_recovery_decisions: own read"
  ON c5_recovery_decisions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "c5_recovery_decisions: clinician read assigned patient"
  ON c5_recovery_decisions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = c5_recovery_decisions.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

-- Append-only.
CREATE OR REPLACE FUNCTION trg_c5_recovery_decisions_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'C5_RECOVERY_DECISION_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER trg_c5_recovery_decisions_immutable
  BEFORE UPDATE ON c5_recovery_decisions
  FOR EACH ROW EXECUTE FUNCTION trg_c5_recovery_decisions_immutable();

-- -----------------------------------------------------------------------------
-- Weekly progress (pure read). NULL when the version defines no target.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION c5_weekly_progress(p_user_id UUID, p_version_id UUID, p_today DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_target SMALLINT;
  v_mode TEXT;
  v_week_start DATE := p_today - (EXTRACT(ISODOW FROM p_today)::int - 1);
  v_count INT;
BEGIN
  SELECT target_sessions_per_week, scheduling_mode INTO v_target, v_mode FROM prescription_versions WHERE id = p_version_id;
  IF v_mode IS DISTINCT FROM 'sequence' OR v_target IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_count FROM rehab_sessions
  WHERE user_id = p_user_id AND training_status = 'finished'
    AND patient_local_date BETWEEN v_week_start AND v_week_start + 6;
  RETURN jsonb_build_object('target', v_target, 'finished_sessions', v_count,
    'week_start', v_week_start, 'week_end', v_week_start + 6, 'target_reached', v_count >= v_target);
END;
$$;
REVOKE ALL ON FUNCTION c5_weekly_progress(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Recovery guidance (pure read). Always describes the facts; `applies` says
-- whether today is before the earliest recommended date. Whether it is
-- PRESENTED is decided by c5_get_training_guidance (only when eligible).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION c5_recovery_guidance(p_user_id UUID, p_version_id UUID, p_today DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_authored SMALLINT;
  v_days SMALLINT;
  v_anchor RECORD;
  v_earliest DATE;
BEGIN
  SELECT recovery_days INTO v_authored FROM prescription_versions WHERE id = p_version_id;
  v_days := COALESCE(v_authored, 0);  -- NULL (never authored) behaves as None
  IF v_days = 0 THEN
    RETURN jsonb_build_object('applies', false, 'recommended_recovery_days', v_authored);
  END IF;

  SELECT rs.id, rs.patient_local_date INTO v_anchor
  FROM rehab_sessions rs
  WHERE rs.user_id = p_user_id
    AND rs.training_status IN ('finished', 'stopped_early', 'stopped_pause', 'stopped_acute')
    AND EXISTS (SELECT 1 FROM set_outcomes so WHERE so.rehab_session_id = rs.id AND so.outcome = 'completed')
  ORDER BY rs.patient_local_date DESC, rs.started_at DESC
  LIMIT 1;
  IF v_anchor.id IS NULL THEN
    RETURN jsonb_build_object('applies', false, 'recommended_recovery_days', v_authored);
  END IF;

  v_earliest := v_anchor.patient_local_date + v_days + 1;
  RETURN jsonb_build_object(
    'applies', p_today < v_earliest,
    'recommended_recovery_days', v_days,
    'anchor_session_id', v_anchor.id,
    'anchor_start_local_date', v_anchor.patient_local_date,
    'earliest_recommended_date', v_earliest,
    'rest_days_completed', GREATEST(p_today - v_anchor.patient_local_date - 1, 0));
END;
$$;
REVOKE ALL ON FUNCTION c5_recovery_guidance(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Internal: eligibility + the advisory layers, all from one clock read.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION c5_training_guidance_internal(p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_elig JSONB := c5_start_eligibility_internal(p_user_id);
  v_version UUID;
  v_tz TEXT;
  v_today DATE;
  v_weekly JSONB;
  v_recovery JSONB;
  v_decision RECORD;
BEGIN
  SELECT current_prescription_version_id INTO v_version FROM patient_prescriptions WHERE patient_id = p_user_id;
  SELECT timezone INTO v_tz FROM profiles WHERE id = p_user_id;
  IF v_version IS NULL OR v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    RETURN jsonb_build_object('eligibility', v_elig);
  END IF;
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_weekly := c5_weekly_progress(p_user_id, v_version, v_today);

  -- Advisory recovery is presented only for an otherwise actionable
  -- opportunity: Sequence, or a Calendar MAKE-UP (never a scheduled day).
  IF v_elig->>'result' = 'eligible'
     AND (v_elig->>'scheduling_mode' = 'sequence' OR v_elig->'calendar'->>'state' = 'make_up') THEN
    v_recovery := c5_recovery_guidance(p_user_id, v_version, v_today);
    IF (v_recovery->>'applies')::boolean THEN
      SELECT decision, decided_at INTO v_decision FROM c5_recovery_decisions
      WHERE user_id = p_user_id AND decision_local_date = v_today
        AND anchor_session_id = (v_recovery->>'anchor_session_id')::uuid
      ORDER BY decided_at DESC LIMIT 1;
      v_recovery := v_recovery || jsonb_build_object('todays_decision', v_decision.decision);
    ELSE
      v_recovery := NULL;
    END IF;
  END IF;

  RETURN jsonb_build_object('eligibility', v_elig, 'weekly', v_weekly, 'recovery', v_recovery,
    'patient_local_date', v_today, 'prescription_version_id', v_version);
END;
$$;
REVOKE ALL ON FUNCTION c5_training_guidance_internal(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION c5_get_training_guidance(p_patient_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c5_training_guidance_internal(p_patient_id);
$$;
REVOKE ALL ON FUNCTION c5_get_training_guidance(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_get_training_guidance(UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- Record Take Recovery Day / Continue. Recomputes everything server-side
-- (the browser supplies only its idempotency key and the choice). Refuses
-- when guidance is not currently presented (any hard gate, guidance not
-- applicable, Calendar scheduled day). Never touches sessions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION c5_record_recovery_decision(p_patient_id UUID, p_client_request_id UUID, p_decision TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing c5_recovery_decisions;
  v_g JSONB;
  v_r JSONB;
  v_tz TEXT;
  v_row c5_recovery_decisions;
BEGIN
  IF p_patient_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('take_recovery_day', 'continue') THEN
    RETURN jsonb_build_object('result', 'invalid_decision');
  END IF;

  -- Serialize with publish / pause / Start for this patient so the version
  -- and gates read below cannot change mid-decision.
  PERFORM 1 FROM patient_prescriptions WHERE patient_id = p_patient_id FOR SHARE;

  SELECT * INTO v_existing FROM c5_recovery_decisions WHERE client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.user_id <> p_patient_id THEN RAISE EXCEPTION 'CLIENT_REQUEST_ID_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RETURN jsonb_build_object('result', 'recorded', 'replayed', true, 'decision', v_existing.decision, 'decision_id', v_existing.id);
  END IF;

  v_g := c5_training_guidance_internal(p_patient_id);
  IF v_g->'eligibility'->>'result' <> 'eligible' THEN
    RETURN jsonb_build_object('result', v_g->'eligibility'->>'result');
  END IF;
  v_r := v_g->'recovery';
  IF v_r IS NULL OR jsonb_typeof(v_r) = 'null' THEN
    RETURN jsonb_build_object('result', 'recovery_guidance_not_applicable');
  END IF;

  SELECT timezone INTO v_tz FROM profiles WHERE id = p_patient_id;
  INSERT INTO c5_recovery_decisions (
    user_id, client_request_id, decision, decision_local_date, patient_timezone,
    prescription_version_id, recommended_recovery_days, anchor_session_id, anchor_start_local_date,
    earliest_recommended_date, rest_days_completed, weekly_target, weekly_finished_sessions
  ) VALUES (
    p_patient_id, p_client_request_id, p_decision, (v_g->>'patient_local_date')::date, v_tz,
    (v_g->>'prescription_version_id')::uuid, (v_r->>'recommended_recovery_days')::smallint,
    (v_r->>'anchor_session_id')::uuid, (v_r->>'anchor_start_local_date')::date,
    (v_r->>'earliest_recommended_date')::date, (v_r->>'rest_days_completed')::smallint,
    (v_g->'weekly'->>'target')::smallint, (v_g->'weekly'->>'finished_sessions')::smallint
  ) RETURNING * INTO v_row;

  RETURN jsonb_build_object('result', 'recorded', 'replayed', false, 'decision', v_row.decision, 'decision_id', v_row.id);
END;
$$;
REVOKE ALL ON FUNCTION c5_record_recovery_decision(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_record_recovery_decision(UUID, UUID, TEXT) TO service_role;
