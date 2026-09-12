-- =============================================================================
-- Milestone 6, Stage 3A: durable, versioned storage for longitudinal
-- clinical interpretation. ARCHITECTURE ONLY — no inference rules, no
-- classifier, no patient-facing states are implemented by this migration.
-- Nothing writes to these tables yet; they exist so a future,
-- separately-approved Stage 3B+ engine has somewhere durable to persist its
-- output without a schema redesign.
--
-- Guiding architecture (per the M6 Stage 3 brief):
--   Prescription -> Session Prescription Snapshot -> Actual Performance ->
--   Patient Response -> Clinical Interpretation -> Clinician Review
-- This migration is the "Clinical Interpretation" layer ONLY. It reads from
-- (via provenance references) but never mutates the raw layers below it
-- (rehab_sessions, morning_responses, tolerance_evaluations,
-- prescription_versions) or the review layer above it (not built yet).
--
-- Reused conventions (see the M6 Stage 3A audit in the founder report for
-- the full citation trail):
--   - Append-only, server-derived-only trust tier, identical to
--     escalation_evaluations / tolerance_evaluations / prescription_versions
--     / session_guidance_contexts: RLS enabled, patient+clinician READ
--     policies only, no permissive write policy for `authenticated` at all,
--     explicit REVOKE as defense in depth. Only service_role writes.
--   - No organization_id column, matching the EXISTING documented decision
--     in 20260905000001_m3_session_response.sql: "clinical tables in this
--     schema are not org-scoped ... documented as the CURRENT access model,
--     not a permanent multi-tenancy decision." Interpretations are
--     patient-scoped (user_id) with clinician access via supervisor_patients,
--     exactly like every other clinical table.
--   - Free-TEXT, NOT CHECK-constrained vocabulary for `domain` and
--     `result_state` — mirrors tolerance_evaluations' OWN Stage 1 precedent
--     (20260906000001_m4_stage1_foundation.sql: "the vocabulary direction
--     ... is approved as a DIRECTION, not a locked, implemented mapping").
--     Stage 3B+ will lock these vocabularies once the classifier is
--     designed, the same way Stage 4 later locked tolerance_classification.
--   - `ruleset_version` as a plain TEXT column (not FK'd to a separate
--     versions table) — mirrors escalation_evaluations.rule_version and
--     tolerance_evaluations.rule_version exactly (each paired with a TS
--     constant, e.g. TOLERANCE_RULE_VERSION). A dedicated ruleset-versions
--     table was considered and rejected as an unnecessary parallel
--     convention — see the Stage 3A report's design-decisions section.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- m6_longitudinal_interpretations
--
-- One row per generated interpretation. Immutable once written: a future
-- ruleset update or recomputation NEVER updates an existing row — it INSERTs
-- a new one. "Current" interpretation for a (user, domain) is always
-- DERIVED as the latest row by generated_at, exactly like prescription_versions'
-- "current version" derivation — no is_current flag, no superseded_at column.
-- ---------------------------------------------------------------------------
CREATE TABLE m6_longitudinal_interpretations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id),

  -- WHAT was interpreted. Free text, deliberately unconstrained — see the
  -- header note. Expected early values (not enforced): 'symptoms_short_window',
  -- 'symptoms_long_window', 'symptoms_overall', 'capacity_series',
  -- 'training_response_series'. Do not assume this is the final list.
  domain            TEXT NOT NULL,

  -- Exact ruleset/model version that produced this row, e.g. 'm6_longitudinal_v1'.
  -- Never reused across a materially different rule set — a new ruleset
  -- version means new rows going forward, never a rewrite of old ones.
  ruleset_version   TEXT NOT NULL,

  -- Structured description of what was evaluated. Deliberately JSONB, not
  -- fixed columns — window SHAPE genuinely varies by domain (a rolling
  -- N+N session count is not the same shape as a calendar-week long-term
  -- comparison) and Stage 3B has not yet decided all domains' shapes.
  -- Example (illustrative only, not enforced): {"kind": "rolling_5_plus_5",
  -- "unit": "sessions"}.
  window_definition JSONB NOT NULL DEFAULT '{}',

  -- Optional, queryable convenience dates when the window genuinely has a
  -- calendar boundary — NULL when not applicable to this domain, never a
  -- guessed boundary. Deliberately nullable+independent of window_definition
  -- (which remains the source of truth for domains where these two dates
  -- don't fully capture the shape).
  window_start_date DATE,
  window_end_date   DATE,

  -- Coded result, separate from any future explanatory/patient-facing text
  -- (which does not exist yet — Stage 3A stores no copy at all). Free text,
  -- unconstrained — see header note. Illustrative future values only, not
  -- enforced: 'improving', 'stable', 'trending_higher', 'mixed',
  -- 'insufficient_data'.
  result_state      TEXT NOT NULL,

  -- Structured supporting detail specific to this domain's computation
  -- (e.g. rolling-window frequency counts) — intermediate data for future
  -- transparency/debugging, never prose and never patient-facing copy.
  result_detail     JSONB NOT NULL DEFAULT '{}',

  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT m6_longitudinal_interpretations_window_dates_order CHECK (
    window_start_date IS NULL OR window_end_date IS NULL OR window_start_date <= window_end_date
  )
);

CREATE INDEX idx_m6_interpretations_user_domain_generated
  ON m6_longitudinal_interpretations (user_id, domain, generated_at DESC);

ALTER TABLE m6_longitudinal_interpretations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_longitudinal_interpretations: own read"
  ON m6_longitudinal_interpretations FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "m6_longitudinal_interpretations: clinician read assigned patient"
  ON m6_longitudinal_interpretations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = m6_longitudinal_interpretations.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- Append-only, server-derived-only — no permissive INSERT/UPDATE/DELETE
-- policy exists at all, so RLS default-denies every write from
-- `authenticated`. The REVOKE below is defense in depth, identical to
-- escalation_evaluations/tolerance_evaluations/prescription_versions. No
-- inference engine exists yet (Stage 3B+) — whichever future server-side
-- path generates these rows will use the service-role client, same as
-- every other table in this trust tier.
REVOKE INSERT, UPDATE, DELETE ON m6_longitudinal_interpretations FROM authenticated;

-- ---------------------------------------------------------------------------
-- m6_interpretation_reason_codes
--
-- Structured, multi-valued limitation/reason attachment — an interpretation
-- may carry zero or more of these. NOT final patient-facing messages (no
-- copy is stored here, only the code). Initial vocabulary is the Stage 3A
-- brief's explicit list; CHECK-constrained (unlike domain/result_state
-- above) because this list was given as a concrete starting vocabulary, not
-- "a direction" — extend it via an additive migration the same way
-- session_events.type was widened for sudden_sharp_pain
-- (20260911000001_m5_acute_safety_gate.sql).
-- ---------------------------------------------------------------------------
CREATE TABLE m6_interpretation_reason_codes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id UUID NOT NULL REFERENCES m6_longitudinal_interpretations(id) ON DELETE CASCADE,
  reason_code       TEXT NOT NULL CHECK (reason_code IN (
    'limited_coverage',
    'mixed_symptom_directions',
    'high_response_variability',
    'recent_prescription_change',
    'limited_comparable_exposures',
    'external_loading_context_present',
    'capacity_response_mismatch'
  )),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT m6_interpretation_reason_codes_unique UNIQUE (interpretation_id, reason_code)
);

CREATE INDEX idx_m6_reason_codes_interpretation ON m6_interpretation_reason_codes (interpretation_id);

ALTER TABLE m6_interpretation_reason_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_interpretation_reason_codes: own read"
  ON m6_interpretation_reason_codes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      WHERE mi.id = m6_interpretation_reason_codes.interpretation_id AND mi.user_id = auth.uid()
    )
  );

CREATE POLICY "m6_interpretation_reason_codes: clinician read assigned patient"
  ON m6_interpretation_reason_codes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_reason_codes.interpretation_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON m6_interpretation_reason_codes FROM authenticated;

-- ---------------------------------------------------------------------------
-- Provenance: normalized join tables, one per source-entity type. Chosen
-- over a single polymorphic (source_table, source_id) table specifically
-- because these are heterogeneous, real foreign keys — a polymorphic table
-- cannot be FK-constrained per row in Postgres, which would silently reopen
-- the "queryable, integrity-checked reference" requirement the brief asks
-- for. Each is a pure join: no data duplicated from the source row.
-- ---------------------------------------------------------------------------

CREATE TABLE m6_interpretation_rehab_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id UUID NOT NULL REFERENCES m6_longitudinal_interpretations(id) ON DELETE CASCADE,
  rehab_session_id  UUID NOT NULL REFERENCES rehab_sessions(id),
  CONSTRAINT m6_interpretation_rehab_sessions_unique UNIQUE (interpretation_id, rehab_session_id)
);
CREATE INDEX idx_m6_interp_sessions_interpretation ON m6_interpretation_rehab_sessions (interpretation_id);
CREATE INDEX idx_m6_interp_sessions_session ON m6_interpretation_rehab_sessions (rehab_session_id);

CREATE TABLE m6_interpretation_morning_responses (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id   UUID NOT NULL REFERENCES m6_longitudinal_interpretations(id) ON DELETE CASCADE,
  morning_response_id UUID NOT NULL REFERENCES morning_responses(id),
  CONSTRAINT m6_interpretation_morning_responses_unique UNIQUE (interpretation_id, morning_response_id)
);
CREATE INDEX idx_m6_interp_morning_responses_interpretation ON m6_interpretation_morning_responses (interpretation_id);

CREATE TABLE m6_interpretation_tolerance_evaluations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id        UUID NOT NULL REFERENCES m6_longitudinal_interpretations(id) ON DELETE CASCADE,
  tolerance_evaluation_id  UUID NOT NULL REFERENCES tolerance_evaluations(id),
  CONSTRAINT m6_interpretation_tolerance_evaluations_unique UNIQUE (interpretation_id, tolerance_evaluation_id)
);
CREATE INDEX idx_m6_interp_tolerance_evals_interpretation ON m6_interpretation_tolerance_evaluations (interpretation_id);

CREATE TABLE m6_interpretation_prescription_versions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id        UUID NOT NULL REFERENCES m6_longitudinal_interpretations(id) ON DELETE CASCADE,
  prescription_version_id  UUID NOT NULL REFERENCES prescription_versions(id),
  CONSTRAINT m6_interpretation_prescription_versions_unique UNIQUE (interpretation_id, prescription_version_id)
);
CREATE INDEX idx_m6_interp_prescription_versions_interpretation ON m6_interpretation_prescription_versions (interpretation_id);

-- RLS + grants: identical shape across all four provenance tables (own read
-- via the parent interpretation's user_id, clinician read via
-- supervisor_patients, append-only/service-role-only write) — written out
-- explicitly per table rather than via a dynamic loop, matching this
-- codebase's existing migration style (see rehab_sessions/set_outcomes/
-- session_events in 20260905000001_m3_session_response.sql, which repeats
-- the same policy shape per table rather than generating it).

ALTER TABLE m6_interpretation_rehab_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_interpretation_rehab_sessions: own read"
  ON m6_interpretation_rehab_sessions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM m6_longitudinal_interpretations mi WHERE mi.id = m6_interpretation_rehab_sessions.interpretation_id AND mi.user_id = auth.uid())
  );

CREATE POLICY "m6_interpretation_rehab_sessions: clinician read assigned patient"
  ON m6_interpretation_rehab_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_rehab_sessions.interpretation_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON m6_interpretation_rehab_sessions FROM authenticated;

ALTER TABLE m6_interpretation_morning_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_interpretation_morning_responses: own read"
  ON m6_interpretation_morning_responses FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM m6_longitudinal_interpretations mi WHERE mi.id = m6_interpretation_morning_responses.interpretation_id AND mi.user_id = auth.uid())
  );

CREATE POLICY "m6_interpretation_morning_responses: clinician read assigned patient"
  ON m6_interpretation_morning_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_morning_responses.interpretation_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON m6_interpretation_morning_responses FROM authenticated;

ALTER TABLE m6_interpretation_tolerance_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_interpretation_tolerance_evaluations: own read"
  ON m6_interpretation_tolerance_evaluations FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM m6_longitudinal_interpretations mi WHERE mi.id = m6_interpretation_tolerance_evaluations.interpretation_id AND mi.user_id = auth.uid())
  );

CREATE POLICY "m6_interpretation_tolerance_evaluations: clinician read assigned patient"
  ON m6_interpretation_tolerance_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_tolerance_evaluations.interpretation_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON m6_interpretation_tolerance_evaluations FROM authenticated;

ALTER TABLE m6_interpretation_prescription_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_interpretation_prescription_versions: own read"
  ON m6_interpretation_prescription_versions FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM m6_longitudinal_interpretations mi WHERE mi.id = m6_interpretation_prescription_versions.interpretation_id AND mi.user_id = auth.uid())
  );

CREATE POLICY "m6_interpretation_prescription_versions: clinician read assigned patient"
  ON m6_interpretation_prescription_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_prescription_versions.interpretation_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON m6_interpretation_prescription_versions FROM authenticated;

-- ---------------------------------------------------------------------------
-- m6_interpretation_heuristics
--
-- Which catalogued heuristic(s) (20260911000006_m6_stage3a_heuristics_evidence_catalog.sql,
-- applied immediately before this migration) were applied to produce this
-- specific interpretation — the per-interpretation half of "View model
-- logic": a clinician viewing one interpretation can trace exactly which
-- catalogued rules produced it, and from there to their evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE m6_interpretation_heuristics (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interpretation_id UUID NOT NULL REFERENCES m6_longitudinal_interpretations(id) ON DELETE CASCADE,
  heuristic_id      UUID NOT NULL REFERENCES m6_heuristics(id),
  CONSTRAINT m6_interpretation_heuristics_unique UNIQUE (interpretation_id, heuristic_id)
);
CREATE INDEX idx_m6_interp_heuristics_interpretation ON m6_interpretation_heuristics (interpretation_id);
CREATE INDEX idx_m6_interp_heuristics_heuristic ON m6_interpretation_heuristics (heuristic_id);

ALTER TABLE m6_interpretation_heuristics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_interpretation_heuristics: own read"
  ON m6_interpretation_heuristics FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM m6_longitudinal_interpretations mi WHERE mi.id = m6_interpretation_heuristics.interpretation_id AND mi.user_id = auth.uid())
  );

CREATE POLICY "m6_interpretation_heuristics: clinician read assigned patient"
  ON m6_interpretation_heuristics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_heuristics.interpretation_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON m6_interpretation_heuristics FROM authenticated;
