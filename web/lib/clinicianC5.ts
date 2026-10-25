// M1 — clinician C5 review: pure, client-safe types and display helpers.
// No I/O and no clinical interpretation: every value shown comes from an
// authoritative C5 fact (see clinicianC5Server.ts); these helpers only
// label it. Distinctions kept on purpose: UNKNOWN is never zero, a skipped
// set is never zero reps, Stopped is never Finished, a scheduled date is
// never the performed date, the intended morning is never submitted_at,
// and a patient reassessment is never a professional-review release.

import type { C5Snapshot, C5TrainingStatus } from "./c5RuntimeTypes";
import type { C5StiffnessDuration } from "./c5ResponseTypes";

// ---------------------------------------------------------------------------
// Session RPE — clinician descriptor (founder-locked). Derived from the
// authoritative 0–10 integer; never persisted; the number is never changed.
// ---------------------------------------------------------------------------
export const RPE_DESCRIPTORS: readonly string[] = [
  "At rest", // 0
  "Very easy", // 1
  "Somewhat easy", // 2
  "Moderate", // 3
  "Somewhat hard", // 4
  "Hard", // 5
  "Hard", // 6
  "Very hard", // 7
  "Very hard", // 8
  "Very hard", // 9
  "Very, very hard", // 10
];

export function rpeDescriptor(score: number): string {
  if (!Number.isInteger(score) || score < 0 || score > 10) throw new Error(`rpeDescriptor: not a 0–10 integer (${score})`);
  return RPE_DESCRIPTORS[score];
}

export function formatRpe(score: number): string {
  return `${score} · ${rpeDescriptor(score)}`;
}

// ---------------------------------------------------------------------------
// Facts that may be unknown. A graded value is a number, an explicit
// unable-to-recall, or not yet submitted — three different facts.
// ---------------------------------------------------------------------------
export type ScoreFact = { kind: "value"; value: number } | { kind: "unable_to_recall" } | { kind: "not_submitted" };

export function scoreFact(value: number | null, unableToRecall: boolean): ScoreFact {
  if (value != null) return { kind: "value", value };
  if (unableToRecall) return { kind: "unable_to_recall" };
  return { kind: "not_submitted" };
}

export function formatScore(f: ScoreFact, format: (n: number) => string = String): string {
  if (f.kind === "value") return format(f.value);
  return f.kind === "unable_to_recall" ? "Unknown (unable to recall)" : "Not yet submitted";
}

// ---------------------------------------------------------------------------
// Session status
// ---------------------------------------------------------------------------
export const TRAINING_STATUS_LABELS: Record<C5TrainingStatus, string> = {
  started: "In progress (started, not closed)",
  finished: "Finished",
  stopped_early: "Stopped early",
  stopped_pause: "Stopped — program paused",
  stopped_acute: "Stopped for a safety concern",
};

export function trainingStatusLabel(s: C5TrainingStatus): string {
  return TRAINING_STATUS_LABELS[s];
}

export const SEQUENCE_CHOICE_LABELS: Record<string, string> = {
  repeat_previous: "Repeated the stopped workout",
  advance_next: "Moved on to the next workout",
  single_workout_auto: "Single-workout program (automatic)",
};

export const STIFFNESS_DURATION_LABELS: Record<C5StiffnessDuration, string> = {
  lt_5_min: "Less than 5 minutes",
  min_5_15: "5–15 minutes",
  min_15_30: "15–30 minutes",
  gt_30_min: "More than 30 minutes",
};

// ---------------------------------------------------------------------------
// Time, always labelled with the patient's time zone.
// ---------------------------------------------------------------------------
export function formatPatientDateTime(iso: string, timeZone: string | null): string {
  const tz = timeZone ?? "UTC";
  const text = new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `${text} (${tz})`;
}

// A patient-local calendar date (YYYY-MM-DD), formatted without shifting it.
export function formatLocalDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function localDateOf(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC" }).format(new Date(iso));
}

export function daysBetween(fromDate: string, toDate: string): number {
  const [a, b] = [fromDate, toDate].map((d) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  });
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// Morning response
// ---------------------------------------------------------------------------
export type MorningFact =
  | { kind: "none" } // session still open: no obligation yet
  | { kind: "not_yet_due"; dueAt: string | null; referenceLocalDate: string | null }
  | { kind: "due"; dueAt: string | null; referenceLocalDate: string | null }
  | {
      kind: "answered";
      pain: number;
      stiffness: number;
      stiffnessDuration: C5StiffnessDuration | null;
      note: string | null;
      dueAt: string | null;
      referenceLocalDate: string | null;
      submittedAt: string;
      daysAfterReference: number | null;
    }
  | { kind: "unable_to_recall"; dueAt: string | null; referenceLocalDate: string | null; submittedAt: string; daysAfterReference: number | null };

export function morningStatusLabel(m: MorningFact): string {
  switch (m.kind) {
    case "none":
      return "—";
    case "not_yet_due":
      return "Not yet due";
    case "due":
      return "Due — not yet submitted";
    case "answered":
      return m.daysAfterReference && m.daysAfterReference > 0 ? `Submitted (${m.daysAfterReference} day${m.daysAfterReference === 1 ? "" : "s"} after the intended morning)` : "Submitted";
    case "unable_to_recall":
      return "Submitted — unable to recall";
  }
}

// ---------------------------------------------------------------------------
// Safety — process language first (founder-locked D4); the numeric level is
// secondary provenance only.
// ---------------------------------------------------------------------------
export type SafetyProcessState = "clinician_release_required" | "safety_check_in_pending" | "released";

export function safetyProcessLabel(s: SafetyProcessState): string {
  switch (s) {
    case "clinician_release_required":
      return "Clinician release required";
    case "safety_check_in_pending":
      return "Safety check-in pending";
    case "released":
      return "Released";
  }
}

export const LEVEL4_REASON_LABELS: Record<string, string> = {
  recurrent_level_3_episodes: "Recurrent safety reports",
  unresolved_over_48_hours: "Unresolved for more than 48 hours",
  three_blocked_opportunities: "Training blocked three or more times",
};

export const SAFETY_FACT_LABELS: Record<"sudden_or_sharp_pain" | "pop_felt_or_heard" | "new_functional_difficulty", string> = {
  sudden_or_sharp_pain: "Sudden or sharp pain",
  pop_felt_or_heard: "Pop felt or heard",
  new_functional_difficulty: "New difficulty with function",
};

export function yesNoUnknown(v: boolean | null): string {
  return v === true ? "Yes" : v === false ? "No" : "Not answered";
}

// ---------------------------------------------------------------------------
// Read-model contracts (assembled server-side in clinicianC5Server.ts).
// ---------------------------------------------------------------------------
export type C5ImmediateFact =
  | { kind: "none" } // session still open
  | { kind: "pending" } // closed, not yet submitted
  | {
      kind: "submitted";
      peakPain: ScoreFact;
      rpe: ScoreFact;
      safety: { sudden_or_sharp_pain: boolean | null; pop_felt_or_heard: boolean | null; new_functional_difficulty: boolean | null };
      submittedAt: string;
    };

export type C5EscalationFact = { level: number; reason: string; ruleVersion: string; evaluatedAt: string; episodeId: string | null } | null;

export type C5SessionSummary = {
  id: string;
  patientLocalDate: string;
  patientTimezone: string;
  startedAt: string;
  closedAt: string | null;
  trainingStatus: C5TrainingStatus;
  workoutTitle: string;
  versionNumber: number | null;
  schedulingMode: "sequence" | "calendar";
  calendarScheduledDate: string | null;
  sequenceChoice: string | null;
  units: { prescribed: number; completed: number; skipped: number; edited: number };
  immediate: C5ImmediateFact;
  morning: MorningFact;
  escalation: C5EscalationFact;
};

export type C5UnitEdit = {
  editedAt: string;
  previous: { outcome: string; value: number | null; load: number | null };
  next: { outcome: string; value: number | null; load: number | null };
};

export type C5UnitFact =
  | { kind: "not_recorded" }
  | { kind: "skipped"; edits: C5UnitEdit[] }
  | { kind: "completed"; value: number | null; load: number | null; loadUnit: string | null; wasEdited: boolean; edits: C5UnitEdit[] };

export type C5ExerciseFact = {
  exerciseId: string;
  name: string;
  orderIndex: number;
  additionalInstructions: string | null;
  dosage: C5Snapshot["exercises"][number]["dosage"];
  // Actual-value field in the prescription's own unit (reps, contacts,
  // seconds, or the prescribed distance unit).
  valueLabel: string;
  units: C5UnitFact[];
};

export type C5RecoveryDecisionFact = {
  decision: "take_recovery_day" | "continue";
  decidedAt: string;
  decisionLocalDate: string;
  recommendedRecoveryDays: number;
  anchorStartLocalDate: string;
  earliestRecommendedDate: string;
  restDaysCompleted: number;
  weeklyTarget: number | null;
  weeklyFinishedSessions: number | null;
};

export type C5SessionDetail = C5SessionSummary & {
  versionId: string;
  snapshotVersion: number | null;
  targetSessionsPerWeek: number | null;
  recoveryDays: number | null;
  resolvesStoppedSessionId: string | null;
  exercises: C5ExerciseFact[];
  recoveryDecisions: C5RecoveryDecisionFact[];
  cautiousReturn: boolean;
};

export type C5SafetyEpisode = {
  episodeId: string;
  confirmedAt: string;
  initialLevel: number;
  effectiveLevel: number;
  level4Reasons: string[];
  professionallyHeld: boolean;
  requiresClinicianRelease: boolean;
  processState: SafetyProcessState;
  initialFacts: { sudden_or_sharp_pain: boolean; pop_felt_or_heard: boolean; new_functional_difficulty: boolean };
  sourceSession: { id: string; patientLocalDate: string; isC5: boolean; trainingStatus: C5TrainingStatus | null } | null;
  reassessments: {
    submittedAt: string;
    suddenOrSharpPainResolved: boolean | null;
    newFunctionalDifficultyResolved: boolean | null;
    evaluatedByProfessional: boolean;
    clearedByProfessional: boolean | null;
  }[];
  release: { releasePath: string; releasedAt: string; releasedByClinicianId: string | null; releasedByName: string | null; releaseNote: string | null } | null;
  blockedOpportunityCount: number;
};

export function episodeProcessState(e: { released: boolean; requiresClinicianRelease: boolean }): SafetyProcessState {
  if (e.released) return "released";
  return e.requiresClinicianRelease ? "clinician_release_required" : "safety_check_in_pending";
}

// Release path labels (clinician-facing).
export const RELEASE_PATH_LABELS: Record<string, string> = {
  self_resolved_no_evaluation: "Patient reported symptoms resolved",
  professional_clearance: "Patient reported professional clearance",
  professional_clearance_with_prescription: "Patient-reported clearance with an updated prescription (pre-M1 rule)",
  clinician_release: "Released by clinician",
};

// ---------------------------------------------------------------------------
// Current training eligibility (authoritative C5 state) — clinician wording.
// Recovery guidance is advisory and never a hold; the weekly target is never
// a quota.
// ---------------------------------------------------------------------------
export function c5EligibilityLabel(state: { kind: string; gate?: string; recovery?: unknown }): string {
  switch (state.kind) {
    case "no_active_prescription":
      return "No active program";
    case "prescription_paused":
      return "Program paused — no workout available";
    case "acute_blocked":
      return state.gate === "acute_safety_reconciliation_required"
        ? "Safety status being checked"
        : state.gate === "acute_safety_professional_review_required"
          ? "Training hold active — clinician release required"
          : "Training hold active — safety check-in pending";
    case "acute_resolution_required":
      return "Training hold active — the open session must be stopped for safety";
    case "resume":
      return "Session in progress";
    case "immediate_response_required":
      return "Post-session check-in needed before the next workout";
    case "morning_response_required":
      return "Morning check-in needed before the next workout";
    case "timezone_required":
      return "Patient time zone not set";
    case "already_trained_today":
      return "Already trained today";
    case "not_scheduled_today":
      return "No scheduled workout today";
    case "available":
      return state.recovery ? "Eligible to train (advisory recovery guidance shown)" : "Eligible to train";
    default:
      return "Unavailable";
  }
}
