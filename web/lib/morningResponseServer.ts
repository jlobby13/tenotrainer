import "server-only";

// Milestone 4, Stage 1 — server-only data access for the Morning Response
// obligation lifecycle. Single shared creation/reconciliation function used
// by BOTH call sites (M3 finalize's eager creation for new sessions, and the
// outstanding-response query's lazy backfill for pre-M4 sessions) — see the
// Stage 1 plan for why one function serves both rather than two.

import { createServiceRoleClient } from "./supabase/server";
import { getScheduledMorningEligibility, isValidIanaTimezone, DEFAULT_MORNING_REMINDER_TIME } from "./morningEligibility";
import { mapMorningResponseRow, type MorningResponseRecord } from "./morningResponseTypes";

async function getPatientTimingPreferences(
  userId: string
): Promise<{ timezone: string | null; reminderTime: string }> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("profiles")
    .select("timezone, morning_reminder_time")
    .eq("id", userId)
    .maybeSingle();
  return {
    timezone: (data?.timezone as string | null) ?? null,
    reminderTime: (data?.morning_reminder_time as string | undefined) ?? DEFAULT_MORNING_REMINDER_TIME,
  };
}

// Computes scheduled_eligible_at from the timing preferences currently on
// file, or returns null if the timezone isn't known yet. UNKNOWN TIMEZONE !=
// UTC TIMEZONE — this never substitutes a default zone.
async function computeScheduledEligibleAtOrNull(
  userId: string,
  patientLocalDate: string
): Promise<string | null> {
  const { timezone, reminderTime } = await getPatientTimingPreferences(userId);
  if (!timezone || !isValidIanaTimezone(timezone)) return null;
  return getScheduledMorningEligibility(patientLocalDate, timezone, reminderTime).toISOString();
}

// Idempotent get-or-create for a rehab session's morning-response obligation,
// with opportunistic reconciliation of a still-unknown scheduled_eligible_at.
//
// Lifecycle:
//   - New sessions: called once, immediately, when M3's finalize route sets
//     rehab_sessions.status = 'awaiting_morning_response'. If the patient's
//     timezone is already known at that moment, scheduled_eligible_at is
//     computed and FROZEN right then, using whatever reminder preference was
//     in effect — a later preference change can never retroactively alter it.
//   - Pre-M4 sessions (already awaiting_morning_response with no row at all):
//     backfilled lazily, the first time this function is called for them
//     (via getOldestOutstandingMorningResponse). These sessions never had a
//     frozen historical reminder/timezone snapshot — none is fabricated;
//     the row is created honestly with whatever is known NOW.
//   - Reconciliation: if a row already exists but scheduled_eligible_at is
//     still null (timezone wasn't known at creation time, of either kind
//     above), this function re-checks the current timezone on every call and
//     sets it exactly once — the UPDATE is conditioned on
//     scheduled_eligible_at still being null, so it can only happen once per
//     row and never overwrites a value that's already there.
export async function ensureMorningResponseExists(rehabSessionId: string): Promise<MorningResponseRecord> {
  const supabase = createServiceRoleClient();

  const { data: existing, error: existingError } = await supabase
    .from("morning_responses")
    .select()
    .eq("rehab_session_id", rehabSessionId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`ensureMorningResponseExists: lookup failed: ${existingError.message}`);
  }

  let row = existing as Record<string, unknown> | null;

  if (!row) {
    const { data: session, error: sessionError } = await supabase
      .from("rehab_sessions")
      .select("id, user_id, patient_local_date")
      .eq("id", rehabSessionId)
      .maybeSingle();
    if (sessionError || !session) {
      throw new Error(`ensureMorningResponseExists: rehab_session ${rehabSessionId} not found`);
    }

    const scheduledEligibleAt = await computeScheduledEligibleAtOrNull(
      session.user_id as string,
      session.patient_local_date as string
    );

    const { data: inserted, error: insertError } = await supabase
      .from("morning_responses")
      .insert({
        rehab_session_id: rehabSessionId,
        user_id: session.user_id,
        scheduled_eligible_at: scheduledEligibleAt,
      })
      .select()
      .maybeSingle();

    if (insertError) {
      // Unique-violation race: a concurrent call (e.g. two near-simultaneous
      // requests) created the row between our SELECT and INSERT.
      // Idempotent-safe — fetch whichever row won.
      if (insertError.code === "23505") {
        const { data: raced, error: racedError } = await supabase
          .from("morning_responses")
          .select()
          .eq("rehab_session_id", rehabSessionId)
          .maybeSingle();
        if (racedError || !raced) {
          throw new Error(`ensureMorningResponseExists: race on ${rehabSessionId} but row not recoverable`);
        }
        row = raced;
      } else {
        throw new Error(`ensureMorningResponseExists: insert failed: ${insertError.message}`);
      }
    } else {
      row = inserted;
    }
  }

  if (!row) {
    throw new Error(`ensureMorningResponseExists: unable to establish a row for ${rehabSessionId}`);
  }

  if (row.scheduled_eligible_at === null) {
    const { data: session } = await supabase
      .from("rehab_sessions")
      .select("patient_local_date")
      .eq("id", row.rehab_session_id as string)
      .maybeSingle();
    if (session) {
      const computed = await computeScheduledEligibleAtOrNull(
        row.user_id as string,
        session.patient_local_date as string
      );
      if (computed !== null) {
        const { data: reconciled } = await supabase
          .from("morning_responses")
          .update({ scheduled_eligible_at: computed })
          .eq("id", row.id as string)
          .is("scheduled_eligible_at", null)
          .select()
          .maybeSingle();
        if (reconciled) row = reconciled;
      }
    }
  }

  // row is guaranteed non-null here (the throw above already enforced it) —
  // TS can't carry that narrowing through the reassignments above.
  return mapMorningResponseRow(row!);
}

// Oldest-outstanding-first, per the M4 architecture audit's explicit
// direction: never silently hide an older unresolved obligation behind a
// newer one. Ensures every currently-awaiting rehab session has a
// morning_responses row (covering both brand-new and pre-M4 sessions) before
// selecting among them.
export async function getOldestOutstandingMorningResponse(userId: string): Promise<MorningResponseRecord | null> {
  const supabase = createServiceRoleClient();

  const { data: awaitingSessions, error } = await supabase
    .from("rehab_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "awaiting_morning_response");
  if (error) throw new Error(`getOldestOutstandingMorningResponse: ${error.message}`);
  if (!awaitingSessions || awaitingSessions.length === 0) return null;

  const rows = await Promise.all(awaitingSessions.map((s) => ensureMorningResponseExists(s.id as string)));

  const outstanding = rows.filter((r) => r.submittedAt === null);
  if (outstanding.length === 0) return null;

  // A still-unknown scheduled_eligible_at sorts LAST, not first — not
  // knowing when something is due is not the same as it being the most
  // overdue. In practice this is rare (reconciliation above already tries to
  // resolve it on every call) but must not be silently treated as "oldest."
  outstanding.sort((a, b) => {
    if (a.scheduledEligibleAt === null && b.scheduledEligibleAt === null) return 0;
    if (a.scheduledEligibleAt === null) return 1;
    if (b.scheduledEligibleAt === null) return -1;
    return new Date(a.scheduledEligibleAt).getTime() - new Date(b.scheduledEligibleAt).getTime();
  });

  return outstanding[0];
}
