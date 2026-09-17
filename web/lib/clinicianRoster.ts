// C1B — Clinician Dashboard & Roster. Pure, deterministic domain logic only
// (no server-only import, no DB access) — mirrors the acuteSafety.ts /
// acuteSafetyServer.ts split of "pure decision logic" from "server-only DB
// wiring" (see clinicianServer.ts for the latter).
//
// LOCKED founder decisions this module encodes:
//   - Recent-session window is 14 days, factual only (never "adherence").
//   - Roster sort is alphabetical-by-name, deterministic, never
//     reordered by any clinical signal (see compareRosterEntries).
//   - Morning-response badge is due/pending/none per the exact
//     scheduled_eligible_at rules — UNKNOWN != ZERO, never "overdue".

export type RosterMorningResponseStatus = "due" | "pending" | null;

// One outstanding (unsubmitted) morning response obligation, as seen by the
// roster. scheduledEligibleAt === null means eligibility timing could not be
// established yet (unknown timezone, or no morning_responses row created
// yet for a still-open awaiting_morning_response session) — this is
// deliberately DISTINCT from "not yet due" (a known, future
// scheduledEligibleAt), per the founder's UNKNOWN != ZERO rule.
export type OutstandingMorningResponse = {
  scheduledEligibleAt: string | null;
};

// "due" takes priority over "pending" when a patient has more than one
// outstanding obligation in mixed states — it is the more actionable fact.
// A patient whose only outstanding obligations are not-yet-due (known,
// future scheduledEligibleAt) gets no badge at all.
export function deriveMorningResponseBadge(
  outstanding: OutstandingMorningResponse[],
  now: Date
): RosterMorningResponseStatus {
  const nowMs = now.getTime();
  let anyPending = false;
  for (const response of outstanding) {
    if (response.scheduledEligibleAt === null) {
      anyPending = true;
      continue;
    }
    if (new Date(response.scheduledEligibleAt).getTime() <= nowMs) return "due";
  }
  return anyPending ? "pending" : null;
}

// Alphabetical by display name, case-insensitive, LOCKED — never reordered
// by acute safety, morning response, session recency, inactivity,
// prescription state, M6 state, or any other clinical signal. The
// patientId tie-break exists only to make the ordering a deterministic
// total order when two patients share a display name.
export function compareRosterEntries(a: { displayName: string; patientId: string }, b: { displayName: string; patientId: string }): number {
  const nameOrder = a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" });
  if (nameOrder !== 0) return nameOrder;
  return a.patientId.localeCompare(b.patientId);
}

export function formatStageLabel(stage: number | null): string {
  return stage === null ? "No current prescription" : `Stage ${stage}`;
}

// "0 sessions in last 14 days" is a valid, factual zero — never omitted or
// hidden. Deliberately never called "adherence"/"compliance"/"consistency"/
// "participation score"/"activity score" anywhere in this codebase.
export function formatRecentActivityLabel(count: number): string {
  return `${count} session${count === 1 ? "" : "s"} in last 14 days`;
}

// lastSessionAt: the qualifying session's authoritative started_at
// timestamp (exercise_outcome IS NOT NULL), or null when no qualifying
// session has EVER occurred — displayed as "No sessions yet", never "No
// recent session" (which would wrongly imply an older qualifying session
// might exist). Today/Yesterday are calendar-day comparisons against `now`,
// both taken in UTC (rehab_sessions.started_at is a UTC instant, and no
// clinician-local timezone concept exists anywhere else in this codebase).
export function formatLastSessionLabel(lastSessionAt: string | null, now: Date): string {
  if (lastSessionAt === null) return "No sessions yet";

  const startOfUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((startOfUtcDay(now) - startOfUtcDay(new Date(lastSessionAt))) / dayMs);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(lastSessionAt));
}
