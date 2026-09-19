import "server-only";

// C4 — Clinical Decision Support server composition layer. Same contract as
// clinicianPatientOverviewServer.ts / clinicianPatientProgressServer.ts:
// assumes authorization has ALREADY happened (requireClinicianAuth() +
// assertSupervises()). Nothing here performs its own authorization check.
//
// READ-SIDE COMPOSITION ONLY. This file calls ONLY existing read functions —
// getActiveBrakeStatus(), listLongitudinalInterpretationsForPatient() — plus
// two small, local, read-only queries (latest-2 prescription_versions rows;
// a single existence check for "any qualifying session at all"). It NEVER
// imports or calls:
//   - any M6 classifier/generator (classifyCoreDomain, classifyCapacity,
//     classifyTrainingResponse, compareSetVectors, compareWindowLoading,
//     generateShortWindowSymptomInterpretation, generateCapacityInterpretations,
//     generateTrainingResponseInterpretation, persistInterpretation)
//   - the legacy FastAPI progression engine (app/engine/rules.py —
//     evaluate_exercise_progression, run_decision_engine) — that engine is
//     Python, reachable only from the retired /daily-log route, reads the
//     legacy SQLite daily_logs table, and has NO connection whatsoever to
//     this Postgres-native architecture (confirmed in the C4 audit). It is
//     not referenced anywhere in this file, by design.
//   - guidance.ts's patient-relevance/supersession framing (that concept
//     answers a different question — "is this still relevant to the
//     patient's dashboard" — and must never be restated as a clinician
//     review signal)
//
// Every "changed" comparison is a trivial current-vs-previous check on
// already-persisted rows (Section 19 of the C4 brief); every "current
// state" signal is a direct allowlist match against an already-persisted
// resultState. No two independent domain signals are ever combined into a
// new derived one — grep confirms it, and a structural test enforces it
// (see lib/__tests__/clinicianPatientReview.test.ts).

import { createServiceRoleClient } from "./supabase/server";
import { getActiveBrakeStatus } from "./acuteSafetyServer";
import { listLongitudinalInterpretationsForPatient, getInterpretationProvenance } from "./longitudinalInterpretationServer";
import { deriveMorningResponseBadge, type RosterMorningResponseStatus } from "./clinicianRoster";
import { mapPrescriptionVersionRow } from "./prescriptionVersionTypes";
import type { LongitudinalInterpretationRecord } from "./longitudinalInterpretationTypes";
import type { ComparableConstruct } from "./capacityTypes";
import type { MoreDataNeededReason } from "./capacityClassifier";
import {
  detectStateChange,
  detectCapacityConstructChange,
  detectPrescriptionChange,
  symptomsReviewSignal,
  trainingResponseReviewSignal,
  isMoreDataNeededState,
  capacityRecentLoadingLowerSignal,
  type SimpleStateChange,
  type CapacityConstructRow,
  type CapacityConstructChangeItem,
  type PrescriptionChangeItem,
  type PrescriptionVersionSnapshot,
  type SymptomsReviewSignal,
  type TrainingResponseReviewSignal,
} from "./clinicianPatientReview";

const SYMPTOMS_DOMAIN = "symptoms_short_window";
const CAPACITY_DOMAIN = "capacity_series";
const TRAINING_RESPONSE_DOMAIN = "training_response_series";

// Latest + previous only — same locked history depth as C3, reused here for
// the identical reason: enough to answer "did this just change," never a
// timeline.
const HISTORY_DEPTH = 2;

export type SymptomsWhatChanged = SimpleStateChange | null;
export type TrainingResponseWhatChanged = SimpleStateChange | null;

export type SymptomsReviewContext = {
  signal: SymptomsReviewSignal | null;
  moreDataNeeded: boolean;
  interpretationId: string | null;
  // True only when THIS SAME surfaced interpretation's own persisted
  // reason codes include external_loading_context_present (Section 16) —
  // never inferred, never attached to an unrelated interpretation.
  externalLoadReported: boolean;
};

export type TrainingResponseReviewContext = {
  signal: TrainingResponseReviewSignal | null;
  moreDataNeeded: boolean;
  interpretationId: string | null;
  externalLoadReported: boolean;
};

export type CapacityConstructView = {
  constructKey: string;
  displayName: string;
  construct: ComparableConstruct;
  change: CapacityConstructChangeItem | null;
  recentLoadingLower: boolean;
  moreDataNeededReason: MoreDataNeededReason | null;
  interpretationId: string;
  externalLoadReported: boolean;
};

export type ClinicianPatientReview = {
  patientId: string;
  displayName: string;
  acuteReviewActive: boolean;
  whatChanged: {
    symptoms: SymptomsWhatChanged;
    trainingResponse: TrainingResponseWhatChanged;
    capacityConstructs: Extract<CapacityConstructChangeItem, { kind: "new" | "changed" }>[];
    capacityConstructDisplayNames: Map<string, string>;
    prescription: PrescriptionChangeItem;
  };
  reviewContext: {
    symptoms: SymptomsReviewContext;
    trainingResponse: TrainingResponseReviewContext;
    capacityRecentLower: CapacityConstructView[];
    morningResponseStatus: RosterMorningResponseStatus;
    noRecentQualifyingSession: boolean;
  };
};

// Tiny, local, read-only lookup — mirrors the exact same pattern already
// used twice (clinicianServer.ts for the roster, clinicianPatientOverviewServer.ts
// for the patient shell) rather than importing/refactoring either accepted
// file. Deliberately NOT calling ensureMorningResponseExists() — no write
// side effect belongs on a read-only review page.
async function getOutstandingMorningResponseStatus(
  supabase: ReturnType<typeof createServiceRoleClient>,
  patientId: string,
  now: Date
): Promise<RosterMorningResponseStatus> {
  const { data: awaitingSessions, error: awaitingError } = await supabase
    .from("rehab_sessions")
    .select("id")
    .eq("user_id", patientId)
    .eq("status", "awaiting_morning_response");
  if (awaitingError) throw new Error(`getOutstandingMorningResponseStatus failed: ${awaitingError.message}`);

  const awaitingIds = (awaitingSessions ?? []).map((s) => s.id as string);
  if (awaitingIds.length === 0) return null;

  const { data: morningRows, error: morningError } = await supabase
    .from("morning_responses")
    .select("rehab_session_id, scheduled_eligible_at, submitted_at")
    .in("rehab_session_id", awaitingIds);
  if (morningError) throw new Error(`getOutstandingMorningResponseStatus failed: ${morningError.message}`);

  const bySessionId = new Map((morningRows ?? []).map((r) => [r.rehab_session_id as string, r]));
  const outstanding: { scheduledEligibleAt: string | null }[] = [];
  for (const id of awaitingIds) {
    const row = bySessionId.get(id);
    if (row && row.submitted_at !== null) continue;
    outstanding.push({ scheduledEligibleAt: (row?.scheduled_eligible_at as string | null) ?? null });
  }
  return deriveMorningResponseBadge(outstanding, now);
}

// Latest-2 prescription_versions rows, directly — prescriptionVersionsServer.ts
// only exports getLatestPrescriptionVersion() (a single row), which isn't
// enough for a "current vs previous" comparison, so this reads one row
// beyond what that function returns. No new writer, no new table, no
// modification to that file.
async function getLatestTwoPrescriptionVersions(
  supabase: ReturnType<typeof createServiceRoleClient>,
  patientId: string
): Promise<PrescriptionVersionSnapshot[]> {
  const { data, error } = await supabase
    .from("prescription_versions")
    .select()
    .eq("user_id", patientId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_DEPTH);
  if (error) throw new Error(`getLatestTwoPrescriptionVersions failed: ${error.message}`);
  return (data ?? []).map((row) => {
    const mapped = mapPrescriptionVersionRow(row);
    return { id: mapped.id, createdAt: mapped.createdAt, stage: mapped.stage, irritability: mapped.irritability, isInsertional: mapped.isInsertional, source: mapped.source };
  });
}

// Exercise-name resolution for Capacity constructs — the exact same small,
// local, C4-scoped lookup technique C3 already uses (never reusing/exporting
// progressInterpretationServer.ts's private resolveExerciseNames(), per the
// "protect existing behavior" precedent). C4 doesn't fetch Capacity's own
// recentOpportunities (that's C3's job) — names are resolved from a batched
// scan of the patient's own rehab_sessions.prescription_snapshot instead,
// matching on (ex_id, loading_profile) exactly like C3's own resolver.
async function resolveExerciseDisplayNamesForConstructs(
  supabase: ReturnType<typeof createServiceRoleClient>,
  patientId: string,
  constructs: ComparableConstruct[]
): Promise<Map<string, string>> {
  if (constructs.length === 0) return new Map();

  const { data, error } = await supabase.from("rehab_sessions").select("prescription_snapshot").eq("user_id", patientId);
  if (error) throw new Error(`resolveExerciseDisplayNamesForConstructs failed: ${error.message}`);

  const nameByExIdAndProfile = new Map<string, string>();
  for (const row of data ?? []) {
    for (const ex of (row.prescription_snapshot as { ex_id: string; name: string; loading_profile: string | null }[]) ?? []) {
      nameByExIdAndProfile.set(`${ex.ex_id}::${ex.loading_profile ?? ""}`, ex.name);
    }
  }

  const displayNameByConstructKey = new Map<string, string>();
  for (const construct of constructs) {
    const key = JSON.stringify(construct);
    const name = nameByExIdAndProfile.get(`${construct.exId}::${construct.loadingProfile ?? ""}`) ?? construct.exId;
    displayNameByConstructKey.set(key, name);
  }
  return displayNameByConstructKey;
}

async function hasExternalLoadReasonCode(interpretationId: string): Promise<boolean> {
  const provenance = await getInterpretationProvenance(interpretationId);
  return provenance.reasonCodes.includes("external_loading_context_present");
}

export async function getClinicianPatientReview(patientId: string): Promise<ClinicianPatientReview | null> {
  const supabase = createServiceRoleClient();
  const now = new Date();

  const { data: profile, error: profileError } = await supabase.from("profiles").select("id, name").eq("id", patientId).maybeSingle();
  if (profileError) throw new Error(`getClinicianPatientReview failed: ${profileError.message}`);
  if (!profile) return null;

  const [brakeStatus, symptomsRows, trainingResponseRows, capacityRows, prescriptionVersions, morningResponseStatus, hasQualifyingSessionRes] = await Promise.all([
    getActiveBrakeStatus(patientId),
    listLongitudinalInterpretationsForPatient(patientId, { domain: SYMPTOMS_DOMAIN, limit: HISTORY_DEPTH }),
    listLongitudinalInterpretationsForPatient(patientId, { domain: TRAINING_RESPONSE_DOMAIN, limit: HISTORY_DEPTH }),
    listLongitudinalInterpretationsForPatient(patientId, { domain: CAPACITY_DOMAIN }),
    getLatestTwoPrescriptionVersions(supabase, patientId),
    getOutstandingMorningResponseStatus(supabase, patientId, now),
    supabase.from("rehab_sessions").select("id", { count: "exact", head: true }).eq("user_id", patientId).not("exercise_outcome", "is", null),
  ]);
  if (hasQualifyingSessionRes.error) throw new Error(`getClinicianPatientReview failed: ${hasQualifyingSessionRes.error.message}`);

  const [symptomsCurrentRow, symptomsPreviousRow] = symptomsRows;
  const [trCurrentRow, trPreviousRow] = trainingResponseRows;

  const symptomsChange = detectStateChange(
    symptomsCurrentRow ? { id: symptomsCurrentRow.id, resultState: symptomsCurrentRow.resultState } : null,
    symptomsPreviousRow ? { resultState: symptomsPreviousRow.resultState } : null
  );
  const trainingResponseChange = detectStateChange(
    trCurrentRow ? { id: trCurrentRow.id, resultState: trCurrentRow.resultState } : null,
    trPreviousRow ? { resultState: trPreviousRow.resultState } : null
  );

  const symptomsSignalValue = symptomsCurrentRow ? symptomsReviewSignal(symptomsCurrentRow.resultState) : null;
  const trSignalValue = trCurrentRow ? trainingResponseReviewSignal(trCurrentRow.resultState) : null;
  const symptomsMoreDataNeeded = symptomsCurrentRow ? isMoreDataNeededState(symptomsCurrentRow.resultState) : false;
  const trMoreDataNeeded = trCurrentRow ? isMoreDataNeededState(trCurrentRow.resultState) : false;

  // Group every capacity_series row by construct identity (already directly
  // present per-row in window_definition.construct — never reconstructed),
  // taking up to HISTORY_DEPTH rows per construct, exactly as C3 does.
  const byConstruct = new Map<string, LongitudinalInterpretationRecord[]>();
  for (const row of capacityRows) {
    const construct = (row.windowDefinition as { construct?: ComparableConstruct } | null)?.construct;
    if (!construct) continue;
    const key = JSON.stringify(construct);
    const list = byConstruct.get(key) ?? [];
    if (list.length < HISTORY_DEPTH) list.push(row);
    byConstruct.set(key, list);
  }

  function toCapacityRow(row: LongitudinalInterpretationRecord): CapacityConstructRow {
    const detail = row.resultDetail as { construct: ComparableConstruct; moreDataNeededReason: MoreDataNeededReason | null };
    return { interpretationId: row.id, construct: detail.construct, resultState: row.resultState, moreDataNeededReason: detail.moreDataNeededReason ?? null };
  }

  const capacityConstructRows: { key: string; current: CapacityConstructRow; change: CapacityConstructChangeItem | null }[] = [];
  for (const [key, rows] of byConstruct.entries()) {
    const [currentRow, previousRow] = rows;
    const current = toCapacityRow(currentRow);
    const previous = previousRow ? toCapacityRow(previousRow) : null;
    capacityConstructRows.push({ key, current, change: detectCapacityConstructChange(current, previous) });
  }

  const capacityDisplayNames = await resolveExerciseDisplayNamesForConstructs(
    supabase,
    patientId,
    capacityConstructRows.map((c) => c.current.construct)
  );

  const capacityChanges = capacityConstructRows
    .map((c) => c.change)
    .filter((c): c is Extract<CapacityConstructChangeItem, { kind: "new" | "changed" }> => c !== null);

  const capacityRecentLowerRows = capacityConstructRows.filter((c) => capacityRecentLoadingLowerSignal(c.current));

  // External-load presence is checked ONLY for interpretations already
  // being surfaced as a signal (Section 16) — never fetched eagerly for
  // every interpretation, and never attached to one that isn't already
  // shown. Reuses getInterpretationProvenance() verbatim (no new query
  // shape, no classifier).
  const [symptomsExternalLoad, trExternalLoad, capacityExternalLoadFlags] = await Promise.all([
    symptomsSignalValue !== null && symptomsCurrentRow ? hasExternalLoadReasonCode(symptomsCurrentRow.id) : Promise.resolve(false),
    trSignalValue !== null && trCurrentRow ? hasExternalLoadReasonCode(trCurrentRow.id) : Promise.resolve(false),
    Promise.all(capacityRecentLowerRows.map((c) => hasExternalLoadReasonCode(c.current.interpretationId))),
  ]);

  const capacityRecentLower: CapacityConstructView[] = capacityRecentLowerRows.map((c, index) => ({
    constructKey: c.key,
    displayName: capacityDisplayNames.get(c.key) ?? c.current.construct.exId,
    construct: c.current.construct,
    change: c.change,
    recentLoadingLower: true,
    moreDataNeededReason: c.current.moreDataNeededReason,
    interpretationId: c.current.interpretationId,
    externalLoadReported: capacityExternalLoadFlags[index] ?? false,
  }));

  const [currentVersion, previousVersion] = prescriptionVersions;
  const prescriptionChange = detectPrescriptionChange(currentVersion ?? null, previousVersion ?? null);

  const symptomsReviewCtx: SymptomsReviewContext = {
    signal: symptomsSignalValue,
    moreDataNeeded: symptomsMoreDataNeeded,
    interpretationId: symptomsCurrentRow?.id ?? null,
    externalLoadReported: symptomsExternalLoad,
  };
  const trainingResponseReviewCtx: TrainingResponseReviewContext = {
    signal: trSignalValue,
    moreDataNeeded: trMoreDataNeeded,
    interpretationId: trCurrentRow?.id ?? null,
    externalLoadReported: trExternalLoad,
  };

  return {
    patientId: profile.id as string,
    displayName: profile.name as string,
    acuteReviewActive: brakeStatus != null,
    whatChanged: {
      symptoms: symptomsChange,
      trainingResponse: trainingResponseChange,
      capacityConstructs: capacityChanges,
      capacityConstructDisplayNames: capacityDisplayNames,
      prescription: prescriptionChange,
    },
    reviewContext: {
      symptoms: symptomsReviewCtx,
      trainingResponse: trainingResponseReviewCtx,
      capacityRecentLower,
      morningResponseStatus,
      noRecentQualifyingSession: (hasQualifyingSessionRes.count ?? 0) === 0,
    },
  };
}
