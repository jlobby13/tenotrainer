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
import type { DosageInput } from "@/lib/prescriptionDraftTypes";

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
};

export type BuilderDraftWorkout = {
  id: string;
  orderIndex: number;
  exercises: BuilderDraftExercise[];
};
