import "server-only";

// Milestone 5, Stage 2 — server-only data access for Today's Rehab
// feedback. Thin: fetches the three independent facts the pure
// computeTodaysRehabFeedback() needs and hands them off unmodified. This is
// the "narrowly-scoped server helper/view model above the raw Stage 1
// facts" the Stage 2 brief explicitly allows — it does not change or
// duplicate anything in guidance.ts/guidanceServer.ts.

import { createServiceRoleClient } from "./supabase/server";
import { getRelevantGuidanceForPatient } from "./guidanceServer";
import { getOldestOutstandingMorningResponse } from "./morningResponseServer";
import { computeTodaysRehabFeedback, type TodaysRehabFeedback } from "./todaysRehabFeedback";

export async function getTodaysRehabFeedback(userId: string): Promise<TodaysRehabFeedback> {
  // The M4 Stage 3 gate is authoritative (Section 7) — checked first and
  // independently of whether a guidance fact even exists, so an outstanding
  // obligation always wins regardless of prior evaluation history.
  const outstanding = await getOldestOutstandingMorningResponse(userId);

  const guidance = await getRelevantGuidanceForPatient(userId);

  let escalationLevel: number | null = null;
  if (guidance?.evaluation.toleranceClassification === "acute_override") {
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("rehab_sessions")
      .select("current_escalation_level")
      .eq("id", guidance.evaluation.rehabSessionId)
      .maybeSingle();
    escalationLevel = (data?.current_escalation_level as number | null) ?? null;
  }

  return computeTodaysRehabFeedback({
    guidance,
    escalationLevel,
    hasOutstandingMorningResponse: outstanding !== null,
  });
}
