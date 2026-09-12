// Milestone 6, Stage 3A — TenoTrainer Heuristics Catalog + Evidence Catalog
// types. Mirrors the Postgres schema in
// supabase/migrations/20260911000006_m6_stage3a_heuristics_evidence_catalog.sql
// exactly. Client-safe (no server-only import).
//
// ARCHITECTURE ONLY: no rows are seeded by this stage (no heuristic rules
// are implemented yet; no bibliography is populated). These types exist so
// a future "View model logic" surface (clinician-facing, not built yet) has
// a stable shape to render, and so the actual Stage 3B+ classifier has
// somewhere to register the heuristics it implements as it's built.

export type HeuristicStatus = "proposed" | "active" | "superseded" | "retired";

export type HeuristicRecord = {
  id: string;
  heuristicKey: string;
  name: string;
  description: string;
  rationale: string | null;
  // Free text — deliberately not a locked vocabulary. See migration header.
  evidenceStatus: string | null;
  versionIntroduced: string;
  status: HeuristicStatus;
  knownLimitations: string | null;
  alternativesConsidered: string | null;
  reviewedAt: string | null;
  supersedesHeuristicId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceSourceStatus = "active" | "deprecated" | "superseded";

export type EvidenceSourceRecord = {
  id: string;
  citationKey: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  pmid: string | null;
  url: string | null;
  population: string | null;
  studyDesign: string | null;
  sampleSize: number | null;
  tendonPathologyContext: string | null;
  outcomes: string | null;
  followUpDuration: string | null;
  relevantFindings: string | null;
  supports: string | null;
  doesNotEstablish: string | null;
  internalNotes: string | null;
  status: EvidenceSourceStatus;
  // Supersession chain — see the Stage 3A supersession-guard migration
  // (20260911000008). A substantive change to `supports`/`doesNotEstablish`
  // after this source has been cited by a heuristic is rejected at the
  // database level; the caller must insert a new row and set this field
  // pointing at the row it replaces, mirroring supersedesHeuristicId above.
  supersedesEvidenceSourceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HeuristicEvidenceLinkRecord = {
  id: string;
  heuristicId: string;
  evidenceSourceId: string;
  rulesetVersion: string | null;
  notes: string | null;
  createdAt: string;
};

export function mapHeuristicRow(row: Record<string, unknown>): HeuristicRecord {
  return {
    id: row.id as string,
    heuristicKey: row.heuristic_key as string,
    name: row.name as string,
    description: row.description as string,
    rationale: (row.rationale as string | null) ?? null,
    evidenceStatus: (row.evidence_status as string | null) ?? null,
    versionIntroduced: row.version_introduced as string,
    status: row.status as HeuristicStatus,
    knownLimitations: (row.known_limitations as string | null) ?? null,
    alternativesConsidered: (row.alternatives_considered as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    supersedesHeuristicId: (row.supersedes_heuristic_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapEvidenceSourceRow(row: Record<string, unknown>): EvidenceSourceRecord {
  return {
    id: row.id as string,
    citationKey: (row.citation_key as string | null) ?? null,
    title: row.title as string,
    authors: (row.authors as string | null) ?? null,
    year: (row.year as number | null) ?? null,
    doi: (row.doi as string | null) ?? null,
    pmid: (row.pmid as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    population: (row.population as string | null) ?? null,
    studyDesign: (row.study_design as string | null) ?? null,
    sampleSize: (row.sample_size as number | null) ?? null,
    tendonPathologyContext: (row.tendon_pathology_context as string | null) ?? null,
    outcomes: (row.outcomes as string | null) ?? null,
    followUpDuration: (row.follow_up_duration as string | null) ?? null,
    relevantFindings: (row.relevant_findings as string | null) ?? null,
    supports: (row.supports as string | null) ?? null,
    doesNotEstablish: (row.does_not_establish as string | null) ?? null,
    internalNotes: (row.internal_notes as string | null) ?? null,
    status: row.status as EvidenceSourceStatus,
    supersedesEvidenceSourceId: (row.supersedes_evidence_source_id as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapHeuristicEvidenceLinkRow(row: Record<string, unknown>): HeuristicEvidenceLinkRecord {
  return {
    id: row.id as string,
    heuristicId: row.heuristic_id as string,
    evidenceSourceId: row.evidence_source_id as string,
    rulesetVersion: (row.ruleset_version as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}
