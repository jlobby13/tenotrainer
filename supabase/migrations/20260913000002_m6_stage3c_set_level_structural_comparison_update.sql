-- =============================================================================
-- Milestone 6, Stage 3C — founder-review round 3: corrects the catalog text
-- of three heuristics seeded by 20260913000001 (NOT edited here — that
-- migration is already applied and immutable) to reflect the actual,
-- current mechanism after the round-3 redesign:
--   - Capacity/Training Response preserve REAL, ordered, set-level
--     demonstrated performance (never collapsed via min/median/sum/mean).
--   - Session-to-session comparison is structural/partial-order over those
--     real set vectors (compareSetVectors), including within-set reps/load
--     pairing and unequal-set-count handling (non_dominating, never an
--     invented exchange rate).
--   - Consistently lower recorded mechanical loading resolves to
--     more_comparable_data_needed (never loading_pattern_variable,
--     loading_capacity_stable, or any "declining" state) — Capacity has NO
--     decline state, by design.
--   - The Capacity state mapping is now fully deterministic (round 3
--     closed every previously-pending branch).
--   - Training Response's window-level aggregation of real per-exposure
--     comparisons into one increased/maintained/decreased/mixed/insufficient
--     verdict remains an explicit, unapproved review gate.
--
-- This is a plain UPDATE, not a supersession: confirmed via direct query
-- before writing this migration that zero m6_interpretation_heuristics rows
-- reference any of these three heuristic ids in the live database (Stage
-- 3C has not yet been approved for commit, so nothing has used them for
-- real) — the Stage 3A supersession guard (20260911000008) permits a plain
-- UPDATE precisely in this case. If that guard ever rejects this migration
-- when it is actually applied, these heuristics have been used in the
-- interim and this migration must be redone as a supersession
-- (INSERT + supersedes_heuristic_id) instead — do not remove the guard to
-- force it through.
-- =============================================================================

UPDATE m6_heuristics
SET
  description = 'Loading dimensions are compared over the REAL, ordered, set-level demonstrated performance — never collapsed into a single scalar or aggregate (no min/median/sum/mean across sets). A candidate exposure is "higher" only when its set-vector structurally dominates the baseline''s set-vector: every set position where both sides are known moves the same direction (or is equal), with at least one strictly higher. A single set''s own reps/hold-duration and external load moving in different directions is itself non-dominating, never resolved by weighting one over the other. Unequal set counts between two exposures (e.g. 3x12 vs 4x10) are never resolved by inventing an exchange rate between set count and per-set amount — they are always non_dominating.',
  rationale = 'Sets, reps, and external load are qualitatively different kinds of loading, and different sessions may not even have comparable shapes; collapsing them into one number (or assuming a shape mismatch favors one side) would fabricate a weighting or equivalence the clinical team has not endorsed. Preserving the real set-by-set record keeps every classification traceable to an observation that actually happened.',
  known_limitations = 'A TenoTrainer operational comparison rule for v1, not a validated biomechanical loading model. No exercise in the current content library records an external load value at all, so that dimension is unknown (not zero) in essentially every current comparison. Unequal-shape exposures are conservatively non_dominating rather than partially credited — this may under-recognize some legitimately higher, differently-structured sessions; not revisited in this pass.'
WHERE heuristic_key = 'm6_partial_order_loading_comparison';

UPDATE m6_heuristics
SET
  description = 'Maps the 2-of-4 confirmation mechanism and comparable-opportunity history to one of five states, ALL fully deterministic as of round 3: capacity_building, loading_capacity_improving (2-of-4 confirmed AND Well-Tolerated demonstrations outnumber Caution+Maintain ones among the qualifying set), loading_capacity_stable (mechanically at-or-above baseline throughout, regardless of tolerance mix — Capacity is mechanical-only; tolerance/symptom-response variability belongs to Training Response, not Capacity), loading_pattern_variable (genuine opposing mechanical evidence — at least one exposure mechanically higher AND at least one mechanically lower, or a single internally non-dominating exposure — regardless of tolerance), and more_comparable_data_needed (insufficient history, an unrepresentable construct, OR consistently lower recorded mechanical loading with no opposing higher evidence). Capacity has NO decline state: consistently lower loading is never loading_pattern_variable, never loading_capacity_stable, and never any "declining" label — it resolves to more_comparable_data_needed with a structured recent_loading_lower descriptor and the factual phrasing "Recent loading has been lower," with no inference drawn about why, about physiological capacity, or about regression. Capacity is never a universal score — one row exists per patient per comparable construct.',
  known_limitations = 'A TenoTrainer operational labeling/state framework for v1, not a validated clinical instrument or evidence of biological tendon adaptation. No domain is weighted more heavily than another; this is a categorical rollup only, over real demonstrated performance, never inferred physiology.'
WHERE heuristic_key = 'm6_capacity_state_mapping';

UPDATE m6_heuristics
SET
  known_limitations = 'A TenoTrainer operational combination rule for v1, not a validated clinical instrument. The window-level aggregation step — how real, per-construct, per-session structural comparisons (never a synthetic aggregate) combine into one overall increased/maintained/decreased/mixed/insufficient verdict for the aligned 10-episode window — remains an EXPLICIT, UNAPPROVED review gate: no 3-of-5/majority/median/mean/other threshold has been founder-approved for this specific step, so none is invented. Until approved, the engine reports every real underlying comparison (never discarded) but treats the overall window verdict as unresolved, which resolves every Training Response classification to more_data_needed regardless of symptom state. Several symptom-state/loading-comparison combinations the locked rules do not explicitly award a positive state to (e.g. stable symptoms with increased loading) also resolve to more_data_needed by construction rather than an invented sixth state — documented in the Stage 3C design report.'
WHERE heuristic_key = 'm6_training_response_state_mapping';
