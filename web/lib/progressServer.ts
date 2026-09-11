import "server-only";

// Milestone 6, Stage 2 — server-only data access for /patient/progress.
//
// Read-only against existing Postgres history. Deliberately does NOT call
// getPatientSummary()/the FastAPI bridge, and does NOT read SQLite
// daily_logs, Postgres' dead daily_logs/progression_decisions/exercises
// tables, or the stale previous_performance/recent_logs bridge fields (see
// the M6 Stage 1 architecture audit for why those are excluded). Every
// source table here (rehab_sessions, morning_responses, set_outcomes,
// session_load_observations, tolerance_evaluations, acute_safety_episodes)
// is written directly by Next.js/RPC code, independent of the legacy
// FastAPI bridge.
//
// Acute-safety data (acuteEventDates) is fetched and returned entirely
// separately from every other query below — it must never filter, adjust,
// or otherwise influence the symptom/loading/tolerance computations. It is
// surfaced only as an independent factual marker (see progressTypes.ts).

import { createServiceRoleClient } from "./supabase/server";
import type { PrescriptionSnapshotExercise } from "./rehabSessionTypes";
import type { StiffnessDuration, ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";
import {
  buildNumericComparison,
  buildStiffnessDurationComparison,
  comparePrescriptionVersions,
  ruleVersionChanged,
} from "./progressCompare";
import { repsOrHoldLabel } from "./exerciseDisplay";
import type {
  ProgressData,
  RecentResponse,
  SymptomsOverTime,
  SessionLoadingHistoryEntry,
  ExerciseLoadingHistory,
  SetLoadingFact,
  ToleranceHistoryEntry,
  ExternalLoadTag,
} from "./progressTypes";

// Sessions are at most ~daily; 90 covers roughly three months of history,
// generous for Stage 2's "simple, at-a-glance" goal without an unbounded
// query. Revisit if/when pagination is actually needed.
const HISTORY_LIMIT = 90;

type SessionRow = {
  id: string;
  started_at: string;
  patient_local_date: string;
  peak_session_pain: number | null;
  prescription_version_id: string | null;
  prescription_snapshot: PrescriptionSnapshotExercise[];
};

type MorningRow = {
  rehab_session_id: string;
  next_morning_pain: number | null;
  next_morning_stiffness: number | null;
  stiffness_duration: StiffnessDuration | null;
  submitted_at: string | null;
};

type SetOutcomeRow = {
  rehab_session_id: string;
  exercise_id: string;
  exercise_order_index: number;
  set_index: number;
  outcome: "completed" | "skipped";
  prescribed_reps: number | null;
  prescribed_load: number | null;
  actual_reps: number | null;
  actual_load: number | null;
};

type LoadObsRow = { rehab_session_id: string; category: string; timing: string | null };

type ToleranceRow = {
  rehab_session_id: string;
  tolerance_classification: ToleranceClassification;
  immediate_guidance: ImmediateGuidance;
  patient_facing_label: string;
  rule_version: string;
  evaluated_at: string;
};

export async function getProgressData(userId: string): Promise<ProgressData> {
  const supabase = createServiceRoleClient();

  const { data: sessionRows } = await supabase
    .from("rehab_sessions")
    .select("id, started_at, patient_local_date, peak_session_pain, prescription_version_id, prescription_snapshot")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  const sessionsDesc = (sessionRows ?? []) as SessionRow[];
  const sessionIds = sessionsDesc.map((s) => s.id);

  const [morningRes, setOutcomeRes, loadObsRes, toleranceRes, acuteRes] = await Promise.all([
    sessionIds.length
      ? supabase
          .from("morning_responses")
          .select("rehab_session_id, next_morning_pain, next_morning_stiffness, stiffness_duration, submitted_at")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as MorningRow[] }),
    sessionIds.length
      ? supabase
          .from("set_outcomes")
          .select("rehab_session_id, exercise_id, exercise_order_index, set_index, outcome, prescribed_reps, prescribed_load, actual_reps, actual_load")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as SetOutcomeRow[] }),
    sessionIds.length
      ? supabase.from("session_load_observations").select("rehab_session_id, category, timing").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as LoadObsRow[] }),
    sessionIds.length
      ? supabase
          .from("tolerance_evaluations")
          .select("rehab_session_id, tolerance_classification, immediate_guidance, patient_facing_label, rule_version, evaluated_at")
          .in("rehab_session_id", sessionIds)
          .order("evaluated_at", { ascending: true })
      : Promise.resolve({ data: [] as ToleranceRow[] }),
    supabase.from("acute_safety_episodes").select("confirmed_at").eq("user_id", userId),
  ]);

  // Only a FINALIZED morning response is a known fact — submitted_at IS NULL
  // means "not yet answered", even if next_morning_pain already holds a
  // draft value from progressive save. See the morning-response route's own
  // "raw fields the patient may progressively submit" comment.
  const morningBySession = new Map<string, MorningRow>();
  for (const row of (morningRes.data ?? []) as MorningRow[]) {
    if (row.submitted_at != null) morningBySession.set(row.rehab_session_id, row);
  }

  const setsBySession = new Map<string, SetOutcomeRow[]>();
  for (const row of (setOutcomeRes.data ?? []) as SetOutcomeRow[]) {
    const list = setsBySession.get(row.rehab_session_id) ?? [];
    list.push(row);
    setsBySession.set(row.rehab_session_id, list);
  }

  const loadObsBySession = new Map<string, ExternalLoadTag[]>();
  for (const row of (loadObsRes.data ?? []) as LoadObsRow[]) {
    const list = loadObsBySession.get(row.rehab_session_id) ?? [];
    list.push({ category: row.category, timing: row.timing });
    loadObsBySession.set(row.rehab_session_id, list);
  }

  const toleranceRowsAsc = (toleranceRes.data ?? []) as ToleranceRow[];
  const sessionsAsc = [...sessionsDesc].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const sessionById = new Map(sessionsAsc.map((s) => [s.id, s]));

  const hasAnyHistory = sessionsDesc.length > 0;

  // ---------------------------------------------------------------------
  // A. Recent Response — each metric compares independently. peak pain
  // looks at the two most recent SESSIONS with a non-null value; the three
  // morning-response metrics look at the two most recent FINALIZED morning
  // responses (by their session's date) — these need not be the same two
  // sessions as peak pain, since a session's morning response may still be
  // outstanding while its peak pain is already known.
  // ---------------------------------------------------------------------
  const recentResponse: RecentResponse | null = hasAnyHistory
    ? (() => {
        const withPeakPain = sessionsDesc.filter((s) => s.peak_session_pain != null);
        const withMorning = sessionsDesc.filter((s) => morningBySession.has(s.id));

        const peakSessionPain = buildNumericComparison({
          label: "Peak session pain",
          current: withPeakPain[0]?.peak_session_pain ?? null,
          currentDate: withPeakPain[0]?.patient_local_date ?? null,
          previous: withPeakPain[1]?.peak_session_pain ?? null,
          previousDate: withPeakPain[1]?.patient_local_date ?? null,
        });

        const currentMorning = withMorning[0] ? morningBySession.get(withMorning[0].id) ?? null : null;
        const previousMorning = withMorning[1] ? morningBySession.get(withMorning[1].id) ?? null : null;

        const nextMorningPain = buildNumericComparison({
          label: "Next-morning pain",
          current: currentMorning?.next_morning_pain ?? null,
          currentDate: currentMorning ? withMorning[0].patient_local_date : null,
          previous: previousMorning?.next_morning_pain ?? null,
          previousDate: previousMorning ? withMorning[1].patient_local_date : null,
        });

        const morningStiffnessIntensity = buildNumericComparison({
          label: "Morning stiffness intensity",
          current: currentMorning?.next_morning_stiffness ?? null,
          currentDate: currentMorning ? withMorning[0].patient_local_date : null,
          previous: previousMorning?.next_morning_stiffness ?? null,
          previousDate: previousMorning ? withMorning[1].patient_local_date : null,
        });

        const morningStiffnessDuration = buildStiffnessDurationComparison({
          current: currentMorning?.stiffness_duration ?? null,
          currentDate: currentMorning ? withMorning[0].patient_local_date : null,
          previous: previousMorning?.stiffness_duration ?? null,
          previousDate: previousMorning ? withMorning[1].patient_local_date : null,
        });

        return { peakSessionPain, nextMorningPain, morningStiffnessIntensity, morningStiffnessDuration };
      })()
    : null;

  // ---------------------------------------------------------------------
  // B. Symptoms Over Time — each series contains ONLY the dates where that
  // specific fact is known. Never a shared zero-filled axis.
  // ---------------------------------------------------------------------
  const symptomsOverTime: SymptomsOverTime = {
    peakSessionPain: sessionsAsc
      .filter((s) => s.peak_session_pain != null)
      .map((s) => ({ date: s.patient_local_date, value: s.peak_session_pain as number })),
    nextMorningPain: sessionsAsc
      .filter((s) => morningBySession.get(s.id)?.next_morning_pain != null)
      .map((s) => ({ date: s.patient_local_date, value: morningBySession.get(s.id)!.next_morning_pain as number })),
    morningStiffnessIntensity: sessionsAsc
      .filter((s) => morningBySession.get(s.id)?.next_morning_stiffness != null)
      .map((s) => ({ date: s.patient_local_date, value: morningBySession.get(s.id)!.next_morning_stiffness as number })),
    morningStiffnessDuration: sessionsAsc
      .filter((s) => morningBySession.get(s.id)?.stiffness_duration != null)
      .map((s) => ({ date: s.patient_local_date, bucket: morningBySession.get(s.id)!.stiffness_duration as StiffnessDuration })),
  };

  // ---------------------------------------------------------------------
  // C. Loading History — reconstructed per session from that session's OWN
  // prescription_snapshot (never the current/live exercise definition).
  // ---------------------------------------------------------------------
  let previousVersionId: string | null | undefined = undefined; // undefined = "no previous session yet"
  const loadingHistory: SessionLoadingHistoryEntry[] = sessionsAsc.map((session) => {
    const comparedToPrevious =
      previousVersionId === undefined ? "unknown" : comparePrescriptionVersions(previousVersionId, session.prescription_version_id);
    previousVersionId = session.prescription_version_id;

    const setsForSession = setsBySession.get(session.id) ?? [];
    const setsByOrderIndex = new Map<number, SetOutcomeRow[]>();
    for (const row of setsForSession) {
      const list = setsByOrderIndex.get(row.exercise_order_index) ?? [];
      list.push(row);
      setsByOrderIndex.set(row.exercise_order_index, list);
    }

    const exercises: ExerciseLoadingHistory[] = [...session.prescription_snapshot]
      .sort((a, b) => a.order_index - b.order_index)
      .map((ex) => {
        const sets: SetLoadingFact[] = (setsByOrderIndex.get(ex.order_index) ?? [])
          .sort((a, b) => a.set_index - b.set_index)
          .map((row) => ({
            setIndex: row.set_index,
            outcome: row.outcome,
            prescribedReps: row.prescribed_reps,
            prescribedLoad: row.prescribed_load,
            actualReps: row.actual_reps,
            actualLoad: row.actual_load,
            // Only shown when the numeric column is null — a hold/range
            // exercise still gets to show what was actually prescribed,
            // straight from this session's own snapshot, never fabricated.
            prescribedDisplay: row.prescribed_reps == null ? repsOrHoldLabel(ex.dosage ?? {}) : null,
          }));
        return { exId: ex.ex_id, name: ex.name, loadingProfile: ex.loading_profile, sets };
      });

    return {
      rehabSessionId: session.id,
      date: session.patient_local_date,
      prescriptionVersionId: session.prescription_version_id,
      comparedToPrevious,
      exercises,
      externalLoad: loadObsBySession.get(session.id) ?? [],
    };
  });

  // ---------------------------------------------------------------------
  // E. Response / Tolerance History
  // ---------------------------------------------------------------------
  let previousRuleVersion: string | null = null;
  const toleranceHistory: ToleranceHistoryEntry[] = toleranceRowsAsc.map((row) => {
    const interpretationMethodChanged = ruleVersionChanged(previousRuleVersion, row.rule_version);
    previousRuleVersion = row.rule_version;
    return {
      rehabSessionId: row.rehab_session_id,
      date: sessionById.get(row.rehab_session_id)?.patient_local_date ?? row.evaluated_at.slice(0, 10),
      classification: row.tolerance_classification,
      immediateGuidance: row.immediate_guidance,
      patientFacingLabel: row.patient_facing_label,
      ruleVersion: row.rule_version,
      interpretationMethodChanged,
    };
  });

  const acuteEventDates = ((acuteRes.data ?? []) as { confirmed_at: string }[])
    .map((r) => r.confirmed_at)
    .sort((a, b) => a.localeCompare(b));

  return { hasAnyHistory, recentResponse, symptomsOverTime, loadingHistory, toleranceHistory, acuteEventDates };
}
