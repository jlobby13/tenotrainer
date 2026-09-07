-- =============================================================================
-- Milestone 4, Stage 4: single-session tolerance interpretation.
--
-- Extends morning_responses with the two additional raw observations Stage 4
-- requires (stiffness duration, a conditional pain-tolerability
-- clarification) and lightweight external-loading context, and extends
-- tolerance_evaluations (created empty in Stage 1) with the fields needed to
-- persist a real, versioned, reproducible evaluation.
--
-- No existing column is altered or removed. All new columns are nullable
-- (UNKNOWN != ZERO — an unasked/unanswered field stays NULL, never a
-- fabricated default) except tolerance_evaluations' NOT NULL columns, which
-- mirror the already-established pattern for that table (every column on a
-- freshly-computed evaluation row is known by construction — there is no
-- "unanswered" state for a row that only gets inserted once the evaluator
-- has actually run).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- morning_responses: stiffness duration, pain tolerability, external context
-- ---------------------------------------------------------------------------
ALTER TABLE morning_responses
  ADD COLUMN stiffness_duration TEXT,
  ADD COLUMN morning_pain_tolerability TEXT,
  ADD COLUMN external_load_categories TEXT[],
  ADD COLUMN external_load_timing TEXT[];

ALTER TABLE morning_responses
  ADD CONSTRAINT morning_responses_stiffness_duration_check
  CHECK (stiffness_duration IS NULL OR stiffness_duration IN (
    'not_applicable', 'lt_5_min', 'min_5_15', 'min_15_30', 'gt_30_min'
  ));

ALTER TABLE morning_responses
  ADD CONSTRAINT morning_responses_tolerability_check
  CHECK (morning_pain_tolerability IS NULL OR morning_pain_tolerability IN (
    'manageable', 'difficult_to_tolerate'
  ));

-- external_load_categories: NULL means "not asked/answered yet" (UNKNOWN);
-- an explicit ['none'] means the patient was asked and confirmed nothing
-- relevant happened — these are deliberately distinct, never conflated.
ALTER TABLE morning_responses
  ADD CONSTRAINT morning_responses_external_load_categories_check
  CHECK (external_load_categories IS NULL OR external_load_categories <@ ARRAY[
    'running', 'sport', 'prolonged_walking_standing', 'other_lower_body_training',
    'unusually_high_activity', 'other', 'none'
  ]::TEXT[]);

ALTER TABLE morning_responses
  ADD CONSTRAINT morning_responses_external_load_timing_check
  CHECK (external_load_timing IS NULL OR external_load_timing <@ ARRAY[
    'previous_day', 'same_day_before_rehab', 'same_day_after_rehab'
  ]::TEXT[]);

-- Column-level grants: these are all patient-writable raw observations, same
-- trust tier as next_morning_pain/next_morning_stiffness/patient_note.
GRANT UPDATE (
  stiffness_duration, morning_pain_tolerability, external_load_categories, external_load_timing
) ON morning_responses TO authenticated;

-- ---------------------------------------------------------------------------
-- tolerance_evaluations: immediate guidance + structured reason codes
--
-- tolerance_classification and the new immediate_guidance column are now
-- CHECK-constrained to the vocabulary Stage 4 explicitly approves — Stage 1
-- deliberately left tolerance_classification unconstrained free TEXT
-- specifically because that vocabulary was not yet locked; it is now.
-- ---------------------------------------------------------------------------
ALTER TABLE tolerance_evaluations
  ADD COLUMN immediate_guidance TEXT,
  ADD COLUMN reason_codes TEXT[] NOT NULL DEFAULT '{}';

-- Backfill is a no-op in practice (this table has never had a real
-- evaluation written to it — no evaluator existed before Stage 4), but a
-- NOT NULL column added to a table that could theoretically already have
-- rows still needs an explicit value for any that exist before the
-- constraint can apply going forward.
ALTER TABLE tolerance_evaluations
  ALTER COLUMN immediate_guidance SET NOT NULL;

ALTER TABLE tolerance_evaluations
  ADD CONSTRAINT tolerance_evaluations_classification_check
  CHECK (tolerance_classification IN (
    'well_tolerated', 'caution', 'poorly_tolerated', 'acute_override', 'insufficient_data'
  ));

ALTER TABLE tolerance_evaluations
  ADD CONSTRAINT tolerance_evaluations_guidance_check
  CHECK (immediate_guidance IN (
    'maintain', 'maintain_cautiously', 'reduce_modify', 'clinical_review'
  ));
