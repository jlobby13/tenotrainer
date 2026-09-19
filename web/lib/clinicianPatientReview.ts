// C4 — Clinical Decision Support. Pure, deterministic domain logic only (no
// server-only import, no DB access, NO classifier/generator/progression-
// engine functions imported or called) — mirrors the
// clinicianPatientProgress.ts / clinicianPatientProgressServer.ts split.
//
// HARD LOCKED BOUNDARY: every function here is one of exactly three shapes
// (founder brief Section 19):
//   A. direct persisted-state inclusion       (e.g. resultState === X)
//   B. trivial equality/difference comparison  (e.g. current !== previous)
//   C. factual existence/state checks          (e.g. an active episode exists)
// No function here derives a NEW clinical state from a COMBINATION of
// independent observations — each detector takes exactly one domain's
// already-persisted facts and returns a fact about that domain alone. There
// is no `if (symptomsSignal && capacitySignal)`-shaped logic anywhere in
// this module, and no signal's presence or copy ever depends on another
// signal's value.
//
// LOCKED EXCLUSIONS (founder brief Sections 11-17) — these are deliberately
// NOT implemented here, not merely unused:
//   - no skipped-set tally/threshold
//   - no difficulty tally/threshold
//   - no single-session Caution tally/threshold
//   - no restatement of historical immediate guidance as current advice
//   - no new prescribed-vs-actual comparator (reuse Capacity's own
//     persisted mechanical-comparison facts only, never rebuild one)
//   - no composite score of any kind (risk/attention/priority/urgency/
//     recovery/readiness/red-yellow-green/weighted count)
//
// Reused verbatim from C2/C3's own pure modules (never redefined here, to
// avoid vocabulary drift across Overview/Progress/Review):
// formatOverallSymptomsLabel, formatTrainingResponseStateLabel,
// formatCapacityStateLabel, formatCapacityMoreDataReasonLabel (all from
// clinicianPatientProgress.ts); formatIrritabilityLabel,
// formatInsertionalLabel (from clinicianPatientOverview.ts).

import type { ComparableConstruct } from "./capacityTypes";
import type { MoreDataNeededReason } from "./capacityClassifier";
import type { Irritability, PrescriptionVersionSource } from "./prescriptionVersionTypes";
import { comparePrescriptionVersions } from "./progressCompare";
import type { PrescriptionVersionComparison } from "./progressTypes";

// ---------------------------------------------------------------------------
// What Changed — Symptoms / Training Response (identical shape: a trivial
// resultState-string comparison, domain-agnostic on purpose so this single
// function can never encode domain-specific judgment about WHICH states are
// "good"). Requires a REAL previous row — "no previous" never renders as
// "changed".
// ---------------------------------------------------------------------------

export type SimpleStateChange = { interpretationId: string; current: string; previous: string };

export function detectStateChange(
  current: { id: string; resultState: string } | null,
  previous: { resultState: string } | null
): SimpleStateChange | null {
  if (!current || !previous) return null;
  if (current.resultState === previous.resultState) return null;
  return { interpretationId: current.id, current: current.resultState, previous: previous.resultState };
}

// ---------------------------------------------------------------------------
// Review Context — Symptoms / Training Response CURRENT-state allowlists.
// Independent of §change detection above: a signal here reflects only the
// CURRENT persisted state, whether or not it just changed. Only the exact
// states the founder approved ever produce a signal; every other state
// (including the favorable ones) produces null — proving "improving"/
// "stable" are never converted into a review card.
// ---------------------------------------------------------------------------

export type SymptomsReviewSignal = "trending_higher" | "mixed";

export function symptomsReviewSignal(resultState: string | null): SymptomsReviewSignal | null {
  if (resultState === "symptoms_trending_higher") return "trending_higher";
  if (resultState === "mixed_symptom_response") return "mixed";
  return null;
}

export type TrainingResponseReviewSignal = "variable" | "unsettled";

export function trainingResponseReviewSignal(resultState: string | null): TrainingResponseReviewSignal | null {
  if (resultState === "variable_training_response") return "variable";
  if (resultState === "training_response_remains_unsettled") return "unsettled";
  return null;
}

// "more_data_needed" is domain-agnostic as a raw string (Symptoms and
// Training Response both use it) — informational only, never a Review-tier
// signal (founder brief Section 9).
export function isMoreDataNeededState(resultState: string | null): boolean {
  return resultState === "more_data_needed";
}

// ---------------------------------------------------------------------------
// Capacity — construct-scoped change/new detection. Construct identity
// (exercise + loading profile + performance unit) is never inferred from
// exercise name alone — callers pass the already-persisted `construct`
// object verbatim from window_definition.construct, and two constructs are
// distinguished by that object's own JSON identity, never by ex_id alone.
// ---------------------------------------------------------------------------

export type CapacityConstructRow = {
  interpretationId: string;
  construct: ComparableConstruct;
  resultState: string;
  moreDataNeededReason: MoreDataNeededReason | null;
};

export type CapacityConstructChangeItem =
  | { kind: "new"; current: CapacityConstructRow }
  | { kind: "changed"; current: CapacityConstructRow; previousResultState: string };

// `previous` is `null` when this is the construct's first-ever persisted
// row (no prior interpretation for this EXACT construct identity exists) —
// this is the one and only "new construct" trigger, never inferred from
// exercise name matching a differently-shaped construct.
export function detectCapacityConstructChange(current: CapacityConstructRow, previous: CapacityConstructRow | null): CapacityConstructChangeItem | null {
  if (!previous) return { kind: "new", current };
  if (current.resultState === previous.resultState) return null;
  return { kind: "changed", current, previousResultState: previous.resultState };
}

// Independent of "new"/"changed" — a construct's CURRENT row carries this
// reason whether or not it just transitioned into it. Only this exact
// reason ever produces the dedicated "Recent loading has been lower."
// Review Context card; the other two moreDataNeededReason values
// (insufficient_total_history, unrepresentable_construct) never do (they
// may only ever appear as supporting text on a "New loading construct"
// item — see clinicianPatientReviewServer.ts).
export function capacityRecentLoadingLowerSignal(row: CapacityConstructRow): boolean {
  return row.moreDataNeededReason === "recent_loading_lower";
}

// ---------------------------------------------------------------------------
// Prescription version — current vs previous only, using the existing pure
// comparePrescriptionVersions() helper verbatim (never a new comparator).
// Chronology only: this module never claims a version change caused any
// observed Symptoms/Capacity/Training Response change.
// ---------------------------------------------------------------------------

export type PrescriptionVersionSnapshot = {
  id: string;
  createdAt: string;
  stage: number;
  irritability: Irritability;
  isInsertional: boolean;
  source: PrescriptionVersionSource;
};

export type PrescriptionChangeItem = {
  current: PrescriptionVersionSnapshot;
  previous: PrescriptionVersionSnapshot;
  versionComparison: PrescriptionVersionComparison;
} | null;

export function detectPrescriptionChange(current: PrescriptionVersionSnapshot | null, previous: PrescriptionVersionSnapshot | null): PrescriptionChangeItem {
  if (!current || !previous) return null;
  const versionComparison = comparePrescriptionVersions(previous.id, current.id);
  if (versionComparison !== "different") return null;
  return { current, previous, versionComparison };
}

// ---------------------------------------------------------------------------
// Copy — fixed, deterministic strings only. No template ever incorporates
// another domain's value (see the module header's compound-inference lock).
// ---------------------------------------------------------------------------

export const NEW_CAPACITY_CONSTRUCT_TITLE = "New loading construct";
export const NEW_CAPACITY_CONSTRUCT_COPY = "A new loading construct is being established; comparable history is limited.";
export const NO_RECENT_SESSION_TEXT = "No recent qualifying rehab session is available for review.";
export const CLINICAL_REVIEW_ACTIVE_TITLE = "Clinical review active";

const PRESCRIPTION_SOURCE_LABELS: Record<PrescriptionVersionSource, string> = {
  onboarding: "Onboarding",
  legacy_bootstrap: "Legacy bootstrap",
  clinician_change: "Clinician change",
  system_progression: "System progression",
};
export function formatPrescriptionSourceLabel(source: PrescriptionVersionSource): string {
  return PRESCRIPTION_SOURCE_LABELS[source];
}
