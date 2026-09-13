// Milestone 6, Stage 3C — stable heuristic_key constants for the operational
// rules this stage implements, cataloged in m6_heuristics by
// supabase/migrations/20260913000001_m6_stage3c_capacity_training_response_heuristics_seed.sql.
// Client-safe (no server-only import). Mirrors symptomHeuristics.ts's
// established pattern — the engine looks these rows up by key
// (getHeuristicByKey), never hardcoded UUIDs.
//
// Keys match those given explicitly in the Stage 3C founder-decision brief
// section 16.

export const CAPACITY_COMPARABLE_DEMONSTRATIONS_2_OF_4_HEURISTIC_KEY = "m6_capacity_comparable_demonstrations_2_of_4";
export const SUCCESSFUL_CAPACITY_EXPOSURE_QUALIFICATION_HEURISTIC_KEY = "m6_successful_capacity_exposure_qualification";
export const CAPACITY_COMPARABLE_SERIES_DEFINITION_HEURISTIC_KEY = "m6_capacity_comparable_series_definition";
export const CAPACITY_STATE_MAPPING_HEURISTIC_KEY = "m6_capacity_state_mapping";
export const TRAINING_RESPONSE_STATE_MAPPING_HEURISTIC_KEY = "m6_training_response_state_mapping";
export const REPS_VS_HOLD_UNIT_RESOLUTION_HEURISTIC_KEY = "m6_reps_vs_hold_unit_resolution";
// Cross-cutting rule reused by both Capacity confirmation and Training
// Response's loading comparison — cataloged separately per brief section 16
// ("catalog any founder-approved partial-order loading comparison rule if
// it constitutes a separate heuristic").
export const PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY = "m6_partial_order_loading_comparison";

// Round 4 founder decision — the final Training Response window mechanism.
// Seeded by 20260913000003_m6_stage3c_training_response_window_heuristics_seed.sql.
export const TRAINING_RESPONSE_WINDOW_PAIRING_HEURISTIC_KEY = "m6_training_response_window_pairing";
export const TRAINING_RESPONSE_MINIMUM_PAIRED_EXPOSURES_HEURISTIC_KEY = "m6_training_response_minimum_paired_exposures";
export const TRAINING_RESPONSE_LOADING_DIRECTION_MAPPING_HEURISTIC_KEY = "m6_training_response_loading_direction_mapping";

export const STAGE_3C_CAPACITY_HEURISTIC_KEYS = [
  CAPACITY_COMPARABLE_SERIES_DEFINITION_HEURISTIC_KEY,
  PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY,
  CAPACITY_COMPARABLE_DEMONSTRATIONS_2_OF_4_HEURISTIC_KEY,
  SUCCESSFUL_CAPACITY_EXPOSURE_QUALIFICATION_HEURISTIC_KEY,
  CAPACITY_STATE_MAPPING_HEURISTIC_KEY,
] as const;

export const STAGE_3C_TRAINING_RESPONSE_HEURISTIC_KEYS = [
  TRAINING_RESPONSE_STATE_MAPPING_HEURISTIC_KEY,
  PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY,
  TRAINING_RESPONSE_WINDOW_PAIRING_HEURISTIC_KEY,
  TRAINING_RESPONSE_MINIMUM_PAIRED_EXPOSURES_HEURISTIC_KEY,
  TRAINING_RESPONSE_LOADING_DIRECTION_MAPPING_HEURISTIC_KEY,
] as const;
