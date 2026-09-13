// Milestone 6, Stage 3C — pure Capacity exposure construction. No I/O.
//
// One CapacityExposure per (base response episode x exercise appearing in
// that session's prescription_snapshot). Reuses Stage 3B's base-episode
// gate conceptually (session + actual performance + finalized M4 response +
// tolerance evaluation) — a capacity exposure still needs a real tolerance
// evaluation to know whether it qualifies as successful (brief section 8),
// and a tolerance evaluation requires a finalized morning response, so the
// atomic gating is identical to responseEpisode.ts's isBaseResponseEpisode.
//
// FOUNDER DECISION (round 3): preserve the REAL, ordered, set-level
// performance — never collapse to a single scalar (no min/median/sum/mean
// across sets). `buildSetVector` returns one SetObservation per prescribed
// set, in set order, pairing each set's own reps/hold-duration with that
// SAME set's own external load (never reordering dimensions across sets).
//
// Mechanical performance remains factual even when an exercise's dosage
// isn't quantitatively representable (brief section 4) — such exposures are
// still constructed (set-level completed/skipped outcomes visible), just
// excluded from Capacity classification later, never hidden.

import type { PrescriptionSnapshotExercise } from "./rehabSessionTypes";
import type { CapacityExposure, ComparableConstruct, ExposureSetVector } from "./capacityTypes";
import type { ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";
import { deriveComparableConstruct } from "./capacityConstruct";

export type RawSetOutcomeRow = {
  exercise_id: string;
  set_index: number;
  outcome: "completed" | "skipped";
  prescribed_reps: number | null;
  prescribed_load: number | null;
  actual_reps: number | null;
  actual_load: number | null;
};

export type RawCapacityExposureInput = {
  rehabSessionId: string;
  userId: string;
  patientLocalDate: string;
  prescriptionVersionId: string | null;
  toleranceEvaluationId: string;
  toleranceClassification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance | null;
  prescriptionSnapshot: PrescriptionSnapshotExercise[];
  setOutcomes: RawSetOutcomeRow[]; // every set_outcomes row for this rehab session (any exercise)
};

// LOCKED (brief sections 8-9): well_tolerated+maintain and caution+maintain
// both positively qualify. caution+maintain_cautiously, caution+
// reduce_modify, acute_override/clinical_review, and insufficient_data (a
// documented placeholder never really surfaced) do not.
export function isSuccessfulCapacityExposure(classification: ToleranceClassification, guidance: ImmediateGuidance | null): boolean {
  if (classification === "well_tolerated" && guidance === "maintain") return true;
  if (classification === "caution" && guidance === "maintain") return true;
  return false;
}

// Ordered by setIndex. Prescribed amount/load are recorded regardless of
// outcome (a skipped set was still prescribed); actual amount/load stay
// null (never 0) for a skipped set — outcome itself carries that meaning,
// mirroring set_outcomes' own established convention.
function buildSetVector(sets: RawSetOutcomeRow[], which: "prescribed" | "actual"): ExposureSetVector {
  const sorted = [...sets].sort((a, b) => a.set_index - b.set_index);
  if (which === "prescribed") {
    return sorted.map((s) => ({ setIndex: s.set_index, outcome: s.outcome, amount: s.prescribed_reps, load: s.prescribed_load }));
  }
  return sorted.map((s) => ({
    setIndex: s.set_index,
    outcome: s.outcome,
    amount: s.outcome === "completed" ? s.actual_reps : null,
    load: s.outcome === "completed" ? s.actual_load : null,
  }));
}

export function buildCapacityExposures(raw: RawCapacityExposureInput): CapacityExposure[] {
  const setsByExercise = new Map<string, RawSetOutcomeRow[]>();
  for (const row of raw.setOutcomes) {
    const list = setsByExercise.get(row.exercise_id) ?? [];
    list.push(row);
    setsByExercise.set(row.exercise_id, list);
  }

  const isSuccessful = isSuccessfulCapacityExposure(raw.toleranceClassification, raw.immediateGuidance);

  return raw.prescriptionSnapshot.map((ex): CapacityExposure => {
    const sets = setsByExercise.get(ex.ex_id) ?? [];
    const construct: ComparableConstruct = deriveComparableConstruct(ex);
    return {
      rehabSessionId: raw.rehabSessionId,
      userId: raw.userId,
      patientLocalDate: raw.patientLocalDate,
      prescriptionVersionId: raw.prescriptionVersionId,
      toleranceEvaluationId: raw.toleranceEvaluationId,
      toleranceClassification: raw.toleranceClassification,
      immediateGuidance: raw.immediateGuidance,
      construct,
      prescribed: buildSetVector(sets, "prescribed"),
      actual: buildSetVector(sets, "actual"),
      isSuccessfulExposure: isSuccessful,
    };
  });
}
