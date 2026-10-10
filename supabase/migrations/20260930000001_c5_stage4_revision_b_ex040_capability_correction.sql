-- =============================================================================
-- C5, Stage 4 — Revision B founder correction (pre-implementation): ex_040
-- ("Balance and Frontal-Plane Control Drills") gains 'reps' alongside its
-- existing 'hold' dosage capability. Capability metadata only — no
-- exercise_reference_dosage row is created or inferred for ex_040 (it
-- remains, by design, the one canonical exercise with zero reference
-- dosage; see 20260929000001's implementation report). This is a data
-- correction to the values written in 20260929000001, made here as a new
-- migration rather than editing that already-applied one.
-- =============================================================================

UPDATE canonical_exercises
SET dosage_capabilities = ARRAY['reps', 'hold']
WHERE legacy_ex_id = 'ex_040';
