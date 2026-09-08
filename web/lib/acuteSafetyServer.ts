import "server-only";

// Acute Safety Gate + Resolution Lifecycle — server-only data access. All
// writes to acute_safety_episodes/acute_safety_reassessments/
// acute_safety_releases go through this module via the service-role
// client, matching escalation_evaluations' existing trust tier (never a
// direct authenticated table grant for these). Reads use the same
// service-role client for server components/routes; the RPC
// get_patient_acute_brake_status() is also used directly by
// create_rehab_session_if_allowed() as `authenticated` inside the gate —
// see that migration.

import { createServiceRoleClient } from "./supabase/server";
import {
  computeRecurrenceWindow,
  evaluateReleaseEligibility,
  type PriorEpisodeForWindow,
  type ReassessmentAnswers,
} from "./acuteSafety";
import {
  mapAcuteSafetyEpisodeRow,
  mapAcuteSafetyReassessmentRow,
  mapAcuteSafetyReleaseRow,
  type AcuteBrakeStatus,
  type AcuteSafetyEpisodeRecord,
  type AcuteSafetyReassessmentRecord,
  type AcuteSafetyReleaseRecord,
  type Level4Reason,
} from "./acuteSafetyTypes";

export async function getActiveBrakeStatus(userId: string): Promise<AcuteBrakeStatus> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc("get_patient_acute_brake_status", { p_user_id: userId });
  if (error) throw new Error(`getActiveBrakeStatus: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) return null;
  return {
    episodeId: row.episode_id,
    initialLevel: row.initial_level,
    confirmedAt: row.confirmed_at,
    effectiveLevel: row.effective_level,
    level4Reasons: (row.level4_reasons ?? []) as Level4Reason[],
    blockedOpportunityCount: Number(row.blocked_opportunity_count ?? 0),
  };
}

// Called from the M3 response finalize route the instant
// evaluateEscalation() returns level 3 or 5 for a session — the ONE write
// path for new acute_safety_episodes rows. Computes the anchored
// recurrence-window fields via the pure computeRecurrenceWindow() against
// every prior confirmed episode for this patient (ascending order), then
// inserts. Never invoked for a reassessment — reassessments never create a
// new episode (Section 4).
export async function confirmAcuteSafetyEpisode(params: {
  userId: string;
  sourceRehabSessionId: string;
  sourceEscalationEvaluationId: string;
  initialLevel: 3 | 5;
  initialSuddenOrSharpPain: boolean;
  initialNewFunctionalDifficulty: boolean;
  initialPopFeltOrHeard: boolean;
  confirmedAt: string;
}): Promise<AcuteSafetyEpisodeRecord> {
  const supabase = createServiceRoleClient();

  const { data: priorRows, error: priorError } = await supabase
    .from("acute_safety_episodes")
    .select("id, confirmed_at, recurrence_window_anchor_id, recurrence_sequence_in_window")
    .eq("user_id", params.userId)
    .order("confirmed_at", { ascending: true });
  if (priorError) throw new Error(`confirmAcuteSafetyEpisode: ${priorError.message}`);

  const priorEpisodes: PriorEpisodeForWindow[] = (priorRows ?? []).map((r) => ({
    id: r.id as string,
    confirmedAt: r.confirmed_at as string,
    recurrenceWindowAnchorId: (r.recurrence_window_anchor_id as string | null) ?? null,
    recurrenceSequenceInWindow: r.recurrence_sequence_in_window as number,
  }));

  const window = computeRecurrenceWindow(priorEpisodes, params.confirmedAt);

  const { data, error } = await supabase
    .from("acute_safety_episodes")
    .insert({
      user_id: params.userId,
      source_rehab_session_id: params.sourceRehabSessionId,
      source_escalation_evaluation_id: params.sourceEscalationEvaluationId,
      initial_level: params.initialLevel,
      initial_sudden_or_sharp_pain: params.initialSuddenOrSharpPain,
      initial_new_functional_difficulty: params.initialNewFunctionalDifficulty,
      initial_pop_felt_or_heard: params.initialPopFeltOrHeard,
      recurrence_window_anchor_id: window.anchorId,
      recurrence_sequence_in_window: window.sequenceInWindow,
      level4_recurrent: window.level4Recurrent,
      confirmed_at: params.confirmedAt,
    })
    .select()
    .maybeSingle();
  if (error || !data) throw new Error(`confirmAcuteSafetyEpisode insert failed: ${error?.message ?? "no row returned"}`);
  return mapAcuteSafetyEpisodeRow(data);
}

export async function getEpisode(episodeId: string): Promise<AcuteSafetyEpisodeRecord | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("acute_safety_episodes").select().eq("id", episodeId).maybeSingle();
  if (error) throw new Error(`getEpisode: ${error.message}`);
  return data ? mapAcuteSafetyEpisodeRow(data) : null;
}

export async function getReassessmentHistory(episodeId: string): Promise<AcuteSafetyReassessmentRecord[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("acute_safety_reassessments")
    .select()
    .eq("acute_safety_episode_id", episodeId)
    .order("submitted_at", { ascending: true });
  if (error) throw new Error(`getReassessmentHistory: ${error.message}`);
  return (data ?? []).map(mapAcuteSafetyReassessmentRow);
}

// The single server-controlled entry point for a patient's reassessment
// submission: inserts the reassessment, then evaluates release eligibility
// against the FULL history (never just the newest answer in isolation for
// the professional-hold determination — see hasEverBeenProfessionallyHeld),
// and — only if eligible — inserts the release row. Both writes happen via
// service-role in this one call; nothing here is reachable from a raw
// authenticated table grant (see the migration).
export async function submitReassessmentAndMaybeRelease(params: {
  userId: string;
  episodeId: string;
  answers: ReassessmentAnswers;
}): Promise<{ reassessment: AcuteSafetyReassessmentRecord; release: AcuteSafetyReleaseRecord | null }> {
  const supabase = createServiceRoleClient();

  const episode = await getEpisode(params.episodeId);
  if (!episode || episode.userId !== params.userId) {
    throw new Error("REHAB_SESSION_NOT_FOUND");
  }

  const { data: reassessmentRow, error: insertError } = await supabase
    .from("acute_safety_reassessments")
    .insert({
      acute_safety_episode_id: params.episodeId,
      user_id: params.userId,
      sudden_or_sharp_pain_resolved: params.answers.suddenOrSharpPainResolved,
      new_functional_difficulty_resolved: params.answers.newFunctionalDifficultyResolved,
      evaluated_by_professional: params.answers.evaluatedByProfessional,
      cleared_by_professional: params.answers.clearedByProfessional,
    })
    .select()
    .maybeSingle();
  if (insertError || !reassessmentRow) throw new Error(`submitReassessmentAndMaybeRelease insert failed: ${insertError?.message ?? "no row"}`);
  const reassessment = mapAcuteSafetyReassessmentRow(reassessmentRow);

  // Already released? Idempotent no-op — never re-evaluate or duplicate a
  // release for an episode that already has one.
  const { data: existingRelease } = await supabase.from("acute_safety_releases").select().eq("acute_safety_episode_id", params.episodeId).maybeSingle();
  if (existingRelease) {
    return { reassessment, release: mapAcuteSafetyReleaseRow(existingRelease) };
  }

  const history = await getReassessmentHistory(params.episodeId);
  const hasEverBeenProfessionallyHeld = history.some((r) => r.evaluatedByProfessional === true && r.clearedByProfessional === false);

  const brakeStatus = await getActiveBrakeStatus(params.userId);
  const effectiveLevel = brakeStatus?.episodeId === params.episodeId ? brakeStatus.effectiveLevel : episode.initialLevel === 5 ? 5 : 3;

  const { count: newerVersionCount } = await supabase
    .from("prescription_versions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", params.userId)
    .gt("created_at", episode.confirmedAt);
  const newerPrescriptionVersionExists = (newerVersionCount ?? 0) > 0;

  const eligibility = evaluateReleaseEligibility({
    episode: {
      initialLevel: episode.initialLevel,
      initialSuddenOrSharpPain: episode.initialSuddenOrSharpPain,
      initialNewFunctionalDifficulty: episode.initialNewFunctionalDifficulty,
      effectiveLevel,
    },
    latestReassessment: params.answers,
    hasEverBeenProfessionallyHeld,
    newerPrescriptionVersionExists,
  });

  if (!eligibility.eligible) {
    return { reassessment, release: null };
  }

  let sourcePrescriptionVersionId: string | null = null;
  if (eligibility.releasePath === "professional_clearance_with_prescription") {
    const { data: latestVersion } = await supabase
      .from("prescription_versions")
      .select("id")
      .eq("user_id", params.userId)
      .gt("created_at", episode.confirmedAt)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    sourcePrescriptionVersionId = (latestVersion?.id as string | undefined) ?? null;
  }

  const { data: releaseRow, error: releaseError } = await supabase
    .from("acute_safety_releases")
    .insert({
      acute_safety_episode_id: params.episodeId,
      user_id: params.userId,
      release_path: eligibility.releasePath,
      source_reassessment_id: reassessment.id,
      source_prescription_version_id: sourcePrescriptionVersionId,
    })
    .select()
    .maybeSingle();
  if (releaseError) {
    // Unique-violation race: a concurrent submission already released this
    // episode — idempotent-safe, fetch the winner.
    if (releaseError.code === "23505") {
      const { data: raced } = await supabase.from("acute_safety_releases").select().eq("acute_safety_episode_id", params.episodeId).maybeSingle();
      return { reassessment, release: raced ? mapAcuteSafetyReleaseRow(raced) : null };
    }
    throw new Error(`submitReassessmentAndMaybeRelease release insert failed: ${releaseError.message}`);
  }

  return { reassessment, release: releaseRow ? mapAcuteSafetyReleaseRow(releaseRow) : null };
}
