// Milestone 6, Stage 4 — shared, client-safe types for the patient-facing
// Progress interpretation summary (Symptoms / Capacity / Training
// Response). No server-only import: consumed by both
// progressInterpretationServer.ts (the actual Postgres reads) and the UI
// components/labels.
//
// Every `resultState`/`moreDataNeededReason`/`overallLoadingDirection`
// field here is a raw internal engine value (Stage 3B/3C vocabulary) kept
// as a plain string — this file does NOT re-type it as a union, mirroring
// longitudinalInterpretationTypes.ts's own "not a locked vocabulary at the
// storage layer" stance. progressInterpretationLabels.ts owns the
// exhaustive patient-safe mapping and must never be bypassed by a
// component rendering one of these raw strings directly.

export type SymptomsInterpretationSummary = {
  resultState: string;
  generatedAt: string;
} | null;

export type CapacityConstructSummary = {
  constructKey: string;
  exId: string;
  loadingProfile: string | null;
  performanceUnit: string;
  // Resolved from the patient's own real prescription history — null only
  // when no snapshot naming this exId could be found at all (see
  // progressInterpretationServer.ts's resolveExerciseNames). Never the raw
  // exId.
  exerciseName: string | null;
  resultState: string;
  moreDataNeededReason: string | null;
  generatedAt: string;
};

export type TrainingResponseSummary = {
  resultState: string;
  hasInsufficientConstruct: boolean;
  // 'increased' | 'maintained' | 'decreased' | 'mixed' | 'insufficient' —
  // kept as a raw string here for the same reason as resultState above.
  // Used only to select the correct more_data_needed explanation (decreased
  // loading vs. generic insufficiency) — never rendered directly.
  overallLoadingDirection: string | null;
  generatedAt: string;
} | null;

export type ProgressInterpretationData = {
  symptoms: SymptomsInterpretationSummary;
  capacityConstructs: CapacityConstructSummary[];
  trainingResponse: TrainingResponseSummary;
};
