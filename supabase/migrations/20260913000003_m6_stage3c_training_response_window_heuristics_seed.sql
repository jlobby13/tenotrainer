-- =============================================================================
-- Milestone 6, Stage 3C — founder round 4: catalogs the FINAL locked
-- Training Response window mechanism. Data-only, additive migration — none
-- of 20260913000001/000002 (already applied) are edited.
--
-- Three new operational heuristics, all TenoTrainer operational choices,
-- none a validated biological threshold, MCID, or statistical confidence
-- threshold. None links a fabricated evidence citation.
-- =============================================================================

INSERT INTO m6_heuristics (heuristic_key, name, description, rationale, evidence_status, version_introduced, status, known_limitations)
VALUES
  (
    'm6_training_response_window_pairing',
    'Training Response boundary-adjacent real-exposure pairing',
    'For each comparable construct within the aligned Stage 3B 5+5 window, previous-half and recent-half real exposures are each ordered chronologically, then paired outward from the window boundary: the most-recent previous exposure pairs with the earliest recent exposure, the second-most-recent previous pairs with the second-earliest recent, and so on until the shorter side is exhausted. Every real exposure appears in at most one pair. No synthetic exposure vector, no single arbitrary previous-window reference, and no all-cross-window comparison is used. Real exposures left over on the longer side are preserved in provenance but do not enter that run''s paired comparison.',
    'Pairs the two real observations that are temporally closest to each other across the window seam, avoiding both a single fragile reference point (vulnerable to one atypical session) and the pseudo-replication risk of comparing every previous exposure against every recent one.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational pairing convention for v1, not a validated statistical matching method. When previous/recent counts differ, real exposures on the longer side go unmatched for that run — they are not lost from provenance, but they do not contribute evidence to that specific window''s classification.'
  ),
  (
    'm6_training_response_minimum_paired_exposures',
    'Training Response minimum 2 usable paired exposures',
    'A comparable construct may only contribute a formal window-level loading direction (increased/maintained/decreased/mixed) once it has at least 2 usable real paired comparisons (a comparison is "usable" when the underlying structural comparison actually returned a result, i.e. is not itself "insufficient"). With 0 or 1 usable pair, that construct''s result is "insufficient" — the underlying pair, if any, remains fully visible in provenance, but does not support a longitudinal loading-window conclusion by itself.',
    'A single paired comparison is a factual data point but not evidence of a window-level pattern; requiring at least 2 avoids treating one session''s comparison as if it characterized the whole recent period.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational sufficiency heuristic for v1. It is NOT a validated biological threshold, NOT an MCID, NOT evidence of tendon adaptation, and NOT a statistical confidence threshold — the number 2 was not derived from any validation study.'
  ),
  (
    'm6_training_response_loading_direction_mapping',
    'Training Response construct-level loading direction mapping',
    'Maps a construct''s usable paired comparisons (each higher/equal/lower/non_dominating, from the approved structural set-vector comparison) to one of increased (>=1 higher, zero lower, zero non_dominating; equal may coexist), decreased (>=1 lower, zero higher, zero non_dominating; equal may coexist), maintained (every usable pair equal), or mixed (both higher AND lower present, OR any non_dominating comparison — a single opposing or non-dominating real comparison is intentionally enough to prevent a clean increased/maintained/decreased statement). Multiple constructs then combine: all usable constructs agreeing yields that shared result; disagreement, or any usable construct itself mixed, yields overall mixed. Insufficient constructs never vote toward direction but remain fully visible in provenance and trigger a limited-comparable-exposures context flag when at least one other construct is usable. No 60%, majority voting, 2-of-4, mean, median, or weighted scoring is used at any point in this mapping.',
    'A deliberately conservative, threshold-free rule: any genuine contradiction in the real evidence (an opposing pair, or a single non-dominating pair) is enough to withhold a clean directional claim, favoring "mixed" or "insufficient" over an overstated conclusion.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational combination rule for v1, not a validated clinical instrument. This step never interprets a loading pattern as Capacity confirmation — Capacity remains governed entirely and only by its own independent 2-of-4/qualification/labeling mechanism.'
  )
ON CONFLICT (heuristic_key) DO NOTHING;
