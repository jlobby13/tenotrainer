-- =============================================================================
-- C5, Stage 3F — Canonical Exercise Model Finalization (founder-approved,
-- with the locked modification to preserve canonical clinical metadata now
-- rather than deferring it). Prepares the schema for the future 47-exercise
-- seed — this migration inserts ZERO exercise rows and does not touch
-- app/data/exercise_library.json.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Loading-profile vocabulary — first-ever CHECK on this column (it was
-- deliberately unconstrained in 20260916000001). Column stays nullable.
-- -----------------------------------------------------------------------------
ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_loading_profile_check CHECK (
    loading_profile IS NULL OR loading_profile IN (
      'isometric', 'concentric_eccentric', 'eccentric_biased', 'heavy_dynamic',
      'fast_dynamic', 'reactive_strength', 'explosive_strength', 'stretching', 'return_to_run'
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Library laterality — widen to include `both` (a movement whose own
-- definition requires both sides in sequence, e.g. alternating drills or a
-- paired bilateral+unilateral stretch offering) — distinct from `bilateral`
-- (both sides simultaneously). This is EXERCISE-LIBRARY classification
-- only; prescription_exercise_dosage.side (bilateral/left/right/
-- both_sides_separately/not_applicable) is a separate, patient-specific
-- prescribing choice and is NOT altered by this migration.
-- -----------------------------------------------------------------------------
ALTER TABLE canonical_exercises DROP CONSTRAINT canonical_exercises_unilateral_bilateral_check;
ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_unilateral_bilateral_check CHECK (
    unilateral_bilateral IS NULL OR unilateral_bilateral IN ('unilateral', 'bilateral', 'both', 'not_applicable')
  );

COMMENT ON COLUMN canonical_exercises.unilateral_bilateral IS
  'Exercise-LIBRARY classification of the movement pattern itself (does this exercise, by its own definition, involve one side, both sides together, or both sides in sequence). Distinct from prescription_exercise_dosage.side, which is the patient-specific side a clinician prescribes for one exercise within one prescription — never conflate the two. `both` means the exercise inherently requires both sides as part of its own definition (e.g. an alternating drill), which is a different concept from `bilateral` (both sides simultaneously).';

-- -----------------------------------------------------------------------------
-- 3. Structured execution cues — TEXT -> TEXT[]. Table has zero production
-- rows today; USING clause is written defensively (not merely relying on
-- emptiness) so it is correct even if ever run against a populated table.
-- Future seed must preserve legacy execution_cues[] order exactly (append,
-- never reorder/sort).
-- -----------------------------------------------------------------------------
ALTER TABLE canonical_exercises
  ALTER COLUMN execution_cues TYPE TEXT[] USING (
    CASE WHEN execution_cues IS NULL THEN NULL ELSE ARRAY[execution_cues] END
  );

-- -----------------------------------------------------------------------------
-- 4. Canonical clinical/library metadata — added NOW per the founder's
-- locked modification (not deferred). Natural existing legacy shape
-- preserved per field; no new vocabulary/CHECK invented for the
-- enum-shaped legacy fields below (category/impact_level/rate_of_loading/
-- requires_dorsiflexion_depth/max_load_potential) since the founder did not
-- lock a specific vocabulary for these the way loading_profile/
-- unilateral_bilateral were locked — adding a CHECK here would invent
-- clinical semantics not explicitly approved. Left as free TEXT, nullable,
-- matching loading_profile's own original C5.2 treatment before this
-- migration's amendment.
-- -----------------------------------------------------------------------------
-- `category` already exists (provisioned in 20260916000001) — not re-added
-- here, left exactly as-is (free TEXT, nullable).
ALTER TABLE canonical_exercises
  ADD COLUMN difficulty_level             INTEGER NULL,
  ADD COLUMN target_tissues               TEXT[] NULL,
  ADD COLUMN region_bias                  TEXT[] NULL,
  ADD COLUMN impact_level                 TEXT NULL,
  ADD COLUMN stretch_shortening_cycle     BOOLEAN NULL,
  ADD COLUMN rate_of_loading              TEXT NULL,
  ADD COLUMN requires_full_rom            BOOLEAN NULL,
  ADD COLUMN requires_dorsiflexion_depth  TEXT NULL,
  ADD COLUMN max_load_potential           TEXT NULL,
  ADD COLUMN common_compensations         TEXT[] NULL,
  ADD COLUMN contraindications_or_cautions TEXT NULL,
  ADD COLUMN clinician_notes              TEXT NULL;

COMMENT ON COLUMN canonical_exercises.target_tissues IS
  'Exercise-library metadata. Future seed converts the legacy comma-separated target_tissue string into this array via a deterministic split-and-trim only — no merging, renaming, inferring, removing, or reordering of tissue names. Any further normalization is explicit superuser/clinical review, never an automatic re-seed.';
COMMENT ON COLUMN canonical_exercises.common_compensations IS
  'Exercise-library metadata (movement faults to watch for). Future seed preserves legacy array order and wording verbatim.';

-- decision_rules_tags, progression_options, regression_options are
-- deliberately NOT added. decision_rules_tags remains a legacy JSON/SQLite-
-- side concept through the C5.6 boundary (its WBLT-relevant tags keep
-- driving stretch selection there, entirely unaffected by this migration,
-- since that pipeline never reads canonical_exercises); how (or whether)
-- C5.6 reproduces that behavior against the Postgres-native model is an
-- explicit future design question, not resolved here. progression_options/
-- regression_options belong to the retired GO/STAY/CAUTION/STOP engine and
-- are not carried forward.

-- -----------------------------------------------------------------------------
-- 5. Distance dosage type — identical shape across all three dosage
-- tables. Preserves the authored value/unit; the derived meters value is
-- secondary/comparison-only (GENERATED, never authoritative, never
-- overwrites the authored value) — same philosophy as load_value_kg_derived.
-- -----------------------------------------------------------------------------

-- prescription_exercise_dosage
ALTER TABLE prescription_exercise_dosage DROP CONSTRAINT prescription_exercise_dosage_dosage_type_check;
ALTER TABLE prescription_exercise_dosage
  ADD CONSTRAINT prescription_exercise_dosage_dosage_type_check CHECK (
    dosage_type IN ('repetition', 'hold', 'time', 'contact', 'distance')
  );
ALTER TABLE prescription_exercise_dosage
  ADD COLUMN distance_mode          TEXT NULL CHECK (distance_mode IS NULL OR distance_mode IN ('exact', 'range')),
  ADD COLUMN distance_exact_value   NUMERIC NULL CHECK (distance_exact_value IS NULL OR distance_exact_value > 0),
  ADD COLUMN distance_min_value     NUMERIC NULL CHECK (distance_min_value IS NULL OR distance_min_value > 0),
  ADD COLUMN distance_max_value     NUMERIC NULL CHECK (distance_max_value IS NULL OR distance_max_value > 0),
  ADD COLUMN distance_unit          TEXT NULL CHECK (distance_unit IS NULL OR distance_unit IN ('m', 'km', 'ft', 'mi')),
  ADD COLUMN distance_value_m_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN distance_exact_value IS NOT NULL AND distance_unit IS NOT NULL THEN
        distance_exact_value * CASE distance_unit
          WHEN 'm' THEN 1 WHEN 'km' THEN 1000 WHEN 'ft' THEN 0.3048 WHEN 'mi' THEN 1609.344
        END
      ELSE NULL
    END
  ) STORED;
ALTER TABLE prescription_exercise_dosage
  ADD CONSTRAINT dosage_distance_shape CHECK (
    (dosage_type != 'distance' AND distance_mode IS NULL AND distance_exact_value IS NULL AND distance_min_value IS NULL AND distance_max_value IS NULL AND distance_unit IS NULL)
    OR (dosage_type = 'distance' AND distance_unit IS NOT NULL AND (
      (distance_mode = 'exact' AND distance_exact_value IS NOT NULL AND distance_min_value IS NULL AND distance_max_value IS NULL)
      OR (distance_mode = 'range' AND distance_min_value IS NOT NULL AND distance_max_value IS NOT NULL AND distance_exact_value IS NULL AND distance_max_value >= distance_min_value)
    ))
  );
-- dosage_sets_required_except_time already requires sets for every type
-- except 'time' — 'distance' correctly inherits that requirement with no
-- change needed to that existing constraint.

-- exercise_reference_dosage
ALTER TABLE exercise_reference_dosage DROP CONSTRAINT exercise_reference_dosage_dosage_type_check;
ALTER TABLE exercise_reference_dosage
  ADD CONSTRAINT exercise_reference_dosage_dosage_type_check CHECK (
    dosage_type IN ('repetition', 'hold', 'time', 'contact', 'distance')
  );
ALTER TABLE exercise_reference_dosage
  ADD COLUMN distance_mode          TEXT NULL CHECK (distance_mode IS NULL OR distance_mode IN ('exact', 'range')),
  ADD COLUMN distance_exact_value   NUMERIC NULL CHECK (distance_exact_value IS NULL OR distance_exact_value > 0),
  ADD COLUMN distance_min_value     NUMERIC NULL CHECK (distance_min_value IS NULL OR distance_min_value > 0),
  ADD COLUMN distance_max_value     NUMERIC NULL CHECK (distance_max_value IS NULL OR distance_max_value > 0),
  ADD COLUMN distance_unit          TEXT NULL CHECK (distance_unit IS NULL OR distance_unit IN ('m', 'km', 'ft', 'mi')),
  ADD COLUMN distance_value_m_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN distance_exact_value IS NOT NULL AND distance_unit IS NOT NULL THEN
        distance_exact_value * CASE distance_unit
          WHEN 'm' THEN 1 WHEN 'km' THEN 1000 WHEN 'ft' THEN 0.3048 WHEN 'mi' THEN 1609.344
        END
      ELSE NULL
    END
  ) STORED;
ALTER TABLE exercise_reference_dosage
  ADD CONSTRAINT ref_dosage_distance_shape CHECK (
    (dosage_type != 'distance' AND distance_mode IS NULL AND distance_exact_value IS NULL AND distance_min_value IS NULL AND distance_max_value IS NULL AND distance_unit IS NULL)
    OR (dosage_type = 'distance' AND distance_unit IS NOT NULL AND (
      (distance_mode = 'exact' AND distance_exact_value IS NOT NULL AND distance_min_value IS NULL AND distance_max_value IS NULL)
      OR (distance_mode = 'range' AND distance_min_value IS NOT NULL AND distance_max_value IS NOT NULL AND distance_exact_value IS NULL AND distance_max_value >= distance_min_value)
    ))
  );

-- template_exercise_dosage
ALTER TABLE template_exercise_dosage DROP CONSTRAINT template_exercise_dosage_dosage_type_check;
ALTER TABLE template_exercise_dosage
  ADD CONSTRAINT template_exercise_dosage_dosage_type_check CHECK (
    dosage_type IN ('repetition', 'hold', 'time', 'contact', 'distance')
  );
ALTER TABLE template_exercise_dosage
  ADD COLUMN distance_mode          TEXT NULL CHECK (distance_mode IS NULL OR distance_mode IN ('exact', 'range')),
  ADD COLUMN distance_exact_value   NUMERIC NULL CHECK (distance_exact_value IS NULL OR distance_exact_value > 0),
  ADD COLUMN distance_min_value     NUMERIC NULL CHECK (distance_min_value IS NULL OR distance_min_value > 0),
  ADD COLUMN distance_max_value     NUMERIC NULL CHECK (distance_max_value IS NULL OR distance_max_value > 0),
  ADD COLUMN distance_unit          TEXT NULL CHECK (distance_unit IS NULL OR distance_unit IN ('m', 'km', 'ft', 'mi')),
  ADD COLUMN distance_value_m_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN distance_exact_value IS NOT NULL AND distance_unit IS NOT NULL THEN
        distance_exact_value * CASE distance_unit
          WHEN 'm' THEN 1 WHEN 'km' THEN 1000 WHEN 'ft' THEN 0.3048 WHEN 'mi' THEN 1609.344
        END
      ELSE NULL
    END
  ) STORED;
ALTER TABLE template_exercise_dosage
  ADD CONSTRAINT template_dosage_distance_shape CHECK (
    (dosage_type != 'distance' AND distance_mode IS NULL AND distance_exact_value IS NULL AND distance_min_value IS NULL AND distance_max_value IS NULL AND distance_unit IS NULL)
    OR (dosage_type = 'distance' AND distance_unit IS NOT NULL AND (
      (distance_mode = 'exact' AND distance_exact_value IS NOT NULL AND distance_min_value IS NULL AND distance_max_value IS NULL)
      OR (distance_mode = 'range' AND distance_min_value IS NOT NULL AND distance_max_value IS NOT NULL AND distance_exact_value IS NULL AND distance_max_value >= distance_min_value)
    ))
  );

-- -----------------------------------------------------------------------------
-- 6. Mandatory C5.3 engine co-change — every function that explicitly
-- enumerates dosage columns must include the six new distance columns or
-- distance data is silently dropped on copy/publish. Every other line in
-- these three functions is byte-identical to 20260917000001/20260918000001.
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
  JOIN prescription_workouts ow ON ow.id = oe.prescription_workout_id AND ow.prescription_version_id = p_version_id
  JOIN prescription_workouts nw ON nw.prescription_draft_id = p_draft_id AND nw.order_index = ow.order_index
  JOIN prescription_exercises ne ON ne.prescription_workout_id = nw.id AND ne.order_index = oe.order_index;
END;
$$;
REVOKE ALL ON FUNCTION copy_prescription_version_content_into_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;

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
    distance_mode, distance_exact_value, distance_min_value, distance_max_value, distance_unit,
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
    td.distance_mode, td.distance_exact_value, td.distance_min_value, td.distance_max_value, td.distance_unit,
    td.concentric_duration_seconds, td.rep_hold_duration_seconds, td.eccentric_duration_seconds, td.tempo_description,
    td.rest_seconds, td.load_type, td.load_value_exact, td.load_unit,
    td.rpe, td.rir, td.rom, td.assistance_level, td.side
  FROM template_exercise_dosage td
  JOIN template_exercises te ON te.id = td.template_exercise_id
  JOIN template_workouts tw ON tw.id = te.template_workout_id AND tw.template_id = p_template_id
  JOIN prescription_workouts nw ON nw.prescription_draft_id = p_draft_id AND nw.order_index = tw.order_index
  JOIN prescription_exercises ne ON ne.prescription_workout_id = nw.id AND ne.order_index = te.order_index;

  INSERT INTO prescription_draft_performance_focus (prescription_draft_id, focus)
  SELECT p_draft_id, focus FROM template_performance_focus WHERE template_id = p_template_id;
END;
$$;
REVOKE ALL ON FUNCTION copy_template_content_into_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;

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
