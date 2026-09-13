// Milestone 6, Stage 3C — Capacity + Training Response types. Client-safe
// (no server-only import).
//
// Capacity asks "what level of Achilles loading is the patient repeatedly
// able to demonstrate" — observed mechanical performance, exercise/loading-
// profile specific, never a universal score. Training Response asks "how
// does the tendon respond to the loading performed" — a separate axis that
// must be able to disagree with Capacity. See
// docs/m6-stage3c-capacity-training-response.md for the full design.

import type { ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";

export type PerformanceUnit = "reps" | "hold_seconds" | "unrepresentable";

// LOCKED (Stage 3C brief section 2): exact-match all three. A prescription-
// version change alone never breaks this.
export type ComparableConstruct = {
  exId: string;
  loadingProfile: string | null;
  performanceUnit: PerformanceUnit;
};

// FOUNDER DECISION (round 3): Capacity preserves the REAL, ordered,
// set-level demonstrated performance — never collapsed into a single
// scalar or aggregate (no min/median/sum/mean across sets). One
// SetObservation per prescribed set, in set order.
export type SetObservation = {
  setIndex: number;
  outcome: "completed" | "skipped";
  // Reps (performanceUnit='reps') or hold-seconds (performanceUnit=
  // 'hold_seconds') for THIS set only. null when skipped (never 0) or when
  // the construct's dosage isn't numerically representable at all.
  amount: number | null;
  // External resistance/load for THIS set only. null = unknown/not-recorded
  // (no exercise in the current content library records one today) —
  // NEVER coerced to 0.
  load: number | null;
};

// Ordered by setIndex — the real, un-collapsed prescribed or demonstrated
// performance for one exercise in one session. Comparisons operate
// directly on this structure (capacityLoadingComparison.ts's
// compareSetVectors) — no synthetic aggregate is ever built.
export type ExposureSetVector = SetObservation[];

// One exercise's exposure within one base response episode (rehab session +
// actual performance + finalized M4 response + tolerance evaluation — the
// same atomic gate Stage 3B uses, since Capacity's "successful exposure"
// qualification needs a real tolerance evaluation).
export type CapacityExposure = {
  rehabSessionId: string;
  userId: string;
  patientLocalDate: string;
  prescriptionVersionId: string | null;
  toleranceEvaluationId: string;
  toleranceClassification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance | null;
  construct: ComparableConstruct;
  prescribed: ExposureSetVector;
  actual: ExposureSetVector;
  // LOCKED (brief section 8): well_tolerated+maintain or caution+maintain.
  isSuccessfulExposure: boolean;
};

// `loading_capacity_declining`/"capacity_declining" are explicitly NOT part
// of this vocabulary and never will be — lower recent loading never implies
// declining Capacity (locked). All five states below are now fully
// deterministic as of round 3 (no pending-decision branch remains for
// Capacity).
export type CapacityState =
  | "capacity_building"
  | "loading_capacity_improving"
  | "loading_capacity_stable"
  | "loading_pattern_variable"
  | "more_comparable_data_needed";

export type TrainingResponseState =
  | "loading_tolerance_improving"
  | "stable_training_response"
  | "variable_training_response"
  | "training_response_remains_unsettled"
  | "more_data_needed";
