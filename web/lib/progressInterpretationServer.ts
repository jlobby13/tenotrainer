import "server-only";

// Milestone 6, Stage 4 — thin, read-only composition layer over the
// Stage 3A/3B/3C longitudinal interpretation tables, for the patient-facing
// /patient/progress page.
//
// This module recomputes NOTHING: every resultState/resultDetail value
// returned here is read verbatim from an already-persisted
// m6_longitudinal_interpretations row (via the existing Stage 3A/3C read
// helpers — longitudinalInterpretationServer.ts,
// capacityInterpretationEngine.ts). It contains no clinical logic, no
// threshold, no aggregation across Capacity constructs into an overall
// score, and no new progress state. Its only real work is:
//   1. fetching the latest interpretation per domain (Symptoms; Capacity,
//      per comparable construct; Training Response) in parallel, and
//   2. resolving a patient-safe display name for each Capacity construct's
//      exId from the patient's own real prescription history (never the
//      raw exId, never assuming the construct is still in the CURRENT
//      prescription — see resolveExerciseNames below).

import { createServiceRoleClient } from "./supabase/server";
import { listLongitudinalInterpretationsForPatient } from "./longitudinalInterpretationServer";
import { getLatestCapacityInterpretationsByConstruct } from "./capacityInterpretationEngine";
import type { PrescriptionSnapshotExercise } from "./rehabSessionTypes";
import type { ComparableConstruct } from "./capacityTypes";
import { constructKey as buildConstructKey } from "./capacityConstruct";
import type {
  ProgressInterpretationData,
  SymptomsInterpretationSummary,
  CapacityConstructSummary,
  TrainingResponseSummary,
} from "./progressInterpretationTypes";

const SYMPTOMS_SHORT_WINDOW_DOMAIN = "symptoms_short_window";
const TRAINING_RESPONSE_SERIES_DOMAIN = "training_response_series";

// Generous — mirrors the RAW_SESSION_FETCH_LIMIT convention already used by
// every other M6 engine in this codebase (progressServer.ts,
// capacityInterpretationEngine.ts, longitudinalInterpretationEngine.ts): a
// low-frequency rotating construct may need a deep lookback before its
// name is found.
const EXERCISE_NAME_LOOKUP_SESSION_LIMIT = 400;

// LOCKED (founder direction): resolve each construct's display name from
// the MOST RECENT real prescription snapshot that actually named it —
// never only the current/live prescription (a historical/rotating A/B
// construct may not appear there at all), and never a live exercise-
// library lookup (prescription_snapshot is this codebase's only source of
// truth for what a session actually prescribed — see
// capacityConstruct.ts's own header note on there being no FK-enforced
// exercise catalog). Sessions are queried newest-first, so the FIRST match
// found per exId is already the most recent one — no extra sort needed.
async function resolveExerciseNames(userId: string, exIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const remaining = new Set(exIds);
  if (remaining.size === 0) return names;

  const supabase = createServiceRoleClient();
  const { data: sessionRows } = await supabase
    .from("rehab_sessions")
    .select("prescription_snapshot")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(EXERCISE_NAME_LOOKUP_SESSION_LIMIT);

  for (const row of (sessionRows ?? []) as { prescription_snapshot: PrescriptionSnapshotExercise[] | null }[]) {
    if (remaining.size === 0) break;
    for (const ex of row.prescription_snapshot ?? []) {
      if (remaining.has(ex.ex_id) && ex.name) {
        names.set(ex.ex_id, ex.name);
        remaining.delete(ex.ex_id);
      }
    }
  }
  return names;
}

async function buildCapacityConstructSummaries(userId: string): Promise<CapacityConstructSummary[]> {
  const rows = await getLatestCapacityInterpretationsByConstruct(userId);
  if (rows.length === 0) return [];

  const constructs = rows.map((r) => r.construct as ComparableConstruct | undefined).filter((c): c is ComparableConstruct => c != null);
  const exIds = [...new Set(constructs.map((c) => c.exId))];
  const namesByExId = await resolveExerciseNames(userId, exIds);

  const summaries: CapacityConstructSummary[] = [];
  for (const { construct, interpretation } of rows) {
    const c = construct as ComparableConstruct | undefined;
    if (!c) continue;
    const resultDetail = (interpretation.result_detail as Record<string, unknown>) ?? {};
    summaries.push({
      constructKey: buildConstructKey(c),
      exId: c.exId,
      loadingProfile: c.loadingProfile,
      performanceUnit: c.performanceUnit,
      exerciseName: namesByExId.get(c.exId) ?? null,
      resultState: interpretation.result_state as string,
      moreDataNeededReason: (resultDetail.moreDataNeededReason as string | null) ?? null,
      generatedAt: interpretation.generated_at as string,
    });
  }
  return summaries;
}

export async function getProgressInterpretationData(userId: string): Promise<ProgressInterpretationData> {
  const [symptomsRows, capacityConstructs, trainingResponseRows] = await Promise.all([
    listLongitudinalInterpretationsForPatient(userId, { domain: SYMPTOMS_SHORT_WINDOW_DOMAIN, limit: 1 }),
    buildCapacityConstructSummaries(userId),
    listLongitudinalInterpretationsForPatient(userId, { domain: TRAINING_RESPONSE_SERIES_DOMAIN, limit: 1 }),
  ]);

  const symptomsRow = symptomsRows[0] ?? null;
  const symptoms: SymptomsInterpretationSummary = symptomsRow
    ? { resultState: symptomsRow.resultState, generatedAt: symptomsRow.generatedAt }
    : null;

  const trainingResponseRow = trainingResponseRows[0] ?? null;
  const trainingResponse: TrainingResponseSummary = trainingResponseRow
    ? {
        resultState: trainingResponseRow.resultState,
        hasInsufficientConstruct: Boolean((trainingResponseRow.resultDetail as Record<string, unknown> | null)?.hasInsufficientConstruct),
        overallLoadingDirection: ((trainingResponseRow.resultDetail as Record<string, unknown> | null)?.overallLoadingDirection as string | null) ?? null,
        generatedAt: trainingResponseRow.generatedAt,
      }
    : null;

  return { symptoms, capacityConstructs, trainingResponse };
}
