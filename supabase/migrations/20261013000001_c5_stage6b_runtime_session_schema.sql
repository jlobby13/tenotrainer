-- =============================================================================
-- C5, Stage 6B — C5 patient-runtime session schema foundation.
--
-- Schema only. No lifecycle RPC (record_first_performance, record_performance,
-- finish/stop, response submission) is created here — that is C5.6C. The C5
-- patient runtime stays gated OFF; nothing in this migration creates or
-- alters a session row.
--
-- Founder-locked C5.6A semantics this schema encodes:
--   - A C5 session exists only from the FIRST CONFIRMED ACTUAL PERFORMANCE.
--     Every C5 row is therefore a real training exposure; it is born STARTED.
--   - training_status: started | finished | stopped_early | stopped_pause |
--     stopped_acute. The four closed states are terminal and immutable.
--   - At most one STARTED C5 session per patient; at most one C5 session per
--     patient-local START date (closure date is irrelevant; a session may
--     stay STARTED across midnight).
--   - Training closure and response completion are separate: immediate
--     response lives in its own table (session_immediate_responses), the
--     morning response keeps its own table with an explicit resolution.
--   - UNKNOWN != ZERO: unable_to_recall leaves graded values NULL. Active
--     acute-safety answers have NO unable-to-recall path.
--   - Session RPE is one session-level 0-10 integer, never per set. No C5
--     Difficulty response exists.
--   - Sequence state is DERIVED from session history; the only Sequence
--     fact a session records is the patient choice that actually led to it
--     (sequence_choice + resolves_stopped_session_id). See
--     20261013000002 for the retirement of prescription_sequence_state.
--   - Pause never terminates a STARTED session: nothing here reacts to
--     patient_prescriptions.operational_status.
--
-- LEGACY COEXISTENCE: rows created by the pre-C5 runtime (M3-M6) are
-- distinguished by training_status IS NULL and keep their existing
-- `status`/`exercise_outcome` lifecycle, columns, grants and RLS behavior
-- unchanged. Every new C5 invariant is scoped to training_status IS NOT NULL
-- so no historical row is invalidated.
--
-- WRITE SECURITY TRANSITION: the legacy patient runtime still writes
-- rehab_sessions / set_outcomes / morning_responses / session_events
-- directly with the patient's JWT, so those grants cannot be revoked before
-- cutover without breaking it. Instead, every patient (authenticated) write
-- policy is narrowed to LEGACY parent sessions only, and none of the new C5
-- columns/tables is granted to authenticated. C5 runtime rows are therefore
-- writable only by SECURITY DEFINER RPCs (C5.6C) / service_role.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. prescription_workouts — composite key target so a session's workout is
--    provably a workout OF the session's version (FK below).
-- -----------------------------------------------------------------------------
ALTER TABLE prescription_workouts
  ADD CONSTRAINT prescription_workouts_id_version_unique UNIQUE (id, prescription_version_id);

-- -----------------------------------------------------------------------------
-- 2. rehab_sessions — C5 lifecycle columns.
-- -----------------------------------------------------------------------------
ALTER TABLE rehab_sessions
  ADD COLUMN training_status             TEXT NULL,
  ADD COLUMN prescription_workout_id     UUID NULL,
  ADD COLUMN training_closed_at          TIMESTAMPTZ NULL,
  ADD COLUMN patient_timezone            TEXT NULL,
  ADD COLUMN client_request_id           UUID NULL,
  ADD COLUMN sequence_choice             TEXT NULL,
  ADD COLUMN resolves_stopped_session_id UUID NULL,
  ADD COLUMN calendar_scheduled_date     DATE NULL;

-- Legacy `status` is meaningless for a C5 row, so it may now be NULL. The
-- DEFAULT stays so the legacy create path (create_rehab_session_if_allowed,
-- direct legacy insert) is unchanged; C5 RPCs set it to NULL explicitly.
ALTER TABLE rehab_sessions ALTER COLUMN status DROP NOT NULL;

ALTER TABLE rehab_sessions
  ADD CONSTRAINT rehab_sessions_training_status_check CHECK (
    training_status IS NULL OR training_status IN (
      'started', 'finished', 'stopped_early', 'stopped_pause', 'stopped_acute'
    )
  ),
  -- Exactly one lifecycle model per row: legacy rows use `status`, C5 rows
  -- use `training_status`.
  ADD CONSTRAINT rehab_sessions_one_lifecycle_model CHECK (
    (training_status IS NULL) = (status IS NOT NULL)
  ),
  ADD CONSTRAINT rehab_sessions_sequence_choice_check CHECK (
    sequence_choice IS NULL OR sequence_choice IN ('repeat_previous', 'advance_next', 'single_workout_auto')
  ),
  ADD CONSTRAINT rehab_sessions_resolves_stopped_session_fkey
    FOREIGN KEY (resolves_stopped_session_id) REFERENCES rehab_sessions(id),
  ADD CONSTRAINT rehab_sessions_resolves_stopped_session_unique UNIQUE (resolves_stopped_session_id),
  ADD CONSTRAINT rehab_sessions_client_request_id_unique UNIQUE (client_request_id),
  ADD CONSTRAINT rehab_sessions_workout_of_version_fkey
    FOREIGN KEY (prescription_workout_id, prescription_version_id)
    REFERENCES prescription_workouts (id, prescription_version_id),
  -- C5 rows carry their full immutable prescription association.
  ADD CONSTRAINT rehab_sessions_c5_required_fields CHECK (
    training_status IS NULL OR (
      prescription_version_id IS NOT NULL
      AND prescription_workout_id IS NOT NULL
      AND patient_timezone IS NOT NULL
      AND client_request_id IS NOT NULL
      AND jsonb_typeof(prescription_snapshot) = 'object'
      AND prescription_instance_id = 'c5:' || id::text
    )
  ),
  -- C5-only columns stay NULL on legacy rows.
  ADD CONSTRAINT rehab_sessions_c5_columns_only_on_c5_rows CHECK (
    training_status IS NOT NULL OR (
      prescription_workout_id IS NULL AND training_closed_at IS NULL AND patient_timezone IS NULL
      AND client_request_id IS NULL AND sequence_choice IS NULL
      AND resolves_stopped_session_id IS NULL AND calendar_scheduled_date IS NULL
    )
  ),
  -- Closure timestamp present exactly when the session is terminal.
  ADD CONSTRAINT rehab_sessions_c5_closure_consistent CHECK (
    training_status IS NULL
    OR (training_status = 'started' AND training_closed_at IS NULL)
    OR (training_status <> 'started' AND training_closed_at IS NOT NULL AND training_closed_at >= started_at)
  ),
  -- A C5 row never carries the legacy lifecycle/response columns. In
  -- particular there is no C5 Difficulty response; immediate-response data
  -- (incl. acute-safety answers) lives in session_immediate_responses.
  ADD CONSTRAINT rehab_sessions_c5_no_legacy_response_columns CHECK (
    training_status IS NULL OR (
      exercise_outcome IS NULL AND early_end_reason IS NULL AND exercises_ended_at IS NULL
      AND peak_session_pain IS NULL AND difficulty IS NULL
      AND contributor_reason IS NULL AND contributor_exercise_id IS NULL AND contributor_other_text IS NULL
      AND sudden_or_sharp_pain IS NULL AND pop_felt_or_heard IS NULL AND new_functional_difficulty IS NULL
      AND response_recorded_at IS NULL
    )
  ),
  -- A recorded Sequence choice always names the Stopped session it resolved.
  ADD CONSTRAINT rehab_sessions_sequence_choice_resolves_together CHECK (
    (sequence_choice IS NULL) = (resolves_stopped_session_id IS NULL)
  ),
  ADD CONSTRAINT rehab_sessions_resolves_not_self CHECK (resolves_stopped_session_id <> id),
  -- A make-up fulfils an EARLIER scheduled date; never a future one.
  ADD CONSTRAINT rehab_sessions_calendar_date_not_future CHECK (
    calendar_scheduled_date IS NULL OR calendar_scheduled_date <= patient_local_date
  );

-- One STARTED C5 session per patient.
CREATE UNIQUE INDEX rehab_sessions_c5_one_started_per_patient
  ON rehab_sessions (user_id) WHERE training_status = 'started';

-- One independent C5 session per patient-local START date.
CREATE UNIQUE INDEX rehab_sessions_c5_one_per_local_date
  ON rehab_sessions (user_id, patient_local_date) WHERE training_status IS NOT NULL;

-- A scheduled Calendar opportunity can be FINISHED at most once (a Stopped
-- attempt may be followed by a make-up for the same scheduled date).
CREATE UNIQUE INDEX rehab_sessions_c5_calendar_date_finished_once
  ON rehab_sessions (user_id, calendar_scheduled_date)
  WHERE training_status = 'finished' AND calendar_scheduled_date IS NOT NULL;

-- Sequence derivation: latest C5 session of a version.
CREATE INDEX idx_rehab_sessions_c5_version_started
  ON rehab_sessions (prescription_version_id, started_at DESC) WHERE training_status IS NOT NULL;

COMMENT ON COLUMN rehab_sessions.training_status IS
  'C5 runtime lifecycle. NULL = legacy (pre-C5) row using `status`. started | finished | stopped_early | stopped_pause | stopped_acute. A C5 row is created only at the first confirmed actual performance, so every C5 row is a real training exposure. Closed states are terminal and immutable (trg_rehab_sessions_c5_guard). Weekly completed-session adherence counts finished only; stopped_* are exposures that never count toward X.';
COMMENT ON COLUMN rehab_sessions.status IS
  'LEGACY (pre-C5) lifecycle only. NULL exactly when training_status is set (rehab_sessions_one_lifecycle_model).';
COMMENT ON COLUMN rehab_sessions.started_at IS
  'For C5 rows: the moment of the first confirmed actual performance (never workout open/view/skip).';
COMMENT ON COLUMN rehab_sessions.patient_local_date IS
  'For C5 rows: the patient-local START date, = (started_at AT TIME ZONE patient_timezone)::date, verified by trg_rehab_sessions_c5_guard. The one-session-per-day boundary (rehab_sessions_c5_one_per_local_date).';
COMMENT ON COLUMN rehab_sessions.patient_timezone IS
  'C5: IANA timezone captured at Start (server-derived from the patient profile, never trusted from the client).';
COMMENT ON COLUMN rehab_sessions.prescription_workout_id IS
  'C5: the published workout performed. Composite FK guarantees it belongs to prescription_version_id.';
COMMENT ON COLUMN rehab_sessions.training_closed_at IS
  'C5: when training closed (Finish/Stop). Response obligations are separate and may remain open after this.';
COMMENT ON COLUMN rehab_sessions.client_request_id IS
  'C5: idempotency key of the first-performance request that created this session.';
COMMENT ON COLUMN rehab_sessions.sequence_choice IS
  'C5 Sequence: the patient choice that actually led to THIS session after a Stopped session (repeat_previous | advance_next | single_workout_auto). Recorded only when the session Starts; a pre-session choice that never produced performance is not history. Sequence position is derived, never stored.';
COMMENT ON COLUMN rehab_sessions.resolves_stopped_session_id IS
  'C5 Sequence: the Stopped session this session resolved. UNIQUE — a Stopped session is resolved at most once.';
COMMENT ON COLUMN rehab_sessions.calendar_scheduled_date IS
  'C5 Calendar: the clinician-scheduled date this session fulfils (= patient_local_date for the day''s own workout, earlier for a make-up). Required for Calendar-mode sessions, NULL for Sequence. Never shifts the schedule.';

-- -----------------------------------------------------------------------------
-- 3. rehab_sessions C5 guard — cross-row/cross-table integrity and
--    terminal immutability that a CHECK cannot express. Legacy rows
--    (training_status IS NULL on both OLD and NEW) are untouched.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_rehab_sessions_c5_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_version RECORD;
  v_workout_count INTEGER;
  v_stopped RECORD;
  v_stopped_idx SMALLINT;
  v_new_idx SMALLINT;
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

    SELECT count(*) INTO v_workout_count FROM prescription_workouts WHERE prescription_version_id = NEW.prescription_version_id;
    SELECT order_index INTO v_stopped_idx FROM prescription_workouts WHERE id = v_stopped.prescription_workout_id;
    SELECT order_index INTO v_new_idx FROM prescription_workouts WHERE id = NEW.prescription_workout_id;

    IF NEW.sequence_choice = 'single_workout_auto' THEN
      IF v_workout_count <> 1 THEN
        RAISE EXCEPTION 'C5_SINGLE_WORKOUT_AUTO_REQUIRES_ONE_WORKOUT' USING ERRCODE = 'P0001';
      END IF;
    ELSIF v_workout_count = 1 THEN
      RAISE EXCEPTION 'C5_SINGLE_WORKOUT_MUST_USE_AUTO' USING ERRCODE = 'P0001';
    ELSIF NEW.sequence_choice = 'repeat_previous' AND v_new_idx <> v_stopped_idx THEN
      RAISE EXCEPTION 'C5_REPEAT_PREVIOUS_WORKOUT_MISMATCH' USING ERRCODE = 'P0001';
    ELSIF NEW.sequence_choice = 'advance_next' AND v_new_idx <> (v_stopped_idx + 1) % v_workout_count THEN
      RAISE EXCEPTION 'C5_ADVANCE_NEXT_WORKOUT_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_rehab_sessions_c5_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_rehab_sessions_c5_guard
  BEFORE INSERT OR UPDATE ON rehab_sessions
  FOR EACH ROW EXECUTE FUNCTION trg_rehab_sessions_c5_guard();

-- -----------------------------------------------------------------------------
-- 4. set_outcomes — one row = one confirmed unit of performance (a set,
--    round or bout, per the exercise's dosage_type in the session snapshot).
--    Table name kept for legacy reader compatibility.
-- -----------------------------------------------------------------------------
ALTER TABLE set_outcomes
  ADD COLUMN actual_load_unit        TEXT NULL,
  ADD COLUMN actual_duration_seconds NUMERIC NULL,
  ADD COLUMN actual_distance_m       NUMERIC NULL;

ALTER TABLE set_outcomes
  ADD CONSTRAINT set_outcomes_actual_load_unit_check CHECK (actual_load_unit IS NULL OR actual_load_unit IN ('kg', 'lb')),
  ADD CONSTRAINT set_outcomes_load_unit_requires_load CHECK (actual_load_unit IS NULL OR actual_load IS NOT NULL),
  ADD CONSTRAINT set_outcomes_actual_reps_nonnegative CHECK (actual_reps IS NULL OR actual_reps >= 0),
  ADD CONSTRAINT set_outcomes_actual_load_nonnegative CHECK (actual_load IS NULL OR actual_load >= 0),
  ADD CONSTRAINT set_outcomes_actual_duration_positive CHECK (actual_duration_seconds IS NULL OR actual_duration_seconds > 0),
  ADD CONSTRAINT set_outcomes_actual_distance_positive CHECK (actual_distance_m IS NULL OR actual_distance_m > 0),
  -- A skipped unit never carries fabricated actual values (verified: no
  -- existing row violates this).
  ADD CONSTRAINT set_outcomes_skipped_has_no_actuals CHECK (
    outcome <> 'skipped' OR (
      actual_reps IS NULL AND actual_load IS NULL AND actual_load_unit IS NULL
      AND actual_duration_seconds IS NULL AND actual_distance_m IS NULL
    )
  );

COMMENT ON TABLE set_outcomes IS
  'One row per confirmed unit of performance (set, round or bout — per the exercise dosage_type in the session snapshot), or an explicit skip. Prescribed values live in rehab_sessions.prescription_snapshot; actual_* are what was actually performed. A missing row means not performed/not reached; a skipped row means explicitly skipped. Session RPE never lives here (see session_immediate_responses).';
COMMENT ON COLUMN set_outcomes.actual_reps IS
  'Actual repetitions — or contacts, when the exercise dosage_type is contact-based. NULL = not applicable/unknown, never 0-filled.';
COMMENT ON COLUMN set_outcomes.actual_load IS
  'Actual external load. NULL for bodyweight/not applicable. For C5 rows actual_load_unit is required whenever actual_load is set.';
COMMENT ON COLUMN set_outcomes.exercise_id IS
  'Matches the exercise id in rehab_sessions.prescription_snapshot (for C5 sessions: the published prescription_exercises.id as text).';

CREATE OR REPLACE FUNCTION trg_set_outcomes_c5_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT training_status INTO v_status FROM rehab_sessions WHERE id = NEW.rehab_session_id;
  IF v_status IS NULL THEN RETURN NEW; END IF;  -- legacy parent: unchanged behavior

  IF v_status <> 'started' THEN
    RAISE EXCEPTION 'C5_PERFORMANCE_SESSION_NOT_STARTED' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.rehab_session_id <> OLD.rehab_session_id THEN
    RAISE EXCEPTION 'C5_PERFORMANCE_SESSION_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.outcome = 'completed' THEN
    IF NEW.actual_reps IS NULL AND NEW.actual_duration_seconds IS NULL AND NEW.actual_distance_m IS NULL THEN
      RAISE EXCEPTION 'C5_PERFORMANCE_REQUIRES_PRIMARY_QUANTITY' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.actual_load IS NOT NULL AND NEW.actual_load_unit IS NULL THEN
      RAISE EXCEPTION 'C5_PERFORMANCE_LOAD_REQUIRES_UNIT' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_set_outcomes_c5_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_set_outcomes_c5_guard
  BEFORE INSERT OR UPDATE ON set_outcomes
  FOR EACH ROW EXECUTE FUNCTION trg_set_outcomes_c5_guard();

-- -----------------------------------------------------------------------------
-- 5. session_immediate_responses — the C5 immediate (post-session) response
--    obligation. Created when training closes (C5.6C); OUTSTANDING while
--    resolved_at IS NULL. Separate from training_status by design.
-- -----------------------------------------------------------------------------
CREATE TABLE session_immediate_responses (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id            UUID NOT NULL UNIQUE REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  user_id                     UUID NOT NULL REFERENCES auth.users(id),

  -- Graded values. NULL = not yet answered OR unable to recall (the flag
  -- disambiguates). Never 0-filled.
  peak_session_pain           SMALLINT NULL CHECK (peak_session_pain IS NULL OR peak_session_pain BETWEEN 0 AND 10),
  peak_pain_unable_to_recall  BOOLEAN NOT NULL DEFAULT false,
  overall_session_rpe         SMALLINT NULL CHECK (overall_session_rpe IS NULL OR overall_session_rpe BETWEEN 0 AND 10),
  rpe_unable_to_recall        BOOLEAN NOT NULL DEFAULT false,

  -- Active acute-safety screening (same vocabulary the existing escalation
  -- / acute-safety model reads). Deliberately NO unable-to-recall flag:
  -- these resolve only by an explicit answer / the acute-safety workflow.
  sudden_or_sharp_pain        BOOLEAN NULL,
  pop_felt_or_heard           BOOLEAN NULL,
  new_functional_difficulty   BOOLEAN NULL,

  -- Existing non-safety contributor items, carried forward unchanged.
  contributor_reason          TEXT NULL CHECK (contributor_reason IS NULL OR contributor_reason IN (
    'specific_exercise', 'overall_session_too_much', 'symptoms_higher_before_start',
    'other_physical_activity', 'fatigue_poor_recovery', 'unsure', 'other'
  )),
  contributor_exercise_id     TEXT NULL,
  contributor_other_text      TEXT NULL,

  resolved_at                 TIMESTAMPTZ NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT session_immediate_responses_pain_unknown_not_value
    CHECK (NOT (peak_pain_unable_to_recall AND peak_session_pain IS NOT NULL)),
  CONSTRAINT session_immediate_responses_rpe_unknown_not_value
    CHECK (NOT (rpe_unable_to_recall AND overall_session_rpe IS NOT NULL)),
  -- Resolution requires every graded item answered or explicitly
  -- unable-to-recall, AND every safety item explicitly answered.
  CONSTRAINT session_immediate_responses_resolution_complete CHECK (
    resolved_at IS NULL OR (
      (peak_session_pain IS NOT NULL OR peak_pain_unable_to_recall)
      AND (overall_session_rpe IS NOT NULL OR rpe_unable_to_recall)
      AND sudden_or_sharp_pain IS NOT NULL
      AND pop_felt_or_heard IS NOT NULL
      AND new_functional_difficulty IS NOT NULL
    )
  ),
  CONSTRAINT session_immediate_responses_resolved_after_created CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE INDEX idx_session_immediate_responses_outstanding
  ON session_immediate_responses (user_id) WHERE resolved_at IS NULL;

CREATE TRIGGER trg_session_immediate_responses_updated_at
  BEFORE UPDATE ON session_immediate_responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE session_immediate_responses IS
  'C5 immediate post-session response obligation, one per closed C5 session. OUTSTANDING while resolved_at IS NULL; an outstanding row blocks the next Start (enforced by the C5.6C Start RPC, which checks resolution state, never symptom values). No Difficulty field: Session RPE replaces it for C5.';
COMMENT ON COLUMN session_immediate_responses.overall_session_rpe IS
  'Patient-reported overall Session Rate of Perceived Exertion (RPE), integer 0-10 — the ONLY stored Session RPE observation. Patient anchor words and the clinician descriptor are presentation derived from this number and are never stored. Distinct from the clinician-prescribed exercise target prescription_exercise_dosage.rpe.';
COMMENT ON COLUMN session_immediate_responses.sudden_or_sharp_pain IS
  'Active acute-safety screening answer. No unable-to-recall path exists for safety items.';

CREATE OR REPLACE FUNCTION trg_session_immediate_responses_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.rehab_session_id <> OLD.rehab_session_id OR NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION 'C5_RESPONSE_OWNER_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'C5_RESPONSE_RESOLVED_IMMUTABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT user_id, training_status INTO v_session FROM rehab_sessions WHERE id = NEW.rehab_session_id;
  IF v_session.training_status IS NULL OR v_session.training_status = 'started' THEN
    RAISE EXCEPTION 'C5_RESPONSE_REQUIRES_CLOSED_C5_SESSION' USING ERRCODE = 'P0001';
  END IF;
  IF v_session.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'C5_RESPONSE_USER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trg_session_immediate_responses_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_session_immediate_responses_guard
  BEFORE INSERT OR UPDATE ON session_immediate_responses
  FOR EACH ROW EXECUTE FUNCTION trg_session_immediate_responses_guard();

ALTER TABLE session_immediate_responses ENABLE ROW LEVEL SECURITY;

-- Read-only for patients and assigned clinicians; writes only via
-- SECURITY DEFINER RPCs (C5.6C) / service_role.
REVOKE ALL ON session_immediate_responses FROM anon, authenticated;
GRANT SELECT ON session_immediate_responses TO authenticated;

CREATE POLICY "session_immediate_responses: own read"
  ON session_immediate_responses FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "session_immediate_responses: clinician read assigned patient"
  ON session_immediate_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = session_immediate_responses.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

-- -----------------------------------------------------------------------------
-- 6. morning_responses — explicit resolution (answered | unable_to_recall).
--    Reference/intended morning = scheduled_eligible_at (frozen); actual =
--    submitted_at; timely vs retrospective is derived from these and the
--    session's patient_timezone, never stored.
-- -----------------------------------------------------------------------------
ALTER TABLE morning_responses ADD COLUMN resolution TEXT NULL;

ALTER TABLE morning_responses
  ADD CONSTRAINT morning_responses_resolution_check CHECK (
    resolution IS NULL OR resolution IN ('answered', 'unable_to_recall')
  ),
  ADD CONSTRAINT morning_responses_resolution_requires_submitted CHECK (
    resolution IS NULL OR submitted_at IS NOT NULL
  ),
  -- UNKNOWN != ZERO: an unable-to-recall morning carries no symptom values.
  ADD CONSTRAINT morning_responses_unable_to_recall_has_no_values CHECK (
    resolution IS DISTINCT FROM 'unable_to_recall' OR (
      next_morning_pain IS NULL AND next_morning_stiffness IS NULL
      AND stiffness_duration IS NULL AND morning_pain_tolerability IS NULL
    )
  ),
  ADD CONSTRAINT morning_responses_answered_has_values CHECK (
    resolution IS DISTINCT FROM 'answered' OR (
      next_morning_pain IS NOT NULL AND next_morning_stiffness IS NOT NULL
      AND (next_morning_stiffness = 0 OR stiffness_duration IS NOT NULL)
    )
  );

COMMENT ON COLUMN morning_responses.resolution IS
  'answered | unable_to_recall ("I don''t remember", available timely or retrospective). Required on every submitted C5 morning response; NULL on legacy rows (legacy resolution = submitted_at IS NOT NULL). unable_to_recall leaves every symptom value NULL.';
COMMENT ON COLUMN morning_responses.scheduled_eligible_at IS
  'Reference/intended morning: when the response became due (for C5: the morning after the training CLOSURE local date). Frozen once set. Timeliness is derived from this, submitted_at and the session patient_timezone.';

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

CREATE TRIGGER trg_morning_responses_c5_guard
  BEFORE INSERT OR UPDATE ON morning_responses
  FOR EACH ROW EXECUTE FUNCTION trg_morning_responses_c5_guard();

-- -----------------------------------------------------------------------------
-- 7. Patient write paths narrowed to LEGACY sessions only.
--    The legacy runtime keeps working byte-for-byte (its rows always have
--    training_status IS NULL — authenticated has no grant on that column).
--    C5 rows are unreachable by direct PostgREST writes.
-- -----------------------------------------------------------------------------
DROP POLICY "rehab_sessions: own insert" ON rehab_sessions;
CREATE POLICY "rehab_sessions: own insert"
  ON rehab_sessions FOR INSERT
  WITH CHECK (user_id = auth.uid() AND training_status IS NULL);

DROP POLICY "rehab_sessions: own update" ON rehab_sessions;
CREATE POLICY "rehab_sessions: own update"
  ON rehab_sessions FOR UPDATE
  USING (user_id = auth.uid() AND training_status IS NULL)
  WITH CHECK (user_id = auth.uid() AND training_status IS NULL);

DROP POLICY "set_outcomes: own insert" ON set_outcomes;
CREATE POLICY "set_outcomes: own insert"
  ON set_outcomes FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM rehab_sessions rs
            WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  );

DROP POLICY "set_outcomes: own update" ON set_outcomes;
CREATE POLICY "set_outcomes: own update"
  ON set_outcomes FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM rehab_sessions rs
            WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM rehab_sessions rs
            WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  );

-- set_outcomes previously had TABLE-level INSERT/UPDATE for authenticated,
-- which would extend to the new actual_* columns. Replace with column-level
-- grants on exactly the pre-existing columns (legacy upsert unchanged).
REVOKE INSERT, UPDATE ON set_outcomes FROM authenticated;
GRANT INSERT (
  id, rehab_session_id, exercise_id, exercise_order_index, set_index, outcome,
  prescribed_reps, prescribed_load, actual_reps, actual_load, was_edited, occurred_at, created_at
) ON set_outcomes TO authenticated;
GRANT UPDATE (
  id, rehab_session_id, exercise_id, exercise_order_index, set_index, outcome,
  prescribed_reps, prescribed_load, actual_reps, actual_load, was_edited, occurred_at, created_at
) ON set_outcomes TO authenticated;

DROP POLICY "morning_responses: own insert" ON morning_responses;
CREATE POLICY "morning_responses: own insert"
  ON morning_responses FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM rehab_sessions rs
                WHERE rs.id = morning_responses.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  );

DROP POLICY "morning_responses: own update" ON morning_responses;
CREATE POLICY "morning_responses: own update"
  ON morning_responses FOR UPDATE
  USING (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM rehab_sessions rs
                WHERE rs.id = morning_responses.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM rehab_sessions rs
                WHERE rs.id = morning_responses.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  );

DROP POLICY "session_events: own insert" ON session_events;
CREATE POLICY "session_events: own insert"
  ON session_events FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM rehab_sessions rs
            WHERE rs.id = session_events.rehab_session_id AND rs.user_id = auth.uid() AND rs.training_status IS NULL)
  );
