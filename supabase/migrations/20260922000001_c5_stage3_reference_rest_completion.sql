-- =============================================================================
-- C5, Stage 3G (correction) — Reference-rest completion for the 47-exercise
-- bootstrap. Adds the one library-level metadata field discovered missing
-- during C5.3G verification: exercise_reference_dosage.rest_seconds.
--
-- This is a ONE-TIME COMPLETION of the initial bootstrap, not a recurring
-- JSON synchronization mechanism — exactly like 20260921000001 itself, this
-- migration never reads app/data/exercise_library.json at apply time; the
-- 43 rest values below were computed once, at authoring time, from that
-- file, using the identical deterministic parse already used for every
-- other numeric intra-set rest value in the original bootstrap (a bare
-- "<N>s" or "<N> min" pattern, converted to seconds — nothing else).
--
-- Type/constraint: NUMERIC, CHECK (rest_seconds IS NULL OR rest_seconds >= 0)
-- — this intentionally matches prescription_exercise_dosage.rest_seconds'
-- existing precedent exactly (NUMERIC, >= 0, not INTEGER/> 0), per the
-- founder's own instruction to prefer consistency with that representation
-- over the originally-suggested type.
--
-- This remains reference/educational information only. It has no
-- relationship whatsoever to prescription_exercise_dosage.rest_seconds or
-- template_exercise_dosage.rest_seconds (patient-specific / template
-- fields) and is never read by anything that populates a patient
-- prescription — a clinician leaving a prescription's own rest field blank
-- must never have it silently filled from here.
-- =============================================================================

ALTER TABLE exercise_reference_dosage
  ADD COLUMN rest_seconds NUMERIC NULL CHECK (rest_seconds IS NULL OR rest_seconds >= 0);

COMMENT ON COLUMN exercise_reference_dosage.rest_seconds IS
  'Optional library-level reference intra-set rest, educational/reference information only. NEVER automatically populates prescription_exercise_dosage.rest_seconds or template_exercise_dosage.rest_seconds for any patient/template — those are always explicit clinician choices, populated only through their own write paths.';

-- -----------------------------------------------------------------------------
-- Backfill — scoped exclusively to the 46 bootstrap-owned reference-dosage
-- rows (joined through canonical_exercises.legacy_ex_id), and guarded by
-- `rest_seconds IS NULL` so this can never overwrite a superuser's own
-- later edit (the same non-overwrite discipline as the original bootstrap's
-- ON CONFLICT DO NOTHING, applied here via an equivalent WHERE guard since
-- this is an UPDATE, not an INSERT). Only exercises whose legacy
-- `dosage_defaults.rest` was an unambiguous "<N>s" or "<N> min" pattern are
-- included — ex_033 ("as needed"), ex_034 ("48h between sessions"), and
-- ex_036 ("48h") are deliberately absent from this list: those describe
-- inter-session recovery cadence, not intra-set rest, and are left NULL
-- rather than guessed. ex_040 has no reference-dosage row at all (unchanged,
-- approved omission) and is correspondingly absent here too.
-- -----------------------------------------------------------------------------
UPDATE exercise_reference_dosage erd SET rest_seconds = v.rest_seconds
FROM (VALUES
  ('ex_001', 90), ('ex_002', 90), ('ex_003', 90), ('ex_004', 60), ('ex_005', 60),
  ('ex_006', 90), ('ex_007', 90), ('ex_008', 90), ('ex_009', 90), ('ex_010', 90),
  ('ex_011', 90), ('ex_012', 90), ('ex_013', 90), ('ex_014', 120), ('ex_015', 90),
  ('ex_016', 90), ('ex_017', 90), ('ex_018', 90), ('ex_019', 120), ('ex_020', 120),
  ('ex_021', 120), ('ex_022', 120), ('ex_023', 120), ('ex_024', 120), ('ex_025', 120),
  ('ex_026', 120), ('ex_027', 120), ('ex_028', 120), ('ex_029', 150), ('ex_030', 120),
  ('ex_031', 150), ('ex_032', 150), ('ex_035', 120), ('ex_037', 90), ('ex_038', 60),
  ('ex_039', 60), ('ex_041', 30), ('ex_042', 30), ('ex_043', 30), ('ex_044', 30),
  ('ex_045', 30), ('ex_046', 30), ('ex_047', 30)
) AS v(legacy_ex_id, rest_seconds)
JOIN canonical_exercises ce ON ce.legacy_ex_id = v.legacy_ex_id
WHERE erd.exercise_id = ce.id
  AND erd.rest_seconds IS NULL;
