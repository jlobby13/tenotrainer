-- =============================================================================
-- Milestone 6, Stage 3B: catalog the operational rules the 5+5 longitudinal
-- symptom engine actually implements. Data-only migration (no schema
-- change) — m6_heuristics already exists (20260911000006). Seeding these as
-- a migration, not a one-off script, keeps every environment (dev/staging/
-- prod) with the same catalog rows, matching the reference/catalog-table
-- precedent these rows themselves describe.
--
-- Keys mirror web/lib/symptomHeuristics.ts exactly — the engine
-- (web/lib/longitudinalInterpretationEngine.ts) looks these rows up by
-- heuristic_key via getHeuristicByKey(), never by a hardcoded UUID.
--
-- None of these are validated Achilles biological thresholds — every
-- evidence_status below is 'operational_convenience' or
-- 'operational_heuristic'; none links a fabricated citation. If real
-- evidence is identified later, link it via m6_heuristic_evidence in a
-- separate migration — do not backfill a citation here.
-- =============================================================================

INSERT INTO m6_heuristics (heuristic_key, name, description, rationale, evidence_status, version_introduced, status, known_limitations)
VALUES
  (
    'm6_rolling_5_plus_5_window',
    'Rolling 5+5 short-window symptom comparison',
    'Compares the most recent 5 eligible, complete response episodes against the previous 5 eligible, complete response episodes (10 total) for each core symptom domain (P, MP, MS). Window membership is by eligible-episode count, never calendar days; an episode missing required M4 data is excluded rather than substituted.',
    'A fixed episode count gives a reproducible, patient-pace-independent comparison window that does not require guessing an adherence-dependent calendar span, and avoids diluting the signal with sparse or incomplete data.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'Not validated against a gold-standard comparator. Window size (5+5) is a TenoTrainer operational choice, not derived from a published Achilles-specific monitoring protocol.'
  ),
  (
    'm6_directional_frequency_60pct',
    'Directional frequency (>=60%) pattern rule',
    'For a core symptom domain, a directional pattern (favorable or unfavorable) exists when at least 3 of the 5 recent observations fall on the same side (lower or higher) of the previous window''s median, using the 1-point directional boundary. This frequency/proportion signal is PRIMARY; the median is corroborating only, never independently determinative.',
    'A majority-of-5 rule is simple, reproducible, and resistant to a single outlier session dominating the classification, while still requiring real concentration rather than a bare plurality.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    '60% is a TenoTrainer operational heuristic, not a validated biological threshold. Has not been validated against clinician-judged improvement/worsening.'
  ),
  (
    'm6_one_point_directional_boundary',
    '1-point operational directional boundary',
    'On the 0-10 integer symptom scales (P, MP, MS), a recent observation is classified LOWER when it is at least 1 point below the previous window''s median, HIGHER when at least 1 point above, and SIMILAR otherwise.',
    'A 1-point boundary on an integer 0-10 scale guarantees every observation falls into exactly one category (no dead zone), without requiring a wider band that would suppress real single-point movements.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'This is a TenoTrainer operational directional boundary and must never be presented as a validated Achilles clinical threshold or MCID.'
  ),
  (
    'm6_overall_symptoms_summary_logic',
    'Overall Symptoms summary logic',
    'A non-numeric, non-weighted summary/navigation aid derived only from the three core domains'' (P, MP, MS) directions: Symptoms Improving (>=2 improving, none higher), Symptoms Trending Better (exactly 1 improving, none higher), Symptoms Stable (no qualifying improving/higher pattern), Mixed Symptom Response (>=1 improving AND >=1 higher), Symptoms Trending Higher (>=2 higher, none improving), More Data Needed (any core domain insufficient).',
    'Clinicians and patients need a single headline state, but it must never imply a validated composite score or hide which specific domain is driving it — the per-domain detail is always persisted alongside this summary, never replaced by it.',
    'operational_convenience',
    'm6_longitudinal_v1',
    'active',
    'Not a validated composite clinical instrument. No domain is weighted more heavily than another; this is a categorical rollup only.'
  )
ON CONFLICT (heuristic_key) DO NOTHING;
