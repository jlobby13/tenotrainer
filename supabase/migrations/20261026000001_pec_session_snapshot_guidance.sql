-- =============================================================================
-- PEC — session snapshot version 2: frozen patient exercise guidance.
--
-- c5_build_session_snapshot is the ONE builder for both the pre-start
-- preview and the snapshot frozen into rehab_sessions.prescription_snapshot
-- at first confirmed performance (c5_record_first_performance). Version 2
-- adds, per exercise, a structured `patient_guidance` object copied from
-- the canonical library at build time:
--
--   patient_guidance: {
--     explanation  <- canonical_exercises.patient_facing_explanation
--     setup        <- canonical_exercises.setup_instructions
--     cues         <- canonical_exercises.execution_cues     (array, may be [])
--     watch_for    <- canonical_exercises.common_compensations (array, may be [])
--     media_url    <- canonical_exercises.media_url          (NULL today)
--   }
--
-- CANONICAL LIBRARY vs FROZEN PATIENT SESSION GUIDANCE: the preview reads
-- the current library; once a session Starts, its stored snapshot is the
-- only source of what it instructed — a later library edit never changes a
-- Started or historical session. Clinician-only library content
-- (contraindications_or_cautions, clinician_notes, and every other column)
-- is never copied. The clinician's per-prescription note stays where it
-- was (`additional_instructions`).
--
-- Additive only: every version-1 key is unchanged and every snapshot reader
-- (c5_performance_error, c5_record_first_performance's order_index lookups,
-- the TypeScript mappers) reads named keys. Existing version-1 snapshots are
-- not backfilled and stay valid as they are.
-- =============================================================================
CREATE OR REPLACE FUNCTION c5_build_session_snapshot(p_version_id UUID, p_workout_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'snapshot_version', 2,
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
        'dosage', to_jsonb(ped) - 'id' - 'prescription_exercise_id' - 'created_at' - 'updated_at',
        'patient_guidance', jsonb_build_object(
          'explanation', NULLIF(btrim(ce.patient_facing_explanation), ''),
          'setup', NULLIF(btrim(ce.setup_instructions), ''),
          'cues', COALESCE((SELECT jsonb_agg(c ORDER BY o) FROM unnest(ce.execution_cues) WITH ORDINALITY AS u(c, o) WHERE NULLIF(btrim(c), '') IS NOT NULL), '[]'::jsonb),
          'watch_for', COALESCE((SELECT jsonb_agg(c ORDER BY o) FROM unnest(ce.common_compensations) WITH ORDINALITY AS u(c, o) WHERE NULLIF(btrim(c), '') IS NOT NULL), '[]'::jsonb),
          'media_url', NULLIF(btrim(ce.media_url), '')
        )
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
