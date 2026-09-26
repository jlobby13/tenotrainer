-- =============================================================================
-- C5, Stage 3 — Draft & Publish Engine (founder-approved C5.3A + C5.3B).
--
-- Part A: two additive schema amendments identified in the C5.3A audit.
-- Part B onward: the RPC surface that makes the C5.2 schema operational.
--
-- Authorization split (see C5.3A §4-5, locked in C5.3B):
--   - The HIGH-CONSEQUENCE synchronous legacy relationship check cannot run
--     inside Postgres (no outbound HTTP from plpgsql here) — it MUST happen
--     in the Next.js server layer BEFORE any of these RPCs are invoked.
--     These RPCs therefore re-verify the PG-side supervisor_patients row as
--     a defense-in-depth secondary check only; they are not, by themselves,
--     the fail-closed boundary the founder locked. That boundary lives in
--     web/lib/prescriptionDraftAuth.ts.
--   - None of these functions are GRANTed to `authenticated` — unlike
--     create_rehab_session_if_allowed()/get_patient_acute_brake_status()
--     (patient self-service, safe to invoke directly under RLS), these
--     mutate a DIFFERENT user's clinical data on a clinician's behalf and
--     depend on a check that only exists outside the database. They are
--     callable only via the service-role client, from server code that has
--     already performed the mandatory legacy check.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Part A — schema amendments
-- -----------------------------------------------------------------------------

-- based_on_prescription_version_id = CONTENT SOURCE (what was copied).
-- stale_base_prescription_version_id = the current active version at the
-- MOMENT the draft was created, used exclusively for stale-publish
-- protection. These diverge exactly when copying a HISTORICAL version or a
-- template while a different version is current — see C5.3A §9-10.
ALTER TABLE prescription_drafts
  ADD COLUMN stale_base_prescription_version_id UUID NULL REFERENCES prescription_versions(id);

COMMENT ON COLUMN prescription_drafts.based_on_prescription_version_id IS
  'Content source version copied from (clone_active/clone_historical only). NULL for empty/from_template.';
COMMENT ON COLUMN prescription_drafts.stale_base_prescription_version_id IS
  'The patient''s current version at draft-creation time, captured regardless of source. Compared NULL-safely against patient_prescriptions.current_prescription_version_id at publish — a mismatch blocks publish. Never used as content source.';

ALTER TABLE patient_prescriptions
  ADD COLUMN resumed_by UUID NULL REFERENCES auth.users(id);

COMMENT ON COLUMN patient_prescriptions.resumed_by IS
  'Audit actor for the most recent resume, symmetric with paused_by. Null if never resumed.';

-- -----------------------------------------------------------------------------
-- Part B — exercise-visibility helper (parameterized by clinician id, NOT
-- auth.uid()/RLS — every caller here runs as service-role, where auth.uid()
-- is not the acting clinician, so visibility must be re-expressed
-- explicitly rather than relied on implicitly).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinician_can_access_exercise(p_clinician_id UUID, p_exercise_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM canonical_exercises ce
    WHERE ce.id = p_exercise_id
      AND (
        ce.visibility = 'global'
        OR (ce.visibility = 'private' AND ce.owner_clinician_id = p_clinician_id)
        OR (ce.visibility = 'org_shared' AND EXISTS (
          SELECT 1 FROM organization_members om
          WHERE om.organization_id = ce.organization_id
            AND om.user_id = p_clinician_id
            AND om.role IN ('clinician', 'clinician_admin', 'super_user')
        ))
      )
  );
$$;
REVOKE ALL ON FUNCTION clinician_can_access_exercise(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Content-copy helpers. Both use the (workout.order_index, exercise.order_index)
-- pair as the join key between old and new trees instead of an explicit
-- UUID-remapping table — correct and unambiguous because both are protected
-- by UNIQUE(parent, order_index) constraints already.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION copy_prescription_version_content_into_draft(p_version_id UUID, p_draft_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO prescription_workouts (prescription_draft_id, label, order_index, days_of_week)
  SELECT p_draft_id, label, order_index, days_of_week
  FROM prescription_workouts WHERE prescription_version_id = p_version_id;

  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, status, additional_instructions)
  SELECT nw.id, oe.canonical_exercise_id, oe.order_index, oe.status, oe.additional_instructions
  FROM prescription_exercises oe
  JOIN prescription_workouts ow ON ow.id = oe.prescription_workout_id AND ow.prescription_version_id = p_version_id
  JOIN prescription_workouts nw ON nw.prescription_draft_id = p_draft_id AND nw.order_index = ow.order_index;

  INSERT INTO prescription_exercise_dosage (
    prescription_exercise_id, dosage_type, sets,
    reps_mode, reps_exact, reps_min, reps_max,
    contacts_mode, contacts_exact, contacts_min, contacts_max,
    hold_duration_mode, hold_duration_exact_seconds, hold_duration_min_seconds, hold_duration_max_seconds,
    time_duration_mode, time_duration_exact_seconds, time_duration_min_seconds, time_duration_max_seconds,
    interval_work_seconds, interval_recovery_seconds, interval_rounds,
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
    od.concentric_duration_seconds, od.rep_hold_duration_seconds, od.eccentric_duration_seconds, od.tempo_description,
    od.rest_seconds, od.load_type, od.load_value_exact, od.load_unit,
    od.rpe, od.rir, od.rom, od.assistance_level, od.side
  FROM prescription_exercise_dosage od
  JOIN prescription_exercises oe ON oe.id = od.prescription_exercise_id
  JOIN prescription_workouts ow ON ow.id = oe.prescription_workout_id AND ow.prescription_version_id = p_version_id
  JOIN prescription_workouts nw ON nw.prescription_draft_id = p_draft_id AND nw.order_index = ow.order_index
  JOIN prescription_exercises ne ON ne.prescription_workout_id = nw.id AND ne.order_index = oe.order_index;
END;
$$;
REVOKE ALL ON FUNCTION copy_prescription_version_content_into_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Template tables have no performance-focus join table today (a gap
-- surfaced during this stage, not fixed here — see the implementation
-- report) so template-sourced drafts simply start with zero performance
-- focus rows; the clinician can set them via updateDraftMetadata.
CREATE OR REPLACE FUNCTION copy_template_content_into_draft(p_template_id UUID, p_draft_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO prescription_workouts (prescription_draft_id, label, order_index, days_of_week)
  SELECT p_draft_id, label, order_index, days_of_week
  FROM template_workouts WHERE template_id = p_template_id;

  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index, additional_instructions)
  SELECT nw.id, te.canonical_exercise_id, te.order_index, te.additional_instructions
  FROM template_exercises te
  JOIN template_workouts tw ON tw.id = te.template_workout_id AND tw.template_id = p_template_id
  JOIN prescription_workouts nw ON nw.prescription_draft_id = p_draft_id AND nw.order_index = tw.order_index;

  INSERT INTO prescription_exercise_dosage (
    prescription_exercise_id, dosage_type, sets,
    reps_mode, reps_exact, reps_min, reps_max,
    contacts_mode, contacts_exact, contacts_min, contacts_max,
    hold_duration_mode, hold_duration_exact_seconds, hold_duration_min_seconds, hold_duration_max_seconds,
    time_duration_mode, time_duration_exact_seconds, time_duration_min_seconds, time_duration_max_seconds,
    interval_work_seconds, interval_recovery_seconds, interval_rounds,
    concentric_duration_seconds, rep_hold_duration_seconds, eccentric_duration_seconds, tempo_description,
    rest_seconds, load_type, load_value_exact, load_unit,
    rpe, rir, rom, assistance_level, side
  )
  SELECT ne.id, td.dosage_type, td.sets,
    td.reps_mode, td.reps_exact, td.reps_min, td.reps_max,
    td.contacts_mode, td.contacts_exact, td.contacts_min, td.contacts_max,
    td.hold_duration_mode, td.hold_duration_exact_seconds, td.hold_duration_min_seconds, td.hold_duration_max_seconds,
    td.time_duration_mode, td.time_duration_exact_seconds, td.time_duration_min_seconds, td.time_duration_max_seconds,
    td.interval_work_seconds, td.interval_recovery_seconds, td.interval_rounds,
    td.concentric_duration_seconds, td.rep_hold_duration_seconds, td.eccentric_duration_seconds, td.tempo_description,
    td.rest_seconds, td.load_type, td.load_value_exact, td.load_unit,
    td.rpe, td.rir, td.rom, td.assistance_level, td.side
  FROM template_exercise_dosage td
  JOIN template_exercises te ON te.id = td.template_exercise_id
  JOIN template_workouts tw ON tw.id = te.template_workout_id AND tw.template_id = p_template_id
  JOIN prescription_workouts nw ON nw.prescription_draft_id = p_draft_id AND nw.order_index = tw.order_index
  JOIN prescription_exercises ne ON ne.prescription_workout_id = nw.id AND ne.order_index = te.order_index;
END;
$$;
REVOKE ALL ON FUNCTION copy_template_content_into_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- create_prescription_draft — all four creation modes. Gets-or-creates
-- patient_prescriptions transactionally (locked, so two concurrent first-
-- draft attempts for a brand-new patient can't both try to insert it), then
-- enforces one-open-draft, then copies content where applicable.
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
      scheduling_mode = pv.scheduling_mode
    FROM prescription_versions pv WHERE pv.id = p_source_version_id AND d.id = v_draft_id;
  ELSIF p_source = 'from_template' THEN
    PERFORM copy_template_content_into_draft(p_template_id, v_draft_id);
    UPDATE prescription_drafts d SET
      phase = pt.phase,
      scheduling_mode = pt.scheduling_mode
    FROM prescription_templates pt WHERE pt.id = p_template_id AND d.id = v_draft_id;
  END IF;

  RETURN v_draft_id;
END;
$$;
REVOKE ALL ON FUNCTION create_prescription_draft(UUID, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- validate_prescription_draft — the ONE authoritative rule set, used both
-- as a standalone read-only preview (validateDraft) and internally by
-- publish_prescription_draft (never duplicated).
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
-- publish_prescription_draft — the atomic publish transaction.
--
-- stage/irritability/is_insertional carry-forward: C5.3's draft model does
-- not (yet) let a clinician edit these three legacy plan-state fields —
-- they are a separate clinical-progress axis from what this engine
-- authors. Every publish therefore carries them forward from the patient's
-- MOST RECENT existing prescription_versions row (by created_at, across
-- both legacy and C5-native sources), regardless of which version's
-- CONTENT was cloned — rolling back exercise content to a historical
-- version must never also roll back the patient's current clinical stage.
-- Never fabricated: has_prior_clinical_state (validate_prescription_draft)
-- guarantees at least one such row exists before this runs.
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
    patient_prescription_id, version_number, published_at, published_by, phase, scheduling_mode
  ) VALUES (
    v_pp.patient_id, v_prior.stage, v_prior.irritability, v_prior.is_insertional, 'clinician_change',
    v_pp.id, v_version_number, now(), p_clinician_id, v_draft.phase, v_draft.scheduling_mode
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
    od.concentric_duration_seconds, od.rep_hold_duration_seconds, od.eccentric_duration_seconds, od.tempo_description,
    od.rest_seconds, od.load_type, od.load_value_exact, od.load_unit,
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

-- -----------------------------------------------------------------------------
-- pause / resume — operational state only, never touches version content.
-- The CHECK constraint patient_prescriptions_pause_fields_consistent
-- (C5.2) requires paused_at/paused_by to be NULL whenever active, so resume
-- must null them; resumed_at/resumed_by are left as the last-resume record
-- and are NOT nulled by pause (asymmetric on purpose — see report).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pause_prescription(p_patient_prescription_id UUID, p_clinician_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_pp RECORD;
BEGIN
  SELECT * INTO v_pp FROM patient_prescriptions WHERE id = p_patient_prescription_id FOR UPDATE;
  IF v_pp IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.supervisor_id = p_clinician_id AND sp.patient_id = v_pp.patient_id AND sp.status = 'active'
  ) THEN
    RAISE EXCEPTION 'PATIENT_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF v_pp.operational_status = 'paused' THEN
    RAISE EXCEPTION 'PRESCRIPTION_ALREADY_PAUSED' USING ERRCODE = 'P0001';
  END IF;
  UPDATE patient_prescriptions SET
    operational_status = 'paused', paused_at = now(), paused_by = p_clinician_id, updated_at = now()
  WHERE id = p_patient_prescription_id;
END;
$$;
REVOKE ALL ON FUNCTION pause_prescription(UUID, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION resume_prescription(p_patient_prescription_id UUID, p_clinician_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_pp RECORD;
BEGIN
  SELECT * INTO v_pp FROM patient_prescriptions WHERE id = p_patient_prescription_id FOR UPDATE;
  IF v_pp IS NULL THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.supervisor_id = p_clinician_id AND sp.patient_id = v_pp.patient_id AND sp.status = 'active'
  ) THEN
    RAISE EXCEPTION 'PATIENT_NOT_AUTHORIZED' USING ERRCODE = 'P0001';
  END IF;
  IF v_pp.operational_status = 'active' THEN
    RAISE EXCEPTION 'PRESCRIPTION_ALREADY_ACTIVE' USING ERRCODE = 'P0001';
  END IF;
  UPDATE patient_prescriptions SET
    operational_status = 'active', paused_at = NULL, paused_by = NULL,
    resumed_at = now(), resumed_by = p_clinician_id, updated_at = now()
  WHERE id = p_patient_prescription_id;
END;
$$;
REVOKE ALL ON FUNCTION resume_prescription(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Reorder RPCs — two-phase re-index (offset out of range, then assign final
-- values) inside one transaction, avoiding a transient collision with the
-- UNIQUE(parent, order_index) partial indexes that a naive per-row update
-- sequence could otherwise hit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reorder_prescription_workouts(p_draft_id UUID, p_clinician_id UUID, p_ordered_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_draft RECORD;
  v_idx INTEGER;
  v_count INTEGER;
BEGIN
  SELECT * INTO v_draft FROM prescription_drafts WHERE id = p_draft_id;
  IF v_draft IS NULL OR v_draft.status != 'editing' THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_draft.editing_clinician_id != p_clinician_id THEN RAISE EXCEPTION 'DRAFT_NOT_OWNED_BY_CALLER' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_count FROM prescription_workouts WHERE prescription_draft_id = p_draft_id;
  IF v_count IS DISTINCT FROM COALESCE(array_length(p_ordered_ids, 1), 0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE prescription_workouts SET order_index = order_index + 10000 WHERE prescription_draft_id = p_draft_id;

  FOR v_idx IN 1..array_length(p_ordered_ids, 1) LOOP
    UPDATE prescription_workouts SET order_index = v_idx - 1
    WHERE id = p_ordered_ids[v_idx] AND prescription_draft_id = p_draft_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001'; END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION reorder_prescription_workouts(UUID, UUID, UUID[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION reorder_prescription_exercises(p_workout_id UUID, p_clinician_id UUID, p_ordered_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_draft_id UUID;
  v_draft RECORD;
  v_idx INTEGER;
  v_count INTEGER;
BEGIN
  SELECT prescription_draft_id INTO v_draft_id FROM prescription_workouts WHERE id = p_workout_id;
  IF v_draft_id IS NULL THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_draft FROM prescription_drafts WHERE id = v_draft_id;
  IF v_draft IS NULL OR v_draft.status != 'editing' THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF v_draft.editing_clinician_id != p_clinician_id THEN RAISE EXCEPTION 'DRAFT_NOT_OWNED_BY_CALLER' USING ERRCODE = 'P0001'; END IF;

  SELECT count(*) INTO v_count FROM prescription_exercises WHERE prescription_workout_id = p_workout_id;
  IF v_count IS DISTINCT FROM COALESCE(array_length(p_ordered_ids, 1), 0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE prescription_exercises SET order_index = order_index + 10000 WHERE prescription_workout_id = p_workout_id;

  FOR v_idx IN 1..array_length(p_ordered_ids, 1) LOOP
    UPDATE prescription_exercises SET order_index = v_idx - 1
    WHERE id = p_ordered_ids[v_idx] AND prescription_workout_id = p_workout_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE = 'P0001'; END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION reorder_prescription_exercises(UUID, UUID, UUID[]) FROM PUBLIC, anon, authenticated;
