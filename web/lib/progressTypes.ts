// Milestone 6, Stage 2 — shared, client-safe types for the patient Progress
// page. No server-only import: consumed by both progressServer.ts (which
// does the actual Postgres reads) and the UI components.
//
// Deliberately NOT modeled here: any composite score, readiness percentage,
// or improving/stable/reduced classification — those are Layer 2 (M6 Stage
// 3, founder-approved clinical logic, not built yet). Everything below is a
// factual representation of already-persisted rows, or a plain arithmetic
// delta between two of them (per the founder's Stage 2 brief, "4 → 2,
// decreased by 2 points" is Layer 1; "tendon improved" is not).

import type { StiffnessDuration, ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";

// ---------------------------------------------------------------------------
// A. Recent Response
// ---------------------------------------------------------------------------

// previous/current are independently null — a metric can have a current
// value with no prior one (first-ever session), a prior value with no
// current one (not yet answered today), or neither. NULL is never coerced
// to 0; an explicit reported 0 is a real, distinct value from "unavailable".
export type NumericComparison = {
  label: string;
  previous: number | null;
  previousDate: string | null;
  current: number | null;
  currentDate: string | null;
};

export type StiffnessDurationComparison = {
  previous: StiffnessDuration | null;
  previousDate: string | null;
  current: StiffnessDuration | null;
  currentDate: string | null;
};

export type RecentResponse = {
  peakSessionPain: NumericComparison;
  nextMorningPain: NumericComparison;
  morningStiffnessIntensity: NumericComparison;
  morningStiffnessDuration: StiffnessDurationComparison;
};

// ---------------------------------------------------------------------------
// B. Symptoms Over Time
// ---------------------------------------------------------------------------

export type SymptomPoint = { date: string; value: number };

export type StiffnessDurationPoint = { date: string; bucket: StiffnessDuration };

export type SymptomsOverTime = {
  // Each series carries ONLY the dates where that specific fact is known —
  // never a shared, zero-filled date axis. Rendered as a chart that plots
  // known points and connects only ADJACENT known points, never bridging
  // across a gap.
  peakSessionPain: SymptomPoint[];
  nextMorningPain: SymptomPoint[];
  morningStiffnessIntensity: SymptomPoint[];
  morningStiffnessDuration: StiffnessDurationPoint[];
};

// ---------------------------------------------------------------------------
// C. Loading History
// ---------------------------------------------------------------------------

export type SetLoadingFact = {
  setIndex: number;
  outcome: "completed" | "skipped";
  // Numeric only when this session's OWN snapshot dosage was already a
  // plain number (see lib/exerciseDisplay.ts) — never parsed from a
  // hold-time/range string.
  prescribedReps: number | null;
  prescribedLoad: number | null;
  actualReps: number | null; // always null for a skipped set
  actualLoad: number | null;
  // Human-readable prescribed value straight from this session's own
  // snapshot dosage (e.g. "45s hold", "8-12") — used whenever
  // prescribedReps is null so a hold/range exercise still shows what was
  // actually prescribed, without fabricating a number for it.
  prescribedDisplay: string | null;
};

export type ExerciseLoadingHistory = {
  exId: string;
  name: string;
  loadingProfile: string | null;
  sets: SetLoadingFact[];
};

// 'unknown' whenever either side of the comparison has no resolved
// prescription_version_id (e.g. a pre-M5 legacy session) — never guessed as
// "same". Only 'different' ever produces a "Rehab plan updated" marker.
export type PrescriptionVersionComparison = "same" | "different" | "unknown";

export type ExternalLoadTag = { category: string; timing: string | null };

export type SessionLoadingHistoryEntry = {
  rehabSessionId: string;
  date: string; // patient_local_date, YYYY-MM-DD
  prescriptionVersionId: string | null;
  comparedToPrevious: PrescriptionVersionComparison;
  exercises: ExerciseLoadingHistory[];
  externalLoad: ExternalLoadTag[];
};

// ---------------------------------------------------------------------------
// E. Response / Tolerance History
// ---------------------------------------------------------------------------

export type ToleranceHistoryEntry = {
  rehabSessionId: string;
  date: string;
  classification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance;
  patientFacingLabel: string;
  ruleVersion: string;
  // True only when ruleVersion differs from the immediately-preceding
  // entry's ruleVersion in this same ordered list — never speculative, and
  // inert today (every row is currently "v1"). See progressCompare.ts.
  interpretationMethodChanged: boolean;
};

// ---------------------------------------------------------------------------
// Top-level page data
// ---------------------------------------------------------------------------

export type ProgressData = {
  hasAnyHistory: boolean;
  recentResponse: RecentResponse | null;
  symptomsOverTime: SymptomsOverTime;
  loadingHistory: SessionLoadingHistoryEntry[];
  toleranceHistory: ToleranceHistoryEntry[];
  // Factual acute-event dates only (confirmed_at) — rendered as separate
  // markers, never folded into or excluded from the series above. See
  // progressServer.ts's comment on why these must not affect any other
  // computation here.
  acuteEventDates: string[];
};
