// Milestone 6, Stage 3B — stable heuristic_key constants for the operational
// rules this stage implements, cataloged in m6_heuristics by
// supabase/migrations/20260912000001_m6_stage3b_symptom_heuristics_seed.sql.
// Client-safe (no server-only import) — the engine looks these rows up by
// key (getHeuristicByKey, web/lib/heuristicsCatalogServer.ts) rather than
// hardcoding UUIDs, exactly as heuristicsCatalogTypes.ts's own header
// anticipates ("a developer wiring up Stage 3B code will more often know
// the key").

export const ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY = "m6_rolling_5_plus_5_window";
export const DIRECTIONAL_FREQUENCY_60PCT_HEURISTIC_KEY = "m6_directional_frequency_60pct";
export const ONE_POINT_DIRECTIONAL_BOUNDARY_HEURISTIC_KEY = "m6_one_point_directional_boundary";
export const OVERALL_SYMPTOMS_SUMMARY_HEURISTIC_KEY = "m6_overall_symptoms_summary_logic";
// Added post-founder-review (see docs/m6-stage3b-symptom-engine.md) via
// supabase/migrations/20260912000002_m6_stage3b_consistency_and_msd_heuristics.sql
// — the original 20260912000001 seed migration is already applied and is
// never edited.
export const CONSISTENCY_VARIABLE_VS_CONSISTENT_HEURISTIC_KEY = "m6_consistency_variable_vs_consistent";
export const MSD_MIN_3_PER_WINDOW_HEURISTIC_KEY = "m6_msd_min_3_applicable_per_window";

export const STAGE_3B_SYMPTOM_HEURISTIC_KEYS = [
  ROLLING_5_PLUS_5_WINDOW_HEURISTIC_KEY,
  DIRECTIONAL_FREQUENCY_60PCT_HEURISTIC_KEY,
  ONE_POINT_DIRECTIONAL_BOUNDARY_HEURISTIC_KEY,
  OVERALL_SYMPTOMS_SUMMARY_HEURISTIC_KEY,
  CONSISTENCY_VARIABLE_VS_CONSISTENT_HEURISTIC_KEY,
  MSD_MIN_3_PER_WINDOW_HEURISTIC_KEY,
] as const;
