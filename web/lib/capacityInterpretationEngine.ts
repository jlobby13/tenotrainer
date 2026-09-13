import "server-only";

// Milestone 6, Stage 3C — the Capacity interpretation ENGINE. Persists one
// m6_longitudinal_interpretations row per (patient x comparable construct)
// per run (brief section 1) — NEVER one giant per-patient array of
// unrelated exercise results, and NEVER a universal Capacity score.
//
// Pipeline: fetch raw session/snapshot/set_outcomes/tolerance data ->
// build CapacityExposures per session (capacityExposure.ts, pure) -> group
// by comparable construct (capacityConstruct.ts, pure) -> classify each
// construct's most recent history (capacityClassifier.ts, pure — fully
// deterministic as of round 3, no pending-decision branch remains) ->
// persist.
//
// FOUNDER DECISION (round 3, brief section 7) — EPISODE-SCOPED generation,
// not "most recent session overall": generate/update a Capacity
// interpretation only for the comparable construct(s) present in the
// SPECIFIC completed response episode being processed. When construct A's
// episode completes, only A is (re)evaluated/persisted; construct B is
// untouched until B's own episode completes. This naturally supports a
// rotating A/B (or A/B/C...) program without inventing a most-recent-N-
// session window: each construct's series advances independently, exactly
// once per its own episode, and the Progress read layer retrieves the
// latest persisted row per construct rather than expecting every run to
// touch every construct.
//
// This engine is architecturally still a per-call batch fetch (it re-reads
// a patient's full recent history every invocation, matching every other
// module in this codebase — there is no event/queue infrastructure here to
// hook into). The SMALLEST change that produces the required episode-scoped
// SEMANTIC is accepting an explicit `rehabSessionId` naming which episode
// triggered this run, and scoping "which constructs to (re)persist" to
// exactly that episode's own prescription_snapshot — never "whatever the
// single most-recent session across the whole account happens to contain".
// When no explicit episode is given (ad-hoc/manual invocation), this
// defaults to the patient's own most recent base episode as a convenience,
// not as the production trigger semantic.

import { createServiceRoleClient } from "./supabase/server";
import type { PrescriptionSnapshotExercise } from "./rehabSessionTypes";
import type { ToleranceClassification, ImmediateGuidance } from "./morningResponseTypes";
import { buildCapacityExposures, type RawSetOutcomeRow } from "./capacityExposure";
import { constructKey as buildConstructKey, deriveComparableConstruct } from "./capacityConstruct";
import { classifyCapacity } from "./capacityClassifier";
import type { CapacityExposure, ComparableConstruct } from "./capacityTypes";
import type { InterpretationReasonCode } from "./longitudinalInterpretationTypes";
import { persistInterpretation } from "./longitudinalInterpretationEngine";
import {
  CAPACITY_COMPARABLE_SERIES_DEFINITION_HEURISTIC_KEY,
  PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY,
  CAPACITY_COMPARABLE_DEMONSTRATIONS_2_OF_4_HEURISTIC_KEY,
  SUCCESSFUL_CAPACITY_EXPOSURE_QUALIFICATION_HEURISTIC_KEY,
  CAPACITY_STATE_MAPPING_HEURISTIC_KEY,
} from "./capacityHeuristics";

const CAPACITY_SERIES_DOMAIN = "capacity_series";

// Generous — a construct might only be prescribed intermittently, so
// classifying it needs deeper history than the raw session count itself.
const RAW_SESSION_FETCH_LIMIT = 400;

export type SessionRow = {
  id: string;
  patient_local_date: string;
  prescription_version_id: string | null;
  status: string;
  prescription_snapshot: PrescriptionSnapshotExercise[];
};
type MorningRow = { rehab_session_id: string; submitted_at: string | null };
type ToleranceRow = {
  id: string;
  rehab_session_id: string;
  tolerance_classification: ToleranceClassification;
  immediate_guidance: ImmediateGuidance | null;
};
type LoadObsRow = { rehab_session_id: string; category: string };
type RawSetOutcomeRowWithSession = RawSetOutcomeRow & { rehab_session_id: string };

async function fetchRawCapacityInputs(userId: string) {
  const supabase = createServiceRoleClient();

  const { data: sessionRows } = await supabase
    .from("rehab_sessions")
    .select("id, patient_local_date, prescription_version_id, status, prescription_snapshot")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(RAW_SESSION_FETCH_LIMIT);
  const sessions = (sessionRows ?? []) as SessionRow[];
  const sessionIds = sessions.map((s) => s.id);

  const [morningRes, toleranceRes, setOutcomeRes, loadObsRes] = await Promise.all([
    sessionIds.length
      ? supabase.from("morning_responses").select("rehab_session_id, submitted_at").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as MorningRow[] }),
    sessionIds.length
      ? supabase
          .from("tolerance_evaluations")
          .select("id, rehab_session_id, tolerance_classification, immediate_guidance")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as ToleranceRow[] }),
    sessionIds.length
      ? supabase
          .from("set_outcomes")
          .select("rehab_session_id, exercise_id, set_index, outcome, prescribed_reps, prescribed_load, actual_reps, actual_load")
          .in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as RawSetOutcomeRowWithSession[] }),
    sessionIds.length
      ? supabase.from("session_load_observations").select("rehab_session_id, category").in("rehab_session_id", sessionIds)
      : Promise.resolve({ data: [] as LoadObsRow[] }),
  ]);

  const finalizedMorningSessionIds = new Set(
    ((morningRes.data ?? []) as MorningRow[]).filter((r) => r.submitted_at != null).map((r) => r.rehab_session_id)
  );
  const toleranceBySession = new Map<string, ToleranceRow>();
  for (const row of (toleranceRes.data ?? []) as ToleranceRow[]) {
    if (!toleranceBySession.has(row.rehab_session_id)) toleranceBySession.set(row.rehab_session_id, row);
  }
  const setOutcomesBySession = new Map<string, RawSetOutcomeRowWithSession[]>();
  for (const row of (setOutcomeRes.data ?? []) as RawSetOutcomeRowWithSession[]) {
    const list = setOutcomesBySession.get(row.rehab_session_id) ?? [];
    list.push(row);
    setOutcomesBySession.set(row.rehab_session_id, list);
  }
  const sessionsWithSetOutcomes = new Set(setOutcomesBySession.keys());
  const sessionsWithExternalLoad = new Set(
    ((loadObsRes.data ?? []) as LoadObsRow[]).filter((r) => r.category !== "none").map((r) => r.rehab_session_id)
  );

  return { sessions, finalizedMorningSessionIds, toleranceBySession, setOutcomesBySession, sessionsWithSetOutcomes, sessionsWithExternalLoad };
}

// Reusable across engines: every CapacityExposure for a patient's base
// response episodes (session + actual performance + finalized M4 response +
// tolerance evaluation), newest-first, unfiltered by construct currency —
// plus the set of session ids with any recorded external-load context, and
// every base session row (so a caller can pick out a specific episode).
// Exported so trainingResponseInterpretationEngine.ts can build exposures
// for the EXACT same window Stage 3B used (brief section 12) without
// duplicating this fetch/build logic.
export async function buildAllCapacityExposuresForUser(
  userId: string
): Promise<{ allExposuresNewestFirst: CapacityExposure[]; sessionsWithExternalLoad: Set<string>; baseSessionsNewestFirst: SessionRow[] }> {
  const { sessions, finalizedMorningSessionIds, toleranceBySession, setOutcomesBySession, sessionsWithSetOutcomes, sessionsWithExternalLoad } =
    await fetchRawCapacityInputs(userId);

  // Base gate — same atomic unit as Stage 3B's response episode (session +
  // actual performance + finalized M4 response + tolerance evaluation).
  const baseSessions = sessions.filter(
    (s) => s.status === "response_complete" && sessionsWithSetOutcomes.has(s.id) && finalizedMorningSessionIds.has(s.id) && toleranceBySession.has(s.id)
  );

  // Newest-first already (query order) — build every exposure per session.
  const exposuresBySessionNewestFirst: CapacityExposure[][] = baseSessions.map((s) => {
    const tolerance = toleranceBySession.get(s.id) as ToleranceRow;
    return buildCapacityExposures({
      rehabSessionId: s.id,
      userId,
      patientLocalDate: s.patient_local_date,
      prescriptionVersionId: s.prescription_version_id,
      toleranceEvaluationId: tolerance.id,
      toleranceClassification: tolerance.tolerance_classification,
      immediateGuidance: tolerance.immediate_guidance,
      prescriptionSnapshot: s.prescription_snapshot,
      setOutcomes: setOutcomesBySession.get(s.id) ?? [],
    });
  });

  return { allExposuresNewestFirst: exposuresBySessionNewestFirst.flat(), sessionsWithExternalLoad, baseSessionsNewestFirst: baseSessions };
}

export type CapacityEngineResult = {
  generated: Array<{ interpretationId: string; construct: ComparableConstruct; state: string }>;
};

// `rehabSessionId`: the specific completed response episode that triggered
// this run (brief section 7). Only the construct(s) present in THAT
// episode's own prescription_snapshot are (re)evaluated/persisted — never
// "whatever the single most-recent session across the account contains".
// Omit it only for ad-hoc/manual invocation (defaults to the patient's own
// most recent base episode) — not the intended production trigger shape.
export async function generateCapacityInterpretations(userId: string, rehabSessionId?: string): Promise<CapacityEngineResult> {
  const supabase = createServiceRoleClient();
  const { allExposuresNewestFirst, sessionsWithExternalLoad, baseSessionsNewestFirst } = await buildAllCapacityExposuresForUser(userId);

  const targetSession = rehabSessionId ? baseSessionsNewestFirst.find((s) => s.id === rehabSessionId) : baseSessionsNewestFirst[0];
  if (!targetSession) return { generated: [] };

  // Constructs present in THIS episode only — never other constructs that
  // simply happen to exist elsewhere in the patient's history.
  const episodeConstructKeys = new Set(
    targetSession.prescription_snapshot
      .map((ex) => deriveComparableConstruct(ex))
      .filter((c) => c.performanceUnit !== "unrepresentable")
      .map((c) => buildConstructKey(c))
  );

  const exposuresByConstruct = new Map<string, CapacityExposure[]>();
  for (const e of allExposuresNewestFirst) {
    const key = buildConstructKey(e.construct);
    if (!episodeConstructKeys.has(key)) continue;
    const list = exposuresByConstruct.get(key) ?? [];
    list.push(e);
    exposuresByConstruct.set(key, list);
  }

  const result: CapacityEngineResult = { generated: [] };

  for (const exposuresNewestFirst of exposuresByConstruct.values()) {
    const { state, facts } = classifyCapacity(exposuresNewestFirst);

    const relevantRehabSessionIds = [...new Set([...facts.recentOpportunityRehabSessionIds, ...(facts.baselineRehabSessionId ? [facts.baselineRehabSessionId] : [])])];
    const relevantExposures = exposuresNewestFirst.filter((e) => relevantRehabSessionIds.includes(e.rehabSessionId));
    const toleranceEvaluationIds = [...new Set(relevantExposures.map((e) => e.toleranceEvaluationId))];
    const prescriptionVersionIds = [...new Set(relevantExposures.map((e) => e.prescriptionVersionId).filter((id): id is string => id != null))];

    const reasonCodes: InterpretationReasonCode[] = [];
    if (relevantRehabSessionIds.some((id) => sessionsWithExternalLoad.has(id))) reasonCodes.push("external_loading_context_present");

    const windowDates = relevantExposures.map((e) => e.patientLocalDate).sort();

    const interpretationId = await persistInterpretation(supabase, {
      userId,
      domain: CAPACITY_SERIES_DOMAIN,
      resultState: state,
      windowDefinition: {
        kind: "comparable_construct_2_of_4",
        unit: "comparable_recorded_prescribed_opportunities",
        triggeringRehabSessionId: targetSession.id,
        construct: facts.construct,
        baselineRehabSessionId: facts.baselineRehabSessionId,
        recentOpportunityRehabSessionIds: facts.recentOpportunityRehabSessionIds,
      },
      windowStartDate: windowDates[0] ?? null,
      windowEndDate: windowDates[windowDates.length - 1] ?? null,
      resultDetail: {
        construct: facts.construct,
        qualifyingDemonstrationCount: facts.qualifyingDemonstrationCount,
        qualifyingDemonstrationRehabSessionIds: facts.qualifyingDemonstrationRehabSessionIds,
        wellToleratedQualifyingCount: facts.wellToleratedQualifyingCount,
        cautionMaintainQualifyingCount: facts.cautionMaintainQualifyingCount,
        confirmedByTwoOfFourRule: facts.confirmedByTwoOfFourRule,
        recentLoadingLowerThanPrior: facts.recentLoadingLowerThanPrior,
        // LOCKED phrasing (brief section 9) — never "declining".
        recentLoadingLowerThanPriorNote: facts.recentLoadingLowerThanPrior ? "Recent loading has been lower." : null,
        // Distinguishes "not enough history yet" from "consistently lower
        // loading" — both resolve to more_comparable_data_needed, but the
        // reason is materially different and preserved, never discarded.
        moreDataNeededReason: facts.moreDataNeededReason,
        // Mechanical-only evidence (tolerance-independent) — the basis for
        // loading_pattern_variable. Never derived from or gated by tolerance.
        mechanicallyHigherRehabSessionIds: facts.mechanicallyHigherRehabSessionIds,
        mechanicallyLowerRehabSessionIds: facts.mechanicallyLowerRehabSessionIds,
        hasNonDominatingExposure: facts.hasNonDominatingExposure,
        // Full set-level provenance — the real, un-collapsed demonstrated
        // performance, never discarded after classification (brief section
        // 5/12): every set's own reps/hold-duration paired with that SAME
        // set's own load, never reordered or aggregated.
        recentOpportunities: relevantExposures.map((e) => ({
          rehabSessionId: e.rehabSessionId,
          patientLocalDate: e.patientLocalDate,
          performanceUnit: e.construct.performanceUnit,
          prescribedSets: e.prescribed,
          actualSets: e.actual,
          toleranceClassification: e.toleranceClassification,
          immediateGuidance: e.immediateGuidance,
          isSuccessfulExposure: e.isSuccessfulExposure,
        })),
      },
      rehabSessionIds: relevantRehabSessionIds,
      morningResponseIds: [],
      toleranceEvaluationIds,
      prescriptionVersionIds,
      reasonCodes,
      heuristicKeys: [
        CAPACITY_COMPARABLE_SERIES_DEFINITION_HEURISTIC_KEY,
        PARTIAL_ORDER_LOADING_COMPARISON_HEURISTIC_KEY,
        CAPACITY_COMPARABLE_DEMONSTRATIONS_2_OF_4_HEURISTIC_KEY,
        SUCCESSFUL_CAPACITY_EXPOSURE_QUALIFICATION_HEURISTIC_KEY,
        CAPACITY_STATE_MAPPING_HEURISTIC_KEY,
      ],
    });

    result.generated.push({ interpretationId, construct: facts.construct, state });
  }

  return result;
}

// Retrieves the latest persisted Capacity interpretation for each
// comparable construct a patient has ANY history for — the read-side
// counterpart to episode-scoped generation (brief section 7): since a given
// run only touches the construct(s) in its triggering episode, "the current
// Capacity picture" for a patient is assembled by taking the most recent
// row PER construct, not the most recent row overall (which would only
// reflect whichever construct happened to be trained most recently).
export async function getLatestCapacityInterpretationsByConstruct(userId: string): Promise<Array<{ construct: unknown; interpretation: Record<string, unknown> }>> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("m6_longitudinal_interpretations")
    .select()
    .eq("user_id", userId)
    .eq("domain", CAPACITY_SERIES_DOMAIN)
    .order("generated_at", { ascending: false });
  if (error) throw new Error(`getLatestCapacityInterpretationsByConstruct failed: ${error.message}`);

  const latestByConstruct = new Map<string, Record<string, unknown>>();
  for (const row of data ?? []) {
    const construct = (row.window_definition as Record<string, unknown> | null)?.construct;
    if (!construct) continue;
    const key = JSON.stringify(construct);
    if (!latestByConstruct.has(key)) latestByConstruct.set(key, row); // first hit per construct is the latest (already ordered desc)
  }
  return [...latestByConstruct.entries()].map(([, interpretation]) => ({ construct: (interpretation.window_definition as Record<string, unknown>).construct, interpretation }));
}
