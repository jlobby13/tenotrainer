// C5.4A — Prescription Builder Foundation & Canonical Library Browser. Pure,
// deterministic domain logic only (no server-only import, no DB access) —
// safe to import from both server modules/routes AND client components,
// matching the clinicianRoster.ts / clinicianPatientOverview.ts split
// convention elsewhere in this codebase.
//
// Every formatter here renders a human-readable LABEL only — it never
// mutates or re-derives the underlying stored value. Per the C5.4A brief
// (§7): "Do not display raw enum tokens when a patient/clinician-readable
// label is appropriate ... Do not alter the stored value."

export type LoadingProfile =
  | "isometric"
  | "concentric_eccentric"
  | "eccentric_biased"
  | "heavy_dynamic"
  | "fast_dynamic"
  | "reactive_strength"
  | "explosive_strength"
  | "stretching"
  | "return_to_run";

export type UnilateralBilateral = "unilateral" | "bilateral" | "both" | "not_applicable";

// C5.4 Revision C — anatomical/functional Region taxonomy, stored in the
// pre-existing canonical_exercises.body_part TEXT[] column (populated for
// the first time in 20261003000001). Deliberately separate from category
// (a training-paradigm taxonomy), loading_profile, and region_bias (the
// Achilles-tendinopathy clinical subtype: midportion/insertional — not a
// body region) — see that migration's header for the full rationale.
export type BodyPartRegion = "calf_achilles" | "foot_ankle" | "knee" | "hip" | "core_trunk" | "whole_lower_extremity_general";
export const BODY_PART_REGIONS: BodyPartRegion[] = ["calf_achilles", "foot_ankle", "knee", "hip", "core_trunk", "whole_lower_extremity_general"];
const BODY_PART_REGION_LABELS: Record<BodyPartRegion, string> = {
  calf_achilles: "Calf / Achilles",
  foot_ankle: "Foot / Ankle",
  knee: "Knee",
  hip: "Hip",
  core_trunk: "Core / Trunk",
  whole_lower_extremity_general: "Whole Lower Extremity / General",
};
export function formatBodyPartRegionLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return BODY_PART_REGION_LABELS[value as BodyPartRegion] ?? value;
}

export type ReferenceDosageType = "repetition" | "hold" | "time" | "contact" | "distance";
export type DosageMode = "exact" | "range";
export type DistanceUnit = "m" | "km" | "ft" | "mi";

const LOADING_PROFILE_LABELS: Record<LoadingProfile, string> = {
  isometric: "Isometric",
  concentric_eccentric: "Concentric / Eccentric",
  eccentric_biased: "Eccentric Biased",
  heavy_dynamic: "Heavy Dynamic",
  fast_dynamic: "Fast Dynamic",
  reactive_strength: "Reactive Strength",
  explosive_strength: "Explosive Strength",
  stretching: "Stretching",
  return_to_run: "Return to Run",
};

export function formatLoadingProfileLabel(value: string | null): string | null {
  if (!value) return null;
  return LOADING_PROFILE_LABELS[value as LoadingProfile] ?? value;
}

const LATERALITY_LABELS: Record<UnilateralBilateral, string> = {
  unilateral: "Unilateral",
  bilateral: "Bilateral",
  both: "Both Sides",
  not_applicable: "Not Applicable",
};

export function formatLateralityLabel(value: string | null): string | null {
  if (!value) return null;
  return LATERALITY_LABELS[value as UnilateralBilateral] ?? value;
}

// `category` is free TEXT (no fixed vocabulary — see the C5.3F migration's
// header on why no CHECK/enum was invented for it), but the migrated legacy
// values are snake_case tokens (e.g. "symptom_modulation", "fast_dynamic")
// that read exactly like a raw enum to a clinician. This is a purely
// cosmetic, meaning-preserving transform (underscore -> space, title case)
// — never a clinical re-classification, and never touches the stored
// value. Applies to any free-text snake_case field, not just category.
export function formatFreeTextLabel(value: string | null): string | null {
  if (!value) return null;
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(value)) return value;
  return value.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

const DISTANCE_UNIT_LABELS: Record<DistanceUnit, string> = { m: "m", km: "km", ft: "ft", mi: "mi" };

// Founder-locked thresholds (C5.4B dosage-summary examples): 60s and 90s
// render as raw seconds ("60s rest", "90s rest"); 120s+ multiples of 60
// render as minutes ("2 min rest"). The cutoff is deliberately >=120, not
// >=60 — exactly 60s stays "60s", never "1 min".
export function formatSeconds(seconds: number): string {
  if (seconds % 60 === 0 && seconds >= 120) return `${seconds / 60} min`;
  return `${seconds}s`;
}

// Reference dosage is EDUCATIONAL/REFERENCE information only (C5.4A §11) —
// this formatter only ever produces a display string; it is never used to
// populate prescription_exercise_dosage.
export type ReferenceDosageLike = {
  dosageType: ReferenceDosageType;
  sets: number | null;
  repsMode: DosageMode | null;
  repsExact: number | null;
  repsMin: number | null;
  repsMax: number | null;
  contactsMode: DosageMode | null;
  contactsExact: number | null;
  contactsMin: number | null;
  contactsMax: number | null;
  holdDurationMode: DosageMode | null;
  holdDurationExactSeconds: number | null;
  holdDurationMinSeconds: number | null;
  holdDurationMaxSeconds: number | null;
  timeDurationMode: DosageMode | null;
  timeDurationExactSeconds: number | null;
  timeDurationMinSeconds: number | null;
  timeDurationMaxSeconds: number | null;
  intervalWorkSeconds: number | null;
  intervalRecoverySeconds: number | null;
  intervalRounds: number | null;
  distanceMode: DosageMode | null;
  distanceExactValue: number | null;
  distanceMinValue: number | null;
  distanceMaxValue: number | null;
  distanceUnit: DistanceUnit | null;
  tempoDescription: string | null;
  restSeconds: number | null;
};

function formatExactOrRange(mode: DosageMode | null, exact: number | null, min: number | null, max: number | null, unitSingular: string): string | null {
  if (mode === "exact" && exact != null) return `${exact} ${unitSingular}${exact === 1 ? "" : "s"}`;
  if (mode === "range" && min != null && max != null) return `${min}-${max} ${unitSingular}s`;
  return null;
}

export function formatReferenceDosageSummary(d: ReferenceDosageLike): string {
  const parts: string[] = [];
  if (d.sets != null) parts.push(`${d.sets} set${d.sets === 1 ? "" : "s"}`);

  switch (d.dosageType) {
    case "repetition": {
      const reps = formatExactOrRange(d.repsMode, d.repsExact, d.repsMin, d.repsMax, "rep");
      if (reps) parts.push(reps);
      break;
    }
    case "contact": {
      const contacts = formatExactOrRange(d.contactsMode, d.contactsExact, d.contactsMin, d.contactsMax, "contact");
      if (contacts) parts.push(contacts);
      break;
    }
    case "hold": {
      if (d.holdDurationMode === "exact" && d.holdDurationExactSeconds != null) parts.push(`${formatSeconds(d.holdDurationExactSeconds)} hold`);
      else if (d.holdDurationMode === "range" && d.holdDurationMinSeconds != null && d.holdDurationMaxSeconds != null)
        parts.push(`${formatSeconds(d.holdDurationMinSeconds)}-${formatSeconds(d.holdDurationMaxSeconds)} hold`);
      break;
    }
    case "time": {
      if (d.timeDurationMode === "exact" && d.timeDurationExactSeconds != null) parts.push(formatSeconds(d.timeDurationExactSeconds));
      else if (d.timeDurationMode === "range" && d.timeDurationMinSeconds != null && d.timeDurationMaxSeconds != null)
        parts.push(`${formatSeconds(d.timeDurationMinSeconds)}-${formatSeconds(d.timeDurationMaxSeconds)}`);
      if (d.intervalWorkSeconds != null && d.intervalRecoverySeconds != null) {
        parts.push(`(${formatSeconds(d.intervalWorkSeconds)} work / ${formatSeconds(d.intervalRecoverySeconds)} recovery)`);
      }
      if (d.intervalRounds != null) parts.push(`${d.intervalRounds} round${d.intervalRounds === 1 ? "" : "s"}`);
      break;
    }
    case "distance": {
      const unit = d.distanceUnit ? DISTANCE_UNIT_LABELS[d.distanceUnit] : "";
      if (d.distanceMode === "exact" && d.distanceExactValue != null) parts.push(`${d.distanceExactValue}${unit}`);
      else if (d.distanceMode === "range" && d.distanceMinValue != null && d.distanceMaxValue != null)
        parts.push(`${d.distanceMinValue}-${d.distanceMaxValue}${unit}`);
      break;
    }
  }

  if (d.tempoDescription) parts.push(d.tempoDescription);
  if (d.restSeconds != null) parts.push(`Rest ${formatSeconds(d.restSeconds)}`);

  return parts.length > 0 ? parts.join(" · ") : "No reference dosage detail on file";
}

// ---------------------------------------------------------------------------
// Library browsing — pure search/filter over an already-fetched, already-
// authorized exercise list. Deliberately in-memory (not a separate search
// service): the C5.4A brief explicitly rules out Elasticsearch/vector/AI
// search for a 47-exercise library. Case-insensitive per §8.
// ---------------------------------------------------------------------------
export type LibraryExercise = {
  id: string;
  name: string;
  category: string | null;
  loadingProfile: string | null;
  unilateralBilateral: string | null;
  bodyPart: string[] | null;
  isFavorite: boolean;
  hasReferenceDosage: boolean;
};

export type LibraryFilters = {
  search: string;
  loadingProfile: string | null;
  category: string | null;
  laterality: string | null;
  // C5.4 Revision C — multi-select, OR-within-Region (an exercise matches if
  // its body_part overlaps ANY selected region), AND-across-filter-families
  // with search/loadingProfile/category/favorites exactly like every other
  // filter here. Empty array = no Region filter applied.
  regions: BodyPartRegion[];
  favoritesOnly: boolean;
};

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = {
  search: "",
  loadingProfile: null,
  category: null,
  laterality: null,
  regions: [],
  favoritesOnly: false,
};

export function filterLibraryExercises<T extends LibraryExercise>(exercises: T[], filters: LibraryFilters): T[] {
  const term = filters.search.trim().toLowerCase();
  return exercises.filter((ex) => {
    if (filters.favoritesOnly && !ex.isFavorite) return false;
    if (filters.loadingProfile && ex.loadingProfile !== filters.loadingProfile) return false;
    if (filters.category && ex.category !== filters.category) return false;
    if (filters.laterality && ex.unilateralBilateral !== filters.laterality) return false;
    if (filters.regions.length > 0) {
      const exerciseRegions = ex.bodyPart ?? [];
      if (!filters.regions.some((r) => exerciseRegions.includes(r))) return false;
    }
    if (term.length > 0) {
      const haystack = `${ex.name} ${ex.category ?? ""} ${formatLoadingProfileLabel(ex.loadingProfile) ?? ""}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

// Facet option lists are always derived from the FULL authorized/active set,
// not the currently-filtered set — so narrowing one filter never hides the
// other available options (standard faceted-search convention). Region
// facets use the fixed, curated BODY_PART_REGIONS order (not alphabetical)
// so Calf/Achilles-first reads naturally, filtered down to regions actually
// present in the data (never offering an option with zero matches).
export function computeLibraryFacets(exercises: LibraryExercise[]): { loadingProfiles: string[]; categories: string[]; regions: BodyPartRegion[] } {
  const loadingProfiles = Array.from(new Set(exercises.map((e) => e.loadingProfile).filter((v): v is string => !!v))).sort();
  const categories = Array.from(new Set(exercises.map((e) => e.category).filter((v): v is string => !!v))).sort();
  const presentRegions = new Set(exercises.flatMap((e) => e.bodyPart ?? []));
  const regions = BODY_PART_REGIONS.filter((r) => presentRegions.has(r));
  return { loadingProfiles, categories, regions };
}
