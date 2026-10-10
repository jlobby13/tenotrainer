-- =============================================================================
-- C5, Stage 4 — Authoring Revision A: Dosage Model & Compatibility.
-- Founder-locked decisions (Prescription Authoring UX Revision Audit,
-- followed by the Revision A authorization). This migration is
-- additive/constraint-replacement only:
--   - dosage_type is PRESERVED on all three dosage tables (reference,
--     template, prescription). It is never removed, never made nullable,
--     and no historical value is rewritten. It becomes a primary-dimension
--     / legacy-display hint only — it no longer GATES which other
--     dimensions may be populated (see the shape constraints below).
--   - Every dimension (reps, hold, contacts, distance, time/interval, load)
--     now validates independently of dosage_type and independently of
--     every other dimension — a row may legitimately populate more than
--     one at once (e.g. reps + hold, or reps + load), which the old
--     dosage_type-keyed XOR constraints structurally forbade.
--   - A new "at least one meaningful dimension" constraint replaces the old
--     per-type "sets required except time" rule (which was itself a
--     dosage_type-coupled artifact of the exclusive model). Verified
--     compatible with every existing row before being written (see the
--     implementation report).
--   - External load gains exact/range support (load_mode/load_value_min/
--     load_value_max), mirroring the existing reps/hold/contacts/distance
--     exact-range pattern exactly. load_value_exact is preserved
--     byte-for-byte, never renamed or migrated.
--   - canonical_exercises gains dosage_capabilities (TEXT[], constrained
--     vocabulary) — explicit, authoritative metadata for which specialized
--     dosage dimensions the future (Revision B) editor should normally
--     expose for a given exercise. Populated for all 47 existing global
--     exercises in this same migration; see the implementation report for
--     the exact per-exercise rationale.
--   - Every explicit dosage column-copy path (clone-active, clone-historical
--     via templates, from_template, publish) is updated so the three new
--     load columns survive copy/publish with no silent field loss.
--
-- Not touched by this migration: dosage_type's own CHECK/NOT NULL, any
-- existing row's values, template_performance_focus, workout/scheduling
-- logic (C5.4C, untouched), M6/session/legacy tables (out of scope,
-- verified to have zero dependency on this schema — see the implementation
-- report).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. canonical_exercises — dosage_capabilities. Constrained TEXT[] rather
--    than five boolean columns (founder preference). Vocabulary intentionally
--    covers only the specialized, formerly-mutually-exclusive dimensions
--    (reps/hold/contacts/distance/interval_time) — universal/shared
--    concepts (sets, load, rest, tempo, RPE/RIR, ROM, assistance, side) are
--    deliberately excluded, they were never gated by dosage_type in the
--    first place (see the audit). No index added: nothing in the current
--    codebase queries canonical_exercises by capability yet (Revision B
--    will read it by single exercise id, not filter by it) — adding one now
--    would be speculative, not justified by an existing query pattern.
-- -----------------------------------------------------------------------------
ALTER TABLE canonical_exercises
  ADD COLUMN dosage_capabilities TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_dosage_capabilities_vocabulary CHECK (
    dosage_capabilities <@ ARRAY['reps', 'hold', 'contacts', 'distance', 'interval_time']::TEXT[]
  );

COMMENT ON COLUMN canonical_exercises.dosage_capabilities IS
  'Explicit, authoritative set of specialized dosage dimensions the clinician editor should normally expose for this exercise (Revision B consumer). Loading Profile may inform a sensible default at content-authoring time, but this column is the resolved, queried-at-render-time source of truth — changing loading_profile does NOT automatically rewrite this column (no DB rule couples them, by founder decision). Universal dimensions (sets, load, rest, tempo, RPE/RIR, ROM, assistance, side) are never listed here — they are not gated by capability, they are always available.';

-- Conservative, evidence-based population for all 47 currently-global
-- exercises (see the implementation report for the exact per-exercise
-- rationale). Base rule: the exercise's existing exercise_reference_dosage
-- row's dosage_type maps directly to one capability (repetition->reps,
-- hold->hold, contact->contacts, time->interval_time, distance->distance).
-- The ONE evidence-based addition beyond that direct mapping: every
-- loading_profile='isometric' exercise (ex_001-004, ex_006 — all
-- hold-type today) ALSO gets 'reps', the explicit founder-named motivating
-- case (isometric holds are routinely also dosed by a rep count, e.g. "3
-- reps of 45s hold"). No other exercise receives a second capability —
-- distance/contacts/interval_time are never added speculatively. ex_040 has
-- no reference dosage row at all (confirmed, not merely null fields); it is
-- assigned 'hold' alone as the single most clinically plausible capability
-- for a balance/frontal-plane control drill, flagged in the implementation
-- report as the one genuinely judgment-call assignment for founder review.
UPDATE canonical_exercises SET dosage_capabilities = ARRAY['hold', 'reps']
  WHERE legacy_ex_id IN ('ex_001', 'ex_002', 'ex_003', 'ex_004', 'ex_006');

UPDATE canonical_exercises SET dosage_capabilities = ARRAY['reps']
  WHERE legacy_ex_id IN (
    'ex_005', 'ex_007', 'ex_008', 'ex_009', 'ex_010', 'ex_011', 'ex_012', 'ex_013', 'ex_014',
    'ex_015', 'ex_016', 'ex_017', 'ex_018', 'ex_019', 'ex_020', 'ex_021', 'ex_022', 'ex_023',
    'ex_024', 'ex_025', 'ex_037', 'ex_038', 'ex_039'
  );

UPDATE canonical_exercises SET dosage_capabilities = ARRAY['interval_time']
  WHERE legacy_ex_id IN ('ex_026', 'ex_033', 'ex_034', 'ex_036');

UPDATE canonical_exercises SET dosage_capabilities = ARRAY['contacts']
  WHERE legacy_ex_id IN ('ex_027', 'ex_028', 'ex_029', 'ex_030', 'ex_031', 'ex_032');

UPDATE canonical_exercises SET dosage_capabilities = ARRAY['distance']
  WHERE legacy_ex_id IN ('ex_035');

UPDATE canonical_exercises SET dosage_capabilities = ARRAY['hold']
  WHERE legacy_ex_id IN ('ex_040', 'ex_041', 'ex_042', 'ex_043', 'ex_044', 'ex_045', 'ex_046', 'ex_047');

-- -----------------------------------------------------------------------------
-- 2. Load range columns — added identically to all three dosage tables.
--    load_value_exact is PRESERVED, never renamed. load_mode NULL is
--    treated as implicitly 'exact' by the new shape constraint below
--    specifically so that not one existing row needs an UPDATE to remain
--    valid — zero historical rows are touched by this section.
--    load_value_kg_derived (existing, exact-only) is UNCHANGED and untouched
--    — never overloaded to represent a range. Two NEW, separate derived
--    columns carry the range's own normalized bounds.
-- -----------------------------------------------------------------------------
ALTER TABLE prescription_exercise_dosage
  ADD COLUMN load_mode      TEXT NULL CHECK (load_mode IS NULL OR load_mode IN ('exact', 'range')),
  ADD COLUMN load_value_min NUMERIC NULL CHECK (load_value_min IS NULL OR load_value_min > 0),
  ADD COLUMN load_value_max NUMERIC NULL CHECK (load_value_max IS NULL OR load_value_max > 0),
  ADD COLUMN load_value_min_kg_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_min IS NOT NULL AND load_unit = 'kg' THEN load_value_min
      WHEN load_type = 'external' AND load_value_min IS NOT NULL AND load_unit = 'lb' THEN round(load_value_min * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN load_value_max_kg_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_max IS NOT NULL AND load_unit = 'kg' THEN load_value_max
      WHEN load_type = 'external' AND load_value_max IS NOT NULL AND load_unit = 'lb' THEN round(load_value_max * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED;

ALTER TABLE template_exercise_dosage
  ADD COLUMN load_mode      TEXT NULL CHECK (load_mode IS NULL OR load_mode IN ('exact', 'range')),
  ADD COLUMN load_value_min NUMERIC NULL CHECK (load_value_min IS NULL OR load_value_min > 0),
  ADD COLUMN load_value_max NUMERIC NULL CHECK (load_value_max IS NULL OR load_value_max > 0),
  ADD COLUMN load_value_min_kg_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_min IS NOT NULL AND load_unit = 'kg' THEN load_value_min
      WHEN load_type = 'external' AND load_value_min IS NOT NULL AND load_unit = 'lb' THEN round(load_value_min * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN load_value_max_kg_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_max IS NOT NULL AND load_unit = 'kg' THEN load_value_max
      WHEN load_type = 'external' AND load_value_max IS NOT NULL AND load_unit = 'lb' THEN round(load_value_max * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED;

ALTER TABLE exercise_reference_dosage
  ADD COLUMN load_mode      TEXT NULL CHECK (load_mode IS NULL OR load_mode IN ('exact', 'range')),
  ADD COLUMN load_value_min NUMERIC NULL CHECK (load_value_min IS NULL OR load_value_min > 0),
  ADD COLUMN load_value_max NUMERIC NULL CHECK (load_value_max IS NULL OR load_value_max > 0),
  ADD COLUMN load_value_min_kg_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_min IS NOT NULL AND load_unit = 'kg' THEN load_value_min
      WHEN load_type = 'external' AND load_value_min IS NOT NULL AND load_unit = 'lb' THEN round(load_value_min * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED,
  ADD COLUMN load_value_max_kg_derived NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_max IS NOT NULL AND load_unit = 'kg' THEN load_value_max
      WHEN load_type = 'external' AND load_value_max IS NOT NULL AND load_unit = 'lb' THEN round(load_value_max * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED;

-- -----------------------------------------------------------------------------
-- 3. Constraint redesign — replace every dosage_type-keyed XOR shape
--    constraint with an independent, dosage_type-agnostic one per
--    dimension, on all three tables. Each dimension's "populated" branch is
--    byte-identical in its internal exact/range correctness rules to the
--    constraint it replaces — only the "AND dosage_type = 'x'" /
--    "dosage_type != 'x'" coupling is removed. The old
--    "*_sets_required_except_time" rule is dropped outright (it was itself
--    dosage_type-coupled) and replaced by the new "at least one dimension"
--    rule below, verified against every existing row before being added.
-- -----------------------------------------------------------------------------

-- ---- prescription_exercise_dosage ----
ALTER TABLE prescription_exercise_dosage
  DROP CONSTRAINT dosage_sets_required_except_time,
  DROP CONSTRAINT dosage_reps_shape,
  DROP CONSTRAINT dosage_contacts_shape,
  DROP CONSTRAINT dosage_hold_shape,
  DROP CONSTRAINT dosage_time_shape,
  DROP CONSTRAINT dosage_load_shape,
  DROP CONSTRAINT dosage_distance_shape;

ALTER TABLE prescription_exercise_dosage
  ADD CONSTRAINT dosage_reps_shape CHECK (
    (reps_mode IS NULL AND reps_exact IS NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (reps_mode = 'exact' AND reps_exact IS NOT NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (reps_mode = 'range' AND reps_min IS NOT NULL AND reps_max IS NOT NULL AND reps_exact IS NULL AND reps_max >= reps_min)
  ),
  ADD CONSTRAINT dosage_contacts_shape CHECK (
    (contacts_mode IS NULL AND contacts_exact IS NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (contacts_mode = 'exact' AND contacts_exact IS NOT NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (contacts_mode = 'range' AND contacts_min IS NOT NULL AND contacts_max IS NOT NULL AND contacts_exact IS NULL AND contacts_max >= contacts_min)
  ),
  ADD CONSTRAINT dosage_hold_shape CHECK (
    (hold_duration_mode IS NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (hold_duration_mode = 'exact' AND hold_duration_exact_seconds IS NOT NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (hold_duration_mode = 'range' AND hold_duration_min_seconds IS NOT NULL AND hold_duration_max_seconds IS NOT NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_max_seconds >= hold_duration_min_seconds)
  ),
  ADD CONSTRAINT dosage_time_shape CHECK (
    (time_duration_mode IS NULL AND time_duration_exact_seconds IS NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
    OR (time_duration_mode = 'exact' AND time_duration_exact_seconds IS NOT NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
    OR (time_duration_mode = 'range' AND time_duration_min_seconds IS NOT NULL AND time_duration_max_seconds IS NOT NULL AND time_duration_exact_seconds IS NULL AND time_duration_max_seconds >= time_duration_min_seconds)
  ),
  ADD CONSTRAINT dosage_distance_shape CHECK (
    (distance_mode IS NULL AND distance_exact_value IS NULL AND distance_min_value IS NULL AND distance_max_value IS NULL AND distance_unit IS NULL)
    OR (distance_mode IS NOT NULL AND distance_unit IS NOT NULL AND (
      (distance_mode = 'exact' AND distance_exact_value IS NOT NULL AND distance_min_value IS NULL AND distance_max_value IS NULL)
      OR (distance_mode = 'range' AND distance_min_value IS NOT NULL AND distance_max_value IS NOT NULL AND distance_exact_value IS NULL AND distance_max_value >= distance_min_value)
    ))
  ),
  ADD CONSTRAINT dosage_load_shape CHECK (
    (load_type != 'external' AND load_mode IS NULL AND load_value_exact IS NULL AND load_value_min IS NULL AND load_value_max IS NULL AND load_unit IS NULL)
    OR (load_type = 'external' AND load_unit IS NOT NULL AND (
      ((load_mode IS NULL OR load_mode = 'exact') AND load_value_exact IS NOT NULL AND load_value_min IS NULL AND load_value_max IS NULL)
      OR (load_mode = 'range' AND load_value_min IS NOT NULL AND load_value_max IS NOT NULL AND load_value_exact IS NULL AND load_value_max >= load_value_min)
    ))
  ),
  ADD CONSTRAINT dosage_at_least_one_dimension CHECK (
    sets IS NOT NULL
    OR reps_mode IS NOT NULL
    OR hold_duration_mode IS NOT NULL
    OR contacts_mode IS NOT NULL
    OR distance_mode IS NOT NULL
    OR time_duration_mode IS NOT NULL
    OR interval_work_seconds IS NOT NULL
    OR interval_recovery_seconds IS NOT NULL
    OR interval_rounds IS NOT NULL
    OR load_type != 'not_applicable'
  );

-- ---- template_exercise_dosage (identical redesign) ----
ALTER TABLE template_exercise_dosage
  DROP CONSTRAINT template_dosage_sets_required_except_time,
  DROP CONSTRAINT template_dosage_reps_shape,
  DROP CONSTRAINT template_dosage_contacts_shape,
  DROP CONSTRAINT template_dosage_hold_shape,
  DROP CONSTRAINT template_dosage_time_shape,
  DROP CONSTRAINT template_dosage_load_shape,
  DROP CONSTRAINT template_dosage_distance_shape;

ALTER TABLE template_exercise_dosage
  ADD CONSTRAINT template_dosage_reps_shape CHECK (
    (reps_mode IS NULL AND reps_exact IS NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (reps_mode = 'exact' AND reps_exact IS NOT NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (reps_mode = 'range' AND reps_min IS NOT NULL AND reps_max IS NOT NULL AND reps_exact IS NULL AND reps_max >= reps_min)
  ),
  ADD CONSTRAINT template_dosage_contacts_shape CHECK (
    (contacts_mode IS NULL AND contacts_exact IS NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (contacts_mode = 'exact' AND contacts_exact IS NOT NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (contacts_mode = 'range' AND contacts_min IS NOT NULL AND contacts_max IS NOT NULL AND contacts_exact IS NULL AND contacts_max >= contacts_min)
  ),
  ADD CONSTRAINT template_dosage_hold_shape CHECK (
    (hold_duration_mode IS NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (hold_duration_mode = 'exact' AND hold_duration_exact_seconds IS NOT NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (hold_duration_mode = 'range' AND hold_duration_min_seconds IS NOT NULL AND hold_duration_max_seconds IS NOT NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_max_seconds >= hold_duration_min_seconds)
  ),
  ADD CONSTRAINT template_dosage_time_shape CHECK (
    (time_duration_mode IS NULL AND time_duration_exact_seconds IS NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
    OR (time_duration_mode = 'exact' AND time_duration_exact_seconds IS NOT NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
    OR (time_duration_mode = 'range' AND time_duration_min_seconds IS NOT NULL AND time_duration_max_seconds IS NOT NULL AND time_duration_exact_seconds IS NULL AND time_duration_max_seconds >= time_duration_min_seconds)
  ),
  ADD CONSTRAINT template_dosage_distance_shape CHECK (
    (distance_mode IS NULL AND distance_exact_value IS NULL AND distance_min_value IS NULL AND distance_max_value IS NULL AND distance_unit IS NULL)
    OR (distance_mode IS NOT NULL AND distance_unit IS NOT NULL AND (
      (distance_mode = 'exact' AND distance_exact_value IS NOT NULL AND distance_min_value IS NULL AND distance_max_value IS NULL)
      OR (distance_mode = 'range' AND distance_min_value IS NOT NULL AND distance_max_value IS NOT NULL AND distance_exact_value IS NULL AND distance_max_value >= distance_min_value)
    ))
  ),
  ADD CONSTRAINT template_dosage_load_shape CHECK (
    (load_type != 'external' AND load_mode IS NULL AND load_value_exact IS NULL AND load_value_min IS NULL AND load_value_max IS NULL AND load_unit IS NULL)
    OR (load_type = 'external' AND load_unit IS NOT NULL AND (
      ((load_mode IS NULL OR load_mode = 'exact') AND load_value_exact IS NOT NULL AND load_value_min IS NULL AND load_value_max IS NULL)
      OR (load_mode = 'range' AND load_value_min IS NOT NULL AND load_value_max IS NOT NULL AND load_value_exact IS NULL AND load_value_max >= load_value_min)
    ))
  ),
  ADD CONSTRAINT template_dosage_at_least_one_dimension CHECK (
    sets IS NOT NULL
    OR reps_mode IS NOT NULL
    OR hold_duration_mode IS NOT NULL
    OR contacts_mode IS NOT NULL
    OR distance_mode IS NOT NULL
    OR time_duration_mode IS NOT NULL
    OR interval_work_seconds IS NOT NULL
    OR interval_recovery_seconds IS NOT NULL
    OR interval_rounds IS NOT NULL
    OR load_type != 'not_applicable'
  );

-- ---- exercise_reference_dosage (identical redesign; no rest_seconds/tempo/
--      RPE/etc. columns exist here beyond what 20260922000001 already added,
--      untouched) ----
ALTER TABLE exercise_reference_dosage
  DROP CONSTRAINT ref_dosage_sets_required_except_time,
  DROP CONSTRAINT ref_dosage_reps_shape,
  DROP CONSTRAINT ref_dosage_contacts_shape,
  DROP CONSTRAINT ref_dosage_hold_shape,
  DROP CONSTRAINT ref_dosage_time_shape,
  DROP CONSTRAINT ref_dosage_load_shape,
  DROP CONSTRAINT ref_dosage_distance_shape;

ALTER TABLE exercise_reference_dosage
  ADD CONSTRAINT ref_dosage_reps_shape CHECK (
    (reps_mode IS NULL AND reps_exact IS NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (reps_mode = 'exact' AND reps_exact IS NOT NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (reps_mode = 'range' AND reps_min IS NOT NULL AND reps_max IS NOT NULL AND reps_exact IS NULL AND reps_max >= reps_min)
  ),
  ADD CONSTRAINT ref_dosage_contacts_shape CHECK (
    (contacts_mode IS NULL AND contacts_exact IS NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (contacts_mode = 'exact' AND contacts_exact IS NOT NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (contacts_mode = 'range' AND contacts_min IS NOT NULL AND contacts_max IS NOT NULL AND contacts_exact IS NULL AND contacts_max >= contacts_min)
  ),
  ADD CONSTRAINT ref_dosage_hold_shape CHECK (
    (hold_duration_mode IS NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (hold_duration_mode = 'exact' AND hold_duration_exact_seconds IS NOT NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (hold_duration_mode = 'range' AND hold_duration_min_seconds IS NOT NULL AND hold_duration_max_seconds IS NOT NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_max_seconds >= hold_duration_min_seconds)
  ),
  ADD CONSTRAINT ref_dosage_time_shape CHECK (
    (time_duration_mode IS NULL AND time_duration_exact_seconds IS NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
    OR (time_duration_mode = 'exact' AND time_duration_exact_seconds IS NOT NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
    OR (time_duration_mode = 'range' AND time_duration_min_seconds IS NOT NULL AND time_duration_max_seconds IS NOT NULL AND time_duration_exact_seconds IS NULL AND time_duration_max_seconds >= time_duration_min_seconds)
  ),
  ADD CONSTRAINT ref_dosage_distance_shape CHECK (
    (distance_mode IS NULL AND distance_exact_value IS NULL AND distance_min_value IS NULL AND distance_max_value IS NULL AND distance_unit IS NULL)
    OR (distance_mode IS NOT NULL AND distance_unit IS NOT NULL AND (
      (distance_mode = 'exact' AND distance_exact_value IS NOT NULL AND distance_min_value IS NULL AND distance_max_value IS NULL)
      OR (distance_mode = 'range' AND distance_min_value IS NOT NULL AND distance_max_value IS NOT NULL AND distance_exact_value IS NULL AND distance_max_value >= distance_min_value)
    ))
  ),
  ADD CONSTRAINT ref_dosage_load_shape CHECK (
    (load_type != 'external' AND load_mode IS NULL AND load_value_exact IS NULL AND load_value_min IS NULL AND load_value_max IS NULL AND load_unit IS NULL)
    OR (load_type = 'external' AND load_unit IS NOT NULL AND (
      ((load_mode IS NULL OR load_mode = 'exact') AND load_value_exact IS NOT NULL AND load_value_min IS NULL AND load_value_max IS NULL)
      OR (load_mode = 'range' AND load_value_min IS NOT NULL AND load_value_max IS NOT NULL AND load_value_exact IS NULL AND load_value_max >= load_value_min)
    ))
  ),
  ADD CONSTRAINT ref_dosage_at_least_one_dimension CHECK (
    sets IS NOT NULL
    OR reps_mode IS NOT NULL
    OR hold_duration_mode IS NOT NULL
    OR contacts_mode IS NOT NULL
    OR distance_mode IS NOT NULL
    OR time_duration_mode IS NOT NULL
    OR interval_work_seconds IS NOT NULL
    OR interval_recovery_seconds IS NOT NULL
    OR interval_rounds IS NOT NULL
    OR load_type != 'not_applicable'
  );

-- -----------------------------------------------------------------------------
-- 4. Copy-path functions — CREATE OR REPLACE so the three new load columns
--    (load_mode, load_value_min, load_value_max) survive every explicit
--    dosage column-copy path. load_value_kg_derived/load_value_min_kg_
--    derived/load_value_max_kg_derived are GENERATED columns and are never
--    listed in an INSERT column list (Postgres computes them). Every other
--    column and every other line of logic in these three functions is
--    byte-identical to their current (20260920000001 / 20260927000001)
--    bodies — only the load column-list insertion changed.
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
    rest_seconds, load_type, load_value_exact, load_unit, load_mode, load_value_min, load_value_max,
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
    td.rest_seconds, td.load_type, td.load_value_exact, td.load_unit, td.load_mode, td.load_value_min, td.load_value_max,
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

  -- UNCHANGED from 20260917000001 (C5.4C §8 — sequence-state behavior is
  -- explicitly preserved, not modified by Revision A either).
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
