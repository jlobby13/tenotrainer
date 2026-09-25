-- =============================================================================
-- C5, Stage 2 — Prescription Management schema foundation (founder-approved
-- C5.2 + C5.2A design). Additive only: no existing table's existing columns
-- change meaning, no existing reader is touched, no existing write path
-- (onboarding sync, legacy bootstrap) is affected. Nothing in this migration
-- is read by any live UI yet — C5.3-C5.6 build on top of this.
--
-- Immutable vs mutable, per the approved design:
--   - prescription_versions (extended) and everything hanging off
--     prescription_version_id (workouts/exercises/dosage/performance-focus)
--     is append-only content, never UPDATEd once published.
--   - patient_prescriptions (operational status), prescription_drafts and
--     everything hanging off prescription_draft_id (while status='editing'),
--     prescription_sequence_state, canonical_exercises and its children,
--     clinician_exercise_favorites, and prescription_templates and its
--     children are ordinary mutable content.
--
-- No write policy is granted to `authenticated` on any new table except
-- clinician_exercise_favorites (own-row insert/delete — trivial, non-
-- clinical) and notifications.read_at (column-level mark-as-read). Every
-- other write path is deliberately left unbuilt in this stage; C5.3
-- introduces the controlled, re-authorized mutation/RPC surface (draft
-- CRUD, publish, pause/resume, exercise/template CRUD). See the C5.2
-- implementation report for the full authorization rationale.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. patient_prescriptions — one prescription identity per patient, owning
--    mutable operational state. Distinct from immutable version content.
-- -----------------------------------------------------------------------------
CREATE TABLE patient_prescriptions (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  current_prescription_version_id UUID NULL REFERENCES prescription_versions(id),
  operational_status              TEXT NOT NULL DEFAULT 'active'
                                     CHECK (operational_status IN ('active', 'paused')),
  paused_at                       TIMESTAMPTZ NULL,
  paused_by                       UUID NULL REFERENCES auth.users(id),
  resumed_at                      TIMESTAMPTZ NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (patient_id),
  CONSTRAINT patient_prescriptions_pause_fields_consistent CHECK (
    (operational_status = 'active' AND paused_at IS NULL AND paused_by IS NULL)
    OR (operational_status = 'paused' AND paused_at IS NOT NULL AND paused_by IS NOT NULL)
  )
);

CREATE TRIGGER trg_patient_prescriptions_updated_at
  BEFORE UPDATE ON patient_prescriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. prescription_versions — additive extension only. Every existing column,
--    row, and RLS policy is untouched. The four new C5-native fields are
--    deliberately nullable: onboarding/legacy_bootstrap rows (still the only
--    writer today) will never populate them, and no backfill is performed in
--    this migration (see the implementation report for why). The togetherness
--    CHECK below guarantees that once C5.3's publish path DOES populate one
--    of them, it populates all four together — historical/legacy rows remain
--    valid because they have all four NULL.
-- -----------------------------------------------------------------------------
ALTER TABLE prescription_versions
  ADD COLUMN patient_prescription_id UUID NULL REFERENCES patient_prescriptions(id),
  ADD COLUMN version_number          INTEGER NULL,
  ADD COLUMN published_at            TIMESTAMPTZ NULL,
  ADD COLUMN published_by            UUID NULL REFERENCES auth.users(id),
  ADD COLUMN phase                   TEXT NULL
    CHECK (phase IS NULL OR phase IN ('early', 'middle', 'late', 'return_to_activity', 'maintenance')),
  ADD COLUMN scheduling_mode         TEXT NULL
    CHECK (scheduling_mode IS NULL OR scheduling_mode IN ('sequence', 'calendar'));

ALTER TABLE prescription_versions
  ADD CONSTRAINT prescription_versions_c5_native_fields_together CHECK (
    (version_number IS NULL AND patient_prescription_id IS NULL AND published_at IS NULL AND published_by IS NULL)
    OR
    (version_number IS NOT NULL AND patient_prescription_id IS NOT NULL AND published_at IS NOT NULL AND published_by IS NOT NULL)
  );

-- Version numbering is per patient_prescription_id, 1-based, no v0. Only
-- meaningful (and only enforced) once a row actually carries these fields.
CREATE UNIQUE INDEX prescription_versions_unique_version_number
  ON prescription_versions (patient_prescription_id, version_number)
  WHERE patient_prescription_id IS NOT NULL AND version_number IS NOT NULL;

COMMENT ON COLUMN prescription_versions.patient_prescription_id IS
  'C5-native only. NULL for every pre-C5 row (onboarding/legacy_bootstrap) and for any row those sources continue to write during the C5.2-C5.5 transitional period. No backfill performed in C5.2 — see implementation report.';
COMMENT ON COLUMN prescription_versions.version_number IS
  '1-based per patient_prescription_id, no v0. NULL until a real C5.3 publish populates it; never fabricated for historical rows.';

-- -----------------------------------------------------------------------------
-- 3. Performance focus (published) — normalized multi-select, zero or many.
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_version_performance_focus (
  prescription_version_id UUID NOT NULL REFERENCES prescription_versions(id) ON DELETE CASCADE,
  focus                    TEXT NOT NULL CHECK (focus IN (
    'symptom_management_load_introduction', 'strength_development', 'energy_storage',
    'reactive_strength', 'explosive_strength', 'return_to_sport_prep', 'maintenance'
  )),
  PRIMARY KEY (prescription_version_id, focus)
);

-- -----------------------------------------------------------------------------
-- 4. canonical_exercises — the new Postgres-native exercise library. The
--    existing `exercises` table (20260831000001) is NOT touched, repurposed,
--    or dropped here — it remains dead/unused, per the founder-locked
--    decision. This table is entirely new and separate.
-- -----------------------------------------------------------------------------
CREATE TABLE canonical_exercises (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_ex_id                TEXT NULL UNIQUE,
  name                        TEXT NOT NULL,
  category                    TEXT NULL,
  loading_profile             TEXT NULL,
  body_part                   TEXT[] NULL,
  unilateral_bilateral        TEXT NULL
    CHECK (unilateral_bilateral IS NULL OR unilateral_bilateral IN ('unilateral', 'bilateral', 'not_applicable')),
  equipment                   TEXT[] NULL,
  phase_tags                  TEXT[] NULL,
  setup_instructions          TEXT NULL,
  execution_cues              TEXT NULL,
  patient_facing_explanation  TEXT NULL,
  media_url                   TEXT NULL,
  visibility                  TEXT NOT NULL CHECK (visibility IN ('global', 'private', 'org_shared')),
  owner_clinician_id          UUID NULL REFERENCES auth.users(id),
  organization_id             UUID NULL REFERENCES organizations(id),
  active                      BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  UUID NULL REFERENCES auth.users(id),

  CONSTRAINT canonical_exercises_visibility_ownership CHECK (
    (visibility = 'global' AND owner_clinician_id IS NULL AND organization_id IS NULL)
    OR (visibility = 'private' AND owner_clinician_id IS NOT NULL AND organization_id IS NULL)
    OR (visibility = 'org_shared' AND owner_clinician_id IS NOT NULL AND organization_id IS NOT NULL)
  )
);

CREATE INDEX idx_canonical_exercises_name_trgm ON canonical_exercises USING gin (name gin_trgm_ops);
CREATE INDEX idx_canonical_exercises_loading_profile ON canonical_exercises (loading_profile);
CREATE INDEX idx_canonical_exercises_phase_tags ON canonical_exercises USING gin (phase_tags);
CREATE INDEX idx_canonical_exercises_body_part ON canonical_exercises USING gin (body_part);
CREATE INDEX idx_canonical_exercises_unilateral_bilateral ON canonical_exercises (unilateral_bilateral);
CREATE INDEX idx_canonical_exercises_owner ON canonical_exercises (owner_clinician_id);
CREATE INDEX idx_canonical_exercises_org ON canonical_exercises (organization_id);

CREATE TRIGGER trg_canonical_exercises_updated_at
  BEFORE UPDATE ON canonical_exercises
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. exercise_reference_dosage — informational reference only. Physically
--    separate from prescription_exercise_dosage (different table, different
--    parent FK, no shared row) — see section 12 for the shared quantity
--    shape and the reference-vs-prescription structural proof.
-- -----------------------------------------------------------------------------
CREATE TABLE exercise_reference_dosage (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id                   UUID NOT NULL UNIQUE REFERENCES canonical_exercises(id) ON DELETE CASCADE,
  dosage_type                   TEXT NOT NULL CHECK (dosage_type IN ('repetition', 'hold', 'time', 'contact')),

  sets                          INTEGER NULL CHECK (sets IS NULL OR sets > 0),

  reps_mode                     TEXT NULL CHECK (reps_mode IS NULL OR reps_mode IN ('exact', 'range')),
  reps_exact                    INTEGER NULL CHECK (reps_exact IS NULL OR reps_exact > 0),
  reps_min                      INTEGER NULL CHECK (reps_min IS NULL OR reps_min > 0),
  reps_max                      INTEGER NULL CHECK (reps_max IS NULL OR reps_max > 0),

  contacts_mode                 TEXT NULL CHECK (contacts_mode IS NULL OR contacts_mode IN ('exact', 'range')),
  contacts_exact                INTEGER NULL CHECK (contacts_exact IS NULL OR contacts_exact > 0),
  contacts_min                  INTEGER NULL CHECK (contacts_min IS NULL OR contacts_min > 0),
  contacts_max                  INTEGER NULL CHECK (contacts_max IS NULL OR contacts_max > 0),

  hold_duration_mode            TEXT NULL CHECK (hold_duration_mode IS NULL OR hold_duration_mode IN ('exact', 'range')),
  hold_duration_exact_seconds   NUMERIC NULL CHECK (hold_duration_exact_seconds IS NULL OR hold_duration_exact_seconds > 0),
  hold_duration_min_seconds     NUMERIC NULL CHECK (hold_duration_min_seconds IS NULL OR hold_duration_min_seconds > 0),
  hold_duration_max_seconds     NUMERIC NULL CHECK (hold_duration_max_seconds IS NULL OR hold_duration_max_seconds > 0),

  time_duration_mode            TEXT NULL CHECK (time_duration_mode IS NULL OR time_duration_mode IN ('exact', 'range')),
  time_duration_exact_seconds   NUMERIC NULL CHECK (time_duration_exact_seconds IS NULL OR time_duration_exact_seconds > 0),
  time_duration_min_seconds     NUMERIC NULL CHECK (time_duration_min_seconds IS NULL OR time_duration_min_seconds > 0),
  time_duration_max_seconds     NUMERIC NULL CHECK (time_duration_max_seconds IS NULL OR time_duration_max_seconds > 0),
  interval_work_seconds         NUMERIC NULL CHECK (interval_work_seconds IS NULL OR interval_work_seconds > 0),
  interval_recovery_seconds     NUMERIC NULL CHECK (interval_recovery_seconds IS NULL OR interval_recovery_seconds > 0),
  interval_rounds               INTEGER NULL CHECK (interval_rounds IS NULL OR interval_rounds > 0),

  concentric_duration_seconds   NUMERIC NULL CHECK (concentric_duration_seconds IS NULL OR concentric_duration_seconds > 0),
  rep_hold_duration_seconds     NUMERIC NULL CHECK (rep_hold_duration_seconds IS NULL OR rep_hold_duration_seconds > 0),
  eccentric_duration_seconds    NUMERIC NULL CHECK (eccentric_duration_seconds IS NULL OR eccentric_duration_seconds > 0),
  tempo_description             TEXT NULL,

  load_type                     TEXT NOT NULL DEFAULT 'not_applicable'
                                   CHECK (load_type IN ('external', 'bodyweight', 'assisted', 'not_applicable')),
  load_value_exact               NUMERIC NULL CHECK (load_value_exact IS NULL OR load_value_exact > 0),
  load_unit                      TEXT NULL CHECK (load_unit IS NULL OR load_unit IN ('kg', 'lb')),

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ref_dosage_sets_required_except_time CHECK (dosage_type = 'time' OR sets IS NOT NULL),

  CONSTRAINT ref_dosage_reps_shape CHECK (
    (dosage_type != 'repetition' AND reps_mode IS NULL AND reps_exact IS NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (dosage_type = 'repetition' AND (
      (reps_mode = 'exact' AND reps_exact IS NOT NULL AND reps_min IS NULL AND reps_max IS NULL)
      OR (reps_mode = 'range' AND reps_min IS NOT NULL AND reps_max IS NOT NULL AND reps_exact IS NULL AND reps_max >= reps_min)
    ))
  ),
  CONSTRAINT ref_dosage_contacts_shape CHECK (
    (dosage_type != 'contact' AND contacts_mode IS NULL AND contacts_exact IS NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (dosage_type = 'contact' AND (
      (contacts_mode = 'exact' AND contacts_exact IS NOT NULL AND contacts_min IS NULL AND contacts_max IS NULL)
      OR (contacts_mode = 'range' AND contacts_min IS NOT NULL AND contacts_max IS NOT NULL AND contacts_exact IS NULL AND contacts_max >= contacts_min)
    ))
  ),
  CONSTRAINT ref_dosage_hold_shape CHECK (
    (dosage_type != 'hold' AND hold_duration_mode IS NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (dosage_type = 'hold' AND (
      (hold_duration_mode = 'exact' AND hold_duration_exact_seconds IS NOT NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
      OR (hold_duration_mode = 'range' AND hold_duration_min_seconds IS NOT NULL AND hold_duration_max_seconds IS NOT NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_max_seconds >= hold_duration_min_seconds)
    ))
  ),
  CONSTRAINT ref_dosage_time_shape CHECK (
    (dosage_type != 'time' AND time_duration_mode IS NULL AND time_duration_exact_seconds IS NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL AND interval_work_seconds IS NULL AND interval_recovery_seconds IS NULL AND interval_rounds IS NULL)
    OR (dosage_type = 'time' AND (
      (time_duration_mode IS NOT NULL) OR (interval_work_seconds IS NOT NULL OR interval_recovery_seconds IS NOT NULL OR interval_rounds IS NOT NULL)
    ) AND (
      time_duration_mode IS NULL
      OR (time_duration_mode = 'exact' AND time_duration_exact_seconds IS NOT NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
      OR (time_duration_mode = 'range' AND time_duration_min_seconds IS NOT NULL AND time_duration_max_seconds IS NOT NULL AND time_duration_exact_seconds IS NULL AND time_duration_max_seconds >= time_duration_min_seconds)
    ))
  ),
  CONSTRAINT ref_dosage_load_shape CHECK (
    (load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit IS NOT NULL)
    OR (load_type != 'external' AND load_value_exact IS NULL AND load_unit IS NULL)
  )
);

CREATE TRIGGER trg_exercise_reference_dosage_updated_at
  BEFORE UPDATE ON exercise_reference_dosage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 6. clinician_exercise_favorites — non-mutating to the exercise itself.
-- -----------------------------------------------------------------------------
CREATE TABLE clinician_exercise_favorites (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinician_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  canonical_exercise_id UUID NOT NULL REFERENCES canonical_exercises(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (clinician_id, canonical_exercise_id)
);

-- -----------------------------------------------------------------------------
-- 7. Templates — private/org-shared, copy-on-use. Physically separate from
--    patient-scoped draft/version content: different authorization domain
--    (clinician ownership, no patient dimension at all), so RLS on these
--    tables never needs to branch on patient-supervision logic.
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  owner_clinician_id  UUID NOT NULL REFERENCES auth.users(id),
  organization_id     UUID NULL REFERENCES organizations(id),
  visibility          TEXT NOT NULL CHECK (visibility IN ('private', 'org_shared')),
  phase               TEXT NULL
    CHECK (phase IS NULL OR phase IN ('early', 'middle', 'late', 'return_to_activity', 'maintenance')),
  scheduling_mode     TEXT NULL CHECK (scheduling_mode IS NULL OR scheduling_mode IN ('sequence', 'calendar')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT prescription_templates_org_shared_requires_org CHECK (
    (visibility = 'org_shared' AND organization_id IS NOT NULL)
    OR (visibility = 'private' AND organization_id IS NULL)
  )
);

CREATE TRIGGER trg_prescription_templates_updated_at
  BEFORE UPDATE ON prescription_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE template_workouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  UUID NOT NULL REFERENCES prescription_templates(id) ON DELETE CASCADE,
  label        TEXT NULL,
  order_index  SMALLINT NOT NULL,
  days_of_week SMALLINT[] NULL CHECK (days_of_week IS NULL OR days_of_week <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (template_id, order_index)
);

CREATE TABLE template_exercises (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_workout_id     UUID NOT NULL REFERENCES template_workouts(id) ON DELETE CASCADE,
  canonical_exercise_id   UUID NOT NULL REFERENCES canonical_exercises(id),
  order_index             SMALLINT NOT NULL,
  additional_instructions TEXT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (template_workout_id, order_index)
);

-- template_exercise_dosage mirrors prescription_exercise_dosage's full shape
-- (see section 9) so template application is a trivial INSERT ... SELECT.
CREATE TABLE template_exercise_dosage (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_exercise_id          UUID NOT NULL UNIQUE REFERENCES template_exercises(id) ON DELETE CASCADE,
  dosage_type                   TEXT NOT NULL CHECK (dosage_type IN ('repetition', 'hold', 'time', 'contact')),

  sets                          INTEGER NULL CHECK (sets IS NULL OR sets > 0),

  reps_mode                     TEXT NULL CHECK (reps_mode IS NULL OR reps_mode IN ('exact', 'range')),
  reps_exact                    INTEGER NULL CHECK (reps_exact IS NULL OR reps_exact > 0),
  reps_min                      INTEGER NULL CHECK (reps_min IS NULL OR reps_min > 0),
  reps_max                      INTEGER NULL CHECK (reps_max IS NULL OR reps_max > 0),

  contacts_mode                 TEXT NULL CHECK (contacts_mode IS NULL OR contacts_mode IN ('exact', 'range')),
  contacts_exact                INTEGER NULL CHECK (contacts_exact IS NULL OR contacts_exact > 0),
  contacts_min                  INTEGER NULL CHECK (contacts_min IS NULL OR contacts_min > 0),
  contacts_max                  INTEGER NULL CHECK (contacts_max IS NULL OR contacts_max > 0),

  hold_duration_mode            TEXT NULL CHECK (hold_duration_mode IS NULL OR hold_duration_mode IN ('exact', 'range')),
  hold_duration_exact_seconds   NUMERIC NULL CHECK (hold_duration_exact_seconds IS NULL OR hold_duration_exact_seconds > 0),
  hold_duration_min_seconds     NUMERIC NULL CHECK (hold_duration_min_seconds IS NULL OR hold_duration_min_seconds > 0),
  hold_duration_max_seconds     NUMERIC NULL CHECK (hold_duration_max_seconds IS NULL OR hold_duration_max_seconds > 0),

  time_duration_mode            TEXT NULL CHECK (time_duration_mode IS NULL OR time_duration_mode IN ('exact', 'range')),
  time_duration_exact_seconds   NUMERIC NULL CHECK (time_duration_exact_seconds IS NULL OR time_duration_exact_seconds > 0),
  time_duration_min_seconds     NUMERIC NULL CHECK (time_duration_min_seconds IS NULL OR time_duration_min_seconds > 0),
  time_duration_max_seconds     NUMERIC NULL CHECK (time_duration_max_seconds IS NULL OR time_duration_max_seconds > 0),
  interval_work_seconds         NUMERIC NULL CHECK (interval_work_seconds IS NULL OR interval_work_seconds > 0),
  interval_recovery_seconds     NUMERIC NULL CHECK (interval_recovery_seconds IS NULL OR interval_recovery_seconds > 0),
  interval_rounds               INTEGER NULL CHECK (interval_rounds IS NULL OR interval_rounds > 0),

  concentric_duration_seconds   NUMERIC NULL CHECK (concentric_duration_seconds IS NULL OR concentric_duration_seconds > 0),
  rep_hold_duration_seconds     NUMERIC NULL CHECK (rep_hold_duration_seconds IS NULL OR rep_hold_duration_seconds > 0),
  eccentric_duration_seconds    NUMERIC NULL CHECK (eccentric_duration_seconds IS NULL OR eccentric_duration_seconds > 0),
  tempo_description             TEXT NULL,

  rest_seconds                  NUMERIC NULL CHECK (rest_seconds IS NULL OR rest_seconds >= 0),

  load_type                     TEXT NOT NULL DEFAULT 'not_applicable'
                                   CHECK (load_type IN ('external', 'bodyweight', 'assisted', 'not_applicable')),
  load_value_exact               NUMERIC NULL CHECK (load_value_exact IS NULL OR load_value_exact > 0),
  load_unit                      TEXT NULL CHECK (load_unit IS NULL OR load_unit IN ('kg', 'lb')),
  load_value_kg_derived          NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit = 'kg' THEN load_value_exact
      WHEN load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit = 'lb' THEN round(load_value_exact * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED,

  rpe                NUMERIC(3,1) NULL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
  rir                INTEGER NULL CHECK (rir IS NULL OR (rir >= 0 AND rir <= 10)),
  rom                TEXT NULL,
  assistance_level   TEXT NULL CHECK (assistance_level IS NULL OR assistance_level IN ('contact_guard', 'minimal', 'moderate', 'maximum')),
  side               TEXT NULL CHECK (side IS NULL OR side IN ('bilateral', 'left', 'right', 'both_sides_separately', 'not_applicable')),

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT template_dosage_sets_required_except_time CHECK (dosage_type = 'time' OR sets IS NOT NULL),

  CONSTRAINT template_dosage_reps_shape CHECK (
    (dosage_type != 'repetition' AND reps_mode IS NULL AND reps_exact IS NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (dosage_type = 'repetition' AND (
      (reps_mode = 'exact' AND reps_exact IS NOT NULL AND reps_min IS NULL AND reps_max IS NULL)
      OR (reps_mode = 'range' AND reps_min IS NOT NULL AND reps_max IS NOT NULL AND reps_exact IS NULL AND reps_max >= reps_min)
    ))
  ),
  CONSTRAINT template_dosage_contacts_shape CHECK (
    (dosage_type != 'contact' AND contacts_mode IS NULL AND contacts_exact IS NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (dosage_type = 'contact' AND (
      (contacts_mode = 'exact' AND contacts_exact IS NOT NULL AND contacts_min IS NULL AND contacts_max IS NULL)
      OR (contacts_mode = 'range' AND contacts_min IS NOT NULL AND contacts_max IS NOT NULL AND contacts_exact IS NULL AND contacts_max >= contacts_min)
    ))
  ),
  CONSTRAINT template_dosage_hold_shape CHECK (
    (dosage_type != 'hold' AND hold_duration_mode IS NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (dosage_type = 'hold' AND (
      (hold_duration_mode = 'exact' AND hold_duration_exact_seconds IS NOT NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
      OR (hold_duration_mode = 'range' AND hold_duration_min_seconds IS NOT NULL AND hold_duration_max_seconds IS NOT NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_max_seconds >= hold_duration_min_seconds)
    ))
  ),
  CONSTRAINT template_dosage_time_shape CHECK (
    (dosage_type != 'time' AND time_duration_mode IS NULL AND time_duration_exact_seconds IS NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL AND interval_work_seconds IS NULL AND interval_recovery_seconds IS NULL AND interval_rounds IS NULL)
    OR (dosage_type = 'time' AND (
      (time_duration_mode IS NOT NULL) OR (interval_work_seconds IS NOT NULL OR interval_recovery_seconds IS NOT NULL OR interval_rounds IS NOT NULL)
    ) AND (
      time_duration_mode IS NULL
      OR (time_duration_mode = 'exact' AND time_duration_exact_seconds IS NOT NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
      OR (time_duration_mode = 'range' AND time_duration_min_seconds IS NOT NULL AND time_duration_max_seconds IS NOT NULL AND time_duration_exact_seconds IS NULL AND time_duration_max_seconds >= time_duration_min_seconds)
    ))
  ),
  CONSTRAINT template_dosage_load_shape CHECK (
    (load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit IS NOT NULL)
    OR (load_type != 'external' AND load_value_exact IS NULL AND load_unit IS NULL)
  )
);

CREATE TRIGGER trg_template_exercise_dosage_updated_at
  BEFORE UPDATE ON template_exercise_dosage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 8. prescription_drafts — the single mutable in-progress prescription per
--    patient. Never in prescription_versions, so existing C2-C4 readers of
--    that table are structurally incapable of ever seeing draft content.
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_drafts (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_prescription_id          UUID NOT NULL REFERENCES patient_prescriptions(id) ON DELETE CASCADE,
  status                           TEXT NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'discarded', 'published')),
  source                           TEXT NOT NULL CHECK (source IN ('empty', 'clone_active', 'clone_historical', 'from_template')),
  based_on_prescription_version_id UUID NULL REFERENCES prescription_versions(id),
  source_template_id               UUID NULL REFERENCES prescription_templates(id),
  phase                            TEXT NULL
    CHECK (phase IS NULL OR phase IN ('early', 'middle', 'late', 'return_to_activity', 'maintenance')),
  scheduling_mode                  TEXT NULL CHECK (scheduling_mode IS NULL OR scheduling_mode IN ('sequence', 'calendar')),

  -- Ownership: three distinct actor columns, per the C5.2A-locked decision.
  -- created_by = audit only. editing_clinician_id = the sole clinician
  -- permitted to mutate this draft while status='editing' — no implicit
  -- takeover, no reassignment path in C5 v1. updated_by = last-write audit
  -- only, carries no authorization meaning.
  created_by                       UUID NOT NULL REFERENCES auth.users(id),
  editing_clinician_id             UUID NOT NULL REFERENCES auth.users(id),
  updated_by                       UUID NOT NULL REFERENCES auth.users(id),

  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Max one OPEN draft per patient prescription. Partial index (not a plain
-- UNIQUE) so discarded/published draft rows are retained for audit without
-- counting toward the limit.
CREATE UNIQUE INDEX prescription_drafts_one_open_per_patient_prescription
  ON prescription_drafts (patient_prescription_id)
  WHERE status = 'editing';

CREATE TRIGGER trg_prescription_drafts_updated_at
  BEFORE UPDATE ON prescription_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE prescription_draft_performance_focus (
  prescription_draft_id UUID NOT NULL REFERENCES prescription_drafts(id) ON DELETE CASCADE,
  focus                  TEXT NOT NULL CHECK (focus IN (
    'symptom_management_load_introduction', 'strength_development', 'energy_storage',
    'reactive_strength', 'explosive_strength', 'return_to_sport_prep', 'maintenance'
  )),
  PRIMARY KEY (prescription_draft_id, focus)
);

-- -----------------------------------------------------------------------------
-- 9. prescription_workouts — shared by drafts and published versions via an
--    exactly-one-parent polymorphic FK. Both parents share the identical
--    patient-supervision authorization domain, so one RLS policy set (via
--    the helper function below) safely covers both.
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_workouts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_version_id  UUID NULL REFERENCES prescription_versions(id) ON DELETE CASCADE,
  prescription_draft_id    UUID NULL REFERENCES prescription_drafts(id) ON DELETE CASCADE,
  label                    TEXT NULL,
  order_index              SMALLINT NOT NULL,
  days_of_week             SMALLINT[] NULL CHECK (days_of_week IS NULL OR days_of_week <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT prescription_workouts_exactly_one_parent CHECK (
    num_nonnulls(prescription_version_id, prescription_draft_id) = 1
  )
);

-- Partial indexes, not a single plain UNIQUE, because a plain
-- UNIQUE(prescription_version_id, order_index) would never catch duplicate
-- order_index values among draft-owned rows (all NULL prescription_version_id
-- — Postgres never treats NULLs as equal for uniqueness purposes).
CREATE UNIQUE INDEX prescription_workouts_order_per_version
  ON prescription_workouts (prescription_version_id, order_index)
  WHERE prescription_version_id IS NOT NULL;
CREATE UNIQUE INDEX prescription_workouts_order_per_draft
  ON prescription_workouts (prescription_draft_id, order_index)
  WHERE prescription_draft_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 10. prescription_exercises — exercise membership within a workout. Status
--     is immutable/versioned content per the C5.2A-locked decision: pausing
--     an exercise requires a new draft->publish cycle, so it is automatically
--     diffable by future prescription history. No separate mutable
--     exercise-pause runtime table exists.
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_exercises (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_workout_id  UUID NOT NULL REFERENCES prescription_workouts(id) ON DELETE CASCADE,
  canonical_exercise_id    UUID NOT NULL REFERENCES canonical_exercises(id),
  order_index              SMALLINT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  additional_instructions  TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (prescription_workout_id, order_index)
);

-- -----------------------------------------------------------------------------
-- 11. prescription_exercise_dosage — final approved typed dosage model.
--     Exact-vs-range is structurally explicit per quantity: a `_mode` column
--     gates which of `_exact` or (`_min`,`_max`) may be populated, so
--     min=max can never be silently read back as "exact" (they are
--     mutually-exclusive columns, not inferred from equality). Rep-level
--     structured timing (concentric/rep-level hold/eccentric) is a
--     deliberately distinct set of columns from hold-based EXERCISE
--     duration (hold_duration_*) — these represent different concepts and
--     must never be conflated (see column comments below).
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_exercise_dosage (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_exercise_id      UUID NOT NULL UNIQUE REFERENCES prescription_exercises(id) ON DELETE CASCADE,
  dosage_type                   TEXT NOT NULL CHECK (dosage_type IN ('repetition', 'hold', 'time', 'contact')),

  sets                          INTEGER NULL CHECK (sets IS NULL OR sets > 0),

  reps_mode                     TEXT NULL CHECK (reps_mode IS NULL OR reps_mode IN ('exact', 'range')),
  reps_exact                    INTEGER NULL CHECK (reps_exact IS NULL OR reps_exact > 0),
  reps_min                      INTEGER NULL CHECK (reps_min IS NULL OR reps_min > 0),
  reps_max                      INTEGER NULL CHECK (reps_max IS NULL OR reps_max > 0),

  contacts_mode                 TEXT NULL CHECK (contacts_mode IS NULL OR contacts_mode IN ('exact', 'range')),
  contacts_exact                INTEGER NULL CHECK (contacts_exact IS NULL OR contacts_exact > 0),
  contacts_min                  INTEGER NULL CHECK (contacts_min IS NULL OR contacts_min > 0),
  contacts_max                  INTEGER NULL CHECK (contacts_max IS NULL OR contacts_max > 0),

  -- Hold-based EXERCISE duration (e.g. "5 x 45s isometric hold") — NOT the
  -- same concept as rep_hold_duration_seconds below.
  hold_duration_mode            TEXT NULL CHECK (hold_duration_mode IS NULL OR hold_duration_mode IN ('exact', 'range')),
  hold_duration_exact_seconds   NUMERIC NULL CHECK (hold_duration_exact_seconds IS NULL OR hold_duration_exact_seconds > 0),
  hold_duration_min_seconds     NUMERIC NULL CHECK (hold_duration_min_seconds IS NULL OR hold_duration_min_seconds > 0),
  hold_duration_max_seconds     NUMERIC NULL CHECK (hold_duration_max_seconds IS NULL OR hold_duration_max_seconds > 0),

  -- Total/continuous duration, independent of the structured interval
  -- columns below (a clinician may populate total-only, interval-only, or
  -- both — no arithmetic-equivalence CHECK is enforced between them).
  time_duration_mode            TEXT NULL CHECK (time_duration_mode IS NULL OR time_duration_mode IN ('exact', 'range')),
  time_duration_exact_seconds   NUMERIC NULL CHECK (time_duration_exact_seconds IS NULL OR time_duration_exact_seconds > 0),
  time_duration_min_seconds     NUMERIC NULL CHECK (time_duration_min_seconds IS NULL OR time_duration_min_seconds > 0),
  time_duration_max_seconds     NUMERIC NULL CHECK (time_duration_max_seconds IS NULL OR time_duration_max_seconds > 0),
  interval_work_seconds         NUMERIC NULL CHECK (interval_work_seconds IS NULL OR interval_work_seconds > 0),
  interval_recovery_seconds     NUMERIC NULL CHECK (interval_recovery_seconds IS NULL OR interval_recovery_seconds > 0),
  interval_rounds               INTEGER NULL CHECK (interval_rounds IS NULL OR interval_rounds > 0),

  -- Rep-level structured timing phases (e.g. "2 sec concentric / 1 sec top
  -- hold / 3 sec eccentric" within EACH rep) — distinct from both
  -- hold_duration_* (whole-exercise isometric hold) and tempo_description
  -- (free text, never parsed into these). Optional and independent.
  concentric_duration_seconds   NUMERIC NULL CHECK (concentric_duration_seconds IS NULL OR concentric_duration_seconds > 0),
  rep_hold_duration_seconds     NUMERIC NULL CHECK (rep_hold_duration_seconds IS NULL OR rep_hold_duration_seconds > 0),
  eccentric_duration_seconds    NUMERIC NULL CHECK (eccentric_duration_seconds IS NULL OR eccentric_duration_seconds > 0),
  tempo_description             TEXT NULL,

  rest_seconds                  NUMERIC NULL CHECK (rest_seconds IS NULL OR rest_seconds >= 0),

  load_type                     TEXT NOT NULL DEFAULT 'not_applicable'
                                   CHECK (load_type IN ('external', 'bodyweight', 'assisted', 'not_applicable')),
  load_value_exact               NUMERIC NULL CHECK (load_value_exact IS NULL OR load_value_exact > 0),
  load_unit                      TEXT NULL CHECK (load_unit IS NULL OR load_unit IN ('kg', 'lb')),
  -- Database-owned, deterministic, always-in-sync derived value for
  -- cross-unit comparison ONLY. A GENERATED column is used specifically so
  -- no future application write path can independently (and inconsistently)
  -- compute this — it is recomputed automatically from load_value_exact/
  -- load_unit/load_type on every write and can never drift from them. Never
  -- displayed as the authored value; never used to overwrite it.
  load_value_kg_derived          NUMERIC GENERATED ALWAYS AS (
    CASE
      WHEN load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit = 'kg' THEN load_value_exact
      WHEN load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit = 'lb' THEN round(load_value_exact * 0.45359237, 4)
      ELSE NULL
    END
  ) STORED,

  rpe                NUMERIC(3,1) NULL CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10)),
  rir                INTEGER NULL CHECK (rir IS NULL OR (rir >= 0 AND rir <= 10)),
  rom                TEXT NULL,
  assistance_level   TEXT NULL CHECK (assistance_level IS NULL OR assistance_level IN ('contact_guard', 'minimal', 'moderate', 'maximum')),
  side               TEXT NULL CHECK (side IS NULL OR side IN ('bilateral', 'left', 'right', 'both_sides_separately', 'not_applicable')),

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT dosage_sets_required_except_time CHECK (dosage_type = 'time' OR sets IS NOT NULL),

  CONSTRAINT dosage_reps_shape CHECK (
    (dosage_type != 'repetition' AND reps_mode IS NULL AND reps_exact IS NULL AND reps_min IS NULL AND reps_max IS NULL)
    OR (dosage_type = 'repetition' AND (
      (reps_mode = 'exact' AND reps_exact IS NOT NULL AND reps_min IS NULL AND reps_max IS NULL)
      OR (reps_mode = 'range' AND reps_min IS NOT NULL AND reps_max IS NOT NULL AND reps_exact IS NULL AND reps_max >= reps_min)
    ))
  ),
  CONSTRAINT dosage_contacts_shape CHECK (
    (dosage_type != 'contact' AND contacts_mode IS NULL AND contacts_exact IS NULL AND contacts_min IS NULL AND contacts_max IS NULL)
    OR (dosage_type = 'contact' AND (
      (contacts_mode = 'exact' AND contacts_exact IS NOT NULL AND contacts_min IS NULL AND contacts_max IS NULL)
      OR (contacts_mode = 'range' AND contacts_min IS NOT NULL AND contacts_max IS NOT NULL AND contacts_exact IS NULL AND contacts_max >= contacts_min)
    ))
  ),
  CONSTRAINT dosage_hold_shape CHECK (
    (dosage_type != 'hold' AND hold_duration_mode IS NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
    OR (dosage_type = 'hold' AND (
      (hold_duration_mode = 'exact' AND hold_duration_exact_seconds IS NOT NULL AND hold_duration_min_seconds IS NULL AND hold_duration_max_seconds IS NULL)
      OR (hold_duration_mode = 'range' AND hold_duration_min_seconds IS NOT NULL AND hold_duration_max_seconds IS NOT NULL AND hold_duration_exact_seconds IS NULL AND hold_duration_max_seconds >= hold_duration_min_seconds)
    ))
  ),
  CONSTRAINT dosage_time_shape CHECK (
    (dosage_type != 'time' AND time_duration_mode IS NULL AND time_duration_exact_seconds IS NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL AND interval_work_seconds IS NULL AND interval_recovery_seconds IS NULL AND interval_rounds IS NULL)
    OR (dosage_type = 'time' AND (
      (time_duration_mode IS NOT NULL) OR (interval_work_seconds IS NOT NULL OR interval_recovery_seconds IS NOT NULL OR interval_rounds IS NOT NULL)
    ) AND (
      time_duration_mode IS NULL
      OR (time_duration_mode = 'exact' AND time_duration_exact_seconds IS NOT NULL AND time_duration_min_seconds IS NULL AND time_duration_max_seconds IS NULL)
      OR (time_duration_mode = 'range' AND time_duration_min_seconds IS NOT NULL AND time_duration_max_seconds IS NOT NULL AND time_duration_exact_seconds IS NULL AND time_duration_max_seconds >= time_duration_min_seconds)
    ))
  ),
  CONSTRAINT dosage_load_shape CHECK (
    (load_type = 'external' AND load_value_exact IS NOT NULL AND load_unit IS NOT NULL)
    OR (load_type != 'external' AND load_value_exact IS NULL AND load_unit IS NULL)
  )
);

CREATE TRIGGER trg_prescription_exercise_dosage_updated_at
  BEFORE UPDATE ON prescription_exercise_dosage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 12. prescription_sequence_state — mutable Sequence Mode runtime state,
--     deliberately outside immutable version content. Reset to the new
--     version's first workout on every publish under Sequence Mode
--     (founder-locked: no attempt to preserve ordinal position across a
--     changed workout list). Session-completion advancement is a C5.6
--     concern, not implemented here.
-- -----------------------------------------------------------------------------
CREATE TABLE prescription_sequence_state (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_prescription_id  UUID NOT NULL UNIQUE REFERENCES patient_prescriptions(id) ON DELETE CASCADE,
  prescription_version_id  UUID NOT NULL REFERENCES prescription_versions(id),
  current_workout_id       UUID NULL REFERENCES prescription_workouts(id),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 13. notifications — general infrastructure. Honest nullable typed FK
--     (prescription_version_id), never a fake-generic entity_type/entity_id.
--     Future unrelated notification types add their own typed nullable FK
--     column plus a matching CHECK, rather than broadening this one.
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type                      TEXT NOT NULL CHECK (type IN ('prescription_published', 'prescription_updated')),
  prescription_version_id   UUID NULL REFERENCES prescription_versions(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at                   TIMESTAMPTZ NULL,

  CONSTRAINT notifications_prescription_ref_required CHECK (
    type NOT IN ('prescription_published', 'prescription_updated') OR prescription_version_id IS NOT NULL
  )
);

CREATE INDEX idx_notifications_patient_unread ON notifications (patient_id) WHERE read_at IS NULL;

-- =============================================================================
-- RLS
-- =============================================================================

-- Helper: does the current user have read/write authorization for the given
-- workout, regardless of whether it belongs to a published version (own or
-- actively-supervised patient) or a draft (actively-supervised clinician
-- only — patients never see draft-owned workouts, by omission, not filter).
CREATE OR REPLACE FUNCTION can_access_prescription_workout(p_workout_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM prescription_workouts pw
    LEFT JOIN prescription_versions pv ON pv.id = pw.prescription_version_id
    LEFT JOIN prescription_drafts pd ON pd.id = pw.prescription_draft_id
    LEFT JOIN patient_prescriptions pp ON pp.id = pd.patient_prescription_id
    WHERE pw.id = p_workout_id
      AND (
        (pv.id IS NOT NULL AND (
          pv.user_id = auth.uid()
          OR EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = pv.user_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active')
        ))
        OR
        (pd.id IS NOT NULL AND EXISTS (
          SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = pp.patient_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
        ))
      )
  );
$$;

ALTER TABLE patient_prescriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "patient_prescriptions: own read" ON patient_prescriptions FOR SELECT
  USING (patient_id = auth.uid());
CREATE POLICY "patient_prescriptions: clinician read" ON patient_prescriptions FOR SELECT
  USING (EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = patient_prescriptions.patient_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'));
REVOKE INSERT, UPDATE, DELETE ON patient_prescriptions FROM authenticated;

ALTER TABLE prescription_version_performance_focus ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_version_performance_focus: read" ON prescription_version_performance_focus FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM prescription_versions pv
    WHERE pv.id = prescription_version_performance_focus.prescription_version_id
      AND (pv.user_id = auth.uid() OR EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = pv.user_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'))
  ));
REVOKE INSERT, UPDATE, DELETE ON prescription_version_performance_focus FROM authenticated;

ALTER TABLE canonical_exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "canonical_exercises: global read" ON canonical_exercises FOR SELECT
  USING (visibility = 'global');
CREATE POLICY "canonical_exercises: private read" ON canonical_exercises FOR SELECT
  USING (visibility = 'private' AND owner_clinician_id = auth.uid());
CREATE POLICY "canonical_exercises: org shared read" ON canonical_exercises FOR SELECT
  USING (visibility = 'org_shared' AND is_org_clinician(organization_id));
-- Narrowly scoped: a patient may read a canonical_exercises row ONLY when it
-- is referenced by one of their OWN published prescriptions — never broadened
-- to all private/org_shared content generally (see implementation report).
CREATE POLICY "canonical_exercises: patient read via own published prescription" ON canonical_exercises FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM prescription_exercises pe
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    JOIN prescription_versions pv ON pv.id = pw.prescription_version_id
    WHERE pe.canonical_exercise_id = canonical_exercises.id AND pv.user_id = auth.uid()
  ));
REVOKE INSERT, UPDATE, DELETE ON canonical_exercises FROM authenticated;

ALTER TABLE exercise_reference_dosage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exercise_reference_dosage: read via exercise visibility" ON exercise_reference_dosage FOR SELECT
  USING (EXISTS (SELECT 1 FROM canonical_exercises ce WHERE ce.id = exercise_reference_dosage.exercise_id));
REVOKE INSERT, UPDATE, DELETE ON exercise_reference_dosage FROM authenticated;

-- Favorites: the one deliberate exception to "no authenticated writes before
-- C5.3" — trivial, non-clinical, own-row-only predicate, no transactional
-- machinery required.
ALTER TABLE clinician_exercise_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clinician_exercise_favorites: own read" ON clinician_exercise_favorites FOR SELECT
  USING (clinician_id = auth.uid());
CREATE POLICY "clinician_exercise_favorites: own insert" ON clinician_exercise_favorites FOR INSERT
  WITH CHECK (clinician_id = auth.uid());
CREATE POLICY "clinician_exercise_favorites: own delete" ON clinician_exercise_favorites FOR DELETE
  USING (clinician_id = auth.uid());
REVOKE UPDATE ON clinician_exercise_favorites FROM authenticated;

ALTER TABLE prescription_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_templates: owner read" ON prescription_templates FOR SELECT
  USING (owner_clinician_id = auth.uid());
CREATE POLICY "prescription_templates: org shared read" ON prescription_templates FOR SELECT
  USING (visibility = 'org_shared' AND is_org_clinician(organization_id));
REVOKE INSERT, UPDATE, DELETE ON prescription_templates FROM authenticated;

ALTER TABLE template_workouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "template_workouts: read via template visibility" ON template_workouts FOR SELECT
  USING (EXISTS (SELECT 1 FROM prescription_templates pt WHERE pt.id = template_workouts.template_id));
REVOKE INSERT, UPDATE, DELETE ON template_workouts FROM authenticated;

ALTER TABLE template_exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "template_exercises: read via template visibility" ON template_exercises FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM template_workouts tw WHERE tw.id = template_exercises.template_workout_id
  ));
REVOKE INSERT, UPDATE, DELETE ON template_exercises FROM authenticated;

ALTER TABLE template_exercise_dosage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "template_exercise_dosage: read via template visibility" ON template_exercise_dosage FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM template_exercises te WHERE te.id = template_exercise_dosage.template_exercise_id
  ));
REVOKE INSERT, UPDATE, DELETE ON template_exercise_dosage FROM authenticated;

ALTER TABLE prescription_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_drafts: supervising clinician read" ON prescription_drafts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM patient_prescriptions pp
    JOIN supervisor_patients sp ON sp.patient_id = pp.patient_id
    WHERE pp.id = prescription_drafts.patient_prescription_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
  ));
-- Deliberately NO patient-facing SELECT policy at all: structural
-- invisibility, not a filtered read. No authenticated write policy either
-- (draft mutation is entirely service-role/RPC, and additionally re-checks
-- editing_clinician_id at the application layer — see implementation report).
REVOKE INSERT, UPDATE, DELETE ON prescription_drafts FROM authenticated;

ALTER TABLE prescription_draft_performance_focus ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_draft_performance_focus: supervising clinician read" ON prescription_draft_performance_focus FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM prescription_drafts pd
    JOIN patient_prescriptions pp ON pp.id = pd.patient_prescription_id
    JOIN supervisor_patients sp ON sp.patient_id = pp.patient_id
    WHERE pd.id = prescription_draft_performance_focus.prescription_draft_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
  ));
REVOKE INSERT, UPDATE, DELETE ON prescription_draft_performance_focus FROM authenticated;

ALTER TABLE prescription_workouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_workouts: read" ON prescription_workouts FOR SELECT
  USING (can_access_prescription_workout(id));
REVOKE INSERT, UPDATE, DELETE ON prescription_workouts FROM authenticated;

ALTER TABLE prescription_exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_exercises: read" ON prescription_exercises FOR SELECT
  USING (can_access_prescription_workout(prescription_workout_id));
REVOKE INSERT, UPDATE, DELETE ON prescription_exercises FROM authenticated;

ALTER TABLE prescription_exercise_dosage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_exercise_dosage: read" ON prescription_exercise_dosage FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM prescription_exercises pe WHERE pe.id = prescription_exercise_dosage.prescription_exercise_id AND can_access_prescription_workout(pe.prescription_workout_id)
  ));
REVOKE INSERT, UPDATE, DELETE ON prescription_exercise_dosage FROM authenticated;

ALTER TABLE prescription_sequence_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prescription_sequence_state: own read" ON prescription_sequence_state FOR SELECT
  USING (EXISTS (SELECT 1 FROM patient_prescriptions pp WHERE pp.id = prescription_sequence_state.patient_prescription_id AND pp.patient_id = auth.uid()));
CREATE POLICY "prescription_sequence_state: clinician read" ON prescription_sequence_state FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM patient_prescriptions pp JOIN supervisor_patients sp ON sp.patient_id = pp.patient_id
    WHERE pp.id = prescription_sequence_state.patient_prescription_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
  ));
REVOKE INSERT, UPDATE, DELETE ON prescription_sequence_state FROM authenticated;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notifications: own read" ON notifications FOR SELECT
  USING (patient_id = auth.uid());
CREATE POLICY "notifications: own mark read" ON notifications FOR UPDATE
  USING (patient_id = auth.uid()) WITH CHECK (patient_id = auth.uid());
REVOKE INSERT, DELETE ON notifications FROM authenticated;
REVOKE UPDATE ON notifications FROM authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;
