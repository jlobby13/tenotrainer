import "server-only";

// Milestone 5, Stage 4 — server-only data access for the rehab-day
// scheduling eligibility primitive (see web/lib/rehabSchedule.ts for the
// pure derivation and its LOCKED unknown-vs-guessed distinction).
//
// getTodaysRehabDayEligibility() is the read-only counterpart to the
// authoritative check inside create_rehab_session_if_allowed() — used by
// the dashboard to decide whether to show the normal Start Rehab CTA. It
// is NOT itself an enforcement point (the RPC is); this only controls
// display, matching the existing acute-brake/morning-response-pending
// precedent (see todaysRehabFeedbackServer.ts).

import { toZonedTime } from "date-fns-tz";
import { format } from "date-fns";
import { createServiceRoleClient } from "./supabase/server";
import { isValidIanaTimezone } from "./morningEligibility";
import { deriveRehabDayEligibility, type RehabDayEligibility } from "./rehabSchedule";

// Same UNKNOWN-TIMEZONE-!=-UTC principle as morningResponseServer.ts's
// computeScheduledEligibleAtOrNull: an unresolved timezone means "today's
// patient-local date" is itself unknown, which must make eligibility
// unknown too — never silently assume UTC or the server's own clock.
function todaysLocalDateInTimezone(timezone: string, now: Date): string {
  return format(toZonedTime(now, timezone), "yyyy-MM-dd");
}

export async function getTodaysRehabDayEligibility(userId: string): Promise<RehabDayEligibility> {
  const supabase = createServiceRoleClient();

  const { data: profile } = await supabase.from("profiles").select("timezone").eq("id", userId).maybeSingle();
  const timezone = (profile?.timezone as string | null) ?? null;
  if (!timezone || !isValidIanaTimezone(timezone)) return "unknown";

  const { data: version } = await supabase
    .from("prescription_versions")
    .select("rehab_days_of_week")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!version) return "unknown"; // no prescription at all — nothing to derive from

  const rehabDaysOfWeek = (version.rehab_days_of_week as number[] | null) ?? null;
  const patientLocalDate = todaysLocalDateInTimezone(timezone, new Date());

  return deriveRehabDayEligibility(rehabDaysOfWeek, patientLocalDate);
}
