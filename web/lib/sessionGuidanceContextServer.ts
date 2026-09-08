import "server-only";

// Milestone 5, Stage 3 — server-only READ access to persisted session-
// guidance handoff context. Narrowly scoped per the Stage 3 brief (Section
// 12): this is for future clinician-facing inspection, not for Stage 2's
// Today's Rehab feedback (which continues to derive its own current-state
// view directly from Stage 1 facts via web/lib/guidanceServer.ts, entirely
// independently of this table — see todaysRehabFeedbackServer.ts, unchanged
// by Stage 3).
//
// All WRITES happen exclusively via the capture_session_guidance_context()
// Postgres function (SECURITY DEFINER, called from within
// create_rehab_session_if_allowed()) — nothing in this module ever inserts,
// updates, or deletes a row.

import { createServiceRoleClient } from "./supabase/server";
import { mapSessionGuidanceContextRow, type SessionGuidanceContextRecord } from "./sessionGuidanceContextTypes";

// Returns the immutable handoff context captured when the given session
// began, or null if none exists. Absence is not itself informative on its
// own — see the migration's Section 17 note: it can mean "no prior
// evaluation existed yet" (a genuinely new patient) OR "this session
// predates Stage 3 activation" (captured under an earlier architecture that
// didn't record this fact). This function does not attempt to distinguish
// those two cases — a caller needing to distinguish them would compare
// the session's created_at against Stage 3's activation migration.
export async function getSessionGuidanceContext(rehabSessionId: string): Promise<SessionGuidanceContextRecord | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("session_guidance_contexts")
    .select()
    .eq("rehab_session_id", rehabSessionId)
    .maybeSingle();
  if (error) throw new Error(`getSessionGuidanceContext: ${error.message}`);
  return data ? mapSessionGuidanceContextRow(data) : null;
}
