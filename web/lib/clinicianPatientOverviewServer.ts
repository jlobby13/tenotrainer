import "server-only";

// C2 — Patient Clinical Overview server composition layer. Same contract as
// clinicianServer.ts: assumes authorization has ALREADY happened
// (requireClinicianAuth() + assertSupervises() — see lib/clinicianAuth.ts).
// Nothing here performs its own authorization check.
//
// Deliberately factual/descriptive only — see clinicianPatientOverview.ts's
// header for the locked decisions this composes. HARD BOUNDARY (Section 18
// of the C2 brief): this file must never query m6_longitudinal_interpretations,
// the M6 reason/provenance tables, or any Symptoms/Capacity/Training-Response
// classification — not merely omit them from the response, never read them
// at all. grep for "m6_" or "longitudinal" in this file should find nothing.
//
// Query architecture: one profile lookup, then a parallel batch for
// header-level facts (latest prescription version, active brake status,
// full acute-episode history, latest 5 qualifying sessions), then a second
// parallel batch of child-table reads BATCHED BY the acute-episode-id set
// and the 5 session-ids set — never one query per episode/session. Set-level
// prescribed-vs-actual composition reuses buildPrescribedVsActual() (a
// C2-specific pure helper — see that function's own header for why this is
// not an extraction of capacityExposure.ts/progressServer.ts, both of which
// remain untouched: "Protect M6").

import { createServiceRoleClient } from "./supabase/server";
import { getLatestPrescriptionVersion } from "./prescriptionVersionsServer";
import { getActiveBrakeStatus } from "./acuteSafetyServer";
import { deriveMorningResponseBadge, type RosterMorningResponseStatus } from "./clinicianRoster";
import { buildPrescribedVsActual, type PrescribedVsActualExercise } from "./clinicianPatientOverview";
import type { PrescriptionSnapshotExercise, ExerciseOutcome, Difficulty } from "./rehabSessionTypes";
import type { Irritability } from "./prescriptionVersionTypes";
import type { ToleranceClassification, ImmediateGuidance, StiffnessDuration } from "./morningResponseTypes";
import type { ExternalLoadCategory, ExternalLoadTiming, LoadObservationProvenance } from "./sessionLoadObservations";
import type { ReleasePath } from "./acuteSafetyTypes";

// LOCKED (founder decision) — latest 5 qualifying sessions, fixed count, no
// rolling date window.
const RECENT_SESSION_LIMIT = 5;

export type CurrentPrescriptionFacts = {
  stage: number;
  irritability: Irritability;
  isInsertional: boolean;
  versionCreatedAt: string;
};

export type SessionMorningResponseFacts = {
  submittedAt: string | null;
  scheduledEligibleAt: string | null;
  nextMorningPain: number | null;
  nextMorningStiffness: number | null;
  stiffnessDuration: StiffnessDuration | null;
};

export type SessionToleranceFacts = {
  toleranceClassification: ToleranceClassification;
  immediateGuidance: ImmediateGuidance;
  patientFacingLabel: string;
  reason: string;
};

export type SessionExternalLoadObservation = {
  category: ExternalLoadCategory;
  timing: ExternalLoadTiming | null;
  capturedDuring: LoadObservationProvenance;
};

export type SessionOverviewEntry = {
  rehabSessionId: string;
  patientLocalDate: string;
  startedAt: string;
  exerciseOutcome: ExerciseOutcome;
  earlyEndReason: string | null;
  difficulty: Difficulty | null;
  peakSessionPain: number | null;
  exercises: PrescribedVsActualExercise[];
  // due/pending/null — derived the same way as the C1B roster badge (reuses
  // deriveMorningResponseBadge verbatim), null whenever this session has no
  // outstanding (unsubmitted) morning-response obligation, whether because
  // it was already submitted or because no morning_responses row exists yet
  // (a session that hasn't reached that step of its own response flow).
  morningResponseStatus: RosterMorningResponseStatus;
  // null only when no morning_responses row exists at all for this session
  // yet (response flow not yet reached) — distinct from a row whose fields
  // are individually null (unanswered).
  morningResponse: SessionMorningResponseFacts | null;
  // null when no tolerance_evaluations row exists yet for this session.
  tolerance: SessionToleranceFacts | null;
  externalLoad: SessionExternalLoadObservation[];
  // The acute_safety_episodes.id this session originated, if any — a
  // restrained cross-reference into acuteHistory, never a duplicated
  // rendering of episode detail on the session card itself.
  acuteEpisodeId: string | null;
};

export type AcuteEpisodeReassessmentFacts = {
  evaluatedByProfessional: boolean;
  clearedByProfessional: boolean | null;
  submittedAt: string;
};

export type AcuteEpisodeReleaseFacts = {
  releasePath: ReleasePath;
  releasedAt: string;
};

export type AcuteEpisodeHistoryEntry = {
  episodeId: string;
  confirmedAt: string;
  reportedSuddenOrSharpPain: boolean;
  reportedPopFeltOrHeard: boolean;
  reportedNewFunctionalDifficulty: boolean;
  // Latest submitted reassessment for this episode, if any — never the full
  // history (the collapsed/expanded history entry shows current status, not
  // a reassessment log).
  latestReassessment: AcuteEpisodeReassessmentFacts | null;
  status: "active" | "released";
  release: AcuteEpisodeReleaseFacts | null;
  sourceRehabSessionId: string;
};

export type ClinicianPatientOverview = {
  patientId: string;
  displayName: string;
  acuteReviewActive: boolean;
  // Patient-level outstanding morning-response badge — independent of which
  // of the 5 recent sessions (if any) actually holds the obligation.
  morningResponseStatus: RosterMorningResponseStatus;
  prescription: CurrentPrescriptionFacts | null;
  acuteHistory: AcuteEpisodeHistoryEntry[];
  recentSessions: SessionOverviewEntry[];
};

type EpisodeRow = {
  id: string;
  confirmed_at: string;
  initial_sudden_or_sharp_pain: boolean;
  initial_new_functional_difficulty: boolean;
  initial_pop_felt_or_heard: boolean;
  source_rehab_session_id: string;
};
type ReassessmentRow = {
  acute_safety_episode_id: string;
  evaluated_by_professional: boolean;
  cleared_by_professional: boolean | null;
  submitted_at: string;
};
type ReleaseRow = { acute_safety_episode_id: string; release_path: ReleasePath; released_at: string };
type SessionRow = {
  id: string;
  patient_local_date: string;
  started_at: string;
  exercise_outcome: ExerciseOutcome;
  early_end_reason: string | null;
  difficulty: Difficulty | null;
  peak_session_pain: number | null;
  prescription_snapshot: PrescriptionSnapshotExercise[];
};
type SetOutcomeRow = {
  rehab_session_id: string;
  exercise_id: string;
  set_index: number;
  outcome: "completed" | "skipped";
  prescribed_reps: number | null;
  prescribed_load: number | null;
  actual_reps: number | null;
  actual_load: number | null;
  was_edited: boolean;
};
type MorningResponseRow = {
  rehab_session_id: string;
  scheduled_eligible_at: string | null;
  submitted_at: string | null;
  next_morning_pain: number | null;
  next_morning_stiffness: number | null;
  stiffness_duration: StiffnessDuration | null;
};
type ToleranceRow = {
  rehab_session_id: string;
  tolerance_classification: ToleranceClassification;
  immediate_guidance: ImmediateGuidance;
  patient_facing_label: string;
  reason: string;
};
type LoadObsRow = { rehab_session_id: string; category: ExternalLoadCategory; timing: ExternalLoadTiming | null; captured_during: LoadObservationProvenance };

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const list = map.get(key(row)) ?? [];
    list.push(row);
    map.set(key(row), list);
  }
  return map;
}

export async function getClinicianPatientOverview(patientId: string): Promise<ClinicianPatientOverview | null> {
  const supabase = createServiceRoleClient();

  const { data: profile, error: profileError } = await supabase.from("profiles").select("id, name").eq("id", patientId).maybeSingle();
  if (profileError) throw new Error(`getClinicianPatientOverview failed: ${profileError.message}`);
  if (!profile) return null;

  const [latestVersion, brakeStatus, episodesRes, sessionsRes, awaitingRes] = await Promise.all([
    getLatestPrescriptionVersion(patientId),
    getActiveBrakeStatus(patientId),
    supabase
      .from("acute_safety_episodes")
      .select("id, confirmed_at, initial_sudden_or_sharp_pain, initial_new_functional_difficulty, initial_pop_felt_or_heard, source_rehab_session_id")
      .eq("user_id", patientId)
      .order("confirmed_at", { ascending: false }),
    supabase
      .from("rehab_sessions")
      .select("id, patient_local_date, started_at, exercise_outcome, early_end_reason, difficulty, peak_session_pain, prescription_snapshot")
      .eq("user_id", patientId)
      .not("exercise_outcome", "is", null)
      .order("started_at", { ascending: false })
      .limit(RECENT_SESSION_LIMIT),
    // Patient-level outstanding morning-response badge — reuses the exact
    // same derivation (deriveMorningResponseBadge) as the C1B roster, scoped
    // to this one patient. Not extracted into a shared query helper with
    // clinicianServer.ts's multi-patient batch: that file is already
    // founder-accepted (C1B) and its own query shape (.in over many
    // patients, fetched in parallel with roster facts) differs enough from
    // this single-patient case that factoring them together would touch
    // accepted code for marginal gain — see the C2 audit's "Protect M6"
    // principle applied here to "protect C1B" as well.
    supabase.from("rehab_sessions").select("id").eq("user_id", patientId).eq("status", "awaiting_morning_response"),
  ]);
  if (episodesRes.error) throw new Error(`getClinicianPatientOverview failed: ${episodesRes.error.message}`);
  if (sessionsRes.error) throw new Error(`getClinicianPatientOverview failed: ${sessionsRes.error.message}`);
  if (awaitingRes.error) throw new Error(`getClinicianPatientOverview failed: ${awaitingRes.error.message}`);

  const episodes = (episodesRes.data ?? []) as EpisodeRow[];
  const episodeIds = episodes.map((e) => e.id);
  const sessions = (sessionsRes.data ?? []) as SessionRow[];
  const sessionIds = sessions.map((s) => s.id);
  const awaitingIds = (awaitingRes.data ?? []).map((s) => s.id as string);

  const [reassessmentsRes, releasesRes, setOutcomesRes, morningRes, toleranceRes, loadObsRes, outstandingMorningRes] = await Promise.all([
    episodeIds.length
      ? supabase
          .from("acute_safety_reassessments")
          .select("acute_safety_episode_id, evaluated_by_professional, cleared_by_professional, submitted_at")
          .in("acute_safety_episode_id", episodeIds)
          .order("submitted_at", { ascending: true })
      : Promise.resolve({ data: [] as ReassessmentRow[], error: null }),
    episodeIds.length
      ? supabase.from("acute_safety_releases").select("acute_safety_episode_id, release_path, released_at").in("acute_safety_episode_id", episodeIds)
      : Promise.resolve({ data: [] as ReleaseRow[], error: null }),
    sessionIds.length
      ? supabase
          .from("set_outcomes")
          .select("rehab_session_id, exercise_id, set_index, outcome, prescribed_reps, prescribed_load, actual_reps, actual_load, was_edited")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as SetOutcomeRow[], error: null }),
    sessionIds.length
      ? supabase
          .from("morning_responses")
          .select("rehab_session_id, scheduled_eligible_at, submitted_at, next_morning_pain, next_morning_stiffness, stiffness_duration")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as MorningResponseRow[], error: null }),
    sessionIds.length
      ? supabase
          .from("tolerance_evaluations")
          .select("rehab_session_id, tolerance_classification, immediate_guidance, patient_facing_label, reason")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as ToleranceRow[], error: null }),
    sessionIds.length
      ? supabase.from("session_load_observations").select("rehab_session_id, category, timing, captured_during").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as LoadObsRow[], error: null }),
    awaitingIds.length
      ? supabase.from("morning_responses").select("rehab_session_id, scheduled_eligible_at, submitted_at").in("rehab_session_id", awaitingIds)
      : Promise.resolve({ data: [] as { rehab_session_id: string; scheduled_eligible_at: string | null; submitted_at: string | null }[], error: null }),
  ]);
  if (reassessmentsRes.error) throw new Error(`getClinicianPatientOverview failed: ${reassessmentsRes.error.message}`);
  if (releasesRes.error) throw new Error(`getClinicianPatientOverview failed: ${releasesRes.error.message}`);
  if (setOutcomesRes.error) throw new Error(`getClinicianPatientOverview failed: ${setOutcomesRes.error.message}`);
  if (morningRes.error) throw new Error(`getClinicianPatientOverview failed: ${morningRes.error.message}`);
  if (toleranceRes.error) throw new Error(`getClinicianPatientOverview failed: ${toleranceRes.error.message}`);
  if (loadObsRes.error) throw new Error(`getClinicianPatientOverview failed: ${loadObsRes.error.message}`);
  if (outstandingMorningRes.error) throw new Error(`getClinicianPatientOverview failed: ${outstandingMorningRes.error.message}`);

  const setOutcomesBySession = groupBy((setOutcomesRes.data ?? []) as SetOutcomeRow[], (r) => r.rehab_session_id);
  const morningBySession = new Map(((morningRes.data ?? []) as MorningResponseRow[]).map((r) => [r.rehab_session_id, r]));
  const toleranceBySession = new Map(((toleranceRes.data ?? []) as ToleranceRow[]).map((r) => [r.rehab_session_id, r]));
  const loadObsBySession = groupBy((loadObsRes.data ?? []) as LoadObsRow[], (r) => r.rehab_session_id);
  const episodeIdBySourceSession = new Map(episodes.map((e) => [e.source_rehab_session_id, e.id]));

  const now = new Date();
  const recentSessions: SessionOverviewEntry[] = sessions.map((s): SessionOverviewEntry => {
    const morningRow = morningBySession.get(s.id) ?? null;
    const toleranceRow = toleranceBySession.get(s.id) ?? null;
    const morningResponseStatus =
      morningRow && morningRow.submitted_at === null
        ? deriveMorningResponseBadge([{ scheduledEligibleAt: morningRow.scheduled_eligible_at }], now)
        : null;

    return {
      rehabSessionId: s.id,
      patientLocalDate: s.patient_local_date,
      startedAt: s.started_at,
      exerciseOutcome: s.exercise_outcome,
      earlyEndReason: s.early_end_reason,
      difficulty: s.difficulty,
      peakSessionPain: s.peak_session_pain,
      exercises: buildPrescribedVsActual(s.prescription_snapshot ?? [], setOutcomesBySession.get(s.id) ?? []),
      morningResponseStatus,
      morningResponse: morningRow
        ? {
            submittedAt: morningRow.submitted_at,
            scheduledEligibleAt: morningRow.scheduled_eligible_at,
            nextMorningPain: morningRow.next_morning_pain,
            nextMorningStiffness: morningRow.next_morning_stiffness,
            stiffnessDuration: morningRow.stiffness_duration,
          }
        : null,
      tolerance: toleranceRow
        ? {
            toleranceClassification: toleranceRow.tolerance_classification,
            immediateGuidance: toleranceRow.immediate_guidance,
            patientFacingLabel: toleranceRow.patient_facing_label,
            reason: toleranceRow.reason,
          }
        : null,
      externalLoad: (loadObsBySession.get(s.id) ?? []).map((r) => ({ category: r.category, timing: r.timing, capturedDuring: r.captured_during })),
      acuteEpisodeId: episodeIdBySourceSession.get(s.id) ?? null,
    };
  });

  const reassessmentsByEpisode = groupBy((reassessmentsRes.data ?? []) as ReassessmentRow[], (r) => r.acute_safety_episode_id);
  const releaseByEpisode = new Map(((releasesRes.data ?? []) as ReleaseRow[]).map((r) => [r.acute_safety_episode_id, r]));

  const acuteHistory: AcuteEpisodeHistoryEntry[] = episodes.map((e): AcuteEpisodeHistoryEntry => {
    // Ascending order (queried that way above) — the last element is the
    // most recently submitted reassessment.
    const reassessments = reassessmentsByEpisode.get(e.id) ?? [];
    const latest = reassessments.length > 0 ? reassessments[reassessments.length - 1] : null;
    const release = releaseByEpisode.get(e.id) ?? null;
    return {
      episodeId: e.id,
      confirmedAt: e.confirmed_at,
      reportedSuddenOrSharpPain: e.initial_sudden_or_sharp_pain,
      reportedPopFeltOrHeard: e.initial_pop_felt_or_heard,
      reportedNewFunctionalDifficulty: e.initial_new_functional_difficulty,
      latestReassessment: latest
        ? { evaluatedByProfessional: latest.evaluated_by_professional, clearedByProfessional: latest.cleared_by_professional, submittedAt: latest.submitted_at }
        : null,
      status: release ? "released" : "active",
      release: release ? { releasePath: release.release_path, releasedAt: release.released_at } : null,
      sourceRehabSessionId: e.source_rehab_session_id,
    };
  });

  const outstandingMorningBySession = new Map(
    (outstandingMorningRes.data ?? []).map((r) => [r.rehab_session_id as string, r as { scheduled_eligible_at: string | null; submitted_at: string | null }])
  );
  const outstanding: { scheduledEligibleAt: string | null }[] = [];
  for (const id of awaitingIds) {
    const row = outstandingMorningBySession.get(id);
    if (row && row.submitted_at !== null) continue;
    outstanding.push({ scheduledEligibleAt: row?.scheduled_eligible_at ?? null });
  }

  return {
    patientId: profile.id as string,
    displayName: profile.name as string,
    acuteReviewActive: brakeStatus != null,
    morningResponseStatus: deriveMorningResponseBadge(outstanding, now),
    prescription: latestVersion
      ? { stage: latestVersion.stage, irritability: latestVersion.irritability, isInsertional: latestVersion.isInsertional, versionCreatedAt: latestVersion.createdAt }
      : null,
    acuteHistory,
    recentSessions,
  };
}
