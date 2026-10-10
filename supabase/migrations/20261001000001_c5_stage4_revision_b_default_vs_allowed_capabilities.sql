-- =============================================================================
-- C5, Stage 4 — Revision B focused correction: separate DEFAULT dosage
-- capabilities (what the compact editor shows automatically) from ALLOWED
-- dosage capabilities (the full set of specialized dimensions "+ Add
-- parameter" may ever offer for that exercise). Fixes a real product bug:
-- the "+ Add parameter" menu was offering every dimension NOT currently
-- visible, with no clinical-plausibility gate at all (e.g. Distance/
-- Contacts being offered for an isometric calf hold).
--
-- Chosen semantics (see the implementation report for the full rationale):
--   - canonical_exercises.dosage_capabilities (EXISTING column, REPURPOSED
--     as of this migration) = ALLOWED — the complete set of specialized
--     dimensions that are clinically plausible for this exercise, a
--     superset of the defaults. This is the natural reading of the
--     existing generic name ("capabilities" = what this exercise is
--     capable of, i.e. allowed) and requires no rename.
--   - canonical_exercises.default_dosage_capabilities (NEW column) =
--     DEFAULT — the subset shown automatically, unchanged in MEANING from
--     what dosage_capabilities held before this migration (Revision A/B
--     populated it as the auto-shown set).
--   - default ⊆ allowed is enforced as a real DB CHECK constraint, not just
--     a population convention.
--
-- No reference dosage is touched. No existing prescription/template/draft
-- dosage row is touched — this only affects canonical_exercises metadata
-- that governs the "+ Add parameter" MENU, never what a saved row may
-- already contain (see decision on historical/off-capability compatibility
-- in the implementation report).
-- =============================================================================

ALTER TABLE canonical_exercises
  ADD COLUMN default_dosage_capabilities TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_default_dosage_capabilities_vocabulary CHECK (
    default_dosage_capabilities <@ ARRAY['reps', 'hold', 'contacts', 'distance', 'interval_time']::TEXT[]
  );

COMMENT ON COLUMN canonical_exercises.default_dosage_capabilities IS
  'Specialized dosage dimensions shown automatically when this exercise is added to a draft (the compact editor''s default field set). Always a subset of dosage_capabilities (ALLOWED) — enforced by canonical_exercises_default_subset_of_allowed below.';
COMMENT ON COLUMN canonical_exercises.dosage_capabilities IS
  'C5.4 Revision B correction: REPURPOSED as of 20261001000001 to mean ALLOWED — the complete set of specialized dosage dimensions that are clinically plausible for this exercise (a superset of default_dosage_capabilities). This is what "+ Add parameter" may ever offer; it is NOT the auto-shown default set (see default_dosage_capabilities for that).';

-- default_dosage_capabilities inherits exactly what dosage_capabilities
-- held immediately before this migration — Revision A/B populated that
-- column as the auto-shown DEFAULT set, so this is a lossless carry-over,
-- not a reinterpretation.
UPDATE canonical_exercises
SET default_dosage_capabilities = dosage_capabilities
WHERE visibility = 'global';

-- Widen dosage_capabilities (now ALLOWED) beyond the default set only
-- where there is concrete supporting evidence (founder-hinted clinical
-- pattern, exercise name, or strong structural analogy to a sibling
-- exercise already using that dimension) — never "every dimension the
-- schema permits". Every widened exercise is flagged in the implementation
-- report as a genuine judgment call for founder review.

-- Reactive/plyometric contact exercises: founder-hinted "potentially reps
-- if the exercise's actual structure supports repetitions" — every one of
-- these 6 is a discretely-countable hop/pogo/rebound, so reps is a
-- structurally well-supported alternate framing to contacts.
UPDATE canonical_exercises SET dosage_capabilities = ARRAY['contacts', 'reps']
WHERE legacy_ex_id IN ('ex_027', 'ex_028', 'ex_029', 'ex_030', 'ex_031', 'ex_032');

-- ex_012 "Tempo Calf Raise with Pause at Top": the exercise's own name
-- names an isometric pause component, distinct from the universal tempo/
-- eccentric_duration fields (which capture speed, not an explicit hold).
UPDATE canonical_exercises SET dosage_capabilities = ARRAY['reps', 'hold']
WHERE legacy_ex_id = 'ex_012';

-- ex_026 "Repeated Fast Bilateral Heel Raises": structurally identical
-- calf-raise-at-speed movement to sibling ex_024/ex_025 (both reps-only,
-- same category/loading_profile), referenced by time only because
-- "repeated fast" reps are also commonly dosed by a work duration — reps
-- remains an equally valid alternate framing for the same movement.
UPDATE canonical_exercises SET dosage_capabilities = ARRAY['interval_time', 'reps']
WHERE legacy_ex_id = 'ex_026';

-- ex_034 "Continuous Easy Run" and ex_036 "Hill Walk/Jog Progression":
-- continuous running/walking protocols are commonly prescribed by EITHER
-- duration or distance interchangeably in real practice (unlike interval-
-- structured ex_033, where distance is not a natural framing for a
-- work/recovery pattern, and unlike ex_035's strides, which are natively
-- distance-based only).
UPDATE canonical_exercises SET dosage_capabilities = ARRAY['interval_time', 'distance']
WHERE legacy_ex_id IN ('ex_034', 'ex_036');

-- Stretches (ex_041-047): repeated stretch-hold reps ("3 x 30 sec calf
-- stretch") are near-universal PT practice, directly analogous to the
-- isometric-strength reps+hold case the founder explicitly approved for
-- ex_001-004 — extending the same reasoning to flexibility holds.
UPDATE canonical_exercises SET dosage_capabilities = ARRAY['hold', 'reps']
WHERE legacy_ex_id IN ('ex_041', 'ex_042', 'ex_043', 'ex_044', 'ex_045', 'ex_046', 'ex_047');

-- Every other exercise (isometric holds ex_001-004/ex_006, all plain
-- reps-only strength/eccentric/heavy/fast-dynamic exercises, ex_013, the
-- three accessory reps exercises, ex_033, ex_035, ex_040) is left with
-- allowed = default exactly as already populated — no expansion, matching
-- the founder's own isometric-hold example (contacts/distance are not
-- clinically reasonable there) with no additional evidence to widen them.

-- Hard invariant: default ⊆ allowed, enforced structurally, not just by
-- population convention.
ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_default_subset_of_allowed CHECK (
    default_dosage_capabilities <@ dosage_capabilities
  );
