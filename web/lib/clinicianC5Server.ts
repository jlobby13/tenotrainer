import "server-only";

// M1 — clinician C5 review read model. Server-only.
//
// AUTHORIZATION: every export takes a patientId that the CALLER has already
// authorized (requireClinicianAuth + assertSupervises, the roster's own
// active-relationship query, or — for the patient's own Progress page —
// the authenticated patient's own session identity). Reads use the service-role client scoped to
// that patient id; a session id is always matched together with the
// patient id, never trusted alone.
//
// SOURCE OF TRUTH: reads the authoritative C5 tables directly and stores
// nothing. Derived state (weekly progress, eligibility, effective safety
// level / professional-review requirement) comes from the existing
// database functions — never re-derived here. Fixed query counts per page,
// batched with .in(...), no per-session round trips.

import { createServiceRoleClient } from "./supabase/server";
import { mapSnapshot, readC5TrainingStateForClinician } from "./c5RuntimeServer";
import { outcomeValue, unitCount, unitEntry, type C5Snapshot, type C5TrainingState, type C5TrainingStatus } from "./c5RuntimeTypes";
import type { C5StiffnessDuration } from "./c5ResponseTypes";
import {
  daysBetween,
  episodeProcessState,
  localDateOf,
  scoreFact,
  type C5EscalationFact,
  type C5ExerciseFact,
  type C5ImmediateFact,
  type C5RecoveryDecisionFact,
  type C5SafetyEpisode,
  type C5SessionDetail,
  type C5SessionSummary,
  type C5UnitEdit,
  type C5UnitFact,
  type MorningFact,
} from "./clinicianC5";

type Admin = ReturnType<typeof createServiceRoleClient>;
type Row = Record<string, unknown>;

const SESSION_COLUMNS =
  "id, patient_local_date, patient_timezone, started_at, training_closed_at, training_status, prescription_snapshot, prescription_version_id, calendar_scheduled_date, sequence_choice, resolves_stopped_session_id";

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function workoutTitle(snapshot: C5Snapshot | null): string {
  if (!snapshot) return "Workout";
  const label = snapshot.workout.label?.trim();
  if (!label) return `Workout ${String.fromCharCode(65 + snapshot.workout.orderIndex)}`;
  return label.length <= 2 ? `Workout ${label}` : label;
}

// ---------------------------------------------------------------------------
// Is this a C5 patient? (a C5 program or any C5 session — independent of
// the patient runtime gate, which only governs the PATIENT experience).
// ---------------------------------------------------------------------------
export async function isC5Patient(patientId: string): Promise<boolean> {
  const admin = createServiceRoleClient();
  const [{ data: pp }, { data: session }] = await Promise.all([
    admin.from("patient_prescriptions").select("current_prescription_version_id").eq("patient_id", patientId).maybeSingle(),
    admin.from("rehab_sessions").select("id").eq("user_id", patientId).not("training_status", "is", null).limit(1).maybeSingle(),
  ]);
  return Boolean(pp?.current_prescription_version_id) || Boolean(session);
}

// ---------------------------------------------------------------------------
// Response facts
// ---------------------------------------------------------------------------
function immediateFact(sessionClosed: boolean, r: Row | undefined): C5ImmediateFact {
  if (!sessionClosed) return { kind: "none" };
  if (!r || r.resolved_at == null) return { kind: "pending" };
  return {
    kind: "submitted",
    peakPain: scoreFact(num(r.peak_session_pain), r.peak_pain_unable_to_recall === true),
    rpe: scoreFact(num(r.overall_session_rpe), r.rpe_unable_to_recall === true),
    safety: {
      sudden_or_sharp_pain: (r.sudden_or_sharp_pain as boolean | null) ?? null,
      pop_felt_or_heard: (r.pop_felt_or_heard as boolean | null) ?? null,
      new_functional_difficulty: (r.new_functional_difficulty as boolean | null) ?? null,
    },
    submittedAt: r.resolved_at as string,
  };
}

function morningFact(sessionClosed: boolean, r: Row | undefined, tz: string, now: Date): MorningFact {
  if (!sessionClosed || !r) return { kind: "none" };
  const dueAt = (r.scheduled_eligible_at as string | null) ?? null;
  const referenceLocalDate = (r.reference_local_date as string | null) ?? null;
  const resolution = r.resolution as string | null;
  if (resolution == null) {
    return dueAt && new Date(dueAt) <= now ? { kind: "due", dueAt, referenceLocalDate } : { kind: "not_yet_due", dueAt, referenceLocalDate };
  }
  const submittedAt = r.submitted_at as string;
  const daysAfterReference = referenceLocalDate ? daysBetween(referenceLocalDate, localDateOf(submittedAt, tz)) : null;
  if (resolution === "unable_to_recall") return { kind: "unable_to_recall", dueAt, referenceLocalDate, submittedAt, daysAfterReference };
  return {
    kind: "answered",
    pain: Number(r.next_morning_pain),
    stiffness: Number(r.next_morning_stiffness),
    stiffnessDuration: (r.stiffness_duration as C5StiffnessDuration | null) ?? null,
    note: (r.patient_note as string | null) ?? null,
    dueAt,
    referenceLocalDate,
    submittedAt,
    daysAfterReference,
  };
}

// ---------------------------------------------------------------------------
// Sessions list + detail
// ---------------------------------------------------------------------------
async function loadResponseFacts(admin: Admin, sessionIds: string[]) {
  if (sessionIds.length === 0) {
    return { immediate: new Map<string, Row>(), morning: new Map<string, Row>(), escalation: new Map<string, Row>(), episodeByEval: new Map<string, string>(), units: [] as Row[] };
  }
  const [imm, morn, esc, units] = await Promise.all([
    admin.from("session_immediate_responses").select("*").in("rehab_session_id", sessionIds),
    admin.from("morning_responses").select("*").in("rehab_session_id", sessionIds),
    admin.from("escalation_evaluations").select("id, rehab_session_id, escalation_level, escalation_reason, rule_version, evaluated_at").in("rehab_session_id", sessionIds).order("evaluated_at", { ascending: false }),
    admin.from("set_outcomes").select("id, rehab_session_id, exercise_id, set_index, outcome, actual_reps, actual_load, actual_load_unit, actual_duration_seconds, actual_distance_m, was_edited").in("rehab_session_id", sessionIds),
  ]);
  for (const r of [imm, morn, esc, units]) if (r.error) throw new Error(`clinician C5 read failed: ${r.error.message}`);
  const escalation = new Map<string, Row>();
  for (const e of (esc.data ?? []) as Row[]) if (!escalation.has(e.rehab_session_id as string)) escalation.set(e.rehab_session_id as string, e);
  const evalIds = [...escalation.values()].map((e) => e.id as string);
  const episodeByEval = new Map<string, string>();
  if (evalIds.length) {
    const { data, error } = await admin.from("acute_safety_episodes").select("id, source_escalation_evaluation_id").in("source_escalation_evaluation_id", evalIds);
    if (error) throw new Error(`clinician C5 read failed: ${error.message}`);
    for (const ep of (data ?? []) as Row[]) episodeByEval.set(ep.source_escalation_evaluation_id as string, ep.id as string);
  }
  return {
    immediate: new Map(((imm.data ?? []) as Row[]).map((r) => [r.rehab_session_id as string, r])),
    morning: new Map(((morn.data ?? []) as Row[]).map((r) => [r.rehab_session_id as string, r])),
    escalation,
    episodeByEval,
    units: (units.data ?? []) as Row[],
  };
}

function escalationFact(e: Row | undefined, episodeByEval: Map<string, string>): C5EscalationFact {
  if (!e) return null;
  return {
    level: Number(e.escalation_level),
    reason: e.escalation_reason as string,
    ruleVersion: e.rule_version as string,
    evaluatedAt: e.evaluated_at as string,
    episodeId: episodeByEval.get(e.id as string) ?? null,
  };
}

function summarize(s: Row, facts: Awaited<ReturnType<typeof loadResponseFacts>>, now: Date): C5SessionSummary {
  const snapshot = mapSnapshot(s.prescription_snapshot as Row);
  const status = s.training_status as C5TrainingStatus;
  const closed = status !== "started";
  const id = s.id as string;
  const tz = s.patient_timezone as string;
  const units = facts.units.filter((u) => u.rehab_session_id === id);
  return {
    id,
    patientLocalDate: s.patient_local_date as string,
    patientTimezone: tz,
    startedAt: s.started_at as string,
    closedAt: (s.training_closed_at as string | null) ?? null,
    trainingStatus: status,
    workoutTitle: workoutTitle(snapshot),
    versionNumber: snapshot?.versionNumber ?? null,
    schedulingMode: snapshot?.schedulingMode ?? "sequence",
    calendarScheduledDate: (s.calendar_scheduled_date as string | null) ?? null,
    sequenceChoice: (s.sequence_choice as string | null) ?? null,
    units: {
      prescribed: snapshot ? snapshot.exercises.reduce((n, e) => n + unitCount(e.dosage), 0) : 0,
      completed: units.filter((u) => u.outcome === "completed").length,
      skipped: units.filter((u) => u.outcome === "skipped").length,
      edited: units.filter((u) => u.was_edited === true).length,
    },
    immediate: immediateFact(closed, facts.immediate.get(id)),
    morning: morningFact(closed, facts.morning.get(id), tz, now),
    escalation: escalationFact(facts.escalation.get(id), facts.episodeByEval),
  };
}

export const SESSIONS_PAGE_SIZE = 20;

// Chronological C5 record, newest first (patient-local date, then start).
export async function listC5Sessions(patientId: string, page = 0): Promise<{ sessions: C5SessionSummary[]; hasMore: boolean }> {
  const admin = createServiceRoleClient();
  const from = page * SESSIONS_PAGE_SIZE;
  const { data, error } = await admin
    .from("rehab_sessions")
    .select(SESSION_COLUMNS)
    .eq("user_id", patientId)
    .not("training_status", "is", null)
    .order("patient_local_date", { ascending: false })
    .order("started_at", { ascending: false })
    .range(from, from + SESSIONS_PAGE_SIZE);
  if (error) throw new Error(`listC5Sessions failed: ${error.message}`);
  const rows = (data ?? []) as Row[];
  const pageRows = rows.slice(0, SESSIONS_PAGE_SIZE);
  const facts = await loadResponseFacts(admin, pageRows.map((r) => r.id as string));
  const now = new Date();
  return { sessions: pageRows.map((r) => summarize(r, facts, now)), hasMore: rows.length > SESSIONS_PAGE_SIZE };
}

function editValue(entry: ReturnType<typeof unitEntry>, outcome: string, reps: unknown, duration: unknown, distance: unknown): number | null {
  if (outcome !== "completed") return null;
  return outcomeValue(entry, { actualReps: num(reps), actualDurationSeconds: num(duration), actualDistanceM: num(distance) });
}

export async function getC5SessionDetail(patientId: string, sessionId: string): Promise<C5SessionDetail | null> {
  const admin = createServiceRoleClient();
  const { data: s, error } = await admin
    .from("rehab_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("user_id", patientId)
    .not("training_status", "is", null)
    .maybeSingle();
  if (error) throw new Error(`getC5SessionDetail failed: ${error.message}`);
  if (!s) return null;
  const session = s as Row;
  const [facts, editsRes, decisionsRes, cautiousRes] = await Promise.all([
    loadResponseFacts(admin, [sessionId]),
    admin.from("set_outcome_edits").select("*").eq("rehab_session_id", sessionId).order("edited_at", { ascending: true }),
    admin.from("c5_recovery_decisions").select("*").eq("user_id", patientId).eq("decision_local_date", session.patient_local_date as string).order("decided_at", { ascending: true }),
    admin.from("cautious_return_contexts").select("rehab_session_id").eq("rehab_session_id", sessionId).maybeSingle(),
  ]);
  for (const r of [editsRes, decisionsRes]) if (r.error) throw new Error(`getC5SessionDetail failed: ${r.error.message}`);
  const summary = summarize(session, facts, new Date());
  const raw = session.prescription_snapshot as Row;
  const snapshot = mapSnapshot(raw);

  const editsBySet = new Map<string, Row[]>();
  for (const e of (editsRes.data ?? []) as Row[]) {
    const list = editsBySet.get(e.set_outcome_id as string) ?? [];
    list.push(e);
    editsBySet.set(e.set_outcome_id as string, list);
  }

  const exercises: C5ExerciseFact[] = (snapshot?.exercises ?? []).map((ex) => {
    const entry = unitEntry(ex.dosage);
    const units: C5UnitFact[] = Array.from({ length: unitCount(ex.dosage) }, (_, i) => {
      const u = facts.units.find((x) => x.exercise_id === ex.exerciseId && Number(x.set_index) === i);
      if (!u) return { kind: "not_recorded" };
      const edits: C5UnitEdit[] = (editsBySet.get(u.id as string) ?? []).map((e) => ({
        editedAt: e.edited_at as string,
        previous: {
          outcome: e.previous_outcome as string,
          value: editValue(entry, e.previous_outcome as string, e.previous_actual_reps, e.previous_actual_duration_seconds, e.previous_actual_distance_m),
          load: num(e.previous_actual_load),
        },
        next: {
          outcome: e.new_outcome as string,
          value: editValue(entry, e.new_outcome as string, e.new_actual_reps, e.new_actual_duration_seconds, e.new_actual_distance_m),
          load: num(e.new_actual_load),
        },
      }));
      if (u.outcome === "skipped") return { kind: "skipped", edits };
      return {
        kind: "completed",
        value: outcomeValue(entry, { actualReps: num(u.actual_reps), actualDurationSeconds: num(u.actual_duration_seconds), actualDistanceM: num(u.actual_distance_m) }),
        load: num(u.actual_load),
        loadUnit: (u.actual_load_unit as string | null) ?? null,
        wasEdited: u.was_edited === true,
        edits,
      };
    });
    return {
      exerciseId: ex.exerciseId,
      name: ex.name,
      orderIndex: ex.orderIndex,
      additionalInstructions: ex.additionalInstructions,
      dosage: ex.dosage,
      valueLabel: entry.field === "distance" ? (entry.distanceUnit ?? "m") : entry.field === "duration" ? "seconds" : entry.field,
      units,
    };
  });

  const recoveryDecisions: C5RecoveryDecisionFact[] = ((decisionsRes.data ?? []) as Row[]).map((d) => ({
    decision: d.decision as C5RecoveryDecisionFact["decision"],
    decidedAt: d.decided_at as string,
    decisionLocalDate: d.decision_local_date as string,
    recommendedRecoveryDays: Number(d.recommended_recovery_days),
    anchorStartLocalDate: d.anchor_start_local_date as string,
    earliestRecommendedDate: d.earliest_recommended_date as string,
    restDaysCompleted: Number(d.rest_days_completed),
    weeklyTarget: num(d.weekly_target),
    weeklyFinishedSessions: num(d.weekly_finished_sessions),
  }));

  return {
    ...summary,
    versionId: session.prescription_version_id as string,
    snapshotVersion: num(raw?.snapshot_version),
    targetSessionsPerWeek: num(raw?.target_sessions_per_week),
    recoveryDays: num(raw?.recovery_days),
    resolvesStoppedSessionId: (session.resolves_stopped_session_id as string | null) ?? null,
    exercises,
    recoveryDecisions,
    cautiousReturn: Boolean(cautiousRes.data),
  };
}

// ---------------------------------------------------------------------------
// Safety — ALL episodes (open and released), each with its authoritative
// review state, reassessment history, originating session and release.
// ---------------------------------------------------------------------------
type ReviewStateRow = {
  episode_id: string;
  effective_level: number;
  level4_reasons: string[] | null;
  blocked_opportunity_count: number;
  professionally_held: boolean;
  requires_clinician_release: boolean;
  released: boolean;
};

export async function getC5SafetyEpisodes(patientId: string): Promise<C5SafetyEpisode[]> {
  const admin = createServiceRoleClient();
  const { data: eps, error } = await admin
    .from("acute_safety_episodes")
    .select("id, confirmed_at, initial_level, initial_sudden_or_sharp_pain, initial_pop_felt_or_heard, initial_new_functional_difficulty, source_rehab_session_id")
    .eq("user_id", patientId)
    .order("confirmed_at", { ascending: false });
  if (error) throw new Error(`getC5SafetyEpisodes failed: ${error.message}`);
  const episodes = (eps ?? []) as Row[];
  if (episodes.length === 0) return [];
  const ids = episodes.map((e) => e.id as string);
  const sessionIds = [...new Set(episodes.map((e) => e.source_rehab_session_id as string))];

  // One authoritative review-state call per episode (the database function
  // takes one episode), in parallel.
  const [states, reassessRes, releaseRes, sessionsRes] = await Promise.all([
    Promise.all(
      ids.map(async (id) => {
        const { data, error: e } = await admin.rpc("acute_episode_review_state", { p_episode_id: id });
        if (e) throw new Error(`acute_episode_review_state failed: ${e.message}`);
        return ((data ?? []) as ReviewStateRow[])[0];
      })
    ),
    admin.from("acute_safety_reassessments").select("*").in("acute_safety_episode_id", ids).order("submitted_at", { ascending: true }),
    admin.from("acute_safety_releases").select("*").in("acute_safety_episode_id", ids),
    admin.from("rehab_sessions").select("id, patient_local_date, training_status").in("id", sessionIds),
  ]);
  for (const r of [reassessRes, releaseRes, sessionsRes]) if (r.error) throw new Error(`getC5SafetyEpisodes failed: ${r.error.message}`);
  const stateById = new Map(states.filter(Boolean).map((s) => [s.episode_id, s]));
  const releases = (releaseRes.data ?? []) as Row[];
  const clinicianIds = [...new Set(releases.map((r) => r.released_by_clinician_id as string | null).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (clinicianIds.length) {
    const { data } = await admin.from("profiles").select("id, name").in("id", clinicianIds);
    for (const p of (data ?? []) as Row[]) names.set(p.id as string, p.name as string);
  }
  const sessionById = new Map(((sessionsRes.data ?? []) as Row[]).map((s) => [s.id as string, s]));

  return episodes.map((e) => {
    const id = e.id as string;
    const st = stateById.get(id);
    const rel = releases.find((r) => r.acute_safety_episode_id === id);
    const src = sessionById.get(e.source_rehab_session_id as string);
    const requiresClinicianRelease = st?.requires_clinician_release ?? true; // fail closed
    const released = Boolean(rel);
    return {
      episodeId: id,
      confirmedAt: e.confirmed_at as string,
      initialLevel: Number(e.initial_level),
      effectiveLevel: Number(st?.effective_level ?? e.initial_level),
      level4Reasons: st?.level4_reasons ?? [],
      professionallyHeld: st?.professionally_held ?? false,
      requiresClinicianRelease,
      processState: episodeProcessState({ released, requiresClinicianRelease }),
      initialFacts: {
        sudden_or_sharp_pain: e.initial_sudden_or_sharp_pain === true,
        pop_felt_or_heard: e.initial_pop_felt_or_heard === true,
        new_functional_difficulty: e.initial_new_functional_difficulty === true,
      },
      sourceSession: src
        ? { id: src.id as string, patientLocalDate: src.patient_local_date as string, isC5: src.training_status != null, trainingStatus: (src.training_status as C5TrainingStatus | null) ?? null }
        : null,
      reassessments: ((reassessRes.data ?? []) as Row[])
        .filter((r) => r.acute_safety_episode_id === id)
        .map((r) => ({
          submittedAt: r.submitted_at as string,
          suddenOrSharpPainResolved: (r.sudden_or_sharp_pain_resolved as boolean | null) ?? null,
          newFunctionalDifficultyResolved: (r.new_functional_difficulty_resolved as boolean | null) ?? null,
          evaluatedByProfessional: r.evaluated_by_professional === true,
          clearedByProfessional: (r.cleared_by_professional as boolean | null) ?? null,
        })),
      release: rel
        ? {
            releasePath: rel.release_path as string,
            releasedAt: rel.released_at as string,
            releasedByClinicianId: (rel.released_by_clinician_id as string | null) ?? null,
            releasedByName: rel.released_by_clinician_id ? (names.get(rel.released_by_clinician_id as string) ?? null) : null,
            releaseNote: (rel.release_note as string | null) ?? null,
          }
        : null,
      blockedOpportunityCount: Number(st?.blocked_opportunity_count ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Overview — concise current facts.
// ---------------------------------------------------------------------------
export type C5Overview = {
  program: { versionNumber: number | null; schedulingMode: string | null; publishedAt: string | null; paused: boolean; pausedSince: string | null } | null;
  timezone: string | null;
  latestSession: C5SessionSummary | null;
  openEpisodes: { count: number; clinicianReleaseRequired: boolean };
  eligibility: C5TrainingState;
};

export async function getC5Overview(patientId: string): Promise<C5Overview> {
  const admin = createServiceRoleClient();
  const [ppRes, profileRes, latest, episodes, eligibility] = await Promise.all([
    admin.from("patient_prescriptions").select("id, current_prescription_version_id, operational_status").eq("patient_id", patientId).maybeSingle(),
    admin.from("profiles").select("timezone").eq("id", patientId).maybeSingle(),
    listC5Sessions(patientId, 0),
    getC5SafetyEpisodes(patientId),
    readC5TrainingStateForClinician(patientId),
  ]);
  if (ppRes.error) throw new Error(`getC5Overview failed: ${ppRes.error.message}`);
  const pp = ppRes.data as Row | null;
  let program: C5Overview["program"] = null;
  if (pp?.current_prescription_version_id) {
    const [{ data: v }, { data: pause }] = await Promise.all([
      admin.from("prescription_versions").select("version_number, scheduling_mode, published_at").eq("id", pp.current_prescription_version_id as string).maybeSingle(),
      admin.from("prescription_pause_periods").select("paused_at, resumed_at").eq("patient_prescription_id", pp.id as string).is("resumed_at", null).maybeSingle(),
    ]);
    program = {
      versionNumber: (v?.version_number as number | null) ?? null,
      schedulingMode: (v?.scheduling_mode as string | null) ?? null,
      publishedAt: (v?.published_at as string | null) ?? null,
      paused: pp.operational_status === "paused",
      pausedSince: (pause?.paused_at as string | null) ?? null,
    };
  }
  const open = episodes.filter((e) => e.processState !== "released");
  return {
    program,
    timezone: (profileRes.data?.timezone as string | null) ?? null,
    latestSession: latest.sessions[0] ?? null,
    openEpisodes: { count: open.length, clinicianReleaseRequired: open.some((e) => e.requiresClinicianRelease) },
    eligibility,
  };
}

// ---------------------------------------------------------------------------
// Roster — C5 facts for an already-authorized patient set (batched).
// ---------------------------------------------------------------------------
export type C5RosterFacts = {
  closedSessionStarts: Map<string, string[]>; // patient -> started_at DESC (closed C5 sessions only)
  immediatePending: Set<string>;
  morningOutstanding: Map<string, { scheduledEligibleAt: string | null }[]>;
};

export async function getC5RosterFacts(patientIds: string[]): Promise<C5RosterFacts> {
  const admin = createServiceRoleClient();
  const facts: C5RosterFacts = { closedSessionStarts: new Map(), immediatePending: new Set(), morningOutstanding: new Map() };
  if (patientIds.length === 0) return facts;
  const [latestRes, immRes, mornRes] = await Promise.all([
    // Closed C5 sessions per patient, newest first (an open Started session
    // is never completed activity).
    admin
      .from("rehab_sessions")
      .select("user_id, started_at")
      .in("user_id", patientIds)
      .not("training_status", "is", null)
      .neq("training_status", "started")
      .order("started_at", { ascending: false }),
    // C5 immediate check-ins exist only for closed C5 sessions; unresolved = pending.
    admin.from("session_immediate_responses").select("user_id").in("user_id", patientIds).is("resolved_at", null),
    // Unresolved C5 morning obligations (C5 rows only; legacy rows keep the
    // legacy awaiting_morning_response path).
    admin
      .from("morning_responses")
      .select("user_id, scheduled_eligible_at, rehab_sessions!inner(training_status)")
      .in("user_id", patientIds)
      .is("resolution", null)
      .not("rehab_sessions.training_status", "is", null),
  ]);
  for (const r of [latestRes, immRes, mornRes]) if (r.error) throw new Error(`getC5RosterFacts failed: ${r.error.message}`);
  for (const row of (latestRes.data ?? []) as Row[]) {
    const list = facts.closedSessionStarts.get(row.user_id as string) ?? [];
    list.push(row.started_at as string);
    facts.closedSessionStarts.set(row.user_id as string, list);
  }
  for (const row of (immRes.data ?? []) as Row[]) facts.immediatePending.add(row.user_id as string);
  for (const row of (mornRes.data ?? []) as Row[]) {
    const list = facts.morningOutstanding.get(row.user_id as string) ?? [];
    list.push({ scheduledEligibleAt: (row.scheduled_eligible_at as string | null) ?? null });
    facts.morningOutstanding.set(row.user_id as string, list);
  }
  return facts;
}

// For each patient with any OPEN episode: does any open episode require a
// clinician release? From the authoritative review state (one call per open
// episode, in parallel; open episodes are few). Patients with no open
// episode are absent.
export async function getOpenEpisodeReleaseRequirement(patientIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (patientIds.length === 0) return result;
  const admin = createServiceRoleClient();
  const { data: eps, error } = await admin.from("acute_safety_episodes").select("id, user_id").in("user_id", patientIds);
  if (error) throw new Error(`getOpenEpisodeReleaseRequirement failed: ${error.message}`);
  const episodes = (eps ?? []) as Row[];
  if (episodes.length === 0) return result;
  const { data: rels, error: relError } = await admin.from("acute_safety_releases").select("acute_safety_episode_id").in("acute_safety_episode_id", episodes.map((e) => e.id as string));
  if (relError) throw new Error(`getOpenEpisodeReleaseRequirement failed: ${relError.message}`);
  const released = new Set(((rels ?? []) as Row[]).map((r) => r.acute_safety_episode_id as string));
  const open = episodes.filter((e) => !released.has(e.id as string));
  const states = await Promise.all(
    open.map(async (e) => {
      const { data, error: e2 } = await admin.rpc("acute_episode_review_state", { p_episode_id: e.id as string });
      if (e2) throw new Error(`acute_episode_review_state failed: ${e2.message}`);
      const st = ((data ?? []) as ReviewStateRow[])[0];
      return { patientId: e.user_id as string, requires: st?.requires_clinician_release ?? true };
    })
  );
  for (const s of states) result.set(s.patientId, (result.get(s.patientId) ?? false) || s.requires);
  return result;
}

// Which of these patients are C5 patients (a C5 program or any C5 session).
export async function getC5PatientSet(patientIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (patientIds.length === 0) return out;
  const admin = createServiceRoleClient();
  const [pp, sessions] = await Promise.all([
    admin.from("patient_prescriptions").select("patient_id").in("patient_id", patientIds).not("current_prescription_version_id", "is", null),
    admin.from("rehab_sessions").select("user_id").in("user_id", patientIds).not("training_status", "is", null),
  ]);
  for (const r of [pp, sessions]) if (r.error) throw new Error(`getC5PatientSet failed: ${r.error.message}`);
  for (const r of (pp.data ?? []) as Row[]) out.add(r.patient_id as string);
  for (const r of (sessions.data ?? []) as Row[]) out.add(r.user_id as string);
  return out;
}

export async function getPatientHeader(patientId: string): Promise<{ displayName: string; timezone: string | null } | null> {
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from("profiles").select("name, timezone").eq("id", patientId).maybeSingle();
  if (error) throw new Error(`getPatientHeader failed: ${error.message}`);
  if (!data) return null;
  return { displayName: (data.name as string | null) ?? "Patient", timezone: (data.timezone as string | null) ?? null };
}

// Recent Take Recovery Day / Continue decisions (a recovery day has no
// session, so these are listed on their own; newest first).
export async function getRecentRecoveryDecisions(patientId: string, limit = 5): Promise<C5RecoveryDecisionFact[]> {
  const admin = createServiceRoleClient();
  const { data, error } = await admin.from("c5_recovery_decisions").select("*").eq("user_id", patientId).order("decided_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`getRecentRecoveryDecisions failed: ${error.message}`);
  return ((data ?? []) as Row[]).map((d) => ({
    decision: d.decision as C5RecoveryDecisionFact["decision"],
    decidedAt: d.decided_at as string,
    decisionLocalDate: d.decision_local_date as string,
    recommendedRecoveryDays: Number(d.recommended_recovery_days),
    anchorStartLocalDate: d.anchor_start_local_date as string,
    earliestRecommendedDate: d.earliest_recommended_date as string,
    restDaysCompleted: Number(d.rest_days_completed),
    weeklyTarget: num(d.weekly_target),
    weeklyFinishedSessions: num(d.weekly_finished_sessions),
  }));
}
