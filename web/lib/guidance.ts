// Milestone 5, Stage 1 — derived-guidance domain logic. Pure, deterministic,
// client-safe (no server-only import, no DB access) — mirrors the
// toleranceEvaluation.ts / escalation.ts split of "pure decision logic" from
// "server-only DB wiring" (see guidanceServer.ts for the latter).
//
// This module answers "what is currently relevant?" entirely by DERIVING
// facts from already-persisted, immutable rows — it never reads or writes a
// mutable "current guidance" record, and it never fabricates a fact it
// wasn't given. See the M5 pre-Stage-1 architecture inspection for why:
// prescription identity/session chronology/tolerance-evaluation linkage are
// each independently reconstructible from existing tables, so no mutable
// duplicate of "current clinical truth" is needed.
//
// Stage 1 scope: this module establishes DOMAIN SEMANTICS, not patient-
// facing UX. It returns the underlying immutable facts (superseded,
// a newer prescription version's existence/provenance, same/different-
// version subsequent session) — it does NOT collapse them into a single
// "is this still relevant" boolean. That weighting is a Stage 2 UX
// decision, not made here.
//
// LOCKED semantic distinction (founder-acceptance patch): chronology is not
// intent. "A prescription_versions row was created after this evaluation"
// is an objective fact this module reports as such — it does NOT mean the
// clinician reviewed the evaluation, changed the prescription BECAUSE of
// it, or that the guidance was intentionally addressed. In particular, a
// source='legacy_bootstrap' row created after an old evaluation is a
// migration/provenance event, not clinical action — see
// NewerPrescriptionVersionFact and its `source` field, which callers can
// use to judge provenance themselves, and which this module never
// interprets on their behalf. No field here is named "addressed",
// "resolved", or "reviewed" — none of that evidence exists yet (a future
// guidance_actions-style model would be where it lives).

import type { ImmediateGuidance, ToleranceClassification } from "./morningResponseTypes";
import type { PrescriptionVersionSource } from "./prescriptionVersionTypes";
import type { SessionStatus } from "./rehabSessionTypes";

export type PrescriptionVersionIdentity =
  | { known: true; prescriptionVersionId: string }
  | { known: false }; // legacy/unresolved — see rehab_sessions.prescription_version_id

export type VersionComparison = "same" | "different" | "unknown";

export type SourceEvaluation = {
  id: string;
  rehabSessionId: string;
  toleranceClassification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance;
  reasonCodes: string[];
  evaluatedAt: string;
  ruleVersion: string;
};

export type SubsequentSessionFacts = {
  anotherSessionStarted: boolean;
  anotherSessionCompleted: boolean;
  subsequentSessionId: string | null;
  subsequentSessionPrescriptionVersionId: string | null;
  // null only when anotherSessionStarted is false (there is nothing to
  // compare against yet). Never collapses an unresolved identity into
  // "same" — see versionComparison's computation below.
  versionComparison: VersionComparison | null;
};

// Purely a chronology + provenance fact — see the LOCKED distinction above.
// `source` is echoed as-is (never interpreted) so a caller can judge for
// itself whether, say, a `legacy_bootstrap` row is meaningful evidence of
// anything clinical (it isn't) versus a future `clinician_change` row
// (which still only proves A CHANGE HAPPENED, not that it was in response
// to this specific evaluation).
export type NewerPrescriptionVersionFact =
  | { exists: false }
  | {
      exists: true;
      prescriptionVersionId: string;
      createdAt: string;
      source: PrescriptionVersionSource;
    };

export type RelevantGuidance = {
  evaluation: SourceEvaluation;
  sourcePrescriptionVersion: PrescriptionVersionIdentity;
  // Principle: a newer evaluation supersedes this one as the latest
  // response evidence. This evaluation ROW remains immutable regardless —
  // this flag only describes its current relevance, never rewrites it.
  supersededByNewerEvaluation: boolean;
  // The earliest prescription_versions row (if any) created after this
  // evaluation. Chronology only — NEVER a claim of clinician review, causal
  // response, or "addressed" guidance. See the module header.
  newerPrescriptionVersion: NewerPrescriptionVersionFact;
  subsequentSession: SubsequentSessionFacts;
};

export type EvaluationRef = { id: string; evaluatedAt: string };

// "Latest" is always by evaluatedAt, never by comparing rule_version
// strings lexicographically (e.g. "v10" > "v9" as text but not as a real
// version ordering) — see the M5 pre-Stage-1 inspection's Q3/Q9 finding.
export function pickLatestEvaluation<T extends EvaluationRef>(evaluations: T[]): T | null {
  if (evaluations.length === 0) return null;
  return [...evaluations].sort(
    (a, b) => new Date(b.evaluatedAt).getTime() - new Date(a.evaluatedAt).getTime()
  )[0];
}

export type SubsequentSessionCandidate = {
  id: string;
  startedAt: string;
  status: SessionStatus;
  prescriptionVersionId: string | null;
};

export type PrescriptionVersionRef = {
  id: string;
  createdAt: string;
  source: PrescriptionVersionSource;
};

export type DeriveGuidanceInput = {
  evaluation: SourceEvaluation;
  sourceSession: {
    id: string;
    startedAt: string;
    prescriptionVersionId: string | null;
  };
  // Every OTHER evaluation on record for this patient (any session, any
  // rule version) — used only to compute supersededByNewerEvaluation.
  allPatientEvaluations: EvaluationRef[];
  // Every prescription_versions row on record for this patient (id,
  // created_at, source) — used only to compute newerPrescriptionVersion.
  // The caller does not need to pre-filter or pre-sort.
  patientPrescriptionVersions: PrescriptionVersionRef[];
  // Every rehab_sessions row for this patient with startedAt AFTER this
  // evaluation's evaluatedAt — the caller does not need to pre-filter or
  // pre-sort; this function does both. "Afterward" is anchored to
  // evaluatedAt (when the guidance became clinically available), not the
  // source session's own startedAt.
  candidateSubsequentSessions: SubsequentSessionCandidate[];
};

export function deriveGuidance(input: DeriveGuidanceInput): RelevantGuidance {
  const { evaluation, sourceSession, allPatientEvaluations, patientPrescriptionVersions, candidateSubsequentSessions } =
    input;

  const evaluatedAtMs = new Date(evaluation.evaluatedAt).getTime();

  const supersededByNewerEvaluation = allPatientEvaluations.some(
    (e) => e.id !== evaluation.id && new Date(e.evaluatedAt).getTime() > evaluatedAtMs
  );

  // Chronology only, per the module's LOCKED distinction — never
  // interpreted as review/intent/resolution here. When more than one
  // prescription_versions row postdates the evaluation, the EARLIEST one is
  // reported (mirrors the "Session N+1" earliest-wins convention below):
  // it's the version any subsequent session would actually have run under.
  const newerVersions = patientPrescriptionVersions
    .filter((v) => new Date(v.createdAt).getTime() > evaluatedAtMs)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const newerPrescriptionVersion: NewerPrescriptionVersionFact =
    newerVersions.length > 0
      ? { exists: true, prescriptionVersionId: newerVersions[0].id, createdAt: newerVersions[0].createdAt, source: newerVersions[0].source }
      : { exists: false };

  const sourcePrescriptionVersion: PrescriptionVersionIdentity = sourceSession.prescriptionVersionId
    ? { known: true, prescriptionVersionId: sourceSession.prescriptionVersionId }
    : { known: false };

  const subsequent = candidateSubsequentSessions
    .filter((s) => new Date(s.startedAt).getTime() > evaluatedAtMs)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const anotherSessionStarted = subsequent.length > 0;
  const anotherSessionCompleted = subsequent.some((s) => s.status === "response_complete");

  // "Session N+1" — the chronologically EARLIEST subsequent session — is
  // what version comparison is computed against. A later second/third
  // subsequent session has its own independent evaluation/guidance chain
  // once it completes; this function deliberately does not traverse past
  // the immediate next session to avoid conflating separate feedback loops.
  const nextSession = subsequent[0] ?? null;

  let versionComparison: VersionComparison | null = null;
  if (nextSession) {
    if (!sourcePrescriptionVersion.known || !nextSession.prescriptionVersionId) {
      // Do not collapse unknown into same, even if both happen to be null.
      versionComparison = "unknown";
    } else if (nextSession.prescriptionVersionId === sourcePrescriptionVersion.prescriptionVersionId) {
      versionComparison = "same";
    } else {
      versionComparison = "different";
    }
  }

  return {
    evaluation,
    sourcePrescriptionVersion,
    supersededByNewerEvaluation,
    newerPrescriptionVersion,
    subsequentSession: {
      anotherSessionStarted,
      anotherSessionCompleted,
      subsequentSessionId: nextSession?.id ?? null,
      subsequentSessionPrescriptionVersionId: nextSession?.prescriptionVersionId ?? null,
      versionComparison,
    },
  };
}
