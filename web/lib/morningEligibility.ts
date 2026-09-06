// Milestone 4, Stage 1 — deterministic, timezone-aware morning-response
// timing utilities. Pure functions only; no session-triggered gating logic
// lives here (that's Stage 3 — see getMorningResponseState's doc comment).
//
// TenoTrainer owns the POLICY ("next local calendar day at the patient's
// configured reminder time"); date-fns-tz owns the CONVERSION ("what UTC
// instant is that wall-clock time in this IANA zone"). A hand-rolled
// offset-correction implementation was deliberately rejected in favor of a
// mature, tested library for the DST-sensitive conversion step.

import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

export const DEFAULT_MORNING_REMINDER_TIME = "05:00:00";

// ---------------------------------------------------------------------------
// Reminder-time validation — 15-minute increments, matching the DB CHECK
// constraint (profiles_morning_reminder_time_15min) so client/server/DB all
// agree on the same rule rather than the DB silently being stricter.
// ---------------------------------------------------------------------------
const REMINDER_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export function isValidMorningReminderTime(time: string): boolean {
  const match = time.match(REMINDER_TIME_PATTERN);
  if (!match) return false;
  const minute = Number(match[2]);
  const second = match[3] !== undefined ? Number(match[3]) : 0;
  return minute % 15 === 0 && second === 0;
}

// Normalizes "HH:MM" to "HH:MM:SS" for consistent storage/comparison —
// callers should validate with isValidMorningReminderTime first.
export function normalizeMorningReminderTime(time: string): string {
  return time.length === 5 ? `${time}:00` : time;
}

// ---------------------------------------------------------------------------
// IANA timezone validation — server is the trust boundary; the browser only
// ever supplies a candidate value, never a value trusted without this check.
// ---------------------------------------------------------------------------
let cachedSupportedTimezones: Set<string> | null = null;

export function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    if (!cachedSupportedTimezones) {
      cachedSupportedTimezones = new Set(Intl.supportedValuesOf("timeZone"));
    }
    if (cachedSupportedTimezones.has(timezone)) return true;
  } catch {
    // Intl.supportedValuesOf unavailable — fall through to the construction check below.
  }
  // Fallback (and extra safety net even when supportedValuesOf succeeds):
  // constructing a DateTimeFormat with an unrecognized zone throws RangeError.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scheduled eligibility instant
// ---------------------------------------------------------------------------

// patientLocalDate: "YYYY-MM-DD" (rehab_sessions.patient_local_date).
// timezone: a validated IANA identifier — caller's responsibility to have
// confirmed this via isValidIanaTimezone (or to have it from a trusted
// source, e.g. already-persisted profiles.timezone).
// reminderTime: "HH:MM:SS" (or "HH:MM") local wall-clock time.
//
// Returns the correct UTC instant for "the calendar day after
// patientLocalDate, at reminderTime local time, in timezone" — DST-correct
// because the actual zone conversion is delegated to date-fns-tz rather than
// computed as a fixed offset.
export function getScheduledMorningEligibility(
  patientLocalDate: string,
  timezone: string,
  reminderTime: string
): Date {
  const nextDay = addDays(parseISO(patientLocalDate), 1);
  const nextDayStr = format(nextDay, "yyyy-MM-dd");
  const normalizedTime = normalizeMorningReminderTime(reminderTime);
  const wallClock = `${nextDayStr}T${normalizedTime}`;
  return fromZonedTime(wallClock, timezone);
}

// ---------------------------------------------------------------------------
// State derivation — pure, reads only scheduled_eligible_at/submitted_at.
// Deliberately does NOT know about session-triggered gating (Stage 3): a
// morning response can become a hard blocker for starting a new session
// before its scheduled time, but that is a separate concept layered on top
// of this function's output, never mixed into it.
// ---------------------------------------------------------------------------
export type MorningResponseState = "pending" | "scheduled_ready" | "submitted";

export function isScheduledEligible(scheduledEligibleAt: string | null, now: Date): boolean {
  if (scheduledEligibleAt === null) return false;
  return now.getTime() >= new Date(scheduledEligibleAt).getTime();
}

export function getMorningResponseState(
  response: { scheduledEligibleAt: string | null; submittedAt: string | null },
  now: Date
): MorningResponseState {
  if (response.submittedAt !== null) return "submitted";
  if (isScheduledEligible(response.scheduledEligibleAt, now)) return "scheduled_ready";
  return "pending";
}
