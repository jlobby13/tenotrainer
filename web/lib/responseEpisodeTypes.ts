// Milestone 6, Stage 3B — response-episode types. Client-safe (no
// server-only import). See responseEpisode.ts for the construction/
// eligibility logic these types support.
//
// LOCKED definition (Stage 3B brief): the atomic eligible longitudinal unit
// is a completed rehab session + actual performance + completed M4
// next-morning response + persisted tolerance evaluation. A response
// episode preserves references to all of those, plus prescription
// snapshot/version, external-loading context, and safety context where
// relevant.
//
// UNKNOWN != ZERO throughout: every field below is `number | null` (or
// `StiffnessDuration | null`), never coerced. `null` always means
// "not known", distinct from an explicit 0.

import type { StiffnessDuration } from "./morningResponseTypes";

export type ExternalLoadObservation = { category: string; timing: string | null };

// Why a given episode is NOT eligible for the P/MP/MS(+MSD) symptom
// analysis, even though it exists as a base response episode (session +
// performance + finalized M4 response + tolerance evaluation all present).
export type SymptomIneligibilityReason =
  | "missing_peak_session_pain"
  | "missing_next_morning_pain"
  | "missing_next_morning_stiffness"
  | "missing_stiffness_duration_with_nonzero_stiffness";

export type ResponseEpisode = {
  rehabSessionId: string;
  userId: string;
  patientLocalDate: string;
  prescriptionVersionId: string | null;
  prescriptionInstanceId: string;
  morningResponseId: string;
  toleranceEvaluationId: string | null;

  // Required response variables (Stage 3B brief section 1).
  peakSessionPain: number | null; // P
  nextMorningPain: number | null; // MP
  nextMorningStiffness: number | null; // MS
  // Only meaningful when nextMorningStiffness > 0. When
  // nextMorningStiffness === 0, this is expected to be 'not_applicable'
  // (a legitimate, complete value) — see morning_responses' own
  // stiffness_duration semantics. NEVER a fabricated bucket.
  stiffnessDuration: StiffnessDuration | null; // MSD

  externalLoadObservations: ExternalLoadObservation[];
  // True when this episode's rehab session coincides with an active/
  // confirmed acute-safety episode for this patient — informational only,
  // never used to silently exclude the episode from symptom-window math
  // (mirrors progressServer.ts's acuteEventDates independence).
  hasAcuteSafetyContext: boolean;

  // Whether this episode has everything required for the P/MP/MS(+MSD)
  // symptom analysis. False episodes still exist as response episodes
  // (they preserve all base references) but are excluded from 5+5 window
  // membership.
  eligibleForSymptomAnalysis: boolean;
  symptomIneligibilityReasons: SymptomIneligibilityReason[];
};
