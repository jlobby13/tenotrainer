-- =============================================================================
-- Milestone 6, Stage 3A: TenoTrainer Heuristics Catalog + Evidence Catalog.
-- ARCHITECTURE ONLY — this migration does not implement any of the actual
-- operational rules it will eventually catalogue (rolling windows,
-- directional-frequency thresholds, coverage thresholds, etc.) and does not
-- populate a research bibliography. It creates the durable structure so
-- those rules and citations can be catalogued, versioned, and eventually
-- shown to clinicians ("View model logic") without a schema redesign.
--
-- Evidence vs. heuristic (see Stage 3A documentation for the full
-- explanation): a cited scientific source (m6_evidence_sources) and a
-- TenoTrainer-created operational heuristic (m6_heuristics) are NOT the
-- same thing. A heuristic may be informed by zero, one, or several evidence
-- sources (m6_heuristic_evidence); it may also be a purely operational
-- convenience with no direct citation, which is why the join is optional,
-- not required.
--
-- Reused convention: these are GLOBAL reference/catalog tables, not
-- patient-scoped clinical data — same category as the existing `exercises`
-- and `knowledge_entries` tables. RLS below reuses THEIR exact,
-- already-established policy shape verbatim (org-member read, clinician_admin/
-- super_user write) from 20260831000003_rls_policies.sql, rather than the
-- patient-scoped user_id/supervisor_patients pattern used elsewhere in M6 —
-- see that migration for the precedent this is copying.
--
-- `knowledge_entries` (the existing legacy KB table) was considered as a
-- home for evidence sources and deliberately NOT reused: it is scoped to
-- the legacy FastAPI exercise-selection engine (still read there, confirmed
-- unused by any Next.js code — see the Stage 3A audit), lacks several
-- fields this catalog requires (DOI, PMID, population, sample size,
-- follow-up duration, explicit "does not establish"), and has no relational
-- link to a heuristics table. Reusing it would re-couple M6 to the legacy
-- system Stage 1's audit specifically flagged as a contamination risk.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- m6_heuristics
--
-- Catalogues TenoTrainer-created operational/clinical heuristics (e.g. a
-- rolling-window size, a directional-frequency threshold, a coverage
-- requirement). Historical integrity mirrors prescription_versions: a
-- substantive rule change is recorded as a NEW row with
-- supersedes_heuristic_id pointing at the one it replaces, never an
-- in-place rewrite of the superseded row's `description`/`rationale`.
-- Ordinary metadata correction (a typo, a clarified rationale) MAY use
-- plain UPDATE — the same judgment call `exercises`/`knowledge_entries`
-- already make implicitly by granting clinician_admin UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE m6_heuristics (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable, human-readable slug for code/doc references — e.g.
  -- 'rolling_5_plus_5_window', 'directional_frequency_60pct',
  -- 'one_point_directional_boundary', 'long_term_coverage_65pct',
  -- 'endpoint_observations_4_of_6', 'capacity_comparable_demonstrations_2_of_4'.
  -- None of these are created by this migration — only the column that will
  -- hold them once Stage 3B+ defines the actual rules.
  heuristic_key           TEXT NOT NULL UNIQUE,
  name                    TEXT NOT NULL,
  description             TEXT NOT NULL,
  rationale               TEXT,

  -- Free text, deliberately unconstrained — "evidence-informed" vs.
  -- "operational convenience" vs. "expert heuristic" is a real distinction
  -- the founder will want to make per-heuristic, but locking the vocabulary
  -- now would be inventing product taxonomy this migration isn't asked to.
  evidence_status         TEXT,

  -- Which ruleset_version (see m6_longitudinal_interpretations.ruleset_version)
  -- first introduced this heuristic. Plain TEXT, not FK'd — same convention
  -- as rule_version elsewhere in this codebase (paired with a TS constant,
  -- not a separate versions table).
  version_introduced      TEXT NOT NULL,

  status                  TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'active', 'superseded', 'retired'
  )),
  known_limitations       TEXT,
  alternatives_considered TEXT,
  reviewed_at             DATE,

  -- Supersession chain — append rather than mutate for a substantive change.
  -- Nullable: most heuristics have no predecessor.
  supersedes_heuristic_id UUID REFERENCES m6_heuristics(id),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_m6_heuristics_status ON m6_heuristics (status);

DO $$ BEGIN
  CREATE TRIGGER trg_m6_heuristics_updated_at
    BEFORE UPDATE ON m6_heuristics
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE m6_heuristics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_heuristics: org members read"
  ON m6_heuristics FOR SELECT
  USING (EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid()));

CREATE POLICY "m6_heuristics: clinician_admin write"
  ON m6_heuristics FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid() AND om.role IN ('clinician_admin', 'super_user'))
  );

CREATE POLICY "m6_heuristics: clinician_admin update"
  ON m6_heuristics FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid() AND om.role IN ('clinician_admin', 'super_user'))
  );

-- ---------------------------------------------------------------------------
-- m6_evidence_sources
--
-- Catalogues scientific sources used to inform TenoTrainer's clinical
-- logic. Populated later by whoever compiles the actual bibliography — this
-- migration creates no rows (no citations are fabricated here).
-- ---------------------------------------------------------------------------
CREATE TABLE m6_evidence_sources (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citation_key              TEXT UNIQUE,
  title                     TEXT NOT NULL,
  authors                   TEXT,
  year                      INTEGER,
  doi                       TEXT,
  pmid                      TEXT,
  url                       TEXT,
  population                TEXT,
  study_design              TEXT,
  sample_size               INTEGER,
  tendon_pathology_context  TEXT,
  outcomes                  TEXT,
  follow_up_duration        TEXT,
  relevant_findings         TEXT,
  -- What TenoTrainer uses this source to support, and its explicit,
  -- equally-important converse — what it does NOT establish. Both free
  -- text; keeping "does not establish" as its own column (not folded into
  -- internal_notes) makes the limitation impossible to omit by accident
  -- when this catalog is eventually surfaced to clinicians.
  supports                  TEXT,
  does_not_establish        TEXT,
  internal_notes            TEXT,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_m6_evidence_sources_status ON m6_evidence_sources (status);

DO $$ BEGIN
  CREATE TRIGGER trg_m6_evidence_sources_updated_at
    BEFORE UPDATE ON m6_evidence_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE m6_evidence_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_evidence_sources: org members read"
  ON m6_evidence_sources FOR SELECT
  USING (EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid()));

CREATE POLICY "m6_evidence_sources: clinician_admin write"
  ON m6_evidence_sources FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid() AND om.role IN ('clinician_admin', 'super_user'))
  );

CREATE POLICY "m6_evidence_sources: clinician_admin update"
  ON m6_evidence_sources FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid() AND om.role IN ('clinician_admin', 'super_user'))
  );

-- ---------------------------------------------------------------------------
-- m6_heuristic_evidence — many-to-many. A heuristic may cite zero, one, or
-- several sources; a source may inform several heuristics.
-- ---------------------------------------------------------------------------
CREATE TABLE m6_heuristic_evidence (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  heuristic_id        UUID NOT NULL REFERENCES m6_heuristics(id) ON DELETE CASCADE,
  evidence_source_id  UUID NOT NULL REFERENCES m6_evidence_sources(id) ON DELETE CASCADE,
  -- Optional: the specific ruleset_version this evidence association was
  -- assessed/relevant for, when that's meaningful to record. NULL means
  -- "generally applicable," not "unknown".
  ruleset_version     TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT m6_heuristic_evidence_unique UNIQUE (heuristic_id, evidence_source_id)
);

CREATE INDEX idx_m6_heuristic_evidence_heuristic ON m6_heuristic_evidence (heuristic_id);
CREATE INDEX idx_m6_heuristic_evidence_source ON m6_heuristic_evidence (evidence_source_id);

ALTER TABLE m6_heuristic_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "m6_heuristic_evidence: org members read"
  ON m6_heuristic_evidence FOR SELECT
  USING (EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid()));

CREATE POLICY "m6_heuristic_evidence: clinician_admin write"
  ON m6_heuristic_evidence FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid() AND om.role IN ('clinician_admin', 'super_user'))
  );

CREATE POLICY "m6_heuristic_evidence: clinician_admin update"
  ON m6_heuristic_evidence FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = auth.uid() AND om.role IN ('clinician_admin', 'super_user'))
  );
