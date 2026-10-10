// C5.3 — Draft & Publish Engine. Pure types shared by the server module and
// (eventually) C5.4 UI code. No I/O, no server-only import.

export type DraftSource = "empty" | "clone_active" | "clone_historical" | "from_template";
export type DraftStatus = "editing" | "discarded" | "published";
export type SchedulingMode = "sequence" | "calendar";
export type RehabPhase = "early" | "middle" | "late" | "return_to_activity" | "maintenance";
export type PerformanceFocus =
  | "symptom_management_load_introduction"
  | "strength_development"
  | "energy_storage"
  | "reactive_strength"
  | "explosive_strength"
  | "return_to_sport_prep"
  | "maintenance";

export type ExerciseStatus = "active" | "paused";
// "distance" added C5.4B — the column set has existed since C5.3F
// (20260920000001) but this type/DosageInput never carried it, so
// updateDosage() could not previously write a distance dosage at all. Pure
// application-layer completion, no schema change.
export type DosageType = "repetition" | "hold" | "time" | "contact" | "distance";
export type DosageMode = "exact" | "range";
export type LoadType = "external" | "bodyweight" | "assisted" | "not_applicable";
export type LoadUnit = "kg" | "lb";
// C5.4 Revision A — external load gains exact/range support, mirroring the
// existing reps/hold/contacts/distance DosageMode pattern exactly.
export type LoadMode = "exact" | "range";
// C5.4 Revision A — explicit, authoritative per-exercise capability
// metadata (canonical_exercises.dosage_capabilities). Deliberately excludes
// universal/shared concepts (sets, load, rest, tempo, RPE/RIR, ROM,
// assistance, side) — those were never gated by dosage_type and remain
// always available; this vocabulary covers only the formerly-mutually-
// exclusive specialized dimensions.
export type DosageCapability = "reps" | "hold" | "contacts" | "distance" | "interval_time";
// C5.4 Revision D — explicit per-exercise applicability of the OPTIONAL
// prescription modifiers in "More options"
// (canonical_exercises.optional_field_capabilities). A UI-offering gate
// only: never required, never restricts what a saved row may contain.
// Patient-specific instructions are always available and deliberately not
// part of this vocabulary. Separate concept from DosageCapability above.
export type OptionalFieldCapability = "tempo" | "rpe" | "rir" | "rom" | "assistance" | "side";
export type AssistanceLevel = "contact_guard" | "minimal" | "moderate" | "maximum";
export type Side = "bilateral" | "left" | "right" | "both_sides_separately" | "not_applicable";
export type DistanceUnit = "m" | "km" | "ft" | "mi";

// Mirrors prescription_exercise_dosage's column set exactly (camelCase).
// Every field optional except dosageType — the DB's own CHECK constraints
// are the authoritative shape validation; this type only prevents typos,
// it does not duplicate the shape rules.
//
// C5.4 Revision A: dosageType remains REQUIRED (kept as the primary
// dimension / legacy-display hint — founder decision #3) but no longer
// implies that only ITS matching fields may be populated. Every dimension
// below (reps/hold/contacts/distance/time+interval/load) is now
// independently populatable regardless of dosageType's value — see
// validateDosageInput() in dosageEditor.ts, which validates each one on its
// own. This type was already structurally permissive (a flat shape, not a
// true discriminated union keyed by dosageType), so no shape change was
// required here beyond adding the new load-range fields.
export type DosageInput = {
  dosageType: DosageType;
  sets?: number | null;
  repsMode?: DosageMode | null;
  repsExact?: number | null;
  repsMin?: number | null;
  repsMax?: number | null;
  contactsMode?: DosageMode | null;
  contactsExact?: number | null;
  contactsMin?: number | null;
  contactsMax?: number | null;
  holdDurationMode?: DosageMode | null;
  holdDurationExactSeconds?: number | null;
  holdDurationMinSeconds?: number | null;
  holdDurationMaxSeconds?: number | null;
  timeDurationMode?: DosageMode | null;
  timeDurationExactSeconds?: number | null;
  timeDurationMinSeconds?: number | null;
  timeDurationMaxSeconds?: number | null;
  intervalWorkSeconds?: number | null;
  intervalRecoverySeconds?: number | null;
  intervalRounds?: number | null;
  distanceMode?: DosageMode | null;
  distanceExactValue?: number | null;
  distanceMinValue?: number | null;
  distanceMaxValue?: number | null;
  distanceUnit?: DistanceUnit | null;
  concentricDurationSeconds?: number | null;
  repHoldDurationSeconds?: number | null;
  eccentricDurationSeconds?: number | null;
  tempoDescription?: string | null;
  restSeconds?: number | null;
  loadType?: LoadType;
  loadValueExact?: number | null;
  loadUnit?: LoadUnit | null;
  // C5.4 Revision A — external load range. loadValueExact is preserved
  // exactly as before for the exact case; loadMode/loadValueMin/
  // loadValueMax are additive and only meaningful when loadMode === "range".
  loadMode?: LoadMode | null;
  loadValueMin?: number | null;
  loadValueMax?: number | null;
  rpe?: number | null;
  rir?: number | null;
  rom?: string | null;
  assistanceLevel?: AssistanceLevel | null;
  side?: Side | null;
};

export type ValidationRuleResult = { rule: string; passed: boolean; detail: string };
