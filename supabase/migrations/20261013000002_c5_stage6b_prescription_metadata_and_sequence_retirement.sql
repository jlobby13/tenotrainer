-- =============================================================================
-- C5, Stage 6B — prescription metadata, notifications and retirement of
-- prescription_sequence_state.
--
-- Schema only; no runtime behavior is enabled. Founder-locked C5.6A
-- semantics encoded here:
--   - recovery_days: clinician-authored, ADVISORY recommended recovery
--     interval. v1 UI offers None/1/2; the database accepts 0-14. The 14-day
--     ceiling is a garbage-value sanity bound, NOT clinical policy. Never
--     inferred from stage, irritability, exercise category or AI; separate
--     from target_sessions_per_week.
--   - Stage/irritability are clinician-facing context only, never runtime
--     inputs, never publication gates merely because absent. Historical
--     values are preserved in place.
--   - Sequence state is DERIVED from session history (see 20261013000001).
--     prescription_sequence_state is retired: its only writer
--     (publish_prescription_draft) stops writing it, then it is dropped.
--   - In-app notifications gain prescription_paused / prescription_resumed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. recovery_days
-- -----------------------------------------------------------------------------
ALTER TABLE prescription_drafts
  ADD COLUMN recovery_days SMALLINT NOT NULL DEFAULT 0
    CONSTRAINT prescription_drafts_recovery_days_range CHECK (recovery_days BETWEEN 0 AND 14);
ALTER TABLE prescription_templates
  ADD COLUMN recovery_days SMALLINT NOT NULL DEFAULT 0
    CONSTRAINT prescription_templates_recovery_days_range CHECK (recovery_days BETWEEN 0 AND 14);
-- Versions: NULL = published before the field existed (no recovery interval
-- was authored). Not backfilled — an immutable record is not rewritten.
ALTER TABLE prescription_versions
  ADD COLUMN recovery_days SMALLINT NULL
    CONSTRAINT prescription_versions_recovery_days_range CHECK (recovery_days IS NULL OR recovery_days BETWEEN 0 AND 14);

COMMENT ON COLUMN prescription_drafts.recovery_days IS
  'Clinician-authored ADVISORY recommended recovery interval in days. 0 = None. v1 UI offers 0/1/2; the 0-14 CHECK is a garbage-value sanity bound, not clinical policy. Never inferred from stage, irritability, exercise category or AI. Independent of target_sessions_per_week. Never shifts a Calendar schedule or warns against a clinician-scheduled workout.';
COMMENT ON COLUMN prescription_templates.recovery_days IS
  'Template-authored default for prescription_drafts.recovery_days. Same semantics.';
COMMENT ON COLUMN prescription_versions.recovery_days IS
  'Immutable published copy of prescription_drafts.recovery_days. NULL = version published before recovery_days existed (none authored). Same semantics.';

-- -----------------------------------------------------------------------------
-- 2. target_sessions_per_week — correct the now-stale semantics comments.
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN prescription_drafts.target_sessions_per_week IS
  'Sequence-mode clinician-defined Mon-Sun completed-session adherence/reporting TARGET (1-7). NULL for Calendar mode (enforced by validate_prescription_draft at publish). It is the Y in "X / Y completed sessions this week", where X = FINISHED C5 sessions only (stopped sessions are exposures, never counted). Not an appointment schedule, quota, exercise-selection or progression rule; never creates sessions or advances the Sequence. Weekly metrics are derived from rehab_sessions; no counter is stored.';
COMMENT ON COLUMN prescription_versions.target_sessions_per_week IS
  'Immutable published copy of prescription_drafts.target_sessions_per_week. Same semantics: the Sequence-mode Mon-Sun Y in "X / Y completed sessions this week" (X = FINISHED sessions).';
COMMENT ON COLUMN prescription_templates.target_sessions_per_week IS
  'Template-authored default for prescription_drafts.target_sessions_per_week. Same semantics.';

-- -----------------------------------------------------------------------------
-- 3. Stage / irritability — contextual, not required.
--    The M5 NOT NULLs made these mandatory on every version. Dropping them
--    removes the schema-level requirement only; no value is changed or
--    invented. (publish_prescription_draft still carries the prior values
--    forward and validate_prescription_draft still reports
--    has_prior_clinical_state — removing that publication rule is part of
--    the C5.6C publish rework.)
-- -----------------------------------------------------------------------------
ALTER TABLE prescription_versions
  ALTER COLUMN stage DROP NOT NULL,
  ALTER COLUMN irritability DROP NOT NULL,
  ALTER COLUMN is_insertional DROP NOT NULL;

COMMENT ON COLUMN prescription_versions.stage IS
  'Clinician-facing contextual classification only (historical, preserved). Optional. Never selects exercises, dosage, schedule, recovery, Sequence or progression, and is never read by the C5 patient runtime. New classifications belong in clinical_classifications.';
COMMENT ON COLUMN prescription_versions.irritability IS
  'Clinician-facing contextual classification only (historical, preserved). Optional; never a runtime input. New classifications belong in clinical_classifications.';

-- Append-only clinician classification record, decoupled from prescription
-- versions. Not backfilled: the existing per-version values are carry-forward
-- copies, not classification events, and remain readable where they are.
CREATE TABLE clinical_classifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stage              INTEGER NULL CHECK (stage IS NULL OR stage >= 1),
  irritability       rehab_irritability NULL,
  is_insertional     BOOLEAN NULL,
  classified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  classified_by      UUID NOT NULL REFERENCES auth.users(id),
  supersedes_id      UUID NULL UNIQUE REFERENCES clinical_classifications(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT clinical_classifications_has_content CHECK (
    stage IS NOT NULL OR irritability IS NOT NULL OR is_insertional IS NOT NULL
  ),
  CONSTRAINT clinical_classifications_not_self_superseding CHECK (supersedes_id <> id)
);

CREATE INDEX idx_clinical_classifications_patient ON clinical_classifications (patient_id, classified_at DESC);

COMMENT ON TABLE clinical_classifications IS
  'Append-only clinician-facing contextual classification (stage / irritability / insertional status). Context only: never an input to exercise selection, dosage, scheduling, recovery, Sequence, progression or publication. Not visible to the patient runtime. Historical pre-C5.6 values remain in prescription_versions.';

ALTER TABLE clinical_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON clinical_classifications FROM anon, authenticated;
GRANT SELECT ON clinical_classifications TO authenticated;

CREATE POLICY "clinical_classifications: clinician read assigned patient"
  ON clinical_classifications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = clinical_classifications.patient_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

-- -----------------------------------------------------------------------------
-- 4. notifications — pause/resume events (in-app only). Events, never the
--    runtime source of truth. Typed nullable FK, matching the existing
--    pattern (never a generic entity_type/entity_id).
-- -----------------------------------------------------------------------------
ALTER TABLE notifications
  ADD COLUMN patient_prescription_id UUID NULL REFERENCES patient_prescriptions(id);

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check CHECK (type IN (
    'prescription_published', 'prescription_updated', 'prescription_paused', 'prescription_resumed'
  )),
  ADD CONSTRAINT notifications_pause_ref_required CHECK (
    type NOT IN ('prescription_paused', 'prescription_resumed') OR patient_prescription_id IS NOT NULL
  );

COMMENT ON COLUMN notifications.patient_prescription_id IS
  'Required for prescription_paused / prescription_resumed. The runtime reads patient_prescriptions.operational_status, never this notification, to decide behavior.';

-- -----------------------------------------------------------------------------
-- 5. Retire prescription_sequence_state.
--    Dependencies (verified before writing this migration): 0 rows; no view,
--    policy or FK elsewhere references it; the only function referencing it
--    is publish_prescription_draft; no application code reads it (only
--    verification-script teardown).
--
--    publish_prescription_draft — CREATE OR REPLACE. The ONLY change from
--    20261010000001 is removal of the prescription_sequence_state
--    upsert/delete block (and its now-unused v_first_workout_id variable).
--    Every other line is byte-identical; the C5.4D fingerprint/lock/side-
--    effect rework is deliberately left to C5.6C.
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

  UPDATE prescription_drafts SET status = 'published', updated_at = now(), updated_by = p_clinician_id WHERE id = p_draft_id;

  v_notification_type := CASE WHEN v_is_first THEN 'prescription_published' ELSE 'prescription_updated' END;
  INSERT INTO notifications (patient_id, type, prescription_version_id) VALUES (v_pp.patient_id, v_notification_type, v_new_version_id);

  RETURN v_new_version_id;
END;
$$;
REVOKE ALL ON FUNCTION publish_prescription_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;

DROP TABLE prescription_sequence_state;
