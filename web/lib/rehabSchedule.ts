// Milestone 5, Stage 4 — founder-review closure patch: rehab-day scheduling
// eligibility primitive. Pure, deterministic, client-safe (no server-only
// import, no DB access) — mirrors derive_rehab_day_eligibility() in
// supabase/migrations/20260909000003_m5_stage4_rehab_schedule_eligibility.sql
// exactly, same pattern as guidance.ts/acuteSafety.ts's TS/SQL mirror pairs.
//
// Answers exactly one question: "is prescribed rehab scheduled for this
// patient on this patient-local calendar date?" Nothing here decides
// exercises, dosage, frequency policy, or anything else — this is strictly
// the eligibility primitive the closure-patch brief asked for.
//
// LOCKED distinction: rehabDaysOfWeek === null means "no schedule identity
// on file" — genuinely UNKNOWN, never coerced into "daily" or any other
// invented cadence. An empty array ([]) is a structurally distinct,
// legitimate "explicitly zero rehab days" value. Nothing in this codebase
// currently writes either a populated array or an empty array — every
// prescription_versions row today has rehabDaysOfWeek === null (see the
// migration's header note on why no cadence could be chosen without
// founder-approved data), so this function currently always returns
// "unknown" in production. Callers must not treat "unknown" as
// "not_scheduled" — see rehabScheduleServer.ts and the dashboard/gate
// integration for how "unknown" is deliberately treated the same as
// "scheduled" (never blocking) until real schedule data exists.

export type RehabDayEligibility = "scheduled" | "not_scheduled" | "unknown";

// patientLocalDate is a plain YYYY-MM-DD calendar-date string, already
// resolved to the patient's local date by the caller (see
// rehabScheduleServer.ts) — this function does no further timezone
// conversion of its own, it only computes which day-of-week that date
// falls on. 0=Sunday..6=Saturday, matching both JS Date.getDay() and
// Postgres EXTRACT(DOW ...) so the TS and SQL mirrors can never disagree.
export function deriveRehabDayEligibility(
  rehabDaysOfWeek: number[] | null,
  patientLocalDate: string
): RehabDayEligibility {
  if (rehabDaysOfWeek === null) return "unknown";

  const [year, month, day] = patientLocalDate.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return rehabDaysOfWeek.includes(dayOfWeek) ? "scheduled" : "not_scheduled";
}
