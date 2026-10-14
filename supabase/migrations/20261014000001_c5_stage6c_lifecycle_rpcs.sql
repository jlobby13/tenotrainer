-- =============================================================================
-- C5, Stage 6C — authoritative C5 training lifecycle.
--
-- Adds the server/database lifecycle the future C5 patient UI will call:
-- shared structural Sequence helper, ONE Start-eligibility path, atomic
-- first-performance Start, performance writes, Finish/Stop with response
-- obligations, Pause/Resume notifications, and the C5.4D publish debt
-- (fingerprint TOCTOU, recovery_days copy, stage/irritability decoupling).
--
-- Authority model: every C5 lifecycle RPC is SECURITY DEFINER, pinned
-- search_path, EXECUTE granted to service_role only. The patient id comes
-- from the trusted server layer (the future C5 patient API routes behind the
-- C5 runtime gate), never from a patient over PostgREST, so the C5 runtime
-- stays unreachable while gated OFF. Legacy runtime paths are untouched.
--
-- Shared lock: patient_prescriptions row. Start (FOR UPDATE), Pause, Resume
-- and Publish (FOR UPDATE, after the draft row), Finish/Stop (FOR SHARE,
-- then the session row). Nothing takes a draft row after the prescription
-- row, and Start never locks session rows, so no lock-order cycle exists.
--
-- No applied migration is edited; replaced functions are CREATE OR REPLACE
-- copies whose changes are listed per section.
-- =============================================================================

-- =============================================================================
-- 1. Shared structural Sequence helper (founder-locked at C5.6B approval).
--    Given an immutable version and a workout OF that version, return the
--    next workout in the version's defined order, wrapping to the first after
--    the last (a single-workout version returns that same workout). NULL if
--    the workout does not belong to the version. PURELY STRUCTURAL: reads
--    prescription_workouts only — never patient, pause, safety, response,
--    schedule or eligibility state. Used by BOTH the rehab_sessions guard
--    trigger and the C5 Sequence derivation (c5_sequence_state).
-- =============================================================================
CREATE OR REPLACE FUNCTION c5_next_workout_id(p_version_id UUID, p_workout_id UUID)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w2.id
  FROM prescription_workouts w1
  JOIN prescription_workouts w2 ON w2.prescription_version_id = w1.prescription_version_id
  WHERE w1.id = p_workout_id AND w1.prescription_version_id = p_version_id
  ORDER BY (w2.order_index <= w1.order_index), w2.order_index
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION c5_next_workout_id(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Guard trigger — CREATE OR REPLACE. The ONLY change from 20261013000001 is
-- that the Sequence-choice consistency check now uses c5_next_workout_id
-- instead of its own inline order_index arithmetic.
CREATE OR REPLACE FUNCTION trg_rehab_sessions_c5_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_version RECORD;
  v_stopped RECORD;
  v_next UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.training_status IS NULL THEN
      IF NEW.training_status IS NOT NULL THEN
        RAISE EXCEPTION 'C5_LEGACY_ROW_CANNOT_BECOME_C5' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;

    -- Columns that may change after creation. While STARTED: closure fields.
    -- Always: the server-derived escalation mirror and updated_at.
    IF OLD.training_status <> 'started' THEN
      IF (to_jsonb(NEW) - 'current_escalation_level' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'current_escalation_level' - 'updated_at') THEN
        RAISE EXCEPTION 'C5_SESSION_TERMINAL_IMMUTABLE' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - 'current_escalation_level' - 'updated_at' - 'training_status' - 'training_closed_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'current_escalation_level' - 'updated_at' - 'training_status' - 'training_closed_at') THEN
      RAISE EXCEPTION 'C5_SESSION_IDENTITY_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  IF NEW.training_status IS NULL THEN RETURN NEW; END IF;

  IF NEW.training_status <> 'started' THEN
    RAISE EXCEPTION 'C5_SESSION_MUST_START_STARTED' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.patient_timezone) THEN
    RAISE EXCEPTION 'C5_INVALID_PATIENT_TIMEZONE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.patient_local_date IS DISTINCT FROM (NEW.started_at AT TIME ZONE NEW.patient_timezone)::date THEN
    RAISE EXCEPTION 'C5_LOCAL_DATE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  SELECT pv.user_id, pv.patient_prescription_id, pv.published_at, pv.scheduling_mode
    INTO v_version
  FROM prescription_versions pv WHERE pv.id = NEW.prescription_version_id;
  IF v_version.patient_prescription_id IS NULL OR v_version.published_at IS NULL THEN
    RAISE EXCEPTION 'C5_VERSION_NOT_PUBLISHED_C5' USING ERRCODE = 'P0001';
  END IF;
  IF v_version.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'C5_VERSION_NOT_OWNED_BY_PATIENT' USING ERRCODE = 'P0001';
  END IF;

  IF (v_version.scheduling_mode = 'calendar') <> (NEW.calendar_scheduled_date IS NOT NULL) THEN
    RAISE EXCEPTION 'C5_CALENDAR_DATE_MODE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.sequence_choice IS NOT NULL THEN
    IF v_version.scheduling_mode IS DISTINCT FROM 'sequence' THEN
      RAISE EXCEPTION 'C5_SEQUENCE_CHOICE_MODE_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_stopped FROM rehab_sessions WHERE id = NEW.resolves_stopped_session_id;
    IF v_stopped.user_id IS DISTINCT FROM NEW.user_id
       OR v_stopped.training_status NOT IN ('stopped_early', 'stopped_pause', 'stopped_acute')
       OR v_stopped.prescription_version_id IS DISTINCT FROM NEW.prescription_version_id
       OR v_stopped.started_at >= NEW.started_at THEN
      RAISE EXCEPTION 'C5_INVALID_STOPPED_SESSION_RESOLUTION' USING ERRCODE = 'P0001';
    END IF;

    -- Structural consistency of the recorded choice only, via the shared
    -- helper. Whether the patient was ELIGIBLE to make the choice is decided
    -- by the lifecycle RPCs, never here.
    v_next := c5_next_workout_id(NEW.prescription_version_id, v_stopped.prescription_workout_id);
    IF NEW.sequence_choice = 'single_workout_auto' THEN
      IF v_next IS DISTINCT FROM v_stopped.prescription_workout_id THEN
        RAISE EXCEPTION 'C5_SINGLE_WORKOUT_AUTO_REQUIRES_ONE_WORKOUT' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.prescription_workout_id IS DISTINCT FROM v_stopped.prescription_workout_id THEN
        RAISE EXCEPTION 'C5_REPEAT_PREVIOUS_WORKOUT_MISMATCH' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_next = v_stopped.prescription_workout_id THEN
      RAISE EXCEPTION 'C5_SINGLE_WORKOUT_MUST_USE_AUTO' USING ERRCODE = 'P0001';
    ELSIF NEW.sequence_choice = 'repeat_previous' AND NEW.prescription_workout_id IS DISTINCT FROM v_stopped.prescription_workout_id THEN
      RAISE EXCEPTION 'C5_REPEAT_PREVIOUS_WORKOUT_MISMATCH' USING ERRCODE = 'P0001';
    ELSIF NEW.sequence_choice = 'advance_next' AND NEW.prescription_workout_id IS DISTINCT FROM v_next THEN
      RAISE EXCEPTION 'C5_ADVANCE_NEXT_WORKOUT_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_rehab_sessions_c5_guard() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 2. A committed C5 session always carries actual performed work. Deferred to
--    commit so the first-performance transaction can insert the session and
--    then its first unit. Backstop only: c5_record_first_performance inserts
--    both atomically, and c5_edit_performance never turns a completed unit
--    into a skip.
-- =============================================================================
CREATE OR REPLACE FUNCTION trg_rehab_sessions_c5_has_performance()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.training_status IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM set_outcomes WHERE rehab_session_id = NEW.id AND outcome = 'completed'
  ) THEN
    RAISE EXCEPTION 'C5_SESSION_WITHOUT_PERFORMANCE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION trg_rehab_sessions_c5_has_performance() FROM PUBLIC, anon, authenticated;

CREATE CONSTRAINT TRIGGER trg_rehab_sessions_c5_has_performance
  AFTER INSERT ON rehab_sessions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_rehab_sessions_c5_has_performance();

-- =============================================================================
-- 3. Morning response reference (founder-locked 2026-10-13, replacing the
--    C5.6A "morning after the closure date" wording):
--      scheduled_eligible_at (due) = max((start_local_date + 1) @ reminder,
--                                        first reminder strictly after closure)
--      reference_local_date        = the patient-local date of that due
--                                    instant — the EFFECTIVE reference morning.
--    Delay / retrospective status derive from scheduled_eligible_at,
--    reference_local_date and submitted_at; nothing is fabricated.
-- =============================================================================
ALTER TABLE morning_responses ADD COLUMN reference_local_date DATE NULL;
ALTER TABLE morning_responses
  ADD CONSTRAINT morning_responses_reference_requires_due CHECK (reference_local_date IS NULL OR scheduled_eligible_at IS NOT NULL);
COMMENT ON COLUMN morning_responses.reference_local_date IS
  'C5: the effective reference morning (patient-local date of scheduled_eligible_at) the response is about. For a session left open across a morning, this is the first morning AFTER closure, never an earlier morning asked about retrospectively. Required on C5 rows; NULL on legacy rows.';
COMMENT ON COLUMN morning_responses.scheduled_eligible_at IS
  'Due instant. C5: max((start_local_date + 1) @ reminder time, first reminder time strictly after training closure) — c5_morning_due_at(). Never due while the session is STARTED. Frozen once set.';

-- Guard — CREATE OR REPLACE; adds the C5 reference requirement only.
CREATE OR REPLACE FUNCTION trg_morning_responses_c5_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session RECORD;
BEGIN
  SELECT user_id, training_status INTO v_session FROM rehab_sessions WHERE id = NEW.rehab_session_id;
  IF v_session.training_status IS NULL THEN RETURN NEW; END IF;  -- legacy parent: unchanged

  IF v_session.training_status = 'started' THEN
    RAISE EXCEPTION 'C5_RESPONSE_REQUIRES_CLOSED_C5_SESSION' USING ERRCODE = 'P0001';
  END IF;
  IF v_session.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'C5_RESPONSE_USER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.scheduled_eligible_at IS NULL OR NEW.reference_local_date IS NULL THEN
    RAISE EXCEPTION 'C5_MORNING_REFERENCE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.submitted_at IS NOT NULL AND NEW.resolution IS NULL THEN
    RAISE EXCEPTION 'C5_MORNING_RESOLUTION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'C5_RESPONSE_RESOLVED_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_morning_responses_c5_guard() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 4. Pause / Resume. Both already take patient_prescriptions FOR UPDATE (the
--    same row Publish and C5 Start lock). Added: the in-app notification and
--    an append-only pause-period record (needed so a scheduled Calendar day
--    that fell inside a pause is never treated as a miss or later make-up —
--    patient_prescriptions keeps only the latest pause timestamps).
--    Pause NEVER touches sessions: a STARTED session stays usable and is only
--    closed by an explicit patient Finish / Stop.
-- =============================================================================
CREATE TABLE prescription_pause_periods (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_prescription_id  UUID NOT NULL REFERENCES patient_prescriptions(id) ON DELETE CASCADE,
  paused_at                TIMESTAMPTZ NOT NULL,
  paused_by                UUID NULL REFERENCES auth.users(id),
  resumed_at               TIMESTAMPTZ NULL,
  resumed_by               UUID NULL REFERENCES auth.users(id),
  CONSTRAINT prescription_pause_periods_order CHECK (resumed_at IS NULL OR resumed_at >= paused_at)
);
CREATE UNIQUE INDEX prescription_pause_periods_one_open
  ON prescription_pause_periods (patient_prescription_id) WHERE resumed_at IS NULL;
COMMENT ON TABLE prescription_pause_periods IS
  'Append-only history of clinician pauses (written only by pause_prescription / resume_prescription). Source for "scheduled day overlapped a pause" in C5 Calendar eligibility. Pre-C5.6C pauses are known only if still open (backfilled below); earlier closed pauses were never recorded.';
ALTER TABLE prescription_pause_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON prescription_pause_periods FROM anon, authenticated;
GRANT SELECT ON prescription_pause_periods TO authenticated;
CREATE POLICY "prescription_pause_periods: clinician read" ON prescription_pause_periods FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM patient_prescriptions pp JOIN supervisor_patients sp ON sp.patient_id = pp.patient_id
    WHERE pp.id = prescription_pause_periods.patient_prescription_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
  ));

INSERT INTO prescription_pause_periods (patient_prescription_id, paused_at, paused_by)
SELECT id, paused_at, paused_by FROM patient_prescriptions WHERE operational_status = 'paused';

CREATE OR REPLACE FUNCTION pause_prescription(p_patient_prescription_id UUID, p_clinician_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  INSERT INTO prescription_pause_periods (patient_prescription_id, paused_at, paused_by)
  VALUES (p_patient_prescription_id, now(), p_clinician_id);
  INSERT INTO notifications (patient_id, type, patient_prescription_id)
  VALUES (v_pp.patient_id, 'prescription_paused', p_patient_prescription_id);
END;
$$;
REVOKE ALL ON FUNCTION pause_prescription(UUID, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION resume_prescription(p_patient_prescription_id UUID, p_clinician_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  UPDATE prescription_pause_periods SET resumed_at = now(), resumed_by = p_clinician_id
  WHERE patient_prescription_id = p_patient_prescription_id AND resumed_at IS NULL;
  INSERT INTO notifications (patient_id, type, patient_prescription_id)
  VALUES (v_pp.patient_id, 'prescription_resumed', p_patient_prescription_id);
END;
$$;
REVOKE ALL ON FUNCTION resume_prescription(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 5. C5.4D debt #1 — expectedFingerprint TOCTOU. A monotonic per-draft
--    content revision is bumped by every draft content write (inside the
--    existing draft-content lock function, which already takes the draft row
--    FOR SHARE) and by every fingerprint-relevant draft-row change. Review
--    hands the revision out with its fingerprint; publish verifies it INSIDE
--    its transaction after taking the draft row FOR UPDATE, so no content
--    write can land between the check and the copy.
--    A separate table (not a draft column) so content writes do not touch
--    prescription_drafts.updated_at, which publication reconciliation reads.
-- =============================================================================
CREATE TABLE prescription_draft_content_revisions (
  prescription_draft_id UUID PRIMARY KEY REFERENCES prescription_drafts(id) ON DELETE CASCADE,
  revision              BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE prescription_draft_content_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON prescription_draft_content_revisions FROM anon, authenticated;
COMMENT ON TABLE prescription_draft_content_revisions IS
  'Monotonic draft content revision (missing row = 0). Bumped by every draft content/metadata write; checked by publish_prescription_draft inside its locked transaction (C5.4D expectedFingerprint TOCTOU fix).';

CREATE OR REPLACE FUNCTION bump_prescription_draft_revisions(p_draft_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_draft_ids IS NULL OR cardinality(p_draft_ids) = 0 THEN RETURN; END IF;
  -- Only drafts that still exist (a cascading draft delete must not fail).
  INSERT INTO prescription_draft_content_revisions (prescription_draft_id, revision)
  SELECT d.id, 1 FROM prescription_drafts d WHERE d.id = ANY(p_draft_ids) ORDER BY d.id
  ON CONFLICT (prescription_draft_id) DO UPDATE SET revision = prescription_draft_content_revisions.revision + 1;
END;
$$;
REVOKE ALL ON FUNCTION bump_prescription_draft_revisions(UUID[]) FROM PUBLIC, anon, authenticated;

-- lock_prescription_drafts_for_content_write — CREATE OR REPLACE: unchanged
-- FOR SHARE lock, plus the revision bump.
CREATE OR REPLACE FUNCTION lock_prescription_drafts_for_content_write(p_draft_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_draft_ids IS NULL OR cardinality(p_draft_ids) = 0 THEN RETURN; END IF;
  -- Fixed order, so two drafts are never locked in opposite orders.
  PERFORM 1 FROM prescription_drafts WHERE id = ANY(p_draft_ids) ORDER BY id FOR SHARE;
  PERFORM bump_prescription_draft_revisions(p_draft_ids);
END;
$$;
REVOKE ALL ON FUNCTION lock_prescription_drafts_for_content_write(UUID[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION trg_prescription_drafts_bump_revision()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM bump_prescription_draft_revisions(ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION trg_prescription_drafts_bump_revision() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_prescription_drafts_bump_revision
  AFTER UPDATE ON prescription_drafts
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.editing_clinician_id IS DISTINCT FROM NEW.editing_clinician_id
    OR OLD.stale_base_prescription_version_id IS DISTINCT FROM NEW.stale_base_prescription_version_id
    OR OLD.phase IS DISTINCT FROM NEW.phase
    OR OLD.scheduling_mode IS DISTINCT FROM NEW.scheduling_mode
    OR OLD.target_sessions_per_week IS DISTINCT FROM NEW.target_sessions_per_week
    OR OLD.recovery_days IS DISTINCT FROM NEW.recovery_days
  )
  EXECUTE FUNCTION trg_prescription_drafts_bump_revision();

-- Read path for Review (service_role): the draft's current revision.
CREATE OR REPLACE FUNCTION get_prescription_draft_revision(p_draft_id UUID)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT revision FROM prescription_draft_content_revisions WHERE prescription_draft_id = p_draft_id), 0);
$$;
REVOKE ALL ON FUNCTION get_prescription_draft_revision(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_prescription_draft_revision(UUID) TO service_role;

-- =============================================================================
-- 6. Stage / irritability decoupled from publication (C5.6A). The
--    has_prior_clinical_state rule is removed: absence of a prior
--    stage/irritability record no longer blocks publication. Every other rule
--    is byte-identical to 20261010000001. (Publish still carries any prior
--    values forward as clinician context; they may now be NULL.)
-- =============================================================================
CREATE OR REPLACE FUNCTION validate_prescription_draft(p_draft_id UUID)
RETURNS TABLE(rule TEXT, passed BOOLEAN, detail TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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

-- =============================================================================
-- 7. publish_prescription_draft — replaced (new optional 3rd argument, so the
--    2-argument overload is dropped; existing named-argument callers resolve
--    to the new function via the DEFAULT). Changes from 20261013000002:
--      - p_expected_revision verified under the draft FOR UPDATE lock;
--      - recovery_days copied into the immutable version;
--      - pinned search_path.
--    Lock order is unchanged: draft row FOR UPDATE, then patient_prescriptions
--    FOR UPDATE. Pause/Resume/C5 Start lock only patient_prescriptions, and
--    nothing locks patient_prescriptions before a draft row, so no cycle.
--    Side effects (version insert, content copy, current pointer, draft
--    status, notification) all commit or roll back together, as before.
-- =============================================================================
DROP FUNCTION publish_prescription_draft(UUID, UUID);
CREATE FUNCTION publish_prescription_draft(p_draft_id UUID, p_clinician_id UUID, p_expected_revision BIGINT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- C5.4D TOCTOU fix: the reviewed revision is verified while the draft row
  -- is held FOR UPDATE, so validation and the content copy below run against
  -- exactly the content the clinician reviewed.
  IF p_expected_revision IS NOT NULL
     AND p_expected_revision IS DISTINCT FROM get_prescription_draft_revision(p_draft_id) THEN
    RAISE EXCEPTION 'DRAFT_CHANGED' USING ERRCODE = 'P0001';
  END IF;

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
    target_sessions_per_week, recovery_days
  ) VALUES (
    v_pp.patient_id, v_prior.stage, v_prior.irritability, v_prior.is_insertional, 'clinician_change',
    v_pp.id, v_version_number, now(), p_clinician_id, v_draft.phase, v_draft.scheduling_mode,
    v_draft.target_sessions_per_week, v_draft.recovery_days
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
REVOKE ALL ON FUNCTION publish_prescription_draft(UUID, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_prescription_draft(UUID, UUID, BIGINT) TO service_role;

-- =============================================================================
-- 8. create_prescription_draft — CREATE OR REPLACE. Only change from
--    20260927000001: recovery_days is copied on clone (a pre-C5.6B version
--    with NULL = none authored becomes 0 = None) and from templates.
-- =============================================================================
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
      target_sessions_per_week = pv.target_sessions_per_week,
      recovery_days = COALESCE(pv.recovery_days, 0)
    FROM prescription_versions pv WHERE pv.id = p_source_version_id AND d.id = v_draft_id;
  ELSIF p_source = 'from_template' THEN
    PERFORM copy_template_content_into_draft(p_template_id, v_draft_id);
    UPDATE prescription_drafts d SET
      phase = pt.phase,
      scheduling_mode = pt.scheduling_mode,
      target_sessions_per_week = pt.target_sessions_per_week,
      recovery_days = pt.recovery_days
    FROM prescription_templates pt WHERE pt.id = p_template_id AND d.id = v_draft_id;
  END IF;

  RETURN v_draft_id;
END;
$$;
REVOKE ALL ON FUNCTION create_prescription_draft(UUID, UUID, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 9-pre. reconcile_missing_acute_episodes — CREATE OR REPLACE. Two changes
--    from 20260911000005, nothing else:
--      - the acute findings snapshot reads the C5 immediate response for a C5
--        session (C5 rows carry no rehab_sessions safety columns; legacy rows
--        have no session_immediate_responses row, so COALESCE is exact);
--      - the trusted server (service_role) may reconcile on a patient's
--        behalf, as the C5 API layer must do in its own committed
--        transaction before calling c5_record_first_performance.
--    Legacy authenticated behavior is unchanged.
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
  IF p_user_id IS DISTINCT FROM auth.uid() AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  FOR v_orphan IN
    SELECT ee.id AS escalation_id, ee.escalation_level, ee.evaluated_at,
           rs.id AS session_id,
           COALESCE(rs.sudden_or_sharp_pain, sir.sudden_or_sharp_pain) AS sudden_or_sharp_pain,
           COALESCE(rs.new_functional_difficulty, sir.new_functional_difficulty) AS new_functional_difficulty,
           COALESCE(rs.pop_felt_or_heard, sir.pop_felt_or_heard) AS pop_felt_or_heard
    FROM escalation_evaluations ee
    JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    LEFT JOIN session_immediate_responses sir ON sir.rehab_session_id = rs.id
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
GRANT EXECUTE ON FUNCTION reconcile_missing_acute_episodes(UUID) TO service_role;

-- =============================================================================
-- 9. C5 runtime internals.
--    All functions below are SECURITY DEFINER with a pinned search_path and
--    are executable by service_role ONLY. The patient id is supplied by the
--    trusted server layer (the future C5 patient API routes, which derive it
--    from the authenticated session behind the C5 runtime gate) — never by a
--    patient over PostgREST. While the C5 patient runtime is gated OFF no
--    patient can reach any of these.
--
--    Result convention: every lifecycle RPC returns JSONB
--    { "result": <stable code>, ... }. Business rejections are RETURNED,
--    never raised, so any side effect that must persist (an acute-brake
--    blocked-opportunity record) commits. Only programming/authorization
--    faults raise.
-- =============================================================================

-- 9a. Morning-response due instant (founder-locked 2026-10-13):
--     due = max( (start_local_date + 1) @ reminder,
--                first reminder instant strictly after training closure ).
--     Pure; no patient state.
CREATE OR REPLACE FUNCTION c5_morning_due_at(
  p_start_local_date DATE, p_closed_at TIMESTAMPTZ, p_timezone TEXT, p_reminder TIME
) RETURNS TIMESTAMPTZ LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_intended TIMESTAMPTZ := ((p_start_local_date + 1) + p_reminder) AT TIME ZONE p_timezone;
  v_close_date DATE := (p_closed_at AT TIME ZONE p_timezone)::date;
  v_after_close TIMESTAMPTZ := (v_close_date + p_reminder) AT TIME ZONE p_timezone;
BEGIN
  IF v_after_close <= p_closed_at THEN
    v_after_close := ((v_close_date + 1) + p_reminder) AT TIME ZONE p_timezone;
  END IF;
  RETURN GREATEST(v_intended, v_after_close);
END;
$$;
REVOKE ALL ON FUNCTION c5_morning_due_at(DATE, TIMESTAMPTZ, TEXT, TIME) FROM PUBLIC, anon, authenticated;

-- 9b. Immutable session snapshot, built server-side from published content.
--     Active exercises only (a paused exercise is not prescribed for the
--     session). No stage/irritability: they are not runtime inputs.
CREATE OR REPLACE FUNCTION c5_build_session_snapshot(p_version_id UUID, p_workout_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'snapshot_version', 1,
    'prescription_version_id', pv.id,
    'version_number', pv.version_number,
    'scheduling_mode', pv.scheduling_mode,
    'target_sessions_per_week', pv.target_sessions_per_week,
    'recovery_days', pv.recovery_days,
    'workout', jsonb_build_object('id', pw.id, 'label', pw.label, 'order_index', pw.order_index, 'days_of_week', to_jsonb(pw.days_of_week)),
    'exercises', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'exercise_id', pe.id::text,
        'canonical_exercise_id', pe.canonical_exercise_id,
        'name', ce.name,
        'order_index', pe.order_index,
        'additional_instructions', pe.additional_instructions,
        'dosage', to_jsonb(ped) - 'id' - 'prescription_exercise_id' - 'created_at' - 'updated_at'
      ) ORDER BY pe.order_index)
      FROM prescription_exercises pe
      JOIN canonical_exercises ce ON ce.id = pe.canonical_exercise_id
      JOIN prescription_exercise_dosage ped ON ped.prescription_exercise_id = pe.id
      WHERE pe.prescription_workout_id = pw.id AND pe.status = 'active'
    ), '[]'::jsonb)
  )
  FROM prescription_versions pv
  JOIN prescription_workouts pw ON pw.prescription_version_id = pv.id AND pw.id = p_workout_id
  WHERE pv.id = p_version_id;
$$;
REVOKE ALL ON FUNCTION c5_build_session_snapshot(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- 9c. Validate one performance unit against the frozen snapshot. Returns
--     NULL when valid, else a stable error detail code.
--     p_perf: { exercise_id, unit_index, outcome ('completed'|'skipped'),
--               actual_reps, actual_load, actual_load_unit,
--               actual_duration_seconds, actual_distance_m }
--     A unit is a set / round / bout: units = COALESCE(sets, interval_rounds, 1).
--     Primary quantity by dosage_type: repetition|contact -> actual_reps;
--     hold|time -> actual_duration_seconds; a prescribed distance dimension
--     also accepts actual_distance_m.
CREATE OR REPLACE FUNCTION c5_performance_error(p_snapshot JSONB, p_perf JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_ex JSONB;
  v_d JSONB;
  v_type TEXT;
  v_units INTEGER;
  v_index INTEGER;
  v_outcome TEXT := p_perf->>'outcome';
  v_reps NUMERIC;
  v_load NUMERIC;
  v_unit TEXT := p_perf->>'actual_load_unit';
  v_dur NUMERIC;
  v_dist NUMERIC;
  v_has_distance BOOLEAN;
BEGIN
  IF jsonb_typeof(p_perf) IS DISTINCT FROM 'object' THEN RETURN 'performance_malformed'; END IF;
  SELECT e INTO v_ex FROM jsonb_array_elements(p_snapshot->'exercises') e WHERE e->>'exercise_id' = p_perf->>'exercise_id';
  IF v_ex IS NULL THEN RETURN 'exercise_not_in_session'; END IF;
  v_d := v_ex->'dosage';
  v_type := v_d->>'dosage_type';
  v_units := COALESCE((v_d->>'sets')::INTEGER, (v_d->>'interval_rounds')::INTEGER, 1);

  BEGIN
    v_index := (p_perf->>'unit_index')::INTEGER;
    v_reps := (p_perf->>'actual_reps')::NUMERIC;
    v_load := (p_perf->>'actual_load')::NUMERIC;
    v_dur := (p_perf->>'actual_duration_seconds')::NUMERIC;
    v_dist := (p_perf->>'actual_distance_m')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'performance_malformed';
  END;
  IF v_index IS NULL OR v_index < 0 OR v_index >= v_units THEN RETURN 'unit_index_out_of_range'; END IF;

  IF v_outcome = 'skipped' THEN
    IF v_reps IS NOT NULL OR v_load IS NOT NULL OR v_unit IS NOT NULL OR v_dur IS NOT NULL OR v_dist IS NOT NULL THEN
      RETURN 'skip_has_quantities';
    END IF;
    RETURN NULL;
  END IF;
  IF v_outcome IS DISTINCT FROM 'completed' THEN RETURN 'invalid_outcome'; END IF;

  IF (v_reps IS NOT NULL AND v_reps < 0) OR (v_load IS NOT NULL AND v_load < 0)
     OR (v_dur IS NOT NULL AND v_dur <= 0) OR (v_dist IS NOT NULL AND v_dist <= 0) THEN
    RETURN 'quantity_out_of_range';
  END IF;
  IF v_load IS NOT NULL AND (v_unit IS NULL OR v_unit NOT IN ('kg', 'lb')) THEN RETURN 'load_unit_required'; END IF;
  IF v_load IS NULL AND v_unit IS NOT NULL THEN RETURN 'load_unit_without_load'; END IF;

  v_has_distance := v_d->>'distance_mode' IS NOT NULL;
  IF v_dist IS NOT NULL AND NOT v_has_distance THEN RETURN 'distance_not_prescribed'; END IF;

  IF NOT (
    (v_type IN ('repetition', 'contact') AND COALESCE(v_reps, 0) > 0)
    OR (v_type IN ('hold', 'time') AND COALESCE(v_dur, 0) > 0)
    OR (v_has_distance AND COALESCE(v_dist, 0) > 0)
  ) THEN
    RETURN 'primary_quantity_required';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION c5_performance_error(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- 9d. Acute-safety brake as seen by the C5 lifecycle. Reuses the existing
--     authoritative brake (get_patient_acute_brake_status) unchanged, and
--     fails closed if an escalation that should have produced an episode has
--     not yet been reconciled (reconcile_missing_acute_episodes must run in
--     its own committed transaction first — 20260911000005).
--     Returns NULL when no brake, else 'acute_safety_review_required' |
--     'acute_safety_professional_review_required' |
--     'acute_safety_reconciliation_required'.
CREATE OR REPLACE FUNCTION c5_acute_gate(p_user_id UUID, OUT o_code TEXT, OUT o_episode_id UUID, OUT o_level SMALLINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_brake RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM escalation_evaluations ee
    JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    WHERE rs.user_id = p_user_id AND ee.escalation_level IN (3, 5)
      AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes ase WHERE ase.source_escalation_evaluation_id = ee.id)
  ) THEN
    o_code := 'acute_safety_reconciliation_required';
    RETURN;
  END IF;
  SELECT * INTO v_brake FROM get_patient_acute_brake_status(p_user_id);
  IF FOUND THEN
    o_episode_id := v_brake.episode_id;
    o_level := v_brake.effective_level;
    o_code := CASE WHEN v_brake.effective_level >= 4 THEN 'acute_safety_professional_review_required' ELSE 'acute_safety_review_required' END;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION c5_acute_gate(UUID) FROM PUBLIC, anon, authenticated;

-- 9e. Derived Sequence state for a version (no mutable pointer). Uses the
--     shared structural helper c5_next_workout_id for every "next".
--     { "state": "first" | "next" | "pending_choice",
--       "workout_id", "stopped_session_id", "repeat_workout_id",
--       "advance_workout_id", "single_workout" }
--     A STARTED latest session is handled by the caller (resume) before
--     this is consulted.
CREATE OR REPLACE FUNCTION c5_sequence_state(p_user_id UUID, p_version_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_last RECORD;
  v_next UUID;
BEGIN
  SELECT id, training_status, prescription_workout_id INTO v_last
  FROM rehab_sessions
  WHERE user_id = p_user_id AND prescription_version_id = p_version_id AND training_status IS NOT NULL
  ORDER BY started_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'first', 'workout_id',
      (SELECT id FROM prescription_workouts WHERE prescription_version_id = p_version_id ORDER BY order_index LIMIT 1));
  END IF;

  v_next := c5_next_workout_id(p_version_id, v_last.prescription_workout_id);
  IF v_last.training_status = 'finished' THEN
    RETURN jsonb_build_object('state', 'next', 'workout_id', v_next);
  END IF;
  IF v_last.training_status = 'started' THEN
    RETURN jsonb_build_object('state', 'started', 'session_id', v_last.id);
  END IF;
  RETURN jsonb_build_object(
    'state', 'pending_choice',
    'stopped_session_id', v_last.id,
    'repeat_workout_id', v_last.prescription_workout_id,
    'advance_workout_id', v_next,
    'single_workout', v_next = v_last.prescription_workout_id
  );
END;
$$;
REVOKE ALL ON FUNCTION c5_sequence_state(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- 9f. Calendar opportunity for patient-local date p_today.
--     Today's scheduled workout takes precedence. Otherwise the only
--     possible make-up is the most recent scheduled date D before today
--     (today being unscheduled means the next scheduled workout is not yet
--     due, so D is still inside its make-up window). D is NOT actionable if:
--     it was already FINISHED; it predates the current version's
--     publication (new version voids old make-ups); or it overlapped a
--     pause (not a patient miss, never a later make-up). Weekdays: 0 =
--     Sunday (EXTRACT(DOW)), matching prescription_workouts.days_of_week.
CREATE OR REPLACE FUNCTION c5_calendar_opportunity(
  p_user_id UUID, p_pp_id UUID, p_version_id UUID, p_today DATE, p_timezone TEXT
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_workout UUID;
  v_d DATE;
  v_published_local DATE;
BEGIN
  SELECT id INTO v_workout FROM prescription_workouts
  WHERE prescription_version_id = p_version_id
    AND EXTRACT(DOW FROM p_today)::SMALLINT = ANY(days_of_week);
  IF v_workout IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'scheduled_today', 'workout_id', v_workout, 'calendar_scheduled_date', p_today);
  END IF;

  FOR i IN 1..6 LOOP
    v_d := p_today - i;
    SELECT id INTO v_workout FROM prescription_workouts
    WHERE prescription_version_id = p_version_id
      AND EXTRACT(DOW FROM v_d)::SMALLINT = ANY(days_of_week);
    EXIT WHEN v_workout IS NOT NULL;
  END LOOP;
  IF v_workout IS NULL THEN RETURN jsonb_build_object('state', 'not_scheduled'); END IF;

  SELECT (published_at AT TIME ZONE p_timezone)::date INTO v_published_local FROM prescription_versions WHERE id = p_version_id;
  IF v_d < v_published_local THEN RETURN jsonb_build_object('state', 'not_scheduled'); END IF;

  IF EXISTS (
    SELECT 1 FROM prescription_pause_periods pp
    WHERE pp.patient_prescription_id = p_pp_id
      AND pp.paused_at < ((v_d + 1)::timestamp AT TIME ZONE p_timezone)
      AND (pp.resumed_at IS NULL OR pp.resumed_at > (v_d::timestamp AT TIME ZONE p_timezone))
  ) THEN
    RETURN jsonb_build_object('state', 'not_scheduled');
  END IF;

  IF EXISTS (
    SELECT 1 FROM rehab_sessions
    WHERE user_id = p_user_id AND training_status = 'finished' AND calendar_scheduled_date = v_d
  ) THEN
    RETURN jsonb_build_object('state', 'not_scheduled');
  END IF;

  RETURN jsonb_build_object('state', 'make_up', 'workout_id', v_workout, 'calendar_scheduled_date', v_d);
END;
$$;
REVOKE ALL ON FUNCTION c5_calendar_opportunity(UUID, UUID, UUID, DATE, TEXT) FROM PUBLIC, anon, authenticated;

-- 9g. THE Start-eligibility path. Read-only. Callers that intend to create
--     a session must hold patient_prescriptions FOR UPDATE first.
--     Gate order (first failure wins):
--       no_active_prescription
--       prescription_paused          (only when no STARTED session exists —
--                                     pause never hides an existing session)
--       acute_safety_*               (blocks resume too — C5.6A §5)
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

-- Read-only eligibility for the future patient UI.
CREATE OR REPLACE FUNCTION c5_get_start_eligibility(p_patient_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c5_start_eligibility_internal(p_patient_id);
$$;
REVOKE ALL ON FUNCTION c5_get_start_eligibility(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_get_start_eligibility(UUID) TO service_role;

-- 9h. Response obligations at closure — exactly once per session (UNIQUE
--     rehab_session_id on both tables; closure runs once under the session
--     row lock). Nothing is fabricated: graded values stay NULL. A
--     patient-reported acute stop pre-fills ONLY the safety facts reported.
CREATE OR REPLACE FUNCTION c5_create_response_obligations(p_session_id UUID, p_acute_report JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_s RECORD;
  v_reminder TIME;
  v_due TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_s FROM rehab_sessions WHERE id = p_session_id;
  SELECT COALESCE(morning_reminder_time, '05:00'::time) INTO v_reminder FROM profiles WHERE id = v_s.user_id;
  v_reminder := COALESCE(v_reminder, '05:00'::time);

  INSERT INTO session_immediate_responses (rehab_session_id, user_id, sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty)
  VALUES (p_session_id, v_s.user_id,
    CASE WHEN (p_acute_report->>'sudden_or_sharp_pain')::boolean THEN true END,
    CASE WHEN (p_acute_report->>'pop_felt_or_heard')::boolean THEN true END,
    CASE WHEN (p_acute_report->>'new_functional_difficulty')::boolean THEN true END)
  ON CONFLICT (rehab_session_id) DO NOTHING;

  v_due := c5_morning_due_at(v_s.patient_local_date, v_s.training_closed_at, v_s.patient_timezone, v_reminder);
  INSERT INTO morning_responses (rehab_session_id, user_id, scheduled_eligible_at, reference_local_date)
  VALUES (p_session_id, v_s.user_id, v_due, (v_due AT TIME ZONE v_s.patient_timezone)::date)
  ON CONFLICT (rehab_session_id) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION c5_create_response_obligations(UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 10. C5 lifecycle RPCs (service_role only).
-- =============================================================================

-- 10a. Atomic first-performance Start.
--   p_performance:     the first confirmed unit (outcome must be 'completed').
--   p_pre_start_skips: optional [{exercise_id, unit_index}] skipped before
--                      Start — persisted only because the session Starts.
--   p_sequence_choice: required iff a Stopped session awaits resolution.
-- Lock: patient_prescriptions FOR UPDATE — the same row Publish, Pause and
-- Resume lock, so all four serialize per patient (no draft lock is taken
-- here, so no lock-order cycle with publish's draft -> prescription order).
CREATE OR REPLACE FUNCTION c5_record_first_performance(
  p_patient_id UUID,
  p_client_request_id UUID,
  p_expected_version_id UUID,
  p_workout_id UUID,
  p_performance JSONB,
  p_pre_start_skips JSONB DEFAULT '[]'::jsonb,
  p_sequence_choice TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pp RECORD;
  v_existing RECORD;
  v_elig JSONB;
  v_code TEXT;
  v_version_id UUID;
  v_expected_workout UUID;
  v_resolves UUID;
  v_choice TEXT;
  v_cal_date DATE;
  v_tz TEXT;
  v_local DATE;
  v_snapshot JSONB;
  v_err TEXT;
  v_skip JSONB;
  v_session_id UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_patient_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_pp FROM patient_prescriptions WHERE patient_id = p_patient_id FOR UPDATE;

  -- Idempotency (after the lock, so a concurrent duplicate waits and then
  -- sees the committed session).
  SELECT id, user_id INTO v_existing FROM rehab_sessions WHERE client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.user_id <> p_patient_id THEN RAISE EXCEPTION 'CLIENT_REQUEST_ID_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    RETURN jsonb_build_object('result', 'started', 'session_id', v_existing.id, 'replayed', true);
  END IF;

  v_elig := c5_start_eligibility_internal(p_patient_id);
  v_code := v_elig->>'result';

  IF v_code LIKE 'acute_safety_%' AND v_elig->>'acute_safety_episode_id' IS NOT NULL THEN
    -- Record the blocked loading opportunity (one per patient-local day),
    -- committed because the rejection is returned, not raised.
    INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level)
    VALUES (p_patient_id, (v_elig->>'acute_safety_episode_id')::uuid,
            'c5-day:' || COALESCE((now() AT TIME ZONE (SELECT timezone FROM profiles WHERE id = p_patient_id))::date::text, now()::date::text),
            (v_elig->>'brake_level')::smallint)
    ON CONFLICT (acute_safety_episode_id, prescription_instance_id) DO NOTHING;
  END IF;
  IF v_code <> 'eligible' THEN RETURN v_elig; END IF;

  v_version_id := (v_elig->>'prescription_version_id')::uuid;
  IF p_expected_version_id IS DISTINCT FROM v_version_id THEN
    RETURN jsonb_build_object('result', 'version_changed', 'prescription_version_id', v_version_id);
  END IF;

  IF v_elig->>'scheduling_mode' = 'sequence' THEN
    CASE v_elig->'sequence'->>'state'
      WHEN 'first', 'next' THEN
        IF p_sequence_choice IS NOT NULL THEN
          RETURN jsonb_build_object('result', 'sequence_choice_not_applicable');
        END IF;
        v_expected_workout := (v_elig->'sequence'->>'workout_id')::uuid;
      WHEN 'pending_choice' THEN
        v_resolves := (v_elig->'sequence'->>'stopped_session_id')::uuid;
        IF (v_elig->'sequence'->>'single_workout')::boolean THEN
          v_choice := 'single_workout_auto';
          v_expected_workout := (v_elig->'sequence'->>'repeat_workout_id')::uuid;
        ELSIF p_sequence_choice = 'repeat_previous' THEN
          v_choice := p_sequence_choice;
          v_expected_workout := (v_elig->'sequence'->>'repeat_workout_id')::uuid;
        ELSIF p_sequence_choice = 'advance_next' THEN
          v_choice := p_sequence_choice;
          v_expected_workout := (v_elig->'sequence'->>'advance_workout_id')::uuid;
        ELSE
          RETURN jsonb_build_object('result', 'sequence_choice_required', 'sequence', v_elig->'sequence');
        END IF;
      ELSE
        RAISE EXCEPTION 'C5_UNEXPECTED_SEQUENCE_STATE' USING ERRCODE = 'P0001';
    END CASE;
  ELSE
    IF p_sequence_choice IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'sequence_choice_not_applicable');
    END IF;
    v_expected_workout := (v_elig->'calendar'->>'workout_id')::uuid;
    v_cal_date := (v_elig->'calendar'->>'calendar_scheduled_date')::date;
  END IF;

  IF p_workout_id IS DISTINCT FROM v_expected_workout THEN
    RETURN jsonb_build_object('result', 'workout_not_eligible', 'eligible_workout_id', v_expected_workout);
  END IF;

  v_snapshot := c5_build_session_snapshot(v_version_id, v_expected_workout);

  IF p_performance->>'outcome' IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object('result', 'invalid_performance', 'detail', 'first_performance_must_be_completed');
  END IF;
  v_err := c5_performance_error(v_snapshot, p_performance);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_performance', 'detail', v_err); END IF;

  IF jsonb_typeof(COALESCE(p_pre_start_skips, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('result', 'invalid_performance', 'detail', 'skips_malformed');
  END IF;
  FOR v_skip IN SELECT * FROM jsonb_array_elements(COALESCE(p_pre_start_skips, '[]'::jsonb)) LOOP
    v_err := c5_performance_error(v_snapshot, v_skip || '{"outcome": "skipped"}'::jsonb);
    IF v_err IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_performance', 'detail', 'skip_' || v_err); END IF;
    IF v_skip->>'exercise_id' = p_performance->>'exercise_id' AND (v_skip->>'unit_index')::int = (p_performance->>'unit_index')::int THEN
      RETURN jsonb_build_object('result', 'invalid_performance', 'detail', 'skip_conflicts_with_performance');
    END IF;
  END LOOP;

  v_tz := v_elig->>'patient_timezone';
  v_local := (v_now AT TIME ZONE v_tz)::date;

  INSERT INTO rehab_sessions (
    id, user_id, prescription_instance_id, patient_local_date, status, training_status, started_at,
    prescription_snapshot, prescription_version_id, prescription_workout_id, patient_timezone,
    client_request_id, sequence_choice, resolves_stopped_session_id, calendar_scheduled_date
  ) VALUES (
    v_session_id, p_patient_id, 'c5:' || v_session_id::text, v_local, NULL, 'started', v_now,
    v_snapshot, v_version_id, v_expected_workout, v_tz,
    p_client_request_id, v_choice, v_resolves, v_cal_date
  );

  INSERT INTO set_outcomes (rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, occurred_at)
  SELECT DISTINCT ON (s->>'exercise_id', (s->>'unit_index')::int)
    v_session_id, s->>'exercise_id',
    (SELECT (e->>'order_index')::smallint FROM jsonb_array_elements(v_snapshot->'exercises') e WHERE e->>'exercise_id' = s->>'exercise_id'),
    (s->>'unit_index')::smallint, 'skipped', v_now
  FROM jsonb_array_elements(COALESCE(p_pre_start_skips, '[]'::jsonb)) s;

  INSERT INTO set_outcomes (
    rehab_session_id, exercise_id, exercise_order_index, set_index, outcome,
    actual_reps, actual_load, actual_load_unit, actual_duration_seconds, actual_distance_m, occurred_at
  ) VALUES (
    v_session_id, p_performance->>'exercise_id',
    (SELECT (e->>'order_index')::smallint FROM jsonb_array_elements(v_snapshot->'exercises') e WHERE e->>'exercise_id' = p_performance->>'exercise_id'),
    (p_performance->>'unit_index')::smallint, 'completed',
    (p_performance->>'actual_reps')::numeric, (p_performance->>'actual_load')::numeric, p_performance->>'actual_load_unit',
    (p_performance->>'actual_duration_seconds')::numeric, (p_performance->>'actual_distance_m')::numeric, v_now
  );

  -- Existing acute-safety continuity: the first session after a release
  -- captures its cautious-return context (same rule as the legacy gate).
  INSERT INTO cautious_return_contexts (rehab_session_id, acute_safety_release_id, acute_safety_episode_id)
  SELECT v_session_id, r.id, r.acute_safety_episode_id
  FROM acute_safety_releases r
  WHERE r.user_id = p_patient_id AND r.released_at < v_now
    AND NOT EXISTS (SELECT 1 FROM cautious_return_contexts c WHERE c.acute_safety_release_id = r.id)
  ORDER BY r.released_at DESC LIMIT 1
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('result', 'started', 'session_id', v_session_id, 'replayed', false,
    'prescription_version_id', v_version_id, 'prescription_workout_id', v_expected_workout,
    'patient_local_date', v_local, 'sequence_choice', v_choice, 'calendar_scheduled_date', v_cal_date);
END;
$$;
REVOKE ALL ON FUNCTION c5_record_first_performance(UUID, UUID, UUID, UUID, JSONB, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_record_first_performance(UUID, UUID, UUID, UUID, JSONB, JSONB, TEXT) TO service_role;

-- Shared session lookup + lock for in-session writes. Pause never blocks
-- these (the frozen session stays usable); an active acute brake does.
CREATE OR REPLACE FUNCTION c5_lock_started_session(p_patient_id UUID, p_session_id UUID, OUT o_code TEXT, OUT o_snapshot JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_s RECORD;
  v_acute RECORD;
BEGIN
  SELECT id, training_status, prescription_snapshot INTO v_s FROM rehab_sessions
  WHERE id = p_session_id AND user_id = p_patient_id AND training_status IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN o_code := 'session_not_found'; RETURN; END IF;
  IF v_s.training_status <> 'started' THEN o_code := 'session_closed'; RETURN; END IF;
  SELECT * INTO v_acute FROM c5_acute_gate(p_patient_id);
  IF v_acute.o_code IS NOT NULL THEN o_code := v_acute.o_code; RETURN; END IF;
  o_snapshot := v_s.prescription_snapshot;
END;
$$;
REVOKE ALL ON FUNCTION c5_lock_started_session(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- 10b. Subsequent performance (or an in-session skip). First write wins:
--      an identical retry is a replay; a different value for an already
--      recorded unit is refused (use c5_edit_performance).
CREATE OR REPLACE FUNCTION c5_record_performance(p_patient_id UUID, p_session_id UUID, p_performance JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lock RECORD;
  v_err TEXT;
  v_row set_outcomes;
BEGIN
  SELECT * INTO v_lock FROM c5_lock_started_session(p_patient_id, p_session_id);
  IF v_lock.o_code IS NOT NULL THEN RETURN jsonb_build_object('result', v_lock.o_code); END IF;

  v_err := c5_performance_error(v_lock.o_snapshot, p_performance);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_performance', 'detail', v_err); END IF;

  SELECT * INTO v_row FROM set_outcomes
  WHERE rehab_session_id = p_session_id AND exercise_id = p_performance->>'exercise_id'
    AND set_index = (p_performance->>'unit_index')::smallint;
  IF FOUND THEN
    IF v_row.outcome = p_performance->>'outcome'
       AND v_row.actual_reps IS NOT DISTINCT FROM (p_performance->>'actual_reps')::numeric
       AND v_row.actual_load IS NOT DISTINCT FROM (p_performance->>'actual_load')::numeric
       AND v_row.actual_load_unit IS NOT DISTINCT FROM p_performance->>'actual_load_unit'
       AND v_row.actual_duration_seconds IS NOT DISTINCT FROM (p_performance->>'actual_duration_seconds')::numeric
       AND v_row.actual_distance_m IS NOT DISTINCT FROM (p_performance->>'actual_distance_m')::numeric THEN
      RETURN jsonb_build_object('result', 'recorded', 'replayed', true);
    END IF;
    RETURN jsonb_build_object('result', 'performance_already_recorded');
  END IF;

  INSERT INTO set_outcomes (
    rehab_session_id, exercise_id, exercise_order_index, set_index, outcome,
    actual_reps, actual_load, actual_load_unit, actual_duration_seconds, actual_distance_m, occurred_at
  ) VALUES (
    p_session_id, p_performance->>'exercise_id',
    (SELECT (e->>'order_index')::smallint FROM jsonb_array_elements(v_lock.o_snapshot->'exercises') e WHERE e->>'exercise_id' = p_performance->>'exercise_id'),
    (p_performance->>'unit_index')::smallint, p_performance->>'outcome',
    (p_performance->>'actual_reps')::numeric, (p_performance->>'actual_load')::numeric, p_performance->>'actual_load_unit',
    (p_performance->>'actual_duration_seconds')::numeric, (p_performance->>'actual_distance_m')::numeric, now()
  );
  RETURN jsonb_build_object('result', 'recorded', 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION c5_record_performance(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_record_performance(UUID, UUID, JSONB) TO service_role;

-- 10c. Explicit edit of an already-recorded unit while STARTED. Sets
--      was_edited. A completed unit cannot be turned into a skip (that could
--      leave a Started session with zero performed work).
CREATE OR REPLACE FUNCTION c5_edit_performance(p_patient_id UUID, p_session_id UUID, p_performance JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lock RECORD;
  v_err TEXT;
  v_row set_outcomes;
BEGIN
  SELECT * INTO v_lock FROM c5_lock_started_session(p_patient_id, p_session_id);
  IF v_lock.o_code IS NOT NULL THEN RETURN jsonb_build_object('result', v_lock.o_code); END IF;

  v_err := c5_performance_error(v_lock.o_snapshot, p_performance);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_performance', 'detail', v_err); END IF;

  SELECT * INTO v_row FROM set_outcomes
  WHERE rehab_session_id = p_session_id AND exercise_id = p_performance->>'exercise_id'
    AND set_index = (p_performance->>'unit_index')::smallint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'performance_not_recorded'); END IF;
  IF v_row.outcome = 'completed' AND p_performance->>'outcome' = 'skipped' THEN
    RETURN jsonb_build_object('result', 'invalid_performance', 'detail', 'completed_cannot_become_skipped');
  END IF;

  UPDATE set_outcomes SET
    outcome = p_performance->>'outcome',
    actual_reps = (p_performance->>'actual_reps')::numeric,
    actual_load = (p_performance->>'actual_load')::numeric,
    actual_load_unit = p_performance->>'actual_load_unit',
    actual_duration_seconds = (p_performance->>'actual_duration_seconds')::numeric,
    actual_distance_m = (p_performance->>'actual_distance_m')::numeric,
    was_edited = true
  WHERE id = v_row.id;
  RETURN jsonb_build_object('result', 'edited');
END;
$$;
REVOKE ALL ON FUNCTION c5_edit_performance(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_edit_performance(UUID, UUID, JSONB) TO service_role;

-- 10d. Closure. Lock order: patient_prescriptions (FOR SHARE, so the pause
--      state read for Stop classification cannot change mid-transaction)
--      then the session row (FOR UPDATE). Start takes patient_prescriptions
--      FOR UPDATE and never locks session rows, so no cycle.
CREATE OR REPLACE FUNCTION c5_close_session_internal(
  p_patient_id UUID, p_session_id UUID, p_intent TEXT, p_acute_report JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pp RECORD;
  v_s RECORD;
  v_acute RECORD;
  v_reported BOOLEAN;
  v_status TEXT;
BEGIN
  SELECT * INTO v_pp FROM patient_prescriptions WHERE patient_id = p_patient_id FOR SHARE;
  SELECT id, training_status INTO v_s FROM rehab_sessions
  WHERE id = p_session_id AND user_id = p_patient_id AND training_status IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'session_not_found'); END IF;

  IF v_s.training_status <> 'started' THEN
    -- Idempotent replay of the same closure kind; otherwise already closed.
    IF (p_intent = 'finish' AND v_s.training_status = 'finished')
       OR (p_intent = 'stop' AND v_s.training_status LIKE 'stopped_%') THEN
      RETURN jsonb_build_object('result', 'closed', 'training_status', v_s.training_status, 'replayed', true);
    END IF;
    RETURN jsonb_build_object('result', 'session_already_closed', 'training_status', v_s.training_status);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM set_outcomes WHERE rehab_session_id = p_session_id AND outcome = 'completed') THEN
    RETURN jsonb_build_object('result', 'no_performance_recorded');
  END IF;

  SELECT * INTO v_acute FROM c5_acute_gate(p_patient_id);

  IF p_intent = 'finish' THEN
    IF v_acute.o_code IS NOT NULL THEN RETURN jsonb_build_object('result', v_acute.o_code); END IF;
    v_status := 'finished';
  ELSE
    IF p_acute_report IS NOT NULL AND jsonb_typeof(p_acute_report) <> 'object' THEN
      RETURN jsonb_build_object('result', 'invalid_acute_report');
    END IF;
    v_reported := COALESCE((p_acute_report->>'sudden_or_sharp_pain')::boolean, false)
               OR COALESCE((p_acute_report->>'pop_felt_or_heard')::boolean, false)
               OR COALESCE((p_acute_report->>'new_functional_difficulty')::boolean, false);
    -- Server-derived classification; the client never names the reason.
    v_status := CASE
      WHEN v_reported OR v_acute.o_code IS NOT NULL THEN 'stopped_acute'
      WHEN v_pp.operational_status = 'paused' THEN 'stopped_pause'
      ELSE 'stopped_early'
    END;
  END IF;

  UPDATE rehab_sessions SET training_status = v_status, training_closed_at = now(), updated_at = now()
  WHERE id = p_session_id;
  PERFORM c5_create_response_obligations(p_session_id, CASE WHEN v_reported THEN p_acute_report END);

  RETURN jsonb_build_object('result', 'closed', 'training_status', v_status, 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION c5_close_session_internal(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION c5_finish_session(p_patient_id UUID, p_session_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c5_close_session_internal(p_patient_id, p_session_id, 'finish', NULL);
$$;
REVOKE ALL ON FUNCTION c5_finish_session(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_finish_session(UUID, UUID) TO service_role;

-- p_acute_report: optional in-session safety report
--   { sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty }.
-- Any true value is the acute-termination pathway -> STOPPED_ACUTE.
CREATE OR REPLACE FUNCTION c5_stop_session(p_patient_id UUID, p_session_id UUID, p_acute_report JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c5_close_session_internal(p_patient_id, p_session_id, 'stop', p_acute_report);
$$;
REVOKE ALL ON FUNCTION c5_stop_session(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_stop_session(UUID, UUID, JSONB) TO service_role;
