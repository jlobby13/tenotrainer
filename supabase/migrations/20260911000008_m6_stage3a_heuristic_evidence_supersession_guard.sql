-- =============================================================================
-- Milestone 6, Stage 3A refinement: historical-integrity guard for the
-- Heuristics Catalog + Evidence Catalog (20260911000006).
--
-- Problem this closes: m6_heuristics already had a supersession chain
-- (supersedes_heuristic_id) and a status lifecycle, but nothing actually
-- stopped a plain UPDATE from rewriting description/rationale/evidence_status
-- in place even after the row had been cited by a real interpretation
-- (m6_interpretation_heuristics) — a historical interpretation could then
-- silently appear to have been produced by different clinical logic than it
-- actually was. m6_evidence_sources had no supersession chain at all, so a
-- rewrite of `supports`/`does_not_establish` after a heuristic cited it was
-- untraceable.
--
-- Design: gate on an objective fact — has this row ever actually been used —
-- rather than trying to distinguish "typo fix" from "substantive rewrite" on
-- free text (not reliably possible). Before first use, cataloguing
-- (including correcting typos) stays a free UPDATE. The moment a row is
-- referenced by real output, its clinically-material fields become
-- append-only: a BEFORE UPDATE trigger rejects the write and instructs the
-- caller to insert a new row with supersedes_heuristic_id /
-- supersedes_evidence_source_id pointing at it. This fires for every writer
-- (not just RLS-governed roles), so it isn't just a documented convention.
--
-- Harmless metadata (DOI/PMID/citation cleanup, spelling, title/authors) is
-- explicitly NOT locked — only the fields that define clinical meaning.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- m6_evidence_sources: add the same supersession chain m6_heuristics already
-- has, so a substantive reinterpretation of a source has a documented
-- replacement instead of only going straight to 'deprecated' with no lineage.
-- ---------------------------------------------------------------------------
ALTER TABLE m6_evidence_sources
  ADD COLUMN supersedes_evidence_source_id UUID REFERENCES m6_evidence_sources(id);

ALTER TABLE m6_evidence_sources DROP CONSTRAINT m6_evidence_sources_status_check;
ALTER TABLE m6_evidence_sources
  ADD CONSTRAINT m6_evidence_sources_status_check CHECK (status IN ('active', 'deprecated', 'superseded'));

-- ---------------------------------------------------------------------------
-- m6_heuristics guard: once a heuristic row has been cited by at least one
-- interpretation (m6_interpretation_heuristics), block UPDATEs that change
-- the fields defining what the rule actually does/means. heuristic_key is
-- not included — renaming the stable slug is a separate, narrower concern
-- than clinical meaning and out of scope here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION m6_guard_heuristic_material_rewrite()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.rationale IS DISTINCT FROM OLD.rationale OR
    NEW.evidence_status IS DISTINCT FROM OLD.evidence_status OR
    NEW.version_introduced IS DISTINCT FROM OLD.version_introduced
  ) AND EXISTS (
    SELECT 1 FROM m6_interpretation_heuristics WHERE heuristic_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'm6_heuristics: cannot rewrite the clinical meaning (description/rationale/evidence_status/version_introduced) of a heuristic already cited by an interpretation (id=%). Insert a new row with supersedes_heuristic_id pointing at it instead.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_m6_heuristics_guard_material_rewrite
  BEFORE UPDATE ON m6_heuristics
  FOR EACH ROW EXECUTE FUNCTION m6_guard_heuristic_material_rewrite();

-- ---------------------------------------------------------------------------
-- m6_evidence_sources guard: once a source has been cited by at least one
-- heuristic (m6_heuristic_evidence), block UPDATEs that change what
-- TenoTrainer uses the source to support/not-establish. Citation identity
-- fields (title, authors, doi, pmid, citation_key, etc.) are deliberately
-- NOT locked — DOI/PMID correction and citation cleanup remain plain UPDATEs
-- regardless of use, per founder direction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION m6_guard_evidence_source_material_rewrite()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    NEW.supports IS DISTINCT FROM OLD.supports OR
    NEW.does_not_establish IS DISTINCT FROM OLD.does_not_establish
  ) AND EXISTS (
    SELECT 1 FROM m6_heuristic_evidence WHERE evidence_source_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'm6_evidence_sources: cannot rewrite the interpretive meaning (supports/does_not_establish) of an evidence source already cited by a heuristic (id=%). Insert a new row with supersedes_evidence_source_id pointing at it instead.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_m6_evidence_sources_guard_material_rewrite
  BEFORE UPDATE ON m6_evidence_sources
  FOR EACH ROW EXECUTE FUNCTION m6_guard_evidence_source_material_rewrite();
