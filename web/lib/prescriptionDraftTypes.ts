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
export type AssistanceLevel = "contact_guard" | "minimal" | "moderate" | "maximum";
export type Side = "bilateral" | "left" | "right" | "both_sides_separately" | "not_applicable";
export type DistanceUnit = "m" | "km" | "ft" | "mi";

// Mirrors prescription_exercise_dosage's column set exactly (camelCase).
// Every field optional except dosageType — the DB's own CHECK constraints
// are the authoritative shape validation; this type only prevents typos,
// it does not duplicate the shape rules.
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
  rpe?: number | null;
  rir?: number | null;
  rom?: string | null;
  assistanceLevel?: AssistanceLevel | null;
  side?: Side | null;
};

export type ValidationRuleResult = { rule: string; passed: boolean; detail: string };
