-- =============================================================================
-- C5, Stage 4 — Revision D: exercise-appropriate OPTIONAL prescription fields.
--
-- Applies the same principle as the specialized DEFAULT vs ALLOWED dosage
-- capabilities (20261001000001) to the optional "More options" prescription
-- modifiers: a column existing on prescription_exercise_dosage does NOT mean
-- that field is clinically meaningful for every canonical exercise (e.g.
-- ROM/Assistance/Side for Continuous Easy Run).
--
--   canonical_exercises.optional_field_capabilities (NEW) — the optional
--   prescription modifiers the dosage editor offers for clean authoring of
--   this exercise. Vocabulary (machine-stable, DB-constrained):
--     'tempo'      — structured rep tempo (concentric / rep hold /
--                    eccentric seconds) + tempo description, as one group
--     'rpe'        — the existing rpe column
--     'rir'        — the existing rir column
--     'rom'        — the existing rom column
--     'assistance' — the existing assistance_level column
--     'side'       — the existing side column
--
-- RPE and RIR are separate tokens even though the editor presents them as
-- one mutually-exclusive control: "repetitions in reserve" is not meaningful
-- for every exercise where an effort rating is (e.g. isometric holds), and
-- gating them independently changes neither field's meaning.
--
-- Deliberately NOT part of this vocabulary:
--   - patient-specific/additional instructions — always available.
--   - sets / load / rest — universal, unchanged (Revision B).
--   - the specialized dimensions — dosage_capabilities /
--     default_dosage_capabilities, a separate concept, untouched here.
--
-- This is a pure UI-offering gate. No prescription/template/draft dosage
-- row is touched, no column is dropped or constrained, and the dosage write
-- path does not enforce it: a saved value for a field outside this set is
-- preserved and still shown by the editor (same historical/off-capability
-- principle as the specialized dimensions). Applicable never means required.
-- =============================================================================

ALTER TABLE canonical_exercises
  ADD COLUMN optional_field_capabilities TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE canonical_exercises
  ADD CONSTRAINT canonical_exercises_optional_field_capabilities_vocabulary CHECK (
    optional_field_capabilities <@ ARRAY['tempo', 'rpe', 'rir', 'rom', 'assistance', 'side']::TEXT[]
  );

COMMENT ON COLUMN canonical_exercises.optional_field_capabilities IS
  'C5.4 Revision D: optional prescription modifiers (tempo, rpe, rir, rom, assistance, side) the dosage editor offers for clean authoring of this exercise. UI-offering gate only — never makes a field required, never restricts what a saved dosage row may contain (off-capability saved values remain visible/editable). Patient-specific instructions are always available and are not part of this vocabulary.';

-- -----------------------------------------------------------------------------
-- Clinical curation of all 47 global canonical exercises. Grouped only where
-- the exercises are genuinely equivalent for every one of the six fields.
--
-- Principles applied (see the Revision D report for per-exercise rationale):
--   tempo      — rep-based movements where phase speed is prescribed.
--   rpe        — resistance/contraction effort. NOT offered for running or
--                plyometric/fast work: the existing field is paired with RIR
--                as a resistance-effort rating, and is not reinterpreted as
--                a session-RPE/running-intensity field (flagged for founder
--                review).
--   rir        — only where sets are taken toward fatigue with countable
--                reps (not isometric holds, not pain-gated partial range).
--   rom        — where deliberately constraining/prescribing range is a real
--                variable (range gates, insertional neutral limits, isometric
--                joint angle, stretch end-range).
--   assistance — standing bodyweight work where hand support/guarding is a
--                genuine regression variable, and balance drills. Not
--                machines, heavy loading, fast/plyometric, running, stretches.
--   side       — unilateral (or either-way) exercises where which limb is
--                prescribed matters. Not bilateral work; not running gait.
-- -----------------------------------------------------------------------------

-- Standing bodyweight isometric holds (bilateral): effort target (~70%
-- MVIC) and hold position are prescribed; wall/chair support is a
-- regression variable. RIR is not meaningful for a hold.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['rpe', 'rom', 'assistance']
WHERE legacy_ex_id IN ('ex_001', 'ex_003');

-- Single-leg standing isometric hold: as above, plus which limb.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['rpe', 'rom', 'assistance', 'side']
WHERE legacy_ex_id = 'ex_002';

-- Seated isometric plantarflexion: effort only — no movement range to
-- constrain, no balance/support demand, bilateral.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['rpe']
WHERE legacy_ex_id = 'ex_004';

-- Leg press short-range isometric: effort + hold position (mid-range, not
-- end range). Machine-supported, bilateral.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['rpe', 'rom']
WHERE legacy_ex_id = 'ex_006';

-- Supported partial-range raise: range gate is the defining feature, wall
-- support is the prescribed regression. Pain-gated, not taken toward
-- fatigue — RIR excluded.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo', 'rpe', 'rom', 'assistance']
WHERE legacy_ex_id = 'ex_005';

-- Standing bodyweight bilateral isotonic raises.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo', 'rpe', 'rir', 'rom', 'assistance']
WHERE legacy_ex_id IN ('ex_007', 'ex_009', 'ex_012');

-- Standing bodyweight raises/eccentrics with a single-leg component.
-- ex_013 lowers on both legs "or single leg if tolerated".
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo', 'rpe', 'rir', 'rom', 'assistance', 'side']
WHERE legacy_ex_id IN ('ex_008', 'ex_013', 'ex_015', 'ex_016', 'ex_017');

-- Machine / seated / heavy free-weight bilateral isotonic loading: no
-- assistance (machine-stabilized or HSR-phase), no side.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo', 'rpe', 'rir', 'rom']
WHERE legacy_ex_id IN ('ex_010', 'ex_011', 'ex_014', 'ex_018', 'ex_019', 'ex_020', 'ex_022', 'ex_023', 'ex_037');

-- Heavy single-leg dumbbell raise.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo', 'rpe', 'rir', 'rom', 'side']
WHERE legacy_ex_id = 'ex_021';

-- Band-resisted accessory strengthening performed per limb.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo', 'rpe', 'rir', 'rom', 'side']
WHERE legacy_ex_id IN ('ex_038', 'ex_039');

-- Rep-based fast/snap raises: phase speed is the trained variable (tempo
-- description, e.g. "explosive up, controlled down"); effort-to-fatigue
-- (RPE/RIR) and range are explicitly not the variable.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['tempo']
WHERE legacy_ex_id IN ('ex_024', 'ex_025');

-- Time-based repeated heel raises, bilateral rebounds/pogos/line hops,
-- and every running/return-to-run protocol: none of the optional
-- modifiers apply (intensity/pace guidance belongs in instructions).
UPDATE canonical_exercises SET optional_field_capabilities = '{}'::TEXT[]
WHERE legacy_ex_id IN ('ex_026', 'ex_027', 'ex_028', 'ex_030', 'ex_033', 'ex_034', 'ex_035', 'ex_036');

-- Single-leg plyometrics: which limb only.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['side']
WHERE legacy_ex_id IN ('ex_029', 'ex_031', 'ex_032');

-- Single-leg balance drills: contact guard / support is the classic
-- prescription variable here; which limb.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['assistance', 'side']
WHERE legacy_ex_id = 'ex_040';

-- Bilateral static stretches: stretch end-range only.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['rom']
WHERE legacy_ex_id IN ('ex_041', 'ex_043');

-- Unilateral (or either-way) stretches/mobilization: end-range + limb.
-- ex_047 is performed with "one or both feet" on the board.
UPDATE canonical_exercises SET optional_field_capabilities = ARRAY['rom', 'side']
WHERE legacy_ex_id IN ('ex_042', 'ex_044', 'ex_045', 'ex_046', 'ex_047');
