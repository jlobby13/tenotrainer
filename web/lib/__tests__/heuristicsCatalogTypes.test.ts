// Milestone 6, Stage 3A — Heuristics/Evidence Catalog row mapper tests.
// Pure-function coverage only — see longitudinalInterpretationTypes.test.ts's
// header note for why (no live-DB assertions belong in this file).
import { mapHeuristicRow, mapEvidenceSourceRow, mapHeuristicEvidenceLinkRow } from "../heuristicsCatalogTypes";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

test("mapHeuristicRow maps every snake_case column to its camelCase field", () => {
  const row = {
    id: "h1",
    heuristic_key: "rolling_5_plus_5_window",
    name: "Rolling 5+5 window",
    description: "Compares the most recent 5 comparable observations to the prior 5.",
    rationale: "Balances recency against noise.",
    evidence_status: "operational_convenience",
    version_introduced: "m6_longitudinal_v1",
    status: "proposed",
    known_limitations: "Not validated against a gold-standard comparator.",
    alternatives_considered: "A fixed calendar week window.",
    reviewed_at: "2026-09-01",
    supersedes_heuristic_id: null,
    created_at: "2026-09-11T08:00:00.000Z",
    updated_at: "2026-09-11T08:00:00.000Z",
  };
  assertEqual(
    mapHeuristicRow(row),
    {
      id: "h1",
      heuristicKey: "rolling_5_plus_5_window",
      name: "Rolling 5+5 window",
      description: "Compares the most recent 5 comparable observations to the prior 5.",
      rationale: "Balances recency against noise.",
      evidenceStatus: "operational_convenience",
      versionIntroduced: "m6_longitudinal_v1",
      status: "proposed",
      knownLimitations: "Not validated against a gold-standard comparator.",
      alternativesConsidered: "A fixed calendar week window.",
      reviewedAt: "2026-09-01",
      supersedesHeuristicId: null,
      createdAt: "2026-09-11T08:00:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
    },
    "full row mapping"
  );
});

test("mapHeuristicRow preserves a supersession chain id when present (never dropped)", () => {
  const row = {
    id: "h2",
    heuristic_key: "directional_frequency_65pct",
    name: "Directional frequency 65%",
    description: "Supersedes the 60% version.",
    rationale: null,
    evidence_status: null,
    version_introduced: "m6_longitudinal_v2",
    status: "active",
    known_limitations: null,
    alternatives_considered: null,
    reviewed_at: null,
    supersedes_heuristic_id: "h-old-60pct",
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
  };
  assertEqual(mapHeuristicRow(row).supersedesHeuristicId, "h-old-60pct", "supersession id preserved");
});

test("mapEvidenceSourceRow maps every snake_case column to its camelCase field, including the required does-not-establish limitation", () => {
  const row = {
    id: "e1",
    citation_key: "smith2020",
    title: "Example longitudinal tendinopathy monitoring study",
    authors: "Smith J, Doe A",
    year: 2020,
    doi: "10.1000/example",
    pmid: "12345678",
    url: "https://example.invalid/smith2020",
    population: "Recreational runners with midportion Achilles tendinopathy",
    study_design: "Prospective cohort",
    sample_size: 42,
    tendon_pathology_context: "Midportion Achilles tendinopathy",
    outcomes: "VISA-A, pain NRS",
    follow_up_duration: "12 weeks",
    relevant_findings: "Symptom trajectories varied widely week to week.",
    supports: "Using a rolling window rather than single-session comparison.",
    does_not_establish: "Does not establish a specific window size or threshold.",
    internal_notes: "Flagged for re-review once Stage 3B thresholds are drafted.",
    status: "active",
    supersedes_evidence_source_id: null,
    created_at: "2026-09-11T08:00:00.000Z",
    updated_at: "2026-09-11T08:00:00.000Z",
  };
  assertEqual(
    mapEvidenceSourceRow(row),
    {
      id: "e1",
      citationKey: "smith2020",
      title: "Example longitudinal tendinopathy monitoring study",
      authors: "Smith J, Doe A",
      year: 2020,
      doi: "10.1000/example",
      pmid: "12345678",
      url: "https://example.invalid/smith2020",
      population: "Recreational runners with midportion Achilles tendinopathy",
      studyDesign: "Prospective cohort",
      sampleSize: 42,
      tendonPathologyContext: "Midportion Achilles tendinopathy",
      outcomes: "VISA-A, pain NRS",
      followUpDuration: "12 weeks",
      relevantFindings: "Symptom trajectories varied widely week to week.",
      supports: "Using a rolling window rather than single-session comparison.",
      doesNotEstablish: "Does not establish a specific window size or threshold.",
      internalNotes: "Flagged for re-review once Stage 3B thresholds are drafted.",
      status: "active",
      supersedesEvidenceSourceId: null,
      createdAt: "2026-09-11T08:00:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
    },
    "full row mapping"
  );
});

test("mapEvidenceSourceRow preserves a supersession chain id when present (never dropped)", () => {
  const row = {
    id: "e3",
    citation_key: null,
    title: "Reinterpreted fixture row",
    authors: null,
    year: null,
    doi: null,
    pmid: null,
    url: null,
    population: null,
    study_design: null,
    sample_size: null,
    tendon_pathology_context: null,
    outcomes: null,
    follow_up_duration: null,
    relevant_findings: null,
    supports: "Revised support statement.",
    does_not_establish: null,
    internal_notes: null,
    status: "active",
    supersedes_evidence_source_id: "e-old",
    created_at: "2026-09-11T08:00:00.000Z",
    updated_at: "2026-09-11T08:00:00.000Z",
  };
  assertEqual(mapEvidenceSourceRow(row).supersedesEvidenceSourceId, "e-old", "supersession id preserved");
});

test("mapEvidenceSourceRow preserves NULL optional bibliographic fields (never fabricated)", () => {
  const row = {
    id: "e2",
    citation_key: null,
    title: "Minimal fixture row",
    authors: null,
    year: null,
    doi: null,
    pmid: null,
    url: null,
    population: null,
    study_design: null,
    sample_size: null,
    tendon_pathology_context: null,
    outcomes: null,
    follow_up_duration: null,
    relevant_findings: null,
    supports: null,
    does_not_establish: null,
    internal_notes: null,
    status: "active",
    supersedes_evidence_source_id: null,
    created_at: "2026-09-11T08:00:00.000Z",
    updated_at: "2026-09-11T08:00:00.000Z",
  };
  const mapped = mapEvidenceSourceRow(row);
  assertEqual(mapped.doi, null, "doi null preserved");
  assertEqual(mapped.pmid, null, "pmid null preserved");
  assertEqual(mapped.sampleSize, null, "sampleSize null preserved");
  assertEqual(mapped.doesNotEstablish, null, "doesNotEstablish null preserved");
  assertEqual(mapped.supersedesEvidenceSourceId, null, "supersedesEvidenceSourceId null preserved");
});

test("mapHeuristicEvidenceLinkRow maps every snake_case column to its camelCase field", () => {
  const row = {
    id: "link-1",
    heuristic_id: "h1",
    evidence_source_id: "e1",
    ruleset_version: "m6_longitudinal_v1",
    notes: "Primary support for the rolling-window approach.",
    created_at: "2026-09-11T08:00:00.000Z",
  };
  assertEqual(
    mapHeuristicEvidenceLinkRow(row),
    {
      id: "link-1",
      heuristicId: "h1",
      evidenceSourceId: "e1",
      rulesetVersion: "m6_longitudinal_v1",
      notes: "Primary support for the rolling-window approach.",
      createdAt: "2026-09-11T08:00:00.000Z",
    },
    "full row mapping"
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
