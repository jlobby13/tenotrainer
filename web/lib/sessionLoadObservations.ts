// Milestone 4 Stage 4 founder-acceptance patch — session-level external-load
// observation model. Client-safe (no server-only import). Supersedes the
// external_load_categories/external_load_timing columns that used to live on
// morningResponseTypes.ts's MorningResponseRecord; those columns are
// deprecated in place (see the migration), never dropped.
//
// This is an exposure observation, not an activity diary: no mileage, steps,
// duration, pace, GPS, heart rate, or calories are ever captured — only
// which coarse category of activity happened, and roughly when relative to
// the rehab session.

export type ExternalLoadCategory =
  | "running"
  | "sport"
  | "prolonged_walking_standing"
  | "other_lower_body_training"
  | "unusually_high_activity"
  | "other"
  | "none";

export const EXTERNAL_LOAD_CATEGORIES: ExternalLoadCategory[] = [
  "running",
  "sport",
  "prolonged_walking_standing",
  "other_lower_body_training",
  "unusually_high_activity",
  "other",
];

export const EXTERNAL_LOAD_CATEGORY_LABELS: Record<ExternalLoadCategory, string> = {
  running: "Running",
  sport: "Sport",
  prolonged_walking_standing: "Prolonged walking or standing",
  other_lower_body_training: "Other lower-body training",
  unusually_high_activity: "Unusually high activity",
  other: "Other",
  none: "None",
};

export type ExternalLoadTiming = "previous_day" | "same_day_before_rehab" | "same_day_after_rehab";

export const EXTERNAL_LOAD_TIMING_LABELS: Record<ExternalLoadTiming, string> = {
  previous_day: "The day before",
  same_day_before_rehab: "Same day, before your rehab session",
  same_day_after_rehab: "Same day, after your rehab session",
};

// Which workflow captured the observation. Always set by the server route
// itself — never accepted from a client request body — so provenance can't
// be spoofed. M3 asks only about what could plausibly be known before/around
// the rehab session; M4 asks only about what happened after it.
export type LoadObservationProvenance = "m3_session_response" | "m4_morning_response";

// M3 may only report a timing that could plausibly be known at that point in
// the flow (right after finishing exercises) — the rehab session hasn't
// produced a "same day after rehab" window yet from its own vantage point.
export const M3_TIMING_OPTIONS: ExternalLoadTiming[] = ["previous_day", "same_day_before_rehab"];

// M4 asks specifically about the window after the rehab session and before
// the morning check-in — there is exactly one valid timing, so M4 never
// surfaces a timing question at all; it's assigned this fixed value.
export const M4_FIXED_TIMING: ExternalLoadTiming = "same_day_after_rehab";

export type SessionLoadObservationRecord = {
  id: string;
  rehabSessionId: string;
  userId: string;
  category: ExternalLoadCategory;
  timing: ExternalLoadTiming | null;
  capturedDuring: LoadObservationProvenance;
  createdAt: string;
};

export function mapSessionLoadObservationRow(row: Record<string, unknown>): SessionLoadObservationRecord {
  return {
    id: row.id as string,
    rehabSessionId: row.rehab_session_id as string,
    userId: row.user_id as string,
    category: row.category as ExternalLoadCategory,
    timing: (row.timing as ExternalLoadTiming | null) ?? null,
    capturedDuring: row.captured_during as LoadObservationProvenance,
    createdAt: row.created_at as string,
  };
}

// A submitted selection from either the M3 or M4 capture UI, before it's
// written as one or more normalized rows. `categories` never includes
// "none" mixed with real categories — the UI enforces this as an exclusive
// choice (see ExternalLoadScreen.tsx / MorningCheckInScreen.tsx).
export type ExternalLoadSelection = {
  categories: ExternalLoadCategory[];
  timing: ExternalLoadTiming | null;
};

export function isExplicitNone(selection: ExternalLoadSelection): boolean {
  return selection.categories.length === 1 && selection.categories[0] === "none";
}
