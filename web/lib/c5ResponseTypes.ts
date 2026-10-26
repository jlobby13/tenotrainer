// C5.6E — client-safe types and copy for C5 response submission. No I/O and
// no clinical rules: every value is validated by c5_submit_*_response, and
// whether training is available afterwards comes from the fresh C5 state.

import type { C5TrainingState } from "./c5RuntimeTypes";

export type C5SafetyKey = "sudden_or_sharp_pain" | "pop_felt_or_heard" | "new_functional_difficulty";

export type C5ImmediateCheckIn = {
  sessionId: string;
  trainingStatus: string;
  sessionLocalDate: string;
  workout: { label: string | null; orderIndex: number } | null;
  // Facts already reported as TRUE (at Stop). Fixed: the form shows them as
  // reported and never offers "No".
  recordedSafety: Record<C5SafetyKey, boolean>;
};

export type C5MorningCheckIn = {
  sessionId: string;
  dueAt: string;
  // The morning the answers describe (frozen; never the submission date).
  referenceLocalDate: string;
  sessionLocalDate: string;
};

export type C5CheckIns = {
  patientToday: string | null;
  // PEC — the patient's time zone, for formatting the upcoming time.
  patientTimezone: string | null;
  immediate: C5ImmediateCheckIn[];
  // Due (and unresolved) morning responses only.
  mornings: C5MorningCheckIn[];
  // PEC — the earliest morning check-in that exists but is NOT yet due
  // (scheduled_eligible_at in the future). Informational only: due
  // semantics are unchanged and it never gates or replaces a due action.
  upcomingMorning: { dueAt: string } | null;
};

// PEC — "Morning check-in opens tomorrow at 7:00 AM", in the patient's own
// time zone. Pure formatting of the authoritative scheduled_eligible_at.
export function describeUpcomingMorning(dueAt: string, timezone: string | null, now: Date = new Date()): string {
  const tz = timezone ?? undefined;
  const due = new Date(dueAt);
  let time: string;
  let dayKey: (d: Date) => string;
  try {
    time = due.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    dayKey = (d) => fmt.format(d);
  } catch {
    time = due.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    dayKey = (d) => d.toISOString().slice(0, 10);
  }
  const today = dayKey(now);
  const tomorrow = dayKey(new Date(now.getTime() + 86400000));
  const dueDay = dayKey(due);
  let when: string;
  if (dueDay === today) when = "today";
  else if (dueDay === tomorrow) when = "tomorrow";
  else {
    try {
      when = `on ${due.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: tz })}`;
    } catch {
      when = `on ${due.toDateString()}`;
    }
  }
  return `Morning check-in opens ${when} at ${time}.`;
}

// snake_case = the RPC's own shape. A score is an integer 0-10; "unable to
// recall" is an explicit flag/resolution with the score left absent (NULL).
export type C5ImmediateResponseInput = {
  peak_session_pain?: number | null;
  peak_pain_unable_to_recall?: boolean;
  overall_session_rpe?: number | null;
  rpe_unable_to_recall?: boolean;
  sudden_or_sharp_pain?: boolean;
  pop_felt_or_heard?: boolean;
  new_functional_difficulty?: boolean;
};

export type C5StiffnessDuration = "lt_5_min" | "min_5_15" | "min_15_30" | "gt_30_min";

export type C5MorningResponseInput =
  | {
      resolution: "answered";
      next_morning_pain: number;
      next_morning_stiffness: number;
      stiffness_duration?: C5StiffnessDuration;
      patient_note?: string;
    }
  | { resolution: "unable_to_recall"; patient_note?: string };

export type C5SubmitResult = {
  result: string;
  detail?: string;
  item?: string;
  replayed?: boolean;
  state: C5TrainingState;
  checkIns: C5CheckIns;
};

// The established acute-safety wording (legacy AcuteQuestionsScreen).
export const SAFETY_QUESTIONS: { key: C5SafetyKey; label: string; hint?: string }[] = [
  { key: "sudden_or_sharp_pain", label: "Did you feel sudden or sharp pain?" },
  { key: "pop_felt_or_heard", label: "Did you feel or hear a pop?" },
  { key: "new_functional_difficulty", label: "Are you having new difficulty with function?", hint: "Walking, stairs, or other normal daily activities." },
];

export const STIFFNESS_DURATIONS: { value: C5StiffnessDuration; label: string }[] = [
  { value: "lt_5_min", label: "Less than 5 minutes" },
  { value: "min_5_15", label: "5–15 minutes" },
  { value: "min_15_30", label: "15–30 minutes" },
  { value: "gt_30_min", label: "More than 30 minutes" },
];

// Sparse orientation words for the Session RPE scale (founder-locked). They
// are presentation only: never stored, never mapped to numbers.
export const RPE_ANCHOR_WORDS = ["Very Easy", "Moderate", "Hard", "Very Hard"] as const;

export const C5_RESPONSE_MESSAGES: Record<string, string> = {
  response_not_found: "We couldn't find this check-in. It may already be complete.",
  invalid_response: "Please check your answers and try again.",
  recorded_safety_fact_conflict: "An answer you reported earlier can't be changed here.",
  already_submitted: "This check-in was already submitted. Your original answers are kept.",
  morning_not_yet_due: "This morning check-in isn't open yet.",
};

export function responseMessage(code: string): string {
  return C5_RESPONSE_MESSAGES[code] ?? "Something went wrong. Please try again.";
}
