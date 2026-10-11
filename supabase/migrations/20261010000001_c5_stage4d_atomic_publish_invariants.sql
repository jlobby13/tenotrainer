-- =============================================================================
-- C5, Stage 4D — atomic publish invariants (founder-approved correction).
--
-- C5.4D added two publish-blocking rules:
--   - workouts_have_active_exercise  (no empty workout is ever published)
--   - active_exercise_dosage_valid   (every saved active dosage is valid)
-- They were first enforced in the Next.js layer immediately BEFORE the
-- publish RPC, leaving a check-then-act gap: the editing clinician could
-- change the draft (e.g. from another tab) after the checks passed but
-- before the RPC copied the content. This migration moves both rules into
-- validate_prescription_draft — which publish_prescription_draft already
-- runs inside its own transaction — and closes the gap with a lock protocol
-- on the draft row:
--
--   publish_prescription_draft   takes the draft row FOR UPDATE first;
--   every write to draft content (workouts, exercises, dosage, performance
--   focus) takes the same draft row FOR SHARE via a BEFORE trigger.
--
-- FOR UPDATE conflicts with FOR SHARE, so a content write either commits
-- completely before publication validates (and is therefore validated), or
-- waits until publication has committed (and therefore cannot reach the
-- published version, which by then is already copied). Validation and the
-- content copy run against the same, unchanging draft state. Writes to the
-- draft row itself (metadata) already conflict with FOR UPDATE through their
-- own row lock.
--
-- Everything else is preserved exactly: every existing validation rule,
-- stale-base check and patient_prescriptions FOR UPDATE lock, service-role-
-- only access, immutable version copy, current-pointer move, pause
-- semantics (untouched), notification insert, and sequence-state behavior.
-- No applied migration is edited.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Authoritative dosage validity — mirrors web/lib/dosageEditor.ts
--    validateDosageInput() rule for rule, returning the SAME field codes it
--    returns (parity is verified case by case against the TypeScript function
--    by web/scripts/verifyC5Stage4dAtomicPublish.mjs). Most of these rules
--    are also enforced by prescription_exercise_dosage's CHECK constraints;
--    RPE+RIR mutual exclusion is the one rule that previously existed only
--    in TypeScript. Mirroring all of them keeps the publish boundary correct
--    even if a CHECK is later relaxed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prescription_dosage_exact_or_range_errors(
  p_mode TEXT, p_exact NUMERIC, p_min NUMERIC, p_max NUMERIC, p_field TEXT
) RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_mode = 'exact' THEN
      CASE WHEN p_exact IS NULL OR p_exact <= 0 THEN ARRAY[p_field || 'Exact'] ELSE ARRAY[]::TEXT[] END
    WHEN p_mode = 'range' THEN
      CASE WHEN p_min IS NULL OR p_max IS NULL OR p_min <= 0 OR p_max <= 0 OR p_min > p_max
        THEN ARRAY[p_field || 'Range'] ELSE ARRAY[]::TEXT[] END
    ELSE ARRAY[p_field || 'Mode']
  END;
$$;
REVOKE ALL ON FUNCTION prescription_dosage_exact_or_range_errors(TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION prescription_dosage_validation_errors(d prescription_exercise_dosage)
RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  e TEXT[] := ARRAY[]::TEXT[];
  v_load_type TEXT := COALESCE(d.load_type, 'not_applicable');
  v_load_mode TEXT;
BEGIN
  IF d.reps_mode IS NOT NULL THEN
    e := e || prescription_dosage_exact_or_range_errors(d.reps_mode, d.reps_exact, d.reps_min, d.reps_max, 'reps');
  END IF;
  IF d.hold_duration_mode IS NOT NULL THEN
    e := e || prescription_dosage_exact_or_range_errors(d.hold_duration_mode, d.hold_duration_exact_seconds, d.hold_duration_min_seconds, d.hold_duration_max_seconds, 'holdDuration');
  END IF;
  IF d.contacts_mode IS NOT NULL THEN
    e := e || prescription_dosage_exact_or_range_errors(d.contacts_mode, d.contacts_exact, d.contacts_min, d.contacts_max, 'contacts');
  END IF;
  IF d.distance_mode IS NOT NULL OR d.distance_unit IS NOT NULL THEN
    IF d.distance_unit IS NULL THEN e := e || 'distanceUnit'::TEXT; END IF;
    IF d.distance_mode IS NOT NULL THEN
      e := e || prescription_dosage_exact_or_range_errors(d.distance_mode, d.distance_exact_value, d.distance_min_value, d.distance_max_value, 'distance');
    END IF;
  END IF;
  IF d.time_duration_mode IS NOT NULL THEN
    e := e || prescription_dosage_exact_or_range_errors(d.time_duration_mode, d.time_duration_exact_seconds, d.time_duration_min_seconds, d.time_duration_max_seconds, 'timeDuration');
  END IF;
  IF d.interval_work_seconds IS NOT NULL AND d.interval_work_seconds <= 0 THEN e := e || 'intervalWorkSeconds'::TEXT; END IF;
  IF d.interval_recovery_seconds IS NOT NULL AND d.interval_recovery_seconds <= 0 THEN e := e || 'intervalRecoverySeconds'::TEXT; END IF;
  IF d.interval_rounds IS NOT NULL AND d.interval_rounds <= 0 THEN e := e || 'intervalRounds'::TEXT; END IF;

  IF v_load_type = 'external' THEN
    IF d.load_unit IS NULL THEN e := e || 'loadUnit'::TEXT; END IF;
    -- NULL load_mode with an exact value = 'exact' (pre-Revision-A rows).
    v_load_mode := COALESCE(d.load_mode, CASE WHEN d.load_value_exact IS NOT NULL THEN 'exact' END);
    IF v_load_mode = 'range' THEN
      IF d.load_value_min IS NULL OR d.load_value_max IS NULL OR d.load_value_min <= 0 OR d.load_value_max <= 0
         OR d.load_value_min > d.load_value_max THEN
        e := e || 'loadValueRange'::TEXT;
      END IF;
    ELSIF d.load_value_exact IS NULL OR d.load_value_exact <= 0 THEN
      e := e || 'loadValueExact'::TEXT;
    END IF;
  END IF;

  IF d.rpe IS NOT NULL AND d.rir IS NOT NULL THEN e := e || 'rpeRir'::TEXT; END IF;
  IF d.rpe IS NOT NULL AND (d.rpe < 0 OR d.rpe > 10) THEN e := e || 'rpe'::TEXT; END IF;
  IF d.rir IS NOT NULL AND (d.rir < 0 OR d.rir > 10) THEN e := e || 'rir'::TEXT; END IF;
  IF d.rest_seconds IS NOT NULL AND d.rest_seconds < 0 THEN e := e || 'restSeconds'::TEXT; END IF;

  IF NOT (
    d.sets IS NOT NULL
    OR d.reps_mode IS NOT NULL
    OR d.hold_duration_mode IS NOT NULL
    OR d.contacts_mode IS NOT NULL
    OR d.distance_mode IS NOT NULL
    OR d.time_duration_mode IS NOT NULL
    OR d.interval_work_seconds IS NOT NULL
    OR d.interval_recovery_seconds IS NOT NULL
    OR d.interval_rounds IS NOT NULL
    OR v_load_type != 'not_applicable'
  ) THEN
    e := e || 'dosage'::TEXT;
  END IF;

  RETURN e;
END;
$$;
REVOKE ALL ON FUNCTION prescription_dosage_validation_errors(prescription_exercise_dosage) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. validate_prescription_draft — CREATE OR REPLACE. Every rule from
--    20260927000001 is byte-identical; two rules are added at the end.
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

  -- NEW (C5.4D) — no published workout may be empty.
  RETURN QUERY SELECT 'workouts_have_active_exercise'::TEXT,
    NOT EXISTS (
      SELECT 1 FROM prescription_workouts pw
      WHERE pw.prescription_draft_id = p_draft_id
        AND NOT EXISTS (
          SELECT 1 FROM prescription_exercises pe
          WHERE pe.prescription_workout_id = pw.id AND pe.status = 'active'
        )
    ),
    'every workout must contain at least one active exercise'::TEXT;

  -- NEW (C5.4D) — every saved active dosage passes the shared dosage rules.
  RETURN QUERY SELECT 'active_exercise_dosage_valid'::TEXT,
    NOT EXISTS (
      SELECT 1 FROM prescription_exercises pe
      JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
      JOIN prescription_exercise_dosage ped ON ped.prescription_exercise_id = pe.id
      WHERE pw.prescription_draft_id = p_draft_id AND pe.status = 'active'
        AND cardinality(prescription_dosage_validation_errors(ped)) > 0
    ),
    'every saved active-exercise dosage must pass dosage validation'::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION validate_prescription_draft(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Draft-content write lock. Every INSERT/UPDATE/DELETE of draft-owned
--    content takes the owning draft row FOR SHARE before the change.
--    Version-owned rows (prescription_version_id set) are skipped — they are
--    only ever written by publication itself. SECURITY DEFINER so the lock
--    never depends on the writing role's privileges on prescription_drafts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lock_prescription_drafts_for_content_write(p_draft_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_draft_ids IS NULL OR cardinality(p_draft_ids) = 0 THEN RETURN; END IF;
  -- Fixed order, so two drafts are never locked in opposite orders.
  PERFORM 1 FROM prescription_drafts WHERE id = ANY(p_draft_ids) ORDER BY id FOR SHARE;
END;
$$;
REVOKE ALL ON FUNCTION lock_prescription_drafts_for_content_write(UUID[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION trg_lock_draft_on_workout_write() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.prescription_draft_id IS NOT NULL THEN v_ids := v_ids || OLD.prescription_draft_id; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.prescription_draft_id IS NOT NULL THEN v_ids := v_ids || NEW.prescription_draft_id; END IF;
  PERFORM lock_prescription_drafts_for_content_write(v_ids);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_lock_draft_on_workout_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION trg_lock_draft_on_exercise_write() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids UUID[];
BEGIN
  SELECT array_agg(DISTINCT pw.prescription_draft_id) INTO v_ids
  FROM prescription_workouts pw
  WHERE pw.prescription_draft_id IS NOT NULL
    AND pw.id IN (
      CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.prescription_workout_id END,
      CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.prescription_workout_id END
    );
  PERFORM lock_prescription_drafts_for_content_write(v_ids);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_lock_draft_on_exercise_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION trg_lock_draft_on_dosage_write() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids UUID[];
BEGIN
  SELECT array_agg(DISTINCT pw.prescription_draft_id) INTO v_ids
  FROM prescription_exercises pe
  JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
  WHERE pw.prescription_draft_id IS NOT NULL
    AND pe.id IN (
      CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.prescription_exercise_id END,
      CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.prescription_exercise_id END
    );
  PERFORM lock_prescription_drafts_for_content_write(v_ids);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_lock_draft_on_dosage_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION trg_lock_draft_on_focus_write() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_ids := v_ids || OLD.prescription_draft_id; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_ids := v_ids || NEW.prescription_draft_id; END IF;
  PERFORM lock_prescription_drafts_for_content_write(v_ids);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_lock_draft_on_focus_write() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_prescription_workouts_draft_lock
  BEFORE INSERT OR UPDATE OR DELETE ON prescription_workouts
  FOR EACH ROW EXECUTE FUNCTION trg_lock_draft_on_workout_write();
CREATE TRIGGER trg_prescription_exercises_draft_lock
  BEFORE INSERT OR UPDATE OR DELETE ON prescription_exercises
  FOR EACH ROW EXECUTE FUNCTION trg_lock_draft_on_exercise_write();
CREATE TRIGGER trg_prescription_exercise_dosage_draft_lock
  BEFORE INSERT OR UPDATE OR DELETE ON prescription_exercise_dosage
  FOR EACH ROW EXECUTE FUNCTION trg_lock_draft_on_dosage_write();
CREATE TRIGGER trg_prescription_draft_performance_focus_draft_lock
  BEFORE INSERT OR UPDATE OR DELETE ON prescription_draft_performance_focus
  FOR EACH ROW EXECUTE FUNCTION trg_lock_draft_on_focus_write();

-- -----------------------------------------------------------------------------
-- 4. publish_prescription_draft — CREATE OR REPLACE. The ONLY change from
--    20260929000001 is that the initial draft read now takes the draft row
--    FOR UPDATE (the other half of the lock protocol above). Under READ
--    COMMITTED the locked read returns the latest committed draft row, so a
--    second concurrent publish of the same draft now sees status='published'
--    and gets DRAFT_NOT_FOUND. Every subsequent line is byte-identical.
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
  SELECT * INTO v_draft FROM prescription_drafts WHERE id = p_draft_id FOR UPDATE;
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
    rest_seconds, load_type, load_value_exact, load_unit, load_mode, load_value_min, load_value_max,
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
    od.rest_seconds, od.load_type, od.load_value_exact, od.load_unit, od.load_mode, od.load_value_min, od.load_value_max,
    od.rpe, od.rir, od.rom, od.assistance_level, od.side
  FROM prescription_exercise_dosage od
  JOIN prescription_exercises oe ON oe.id = od.prescription_exercise_id
  JOIN prescription_workouts ow ON ow.id = oe.prescription_workout_id AND ow.prescription_draft_id = p_draft_id
  JOIN prescription_workouts nw ON nw.prescription_version_id = v_new_version_id AND nw.order_index = ow.order_index
  JOIN prescription_exercises ne ON ne.prescription_workout_id = nw.id AND ne.order_index = oe.order_index;

  UPDATE patient_prescriptions SET current_prescription_version_id = v_new_version_id, updated_at = now() WHERE id = v_pp.id;

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
