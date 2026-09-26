-- =============================================================================
-- C5, Stage 3 — final correction (founder-approved C5.3B follow-up audit).
-- Closes the one schema gap found in that audit: prescription_templates had
-- phase/scheduling_mode columns but no Performance Focus join table, unlike
-- prescription_version_performance_focus / prescription_draft_performance_focus.
-- Additive only. Does NOT modify 20260917000001 in any way.
-- =============================================================================

CREATE TABLE template_performance_focus (
  template_id UUID NOT NULL REFERENCES prescription_templates(id) ON DELETE CASCADE,
  focus       TEXT NOT NULL CHECK (focus IN (
    'symptom_management_load_introduction', 'strength_development', 'energy_storage',
    'reactive_strength', 'explosive_strength', 'return_to_sport_prep', 'maintenance'
  )),
  PRIMARY KEY (template_id, focus)
);

ALTER TABLE template_performance_focus ENABLE ROW LEVEL SECURITY;

-- Same visibility model as template_workouts/template_exercises: readable
-- wherever the parent template itself is readable (owner or org-shared
-- clinician-tier member), via a subquery that is itself subject to
-- prescription_templates' own RLS policies. No authenticated write policy —
-- consistent with every other template table; all writes are service-role
-- only (copy-on-use from prescriptionDraftServer.ts / the create_prescription_draft
-- RPC path).
CREATE POLICY "template_performance_focus: read via template visibility" ON template_performance_focus FOR SELECT
  USING (EXISTS (SELECT 1 FROM prescription_templates pt WHERE pt.id = template_performance_focus.template_id));
REVOKE INSERT, UPDATE, DELETE ON template_performance_focus FROM authenticated;

-- -----------------------------------------------------------------------------
-- copy_template_content_into_draft — extended (CREATE OR REPLACE) to also
-- copy zero-or-more template_performance_focus rows into
-- prescription_draft_performance_focus, alongside the workout/exercise/
-- dosage copy it already performed. Everything else in this function is
-- byte-identical to the version defined in 20260917000001.
-- -----------------------------------------------------------------------------
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

  -- NEW: copy zero or more Performance Focus values. Copy-on-use, no live
  -- linkage retained — a later change to the template's own focuses never
  -- reaches this draft (or any already-published version) after this point.
  INSERT INTO prescription_draft_performance_focus (prescription_draft_id, focus)
  SELECT p_draft_id, focus FROM template_performance_focus WHERE template_id = p_template_id;
END;
$$;
REVOKE ALL ON FUNCTION copy_template_content_into_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;
