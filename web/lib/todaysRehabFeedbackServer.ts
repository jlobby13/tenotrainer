import "server-only";

// Milestone 5, Stage 2 — server-only data access for Today's Rehab
// feedback. Thin: fetches the three independent facts the pure
// computeTodaysRehabFeedback() needs and hands them off unmodified. This is
// the "narrowly-scoped server helper/view model above the raw Stage 1
// facts" the Stage 2 brief explicitly allows — it does not change or
// duplicate anything in guidance.ts/guidanceServer.ts.
//
// Acute Safety Gate milestone: getTodaysRehabFeedback() now checks the
// acute brake FIRST (Section 14 precedence — active Level 3/4/5 brake
// supersedes everything else) and, failing that, whether the CURRENT
// session is a just-released cautious-return moment with no evaluation of
// its own yet. Neither check touches computeTodaysRehabFeedback() or its
// inputs — Stage 2's own logic and tests are completely unaffected when no
// brake is active and no cautious-return context applies (the overwhelming
// common case).

import { createServiceRoleClient } from "./supabase/server";
import { getRelevantGuidanceForPatient } from "./guidanceServer";
import { getOldestOutstandingMorningResponse } from "./morningResponseServer";
import { getActiveBrakeStatus } from "./acuteSafetyServer";
import { describeActiveBrake, CAUTIOUS_RETURN_GUIDANCE, type ReassessmentAnswers } from "./acuteSafety";
import { computeTodaysRehabFeedback } from "./todaysRehabFeedback";
import type { DashboardFeedback } from "./dashboardFeedback";

export async function getTodaysRehabFeedback(userId: string): Promise<DashboardFeedback> {
  const supabase = createServiceRoleClient();

  // 1. Active acute brake — absolute top precedence (Section 14). Never
  // even reaches guidance derivation when active.
  const brake = await getActiveBrakeStatus(userId);
  if (brake) {
    const { data: reassessments } = await supabase
      .from("acute_safety_reassessments")
      .select("sudden_or_sharp_pain_resolved, new_functional_difficulty_resolved, evaluated_by_professional, cleared_by_professional")
      .eq("acute_safety_episode_id", brake.episodeId)
      .order("submitted_at", { ascending: true });
    const history = reassessments ?? [];
    const hasEverBeenProfessionallyHeld = history.some((r) => r.evaluated_by_professional === true && r.cleared_by_professional === false);
    const latest = history.length > 0 ? history[history.length - 1] : null;
    const latestAnswers: ReassessmentAnswers | null = latest
      ? {
          suddenOrSharpPainResolved: (latest.sudden_or_sharp_pain_resolved as boolean | null) ?? null,
          newFunctionalDifficultyResolved: (latest.new_functional_difficulty_resolved as boolean | null) ?? null,
          evaluatedByProfessional: latest.evaluated_by_professional as boolean,
          clearedByProfessional: (latest.cleared_by_professional as boolean | null) ?? null,
        }
      : null;
    const { data: episodeRow } = await supabase
      .from("acute_safety_episodes")
      .select("initial_sudden_or_sharp_pain, initial_new_functional_difficulty")
      .eq("id", brake.episodeId)
      .maybeSingle();
    const symptomsStillPresent =
      (episodeRow?.initial_sudden_or_sharp_pain && latestAnswers?.suddenOrSharpPainResolved !== true) ||
      (episodeRow?.initial_new_functional_difficulty && latestAnswers?.newFunctionalDifficultyResolved !== true) ||
      !latestAnswers;

    return {
      kind: "acute_brake",
      display: describeActiveBrake({
        effectiveLevel: brake.effectiveLevel,
        hasEverBeenProfessionallyHeld,
        latestReassessment: latestAnswers,
        symptomsStillPresent: Boolean(symptomsStillPresent),
      }),
    };
  }

  // 2. Cautious return — the most recent rehab session has a
  // cautious_return_contexts row AND has no evaluation of its own yet
  // (once it does, that newer evidence takes precedence — Section 7 — and
  // this falls through to ordinary Stage 2 feedback below).
  const { data: latestSession } = await supabase
    .from("rehab_sessions")
    .select("id")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestSession) {
    const { data: cautiousContext } = await supabase
      .from("cautious_return_contexts")
      .select("id")
      .eq("rehab_session_id", latestSession.id)
      .maybeSingle();
    if (cautiousContext) {
      const { count: evalCount } = await supabase
        .from("tolerance_evaluations")
        .select("id", { count: "exact", head: true })
        .eq("rehab_session_id", latestSession.id);
      if ((evalCount ?? 0) === 0) {
        return { kind: "cautious_return", title: CAUTIOUS_RETURN_GUIDANCE.title, body: CAUTIOUS_RETURN_GUIDANCE.body };
      }
    }
  }

  // 3. Ordinary Stage 2 feedback — completely unchanged.
  const outstanding = await getOldestOutstandingMorningResponse(userId);
  const guidance = await getRelevantGuidanceForPatient(userId);

  let escalationLevel: number | null = null;
  if (guidance?.evaluation.toleranceClassification === "acute_override") {
    const { data } = await supabase
      .from("rehab_sessions")
      .select("current_escalation_level")
      .eq("id", guidance.evaluation.rehabSessionId)
      .maybeSingle();
    escalationLevel = (data?.current_escalation_level as number | null) ?? null;
  }

  const feedback = computeTodaysRehabFeedback({
    guidance,
    escalationLevel,
    hasOutstandingMorningResponse: outstanding !== null,
  });
  return { kind: "stage2", feedback };
}
