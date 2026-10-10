// C5.4A — Prescription Builder Foundation. Shared client/server types for
// the builder route only (distinct from the C5.3 DB-mirroring types in
// lib/prescriptionDraftTypes.ts — these are UI-shaped/enriched views).
//
// BuilderLibraryExercise deliberately duplicates canonicalExerciseLibraryServer's
// CanonicalExerciseRecord shape (JSON-serialized) rather than importing it —
// that module is "server-only" and this type needs to be safely importable
// from client components, mirroring the existing
// prescriptionDraftTypes.ts/prescriptionDraftServer.ts split.

import type { ReferenceDosageLike } from "@/lib/canonicalExerciseLibrary";
import type { DosageInput, SchedulingMode, RehabPhase, PerformanceFocus, DosageCapability, OptionalFieldCapability } from "@/lib/prescriptionDraftTypes";

export type { SchedulingMode, RehabPhase, PerformanceFocus, DosageCapability, OptionalFieldCapability };

export type BuilderLibraryExercise = {
  id: string;
  name: string;
  category: string | null;
  loadingProfile: string | null;
  unilateralBilateral: string | null;
  bodyPart: string[] | null;
  equipment: string[] | null;
  setupInstructions: string | null;
  executionCues: string[] | null;
  patientFacingExplanation: string | null;
  commonCompensations: string[] | null;
  contraindicationsOrCautions: string | null;
  isFavorite: boolean;
  // C5.4 Revision B focused correction — see canonicalExerciseLibraryServer.ts's
  // CanonicalExerciseRecord and the 20261001000001 migration header.
  // default ⊆ allowed always.
  defaultDosageCapabilities: DosageCapability[];
  allowedDosageCapabilities: DosageCapability[];
  // C5.4 Revision D — optional "More options" modifiers offered for clean
  // authoring. Separate from the specialized dimensions above.
  optionalFieldCapabilities: OptionalFieldCapability[];
  hasReferenceDosage: boolean;
  referenceDosage: ReferenceDosageLike | null;
};

export type BuilderDraftExercise = {
  id: string; // prescription_exercises.id
  canonicalExerciseId: string;
  orderIndex: number;
  status: "active" | "paused";
  exerciseName: string;
  loadingProfile: string | null;
  dosageConfigured: boolean;
  // C5.4B — full structured dosage (null until first saved). dosageConfigured
  // above is kept as a cheap boolean derived from `dosage !== null` so
  // existing C5.4A call sites don't need to change.
  dosage: DosageInput | null;
  additionalInstructions: string | null;
  // C5.4 Performance Pass — true only for a Library add whose POST has not
  // returned yet (id is a client-side placeholder). Never sent to the server
  // and never given dosage working state; the row is replaced by the
  // persisted one on success or removed on failure.
  pending?: boolean;
};

export type BuilderDraftWorkout = {
  id: string;
  label: string | null;
  orderIndex: number;
  // C5.4C — Calendar-mode-only weekday assignment (0=Sunday..6=Saturday,
  // matching prescription_workouts.days_of_week exactly). Null/empty under
  // Sequence mode.
  daysOfWeek: number[] | null;
  exercises: BuilderDraftExercise[];
};

// C5.4C — prescription-level scheduling/informational metadata, previously
// entirely unauthored by any UI (the fields have existed since C5.2/C5.3B).
export type BuilderSchedulingState = {
  schedulingMode: SchedulingMode | null;
  targetSessionsPerWeek: number | null;
  phase: RehabPhase | null;
  performanceFocuses: PerformanceFocus[];
};
