// Milestone 6, Stage 4 — patient-safe copy for longitudinal interpretation
// states. Exact wording approved by founder review (M6 Stage 4 copy
// directions, sections 5-8). This file is the ONLY place these
// label/sentence strings may live — no component may render a raw
// resultState, reason code, loading-profile/performance-unit enum slug,
// heuristic key, or exId directly. Do not add, remove, or reword an entry
// without a separate founder pass.

export type PatientCopy = { label: string; sentence: string; secondarySentence?: string };

// ---------------------------------------------------------------------------
// Symptoms (domain: symptoms_short_window)
// ---------------------------------------------------------------------------

export const SYMPTOMS_FALLBACK_COPY: PatientCopy = {
  label: "More data needed",
  sentence: "We need a few more completed rehab responses before we can show a clear symptom trend.",
};

const SYMPTOMS_COPY: Record<string, PatientCopy> = {
  symptoms_improving: {
    label: "Improving",
    sentence: "Your recent symptom measures are trending in a better direction overall.",
  },
  symptoms_trending_better: {
    label: "Trending better",
    sentence: "One of your symptom measures has been improving while the others have remained relatively steady.",
  },
  symptoms_stable: {
    label: "Holding steady",
    sentence: "Your recent symptom measures have stayed relatively steady.",
  },
  mixed_symptom_response: {
    label: "Mixed",
    sentence: "Some symptom measures have improved while others have been trending higher.",
  },
  symptoms_trending_higher: {
    label: "Trending higher",
    sentence: "Your recent symptom measures have been trending higher overall.",
  },
  more_data_needed: SYMPTOMS_FALLBACK_COPY,
};

// `resultState` null = no Symptoms interpretation exists yet at all (Stage
// 4 §15 "no-interpretation fallback") — distinct from, but rendered
// identically to, the engine's own more_data_needed state, since both are
// restrained "not enough yet" messages to the patient.
export function getSymptomsCopy(resultState: string | null): PatientCopy {
  if (resultState == null) return SYMPTOMS_FALLBACK_COPY;
  return SYMPTOMS_COPY[resultState] ?? SYMPTOMS_FALLBACK_COPY;
}

// ---------------------------------------------------------------------------
// Capacity (domain: capacity_series, per construct)
// ---------------------------------------------------------------------------

export const CAPACITY_FALLBACK_COPY: PatientCopy = {
  label: "More data needed",
  sentence: "We need a few more comparable sessions with this exercise before we can describe a loading pattern.",
};

// No overall "no Capacity constructs yet" state exists in the engine (a
// patient with Stage 2 history but zero Capacity rows simply has an empty
// construct list) — this is the section-level (not per-construct) message
// for that case.
export const CAPACITY_SECTION_EMPTY_COPY: PatientCopy = {
  label: "More data needed",
  sentence: "We don't have a loading-capacity pattern to show yet — keep completing your rehab sessions.",
};

const CAPACITY_COPY: Record<string, PatientCopy> = {
  capacity_building: {
    label: "Building",
    sentence:
      "You've demonstrated a higher level of loading on this exercise recently. We need to see that pattern continue before describing a clear change.",
  },
  loading_capacity_improving: {
    label: "Improving",
    sentence: "You've repeatedly completed a higher level of loading on this exercise.",
  },
  loading_capacity_stable: {
    label: "Steady",
    sentence: "Your recent loading on this exercise has remained relatively consistent.",
  },
  loading_pattern_variable: {
    label: "Variable",
    sentence: "Your recent loading on this exercise has varied rather than following one clear direction.",
  },
  "more_comparable_data_needed:insufficient_total_history": CAPACITY_FALLBACK_COPY,
  "more_comparable_data_needed:unrepresentable_construct": {
    label: "Limited trend data",
    sentence: "This exercise's dosage is not recorded in a form that supports the same loading comparison used for other exercises.",
  },
  "more_comparable_data_needed:recent_loading_lower": {
    label: "Recent loading lower",
    sentence: "Recent loading on this exercise has been lower than before.",
    secondarySentence: "This is shown as a factual loading pattern, not as a decline in your tendon's capacity.",
  },
};

export function getCapacityCopy(resultState: string, moreDataNeededReason: string | null): PatientCopy {
  if (resultState === "more_comparable_data_needed") {
    return CAPACITY_COPY[`more_comparable_data_needed:${moreDataNeededReason ?? ""}`] ?? CAPACITY_FALLBACK_COPY;
  }
  return CAPACITY_COPY[resultState] ?? CAPACITY_FALLBACK_COPY;
}

// Patient-readable, restrained words only (never a raw loading_profile
// enum slug) — used ONLY to disambiguate two constructs that would
// otherwise display the identical exercise name (see
// disambiguateCapacityDisplayNames below), and as part of the "Exercise"
// fallback when no real name could be resolved at all.
const LOADING_PROFILE_DESCRIPTORS: Record<string, string> = {
  isometric: "hold",
  stretching: "stretch",
  eccentric_biased: "eccentric",
  heavy_slow_resistance: "slow resistance",
  isotonic_slow: "slow resistance",
  return_to_run: "running",
};

function loadingProfileDescriptor(loadingProfile: string | null): string | null {
  if (!loadingProfile) return null;
  return LOADING_PROFILE_DESCRIPTORS[loadingProfile] ?? null;
}

// LOCKED (founder direction): never show a raw exId. When no real name was
// resolved at all, fall back to "Exercise" plus a loading-profile/unit
// descriptor where one is available.
function resolveCapacityBaseDisplayName(construct: { exerciseName: string | null; loadingProfile: string | null }): string {
  if (construct.exerciseName) return construct.exerciseName;
  const descriptor = loadingProfileDescriptor(construct.loadingProfile);
  return descriptor ? `Exercise (${descriptor})` : "Exercise";
}

// Pure post-process over an already-resolved name list: appends a
// disambiguating loading-profile descriptor ONLY to display names that
// collide (e.g. the same exercise prescribed both as a rep-based set and
// as an isometric hold — two distinct comparable constructs per
// capacityConstruct.ts). Never changes which constructs exist or their
// resultState, only how they're labeled.
export function disambiguateCapacityDisplayNames<
  T extends { constructKey: string; exerciseName: string | null; loadingProfile: string | null },
>(items: T[]): Array<T & { displayName: string }> {
  const baseNames = items.map(resolveCapacityBaseDisplayName);
  const counts = new Map<string, number>();
  for (const n of baseNames) counts.set(n, (counts.get(n) ?? 0) + 1);

  return items.map((item, i) => {
    const base = baseNames[i];
    if ((counts.get(base) ?? 0) <= 1) return { ...item, displayName: base };
    const descriptor = loadingProfileDescriptor(item.loadingProfile);
    return { ...item, displayName: descriptor ? `${base} (${descriptor})` : base };
  });
}

// ---------------------------------------------------------------------------
// Training Response (domain: training_response_series)
// ---------------------------------------------------------------------------

export const TRAINING_RESPONSE_FALLBACK_COPY: PatientCopy = {
  label: "More data needed",
  sentence: "We need more comparable symptom and loading data before we can describe a clear training-response pattern.",
};

const TRAINING_RESPONSE_MORE_DATA_LOWER_LOADING: PatientCopy = {
  label: "More data needed",
  sentence:
    "Recent loading has been lower, so more comparable sessions are needed before we can describe how your symptoms respond at the current loading level.",
};

const TRAINING_RESPONSE_COPY: Record<string, PatientCopy> = {
  loading_tolerance_improving: {
    label: "Responding well",
    sentence: "Your symptoms have been improving while your rehab loading has been maintained or increased.",
  },
  stable_training_response: {
    label: "Steady response",
    sentence: "Your symptoms have stayed relatively steady while your rehab loading has remained comparable.",
  },
  variable_training_response: {
    label: "Variable response",
    sentence: "Your symptom response has varied across your recent rehab loading.",
  },
  training_response_remains_unsettled: {
    label: "Response needs attention",
    sentence: "Your symptoms have been trending higher while your rehab loading has been maintained or increased.",
    secondarySentence: "Your clinician may want to review this pattern with you.",
  },
};

export const TRAINING_RESPONSE_LIMITED_CONSTRUCTS_NOTE = "Some exercises do not yet have enough comparable loading history.";

// `overallLoadingDirection` selects between the generic more_data_needed
// explanation and the specific "recent loading has been lower" one — the
// engine's own resultDetail.overallLoadingDirection === 'decreased' is the
// only signal used (never a new threshold). `hasInsufficientConstruct`
// surfaces the approved patient-safe substitute for the internal
// `limited_comparable_exposures` reason code — that slug itself is never
// rendered.
export function getTrainingResponseCopy(params: {
  resultState: string | null;
  overallLoadingDirection: string | null;
  hasInsufficientConstruct: boolean;
}): { copy: PatientCopy; limitedComparableConstructsNote: string | null } {
  let copy: PatientCopy;
  if (params.resultState == null) {
    copy = TRAINING_RESPONSE_FALLBACK_COPY;
  } else if (params.resultState !== "more_data_needed") {
    copy = TRAINING_RESPONSE_COPY[params.resultState] ?? TRAINING_RESPONSE_FALLBACK_COPY;
  } else if (params.overallLoadingDirection === "decreased") {
    copy = TRAINING_RESPONSE_MORE_DATA_LOWER_LOADING;
  } else {
    copy = TRAINING_RESPONSE_FALLBACK_COPY;
  }
  return {
    copy,
    limitedComparableConstructsNote: params.hasInsufficientConstruct ? TRAINING_RESPONSE_LIMITED_CONSTRUCTS_NOTE : null,
  };
}

// ---------------------------------------------------------------------------
// Top-level Progress Summary — deterministic copy composition only (Stage 4
// §5). NOT a fourth clinical domain, not a score, not a verdict. Symptoms
// and Training Response are always stated independently, in that order;
// Capacity contributes a factual single-exercise sentence only when
// exactly one construct exists, or a neutral orientation sentence when
// more than one exists, and nothing at all when zero exist.
// ---------------------------------------------------------------------------

const SUMMARY_SYMPTOMS_PHRASES: Record<string, string> = {
  symptoms_improving: "Your symptoms have been trending in a better direction.",
  symptoms_trending_better: "One of your symptom measures has been improving while the others have stayed steady.",
  symptoms_stable: "Your symptoms have stayed relatively steady recently.",
  mixed_symptom_response: "Your recent symptom pattern has been mixed.",
  symptoms_trending_higher: "Your symptoms have been more noticeable recently.",
  more_data_needed: "We don't have enough recent data yet to describe a clear symptom trend.",
};

const SUMMARY_TRAINING_RESPONSE_PHRASES: Record<string, string> = {
  loading_tolerance_improving: "Your tendon has also been responding well to your recent rehab loading.",
  stable_training_response: "Your response to your current rehab loading has stayed steady.",
  variable_training_response: "Your response to rehab loading has also varied recently.",
  training_response_remains_unsettled: "Your response to your current rehab loading needs attention.",
  more_data_needed: "We need more comparable loading data before we can describe your overall response to the current rehab loading.",
};

const SUMMARY_TRAINING_RESPONSE_LOWER_LOADING =
  "Recent loading has been lower, so we need more comparable data before we can describe your response to the current rehab loading.";

const SUMMARY_CAPACITY_MULTI_CONSTRUCT = "Your loading capacity is shown exercise by exercise below.";

const SUMMARY_NO_INTERPRETATIONS = [
  "Keep completing your rehab sessions and morning check-ins.",
  "We'll show progress patterns here as enough comparable data becomes available.",
];

function summaryCapacitySentence(construct: { displayName: string; resultState: string }): string {
  switch (construct.resultState) {
    case "loading_capacity_improving":
      return `You've also repeatedly completed a higher level of loading on ${construct.displayName}.`;
    case "capacity_building":
      return `You've recently shown a higher level of loading on ${construct.displayName}, which we're continuing to watch.`;
    case "loading_capacity_stable":
      return `Your loading on ${construct.displayName} has remained relatively consistent.`;
    case "loading_pattern_variable":
      return `Your loading on ${construct.displayName} has varied recently.`;
    default:
      return `We need more comparable data on ${construct.displayName} before describing a loading pattern.`;
  }
}

export function composeProgressSummary(data: {
  symptoms: { resultState: string } | null;
  capacityConstructs: Array<{ displayName: string; resultState: string }>;
  trainingResponse: { resultState: string; overallLoadingDirection: string | null } | null;
}): string[] {
  const noInterpretationsAtAll = data.symptoms == null && data.capacityConstructs.length === 0 && data.trainingResponse == null;
  if (noInterpretationsAtAll) return SUMMARY_NO_INTERPRETATIONS;

  const sentences: string[] = [];

  sentences.push(data.symptoms ? SUMMARY_SYMPTOMS_PHRASES[data.symptoms.resultState] ?? SUMMARY_SYMPTOMS_PHRASES.more_data_needed : SUMMARY_SYMPTOMS_PHRASES.more_data_needed);

  if (data.trainingResponse) {
    if (data.trainingResponse.resultState === "more_data_needed" && data.trainingResponse.overallLoadingDirection === "decreased") {
      sentences.push(SUMMARY_TRAINING_RESPONSE_LOWER_LOADING);
    } else {
      sentences.push(SUMMARY_TRAINING_RESPONSE_PHRASES[data.trainingResponse.resultState] ?? SUMMARY_TRAINING_RESPONSE_PHRASES.more_data_needed);
    }
  } else {
    sentences.push(SUMMARY_TRAINING_RESPONSE_PHRASES.more_data_needed);
  }

  if (data.capacityConstructs.length === 1) {
    sentences.push(summaryCapacitySentence(data.capacityConstructs[0]));
  } else if (data.capacityConstructs.length > 1) {
    sentences.push(SUMMARY_CAPACITY_MULTI_CONSTRUCT);
  }

  return sentences;
}
