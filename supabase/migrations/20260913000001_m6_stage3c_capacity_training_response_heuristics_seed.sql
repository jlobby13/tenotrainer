-- =============================================================================
-- Milestone 6, Stage 3C: catalog the operational rules the Capacity +
-- Training Response engines implement. Data-only migration (no schema
-- change) — m6_heuristics already exists (20260911000006). Keys mirror
-- web/lib/capacityHeuristics.ts exactly — the engines look these rows up by
-- heuristic_key via getHeuristicByKey(), never a hardcoded UUID.
--
-- Two of these rules (m6_capacity_state_mapping's stronger-label threshold,
-- and its loading_pattern_variable trigger) are INTENTIONALLY INCOMPLETE —
-- see each row's known_limitations. The v1 classifier (web/lib/
-- capacityClassifier.ts) never emits loading_capacity_improving or
-- loading_pattern_variable; it returns a "pending_founder_decision" result
-- instead of guessing. This row still exists because the FRAMEWORK around
-- those two branches (the construct, the 2-of-4 mechanism, the three
-- determined states) is real and in production; the row's own text says so
-- plainly, matching this codebase's established practice of never silently
-- overstating what is actually locked.
--
-- None of these are validated Achilles biological thresholds — every
-- evidence_status is 'operational_convenience'; none links a fabricated
-- citation.
-- =============================================================================

INSERT INTO m6_heuristics (heuristic_key, name, description, rationale, evidence_status, version_introduced, status, known_limitations)
VALUES
  (
    'm6_capacity_comparable_series_definition',
    'Capacity comparable-series definition',
    'Two exposures to an exercise are comparable, for Capacity purposes, only when they share the exact-match triple (ex_id, loading_profile, performance_unit) as recorded in each session''s own immutable prescription_snapshot. A prescription-version change alone never breaks comparability; a change to the exercise identity, loading profile, or performance unit (reps vs. hold-time) always does.',
    'Cross-session mechanical comparison is only meaningful when the underlying task is actually the same task — comparing a heavy calf raise to a plyometric pogo hop, or a rep count to a hold duration, would fabricate a false equivalence.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'ex_id is a frozen string captured from the legacy exercise engine''s output, with no live, FK-enforced exercise catalog behind it in this codebase (the Postgres exercises table is dead/unused) — this rule trusts string equality, not referential integrity. Stage 3C does not redesign the exercise catalog.'
  ),
  (
    'm6_partial_order_loading_comparison',
    'Partial-order loading dimension comparison',
    'Loading dimensions (completed sets, reps/hold-seconds per set, external load) are never numerically combined into a single scalar. A candidate exposure is "higher" only when at least one dimension increases and every other known dimension is maintained or increased (Pareto dominance). A mix of one dimension up and another down is "non-dominating" — never resolved by inventing an exchange rate between dimensions. A dimension unknown on either side is excluded from the comparison, never substituted with zero.',
    'Sets, reps, and external load are qualitatively different kinds of loading; collapsing them into one number (e.g. sets*reps) would fabricate a weighting between dimensions the clinical team has not endorsed.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational comparison rule for v1, not a validated biomechanical loading model. No exercise in the current content library records an external load value at all, so that dimension is unknown (not zero) in essentially every current comparison.'
  ),
  (
    'm6_capacity_comparable_demonstrations_2_of_4',
    'Capacity 2-of-4 confirmation rule',
    'A higher demonstrated loading level for a comparable construct requires at least 2 successful comparable demonstrations within the most recent 4 comparable recorded prescribed opportunities for that construct. Unrelated constructs never enter the four. A single higher exposure is factual evidence only, never confirmation by itself.',
    'A bare majority-of-4 rule is simple, reproducible, and resistant to one outlier session being read as a durable capability change, while still requiring real repetition rather than a one-off.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    '2-of-4 is a TenoTrainer operational heuristic, not a validated biological threshold. Has not been validated against clinician-judged capacity change.'
  ),
  (
    'm6_successful_capacity_exposure_qualification',
    'Successful Capacity exposure qualification',
    'A loading exposure positively qualifies as a successful Capacity demonstration when its paired tolerance evaluation is well_tolerated+maintain or caution+maintain. caution+maintain_cautiously, caution+reduce_modify, acute_override/clinical_review, and any insufficient_data placeholder do not qualify. Mechanical performance itself remains factual and visible regardless of qualification.',
    'A higher loading level is only meaningful as a capacity finding if the tendon''s response was acceptable — mechanical repetition alone, without an acceptable response, would overstate what the patient can sustainably do.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational qualification rule for v1, not a validated clinical threshold.'
  ),
  (
    'm6_capacity_state_mapping',
    'Capacity state mapping',
    'Maps the 2-of-4 confirmation mechanism and comparable-opportunity history to one of: capacity_building, loading_capacity_stable, more_comparable_data_needed (fully implemented in v1), plus loading_capacity_improving and loading_pattern_variable (RESERVED — the v1 classifier never emits either; see known_limitations). Capacity is never a universal score — one row exists per patient per comparable construct.',
    'A single headline per construct lets a clinician or patient see where a specific exercise stands without implying a combined, cross-exercise capacity number that was explicitly ruled out.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'TWO BRANCHES ARE INTENTIONALLY UNRESOLVED, not silently decided: (1) the minimum amount of Well-Tolerated evidence (vs. Caution+Maintain) required to justify the stronger loading_capacity_improving label once 2-of-4 is met, and (2) the exact deterministic trigger for loading_pattern_variable. See the Stage 3C design report for the smallest proposed rule for each, pending founder approval.'
  ),
  (
    'm6_training_response_state_mapping',
    'Training Response state mapping',
    'Combines Stage 3B''s Overall Symptoms state with a window-aligned comparable-loading comparison (increased/maintained/decreased/mixed/insufficient, computed over the EXACT SAME 10 response episodes as the relevant Stage 3B interpretation) into one of: loading_tolerance_improving, stable_training_response, variable_training_response, training_response_remains_unsettled, more_data_needed. loading_tolerance_improving requires BOTH a favorable symptom pattern AND loading maintained-or-increased — a symptom improvement achieved via a meaningful deload is never labeled loading_tolerance_improving.',
    'Symptom improvement alone cannot establish improved loading tolerance if it happened only because loading was reduced; Training Response exists specifically to keep that distinction visible rather than implying loading, tolerance are conflated.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational combination rule for v1, not a validated clinical instrument. Several symptom-state/loading-comparison combinations that the locked rules do not explicitly award a positive state to (e.g. stable symptoms with increased loading) resolve to more_data_needed by construction rather than an invented sixth state — documented in the Stage 3C design report.'
  ),
  (
    'm6_reps_vs_hold_unit_resolution',
    'Reps vs. hold-seconds unit resolution',
    'The same numeric performance column (set_outcomes.actual_reps/prescribed_reps) represents repetitions for a reps-based construct and hold-duration seconds for an isometric construct — discriminated only by that specific session''s own prescription_snapshot loading_profile value for the exercise. A non-numeric dosage (a range, a hold-duration string, free text) is never parsed into an invented number; it is marked unrepresentable and excluded from quantitative Capacity comparison, though the exercise remains factually visible.',
    'Formalizes an existing implicit convention (previously only a code comment) as an explicit, cataloged rule, since it materially affects how a raw number in this column should be clinically read.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A technical/structured-performance-model convention, not a clinical rule. Documented as future structured-performance-model technical debt: an explicit set_outcomes.unit column would remove the need to re-derive this from the snapshot on every read, but is not implemented in this pass.'
  )
ON CONFLICT (heuristic_key) DO NOTHING;
