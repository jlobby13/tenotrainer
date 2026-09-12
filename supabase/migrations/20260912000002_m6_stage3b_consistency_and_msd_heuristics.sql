-- =============================================================================
-- Milestone 6, Stage 3B — founder-review follow-up: catalog the two
-- operational rules approved during Stage 3B review that were not yet
-- represented in the heuristics catalog (20260912000001, already applied,
-- is NOT edited here — this is a new, additive migration).
--
-- 1. Consistency mapping (variable vs. consistent) — APPROVED for M6 v1:
--    see web/lib/symptomClassifier.ts's classifyConsistency and
--    docs/m6-stage3b-symptom-engine.md.
-- 2. MSD >=3 applicable-observations-per-window floor — FOUNDER DECISION:
--    see web/lib/symptomClassifier.ts's classifyMsd and the same doc.
--
-- Neither heuristic supersedes an existing row (both are net-new rules, not
-- revisions of an already-cataloged/used heuristic), so the Stage 3A
-- supersession chain (supersedes_heuristic_id) does not apply here.
-- Neither links a fabricated evidence citation.
-- =============================================================================

INSERT INTO m6_heuristics (heuristic_key, name, description, rationale, evidence_status, version_introduced, status, known_limitations)
VALUES
  (
    'm6_consistency_variable_vs_consistent',
    'Consistency: variable vs. consistent mapping',
    'For a core symptom domain (P, MP, MS), the recent 5 relative-direction observations (lower/similar/higher vs. the previous window''s median) are classified as ''variable'' when they contain at least one ''lower'' AND at least one ''higher'' observation (genuinely opposing evidence). Otherwise ''consistent'' — a one-sided mix of a single direction plus ''similar'' observations is NOT automatically variable, since ''similar'' is neutral, not opposing. Direction and consistency remain separate outputs; IQR plays no role in this decision.',
    'A clear, reproducible rule for distinguishing "the pattern points one way" from "the pattern is genuinely mixed", using only the directional evidence already computed for frequency classification rather than an additional invented dispersion threshold.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational definition for M6 v1, not a validated Achilles clinical threshold. Has not been validated against clinician-judged consistency.'
  ),
  (
    'm6_msd_min_3_applicable_per_window',
    'MSD minimum applicable observations per window (>=3)',
    'A formal MSD (next-morning stiffness duration) direction is only produced when each of the previous and recent 5-episode windows contains at least 3 applicable, known duration observations (episodes where morning stiffness was actually present, i.e. MS > 0, and the duration bucket is known). Below that floor in either window, MSD direction is insufficient_data; raw MSD history remains available, and core P/MP/MS symptom classification and the overall Symptoms summary are entirely unaffected.',
    'MSD applicability is conditional on MS > 0, so the qualifying sample size per window can be much smaller than the fixed 5-episode window itself; a floor of 3 avoids drawing a formal ordinal direction conclusion from only 1-2 observations while still allowing a call well before all 5 slots are filled.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'A TenoTrainer operational heuristic for v1, not a validated biological/clinical threshold. The floor of 3 (rather than some other number) has not been independently validated.'
  )
ON CONFLICT (heuristic_key) DO NOTHING;
