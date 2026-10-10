-- =============================================================================
-- C5, Stage 4C — Workout Structure & Scheduling (founder-locked decisions).
-- Additive only. One new column per table (draft/version/template), plus
-- CREATE OR REPLACE on the three existing C5.3 functions that must now
-- carry/validate it. No existing column, row, or RLS policy is touched.
--
-- target_sessions_per_week is authoring/prescription INTENT ONLY:
--   - required (1-7) when scheduling_mode = 'sequence'
--   - NULL when scheduling_mode = 'calendar'
--   - never creates sessions, never advances prescription_sequence_state,
--     never produces an adherence judgment, never touches M6.
--   - patient execution does not consume this until C5.6 deliberately
--     reads it — nothing in this migration wires it to any runtime path.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Schema — one nullable, bounded column per table. Same CHECK shape
--    everywhere: NULL or 1..7 inclusive (founder-specified v1 range).
-- -----------------------------------------------------------------------------
ALTER TABLE prescription_drafts
  ADD COLUMN target_sessions_per_week SMALLINT NULL
    CHECK (target_sessions_per_week IS NULL OR (target_sessions_per_week >= 1 AND target_sessions_per_week <= 7));

ALTER TABLE prescription_versions
  ADD COLUMN target_sessions_per_week SMALLINT NULL
    CHECK (target_sessions_per_week IS NULL OR (target_sessions_per_week >= 1 AND target_sessions_per_week <= 7));

ALTER TABLE prescription_templates
  ADD COLUMN target_sessions_per_week SMALLINT NULL
    CHECK (target_sessions_per_week IS NULL OR (target_sessions_per_week >= 1 AND target_sessions_per_week <= 7));

COMMENT ON COLUMN prescription_drafts.target_sessions_per_week IS
  'Sequence-mode-only clinician-authored scheduling TARGET (1-7 sessions/week). NULL for Calendar mode (enforced by validate_prescription_draft at publish, not by a CHECK here, matching the existing scheduling_mode_present/calendar_days_present pattern — drafts may be freely incomplete mid-authoring). Never itself creates sessions, advances prescription_sequence_state, or feeds any adherence/M6 computation.';
COMMENT ON COLUMN prescription_versions.target_sessions_per_week IS
  'Immutable published copy of the draft value at publish time. Same semantics as prescription_drafts.target_sessions_per_week — informational scheduling intent only.';
COMMENT ON COLUMN prescription_templates.target_sessions_per_week IS
  'Template-authored default, copied into a new draft on from_template creation exactly like phase/scheduling_mode. No template UX is built in C5.4C.';

-- -----------------------------------------------------------------------------
-- 2. create_prescription_draft — CREATE OR REPLACE, byte-identical except
--    the two post-insert UPDATEs (clone_active/clone_historical and
--    from_template) now also carry target_sessions_per_week alongside the
--    existing phase/scheduling_mode copy.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_prescription_draft(
  p_patient_id UUID,
  p_clinician_id UUID,
  p_source TEXT,
  p_source_version_id UUID DEFAULT NULL,
  p_template_id UUID DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pp_id UUID;
  v_current_version_id UUID;
  v_draft_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.supervisor_id = p_clinician_id AND sp.patient_id = p_patient_id AND sp.status = 'active'
  ) THEN
    RAISE EXCEPTION 'PATIENT_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  IF p_source NOT IN ('empty', 'clone_active', 'clone_historical', 'from_template') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, current_prescription_version_id INTO v_pp_id, v_current_version_id
  FROM patient_prescriptions WHERE patient_id = p_patient_id FOR UPDATE;

  IF v_pp_id IS NULL THEN
    INSERT INTO patient_prescriptions (patient_id) VALUES (p_patient_id)
    RETURNING id, current_prescription_version_id INTO v_pp_id, v_current_version_id;
  END IF;

  IF EXISTS (SELECT 1 FROM prescription_drafts WHERE patient_prescription_id = v_pp_id AND status = 'editing') THEN
    RAISE EXCEPTION 'DRAFT_ALREADY_EXISTS' USING ERRCODE = 'P0001';
  END IF;

  IF p_source IN ('clone_active', 'clone_historical') THEN
    IF p_source_version_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM prescription_versions WHERE id = p_source_version_id AND patient_prescription_id = v_pp_id
    ) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001';
    END IF;
    IF p_source = 'clone_active' AND p_source_version_id IS DISTINCT FROM v_current_version_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_source = 'from_template' THEN
    IF p_template_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM prescription_templates pt WHERE pt.id = p_template_id AND (
        pt.owner_clinician_id = p_clinician_id
        OR (pt.visibility = 'org_shared' AND EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = pt.organization_id AND om.user_id = p_clinician_id
            AND om.role IN ('clinician', 'clinician_admin', 'super_user')
        ))
      )
    ) THEN
      RAISE EXCEPTION 'TEMPLATE_UNAVAILABLE' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO prescription_drafts (
    patient_prescription_id, status, source,
    based_on_prescription_version_id, stale_base_prescription_version_id, source_template_id,
    created_by, editing_clinician_id, updated_by
  ) VALUES (
    v_pp_id, 'editing', p_source,
    CASE WHEN p_source IN ('clone_active', 'clone_historical') THEN p_source_version_id ELSE NULL END,
    v_current_version_id,
    CASE WHEN p_source = 'from_template' THEN p_template_id ELSE NULL END,
    p_clinician_id, p_clinician_id, p_clinician_id
  ) RETURNING id INTO v_draft_id;

  IF p_source IN ('clone_active', 'clone_historical') THEN
    PERFORM copy_prescription_version_content_into_draft(p_source_version_id, v_draft_id);
    INSERT INTO prescription_draft_performance_focus (prescription_draft_id, focus)
    SELECT v_draft_id, focus FROM prescription_version_performance_focus WHERE prescription_version_id = p_source_version_id;
    UPDATE prescription_drafts d SET
      phase = pv.phase,
      scheduling_mode = pv.scheduling_mode,
      target_sessions_per_week = pv.target_sessions_per_week
    FROM prescription_versions pv WHERE pv.id = p_source_version_id AND d.id = v_draft_id;
  ELSIF p_source = 'from_template' THEN
    PERFORM copy_template_content_into_draft(p_template_id, v_draft_id);
    UPDATE prescription_drafts d SET
      phase = pt.phase,
      scheduling_mode = pt.scheduling_mode,
      target_sessions_per_week = pt.target_sessions_per_week
    FROM prescription_templates pt WHERE pt.id = p_template_id AND d.id = v_draft_id;
  END IF;

  RETURN v_draft_id;
END;
$$;
REVOKE ALL ON FUNCTION create_prescription_draft(UUID, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. validate_prescription_draft — CREATE OR REPLACE, adds exactly three new
--    rules (sequence target required, calendar target forbidden, calendar
--    weekday exclusivity). Every existing rule is byte-identical — nothing
--    weakened.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_prescription_draft(p_draft_id UUID)
RETURNS TABLE(rule TEXT, passed BOOLEAN, detail TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_draft RECORD;
BEGIN
  SELECT * INTO v_draft FROM prescription_drafts WHERE id = p_draft_id;
  IF v_draft IS NULL THEN
    RETURN QUERY SELECT 'draft_exists'::TEXT, false, 'draft not found'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'has_workout'::TEXT,
    EXISTS(SELECT 1 FROM prescription_workouts WHERE prescription_draft_id = p_draft_id),
    'at least one workout is required'::TEXT;

  RETURN QUERY SELECT 'has_active_exercise'::TEXT,
    EXISTS(
      SELECT 1 FROM prescription_exercises pe
      JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
      WHERE pw.prescription_draft_id = p_draft_id AND pe.status = 'active'
    ),
    'at least one active exercise is required'::TEXT;

  RETURN QUERY SELECT 'active_exercises_have_dosage'::TEXT,
    NOT EXISTS (
      SELECT 1 FROM prescription_exercises pe
      JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
      LEFT JOIN prescription_exercise_dosage ped ON ped.prescription_exercise_id = pe.id
      WHERE pw.prescription_draft_id = p_draft_id AND pe.status = 'active' AND ped.id IS NULL
    ),
    'every active exercise must have a dosage row'::TEXT;

  RETURN QUERY SELECT 'scheduling_mode_present'::TEXT,
    v_draft.scheduling_mode IS NOT NULL,
    'scheduling mode must be set before publish'::TEXT;

  RETURN QUERY SELECT 'sequence_ordering_valid'::TEXT,
    v_draft.scheduling_mode IS DISTINCT FROM 'sequence' OR (
      SELECT COALESCE(MIN(order_index), -1) = 0 AND COALESCE(MAX(order_index), -1) = COUNT(*) - 1
      FROM prescription_workouts WHERE prescription_draft_id = p_draft_id
    ),
    'sequence mode requires contiguous 0-based workout ordering'::TEXT;

  RETURN QUERY SELECT 'calendar_days_present'::TEXT,
    v_draft.scheduling_mode IS DISTINCT FROM 'calendar' OR NOT EXISTS (
      SELECT 1 FROM prescription_workouts
      WHERE prescription_draft_id = p_draft_id
        AND (days_of_week IS NULL OR array_length(days_of_week, 1) IS NULL OR array_length(days_of_week, 1) = 0)
    ),
    'calendar mode requires every workout to have at least one scheduled weekday'::TEXT;

  -- NEW (C5.4C §6/§24) — a weekday may belong to only one workout. Server
  -- is authoritative regardless of client-side disabled controls.
  RETURN QUERY SELECT 'calendar_weekdays_exclusive'::TEXT,
    v_draft.scheduling_mode IS DISTINCT FROM 'calendar' OR NOT EXISTS (
      SELECT wd FROM (
        SELECT unnest(days_of_week) AS wd
        FROM prescription_workouts
        WHERE prescription_draft_id = p_draft_id AND days_of_week IS NOT NULL
      ) all_assigned_days
      GROUP BY wd HAVING count(*) > 1
    ),
    'each weekday may be assigned to only one workout in calendar mode'::TEXT;

  -- NEW (C5.4C §5/§24) — target_sessions_per_week required for Sequence,
  -- forbidden for Calendar. Bounds (1-7) are already CHECK-enforced at
  -- write time; this only enforces presence/absence per mode.
  RETURN QUERY SELECT 'sequence_target_frequency_present'::TEXT,
    v_draft.scheduling_mode IS DISTINCT FROM 'sequence' OR v_draft.target_sessions_per_week IS NOT NULL,
    'sequence mode requires a target sessions-per-week value (1-7)'::TEXT;

  RETURN QUERY SELECT 'calendar_target_frequency_absent'::TEXT,
    v_draft.scheduling_mode IS DISTINCT FROM 'calendar' OR v_draft.target_sessions_per_week IS NULL,
    'calendar mode does not use a target sessions-per-week value'::TEXT;

  RETURN QUERY SELECT 'exercises_active_and_accessible'::TEXT,
    NOT EXISTS (
      SELECT 1 FROM prescription_exercises pe
      JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
      JOIN canonical_exercises ce ON ce.id = pe.canonical_exercise_id
      WHERE pw.prescription_draft_id = p_draft_id
        AND (ce.active = false OR NOT clinician_can_access_exercise(v_draft.editing_clinician_id, ce.id))
    ),
    'every referenced exercise must be active and accessible to the editing clinician'::TEXT;

  RETURN QUERY SELECT 'has_prior_clinical_state'::TEXT,
    EXISTS (
      SELECT 1 FROM prescription_versions pv
      JOIN patient_prescriptions pp ON pp.id = v_draft.patient_prescription_id
      WHERE pv.user_id = pp.patient_id
    ),
    'a prior stage/irritability/insertional-status record must exist to carry forward at publish'::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION validate_prescription_draft(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. publish_prescription_draft — CREATE OR REPLACE, adds
--    target_sessions_per_week to the prescription_versions INSERT. Every
--    other line is byte-identical to 20260917000001, including the
--    unchanged Sequence-reset / Calendar-delete prescription_sequence_state
--    behavior (C5.4C §8 — explicitly preserved, not touched).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION publish_prescription_draft(p_draft_id UUID, p_clinician_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_draft RECORD;
  v_pp RECORD;
  v_prior RECORD;
  v_new_version_id UUID;
  v_version_number INTEGER;
  v_is_first BOOLEAN;
  v_notification_type TEXT;
  v_first_workout_id UUID;
BEGIN
  SELECT * INTO v_draft FROM prescription_drafts WHERE id = p_draft_id;
  IF v_draft IS NULL THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_draft.editing_clinician_id != p_clinician_id THEN RAISE EXCEPTION 'DRAFT_NOT_OWNED_BY_CALLER' USING ERRCODE = 'P0001'; END IF;
  IF v_draft.status != 'editing' THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_pp FROM patient_prescriptions WHERE id = v_draft.patient_prescription_id FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.supervisor_id = p_clinician_id AND sp.patient_id = v_pp.patient_id AND sp.status = 'active'
  ) THEN
    RAISE EXCEPTION 'PATIENT_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;

  IF v_pp.current_prescription_version_id IS DISTINCT FROM v_draft.stale_base_prescription_version_id THEN
    RAISE EXCEPTION 'DRAFT_STALE_BASE' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM validate_prescription_draft(p_draft_id) WHERE NOT passed) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001';
  END IF;

  SELECT stage, irritability, is_insertional INTO v_prior
  FROM prescription_versions WHERE user_id = v_pp.patient_id ORDER BY created_at DESC LIMIT 1;

  v_is_first := v_pp.current_prescription_version_id IS NULL;
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
  FROM prescription_versions WHERE patient_prescription_id = v_pp.id;

  INSERT INTO prescription_versions (
    user_id, stage, irritability, is_insertional, source,
    patient_prescription_id, version_number, published_at, published_by, phase, scheduling_mode,
    target_sessions_per_week
  ) VALUES (
    v_pp.patient_id, v_prior.stage, v_prior.irritability, v_prior.is_insertional, 'clinician_change',
    v_pp.id, v_version_number, now(), p_clinician_id, v_draft.phase, v_draft.scheduling_mode,
    v_draft.target_sessions_per_week
  ) RETURNING id INTO v_new_version_id;

  INSERT INTO prescription_version_performance_focus (prescription_version_id, focus)
  SELECT v_new_version_id, focus FROM prescription_draft_performance_focus WHERE prescription_draft_id = p_draft_id;

  INSERT INTO prescription_workouts (prescription_version_id, label, order_index, days_of_week)
  SELECT v_new_version_id, label, order_index, days_of_week
  FROM prescription_workouts WHERE prescription_draft_id = p_draft_id;

  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status, additional_instructions)
  SELECT nw.id, oe.canonical_exercise_id, oe.order_index, oe.status, oe.additional_instructions
  FROM prescription_exercises oe
  JOIN prescription_workouts ow ON ow.id = oe.prescription_workout_id AND ow.prescription_draft_id = p_draft_id
  JOIN prescription_workouts nw ON nw.prescription_version_id = v_new_version_id AND nw.order_index = ow.order_index;

  INSERT INTO prescription_exercise_dosage (
    prescription_exercise_id, dosage_type, sets,
    reps_mode, reps_exact, reps_min, reps_max,
    contacts_mode, contacts_exact, contacts_min, contacts_max,
    hold_duration_mode, hold_duration_exact_seconds, hold_duration_min_seconds, hold_duration_max_seconds,
    time_duration_mode, time_duration_exact_seconds, time_duration_min_seconds, time_duration_max_seconds,
    interval_work_seconds, interval_recovery_seconds, interval_rounds,
    distance_mode, distance_exact_value, distance_min_value, distance_max_value, distance_unit,
    concentric_duration_seconds, rep_hold_duration_seconds, eccentric_duration_seconds, tempo_description,
    rest_seconds, load_type, load_value_exact, load_unit,
    rpe, rir, rom, assistance_level, side
  )
  SELECT ne.id, od.dosage_type, od.sets,
    od.reps_mode, od.reps_exact, od.reps_min, od.reps_max,
    od.contacts_mode, od.contacts_exact, od.contacts_min, od.contacts_max,
    od.hold_duration_mode, od.hold_duration_exact_seconds, od.hold_duration_min_seconds, od.hold_duration_max_seconds,
    od.time_duration_mode, od.time_duration_exact_seconds, od.time_duration_min_seconds, od.time_duration_max_seconds,
    od.interval_work_seconds, od.interval_recovery_seconds, od.interval_rounds,
    od.distance_mode, od.distance_exact_value, od.distance_min_value, od.distance_max_value, od.distance_unit,
    od.concentric_duration_seconds, od.rep_hold_duration_seconds, od.eccentric_duration_seconds, od.tempo_description,
    od.rest_seconds, od.load_type, od.load_value_exact, od.load_unit,
    od.rpe, od.rir, od.rom, od.assistance_level, od.side
  FROM prescription_exercise_dosage od
  JOIN prescription_exercises oe ON oe.id = od.prescription_exercise_id
  JOIN prescription_workouts ow ON ow.id = oe.prescription_workout_id AND ow.prescription_draft_id = p_draft_id
  JOIN prescription_workouts nw ON nw.prescription_version_id = v_new_version_id AND nw.order_index = ow.order_index
  JOIN prescription_exercises ne ON ne.prescription_workout_id = nw.id AND ne.order_index = oe.order_index;

  UPDATE patient_prescriptions SET current_prescription_version_id = v_new_version_id, updated_at = now() WHERE id = v_pp.id;

  -- UNCHANGED from 20260917000001 (C5.4C §8 — sequence-state behavior is
  -- explicitly preserved, not modified by this migration).
  IF v_draft.scheduling_mode = 'sequence' THEN
    SELECT id INTO v_first_workout_id FROM prescription_workouts
      WHERE prescription_version_id = v_new_version_id ORDER BY order_index ASC LIMIT 1;
    INSERT INTO prescription_sequence_state (patient_prescription_id, prescription_version_id, current_workout_id, updated_at)
    VALUES (v_pp.id, v_new_version_id, v_first_workout_id, now())
    ON CONFLICT (patient_prescription_id) DO UPDATE SET
      prescription_version_id = EXCLUDED.prescription_version_id,
      current_workout_id = EXCLUDED.current_workout_id,
      updated_at = now();
  ELSE
    DELETE FROM prescription_sequence_state WHERE patient_prescription_id = v_pp.id;
  END IF;

  UPDATE prescription_drafts SET status = 'published', updated_at = now(), updated_by = p_clinician_id WHERE id = p_draft_id;

  v_notification_type := CASE WHEN v_is_first THEN 'prescription_published' ELSE 'prescription_updated' END;
  INSERT INTO notifications (patient_id, type, prescription_version_id) VALUES (v_pp.patient_id, v_notification_type, v_new_version_id);

  RETURN v_new_version_id;
END;
$$;
REVOKE ALL ON FUNCTION publish_prescription_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;
