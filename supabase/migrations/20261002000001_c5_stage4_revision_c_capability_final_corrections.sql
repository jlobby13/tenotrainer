-- =============================================================================
-- C5, Stage 4 — Revision C, Part 0: final founder clinical corrections to the
-- ALLOWED dosage-capability set (canonical_exercises.dosage_capabilities;
-- see 20261001000001 for the default-vs-allowed semantics). Two corrections
-- only — every other exercise's mapping from the prior correction is
-- retained unchanged.
--
--   - ex_012 "Tempo Calf Raise with Pause at Top": REMOVE 'hold' from
--     allowed. The within-repetition pause is already representable via the
--     existing universal rep-level tempo/hold fields (concentric_duration_
--     seconds/rep_hold_duration_seconds/eccentric_duration_seconds/
--     tempo_description) — a specialized "Hold" dosage dimension would be a
--     second, competing mechanism for the same within-repetition pause.
--   - ex_041-045, ex_047 (conventional stretches): REMOVE 'reps' from
--     allowed. These should not offer Repetitions merely by analogy to the
--     strength-isometric reps+hold case — that analogy does not hold for a
--     static flexibility stretch.
--   - ex_046 "Knee-to-Wall WBLT Self-Mobilization": UNCHANGED — remains
--     hold+reps allowed (it may reasonably be performed as repeated
--     mobilization repetitions, distinct from the other six stretches).
--
-- default_dosage_capabilities is untouched by this migration (no exercise's
-- DEFAULT changes) — only the ALLOWED superset narrows for these 6
-- exercises. The default ⊆ allowed invariant (20261001000001) remains
-- satisfied throughout (removed 'reps'/'hold' values were never part of
-- default for these exercises).
-- =============================================================================

UPDATE canonical_exercises
SET dosage_capabilities = ARRAY['reps']
WHERE legacy_ex_id = 'ex_012';

UPDATE canonical_exercises
SET dosage_capabilities = ARRAY['hold']
WHERE legacy_ex_id IN ('ex_041', 'ex_042', 'ex_043', 'ex_044', 'ex_045', 'ex_047');

-- ex_046 intentionally not touched — remains ARRAY['hold','reps'].
