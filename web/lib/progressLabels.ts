// Milestone 6, Stage 2 — patient-understandable labels for Progress page
// enums. Client-safe. Kept separate from morningResponseTypes.ts (which
// owns the canonical vocabulary) so display wording can evolve without
// touching the locked schema-mirroring types.

import type { StiffnessDuration, ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";

export const STIFFNESS_DURATION_LABELS: Record<StiffnessDuration, string> = {
  not_applicable: "None",
  lt_5_min: "Under 5 min",
  min_5_15: "5–15 min",
  min_15_30: "15–30 min",
  gt_30_min: "Over 30 min",
};

// Patient-facing label already exists per-row on tolerance_evaluations
// (patient_facing_label) — this is only a fallback/legend for the
// classification code itself, used where the row's own label isn't shown.
export const TOLERANCE_CLASSIFICATION_LABELS: Record<ToleranceClassification, string> = {
  well_tolerated: "Well tolerated",
  caution: "Caution",
  poorly_tolerated: "Poorly tolerated",
  acute_override: "Acute safety review",
  insufficient_data: "Not enough data",
};

export const IMMEDIATE_GUIDANCE_LABELS: Record<ImmediateGuidance, string> = {
  maintain: "Maintain",
  maintain_cautiously: "Maintain cautiously",
  reduce_modify: "Reduce / modify",
  clinical_review: "Clinical review",
};

export const EXTERNAL_LOAD_CATEGORY_LABELS: Record<string, string> = {
  running: "Running",
  sport: "Sport",
  prolonged_walking_standing: "Prolonged walking/standing",
  other_lower_body_training: "Other lower-body training",
  unusually_high_activity: "Unusually high activity",
  other: "Other activity",
  none: "None reported",
};

export const EXTERNAL_LOAD_TIMING_LABELS: Record<string, string> = {
  previous_day: "the day before",
  same_day_before_rehab: "earlier that day, before rehab",
  same_day_after_rehab: "later that day, after rehab",
};
