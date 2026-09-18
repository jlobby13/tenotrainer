import "server-only";

// C3 — Longitudinal Clinical Progress server composition layer. Same
// contract as clinicianPatientOverviewServer.ts: assumes authorization has
// ALREADY happened (requireClinicianAuth() + assertSupervises()). Nothing
// here performs its own authorization check.
//
// HARD BOUNDARY: this file exposes the EXISTING M6 persisted longitudinal
// interpretation architecture — it never recomputes, reinterprets, or
// generates a new interpretation. It calls ONLY the existing read-side
// functions (`listLongitudinalInterpretationsForPatient`,
// `getInterpretationProvenance`, `getHeuristicsByIds`) — never
// `generateShortWindowSymptomInterpretation`, `generateCapacityInterpretations`,
// `generateTrainingResponseInterpretation`, or any classifier function
// (`classifyCoreDomain`, `classifyCapacity`, `classifyTrainingResponse`,
// `compareSetVectors`, `compareWindowLoading`, etc.). None of those names
// are imported anywhere in this file — grep confirms it, and a structural
// test enforces it (see lib/__tests__/clinicianPatientProgress.test.ts).
//
// C3 EXCLUSION (unchanged from C2): never queries Symptoms/Capacity/
// Training Response classification logic beyond reading the already-
// persisted `m6_longitudinal_interpretations` rows — there is no "C4" reach
// here (no generated recommendation, no prescription-action language).
//
// Query architecture: one profile lookup, then a parallel batch of the
// three domains' latest-2 (Symptoms/Training Response) or latest-per-
// construct (Capacity) interpretation reads plus the active-brake status,
// then a second parallel batch of per-interpretation provenance (itself
// already a 6-way parallel batch inside getInterpretationProvenance) plus
// one batched rehab_sessions date lookup and one batched heuristics lookup.

import { createServiceRoleClient } from "./supabase/server";
import { listLongitudinalInterpretationsForPatient, getInterpretationProvenance } from "./longitudinalInterpretationServer";
import { getActiveBrakeStatus } from "./acuteSafetyServer";
import { getHeuristicsByIds } from "./heuristicsCatalogServer";
import type { LongitudinalInterpretationRecord, InterpretationProvenance, InterpretationReasonCode } from "./longitudinalInterpretationTypes";
import type { PrescriptionSnapshotExercise } from "./rehabSessionTypes";
import type { ComparableConstruct } from "./capacityTypes";
import {
  parseSymptomsResultDetail,
  parseCapacityResultDetail,
  parseTrainingResponseResultDetail,
  type SymptomsResultDetail,
  type CapacityResultDetail,
  type TrainingResponseResultDetail,
} from "./clinicianPatientProgress";

const SYMPTOMS_DOMAIN = "symptoms_short_window";
const CAPACITY_DOMAIN = "capacity_series";
const TRAINING_RESPONSE_DOMAIN = "training_response_series";

// Latest + previous only (LOCKED — Section 4 of the C3 brief): enough to
// answer "did this just change, and from what," never a long timeline.
const HISTORY_DEPTH = 2;

export type DomainInterpretation<T> = {
  interpretationId: string;
  resultState: string;
  generatedAt: string;
  windowStartDate: string | null;
  windowEndDate: string | null;
  detail: T;
};

export type ProvenanceView = {
  reasonCodes: InterpretationReasonCode[];
  rehabSessionDates: { rehabSessionId: string; patientLocalDate: string }[];
  prescriptionVersionIds: string[];
  // Short rule NAMES only, never description/rationale/known_limitations —
  // see clinicianPatientProgress.ts's header on why heuristic prose is
  // never rendered (the audit found the Training Response catalog text
  // stale relative to the actual locked implementation).
  heuristicNames: string[];
};

export type SymptomsSection = {
  current: DomainInterpretation<SymptomsResultDetail> | null;
  previous: DomainInterpretation<SymptomsResultDetail> | null;
  provenance: ProvenanceView | null;
};

export type CapacityConstructSection = {
  constructKey: string;
  // Resolved from the patient's OWN historical prescription_snapshot (never
  // the live/current exercise definition) — a tiny C3-local lookup
  // (resolveExerciseDisplayNames below), deliberately NOT reusing or
  // exporting progressInterpretationServer.ts's private resolveExerciseNames()
  // helper, per the C3 brief's "protect existing behavior, don't refactor
  // patient Progress merely to share a small utility."
  displayName: string;
  current: DomainInterpretation<CapacityResultDetail>;
  previous: DomainInterpretation<CapacityResultDetail> | null;
  provenance: ProvenanceView | null;
};

export type TrainingResponseSection = {
  current: DomainInterpretation<TrainingResponseResultDetail> | null;
  previous: DomainInterpretation<TrainingResponseResultDetail> | null;
  provenance: ProvenanceView | null;
  // Keyed by JSON.stringify(constructResult.construct) — same resolution
  // approach as Capacity's displayName (see resolveExerciseDisplayNames).
  constructDisplayNames: Map<string, string>;
};

export type ClinicianPatientProgress = {
  patientId: string;
  displayName: string;
  // Reused verbatim from acuteSafetyServer.ts's canonical derivation — same
  // boolean C1B/C2 already use for "Clinical review active". Current M6
  // interpretation generation does NOT suppress or restart because of this
  // (see the C3 audit's confirmed finding) — C3 represents that honestly by
  // showing a caveat, never by hiding or invalidating any interpretation.
  acuteReviewActive: boolean;
  symptoms: SymptomsSection;
  capacityConstructs: CapacityConstructSection[];
  trainingResponse: TrainingResponseSection;
};

function toDomainInterpretation<T>(row: LongitudinalInterpretationRecord, parse: (raw: Record<string, unknown>) => T): DomainInterpretation<T> {
  return {
    interpretationId: row.id,
    resultState: row.resultState,
    generatedAt: row.generatedAt,
    windowStartDate: row.windowStartDate,
    windowEndDate: row.windowEndDate,
    detail: parse(row.resultDetail),
  };
}

async function buildProvenanceView(
  supabase: ReturnType<typeof createServiceRoleClient>,
  provenance: InterpretationProvenance
): Promise<ProvenanceView> {
  const [sessionsRes, heuristics] = await Promise.all([
    provenance.rehabSessionIds.length
      ? supabase.from("rehab_sessions").select("id, patient_local_date").in("id", provenance.rehabSessionIds)
      : Promise.resolve({ data: [] as { id: string; patient_local_date: string }[], error: null }),
    provenance.heuristicIds.length ? getHeuristicsByIds(provenance.heuristicIds) : Promise.resolve([]),
  ]);
  if (sessionsRes.error) throw new Error(`buildProvenanceView failed: ${sessionsRes.error.message}`);

  return {
    reasonCodes: provenance.reasonCodes,
    rehabSessionDates: (sessionsRes.data ?? []).map((r) => ({ rehabSessionId: r.id, patientLocalDate: r.patient_local_date })),
    prescriptionVersionIds: provenance.prescriptionVersionIds,
    heuristicNames: heuristics.map((h) => h.name),
  };
}

// Tiny C3-local exercise-name lookup — resolves each construct's exId (+
// loadingProfile, to disambiguate) to a real historical display name, read
// straight from the patient's own rehab_sessions.prescription_snapshot
// (never the live/current exercise definition, never fabricated). Batched
// across every construct's exemplar session ids in one query — no
// per-construct round trip. Shared by both Capacity and Training Response
// construct display (each passes its own construct-identity + exemplar
// session-id list; keyed by JSON.stringify(construct) so callers can look
// their own constructs back up by the same key they already have).
async function resolveExerciseDisplayNames(
  supabase: ReturnType<typeof createServiceRoleClient>,
  constructs: { construct: ComparableConstruct; exemplarSessionIds: string[] }[]
): Promise<Map<string, string>> {
  const allSessionIds = new Set<string>();
  for (const c of constructs) {
    for (const id of c.exemplarSessionIds) allSessionIds.add(id);
  }
  if (allSessionIds.size === 0) return new Map();

  const { data, error } = await supabase.from("rehab_sessions").select("id, prescription_snapshot").in("id", [...allSessionIds]);
  if (error) throw new Error(`resolveExerciseDisplayNames failed: ${error.message}`);

  const nameByExIdAndProfile = new Map<string, string>();
  for (const row of data ?? []) {
    for (const ex of (row.prescription_snapshot as PrescriptionSnapshotExercise[]) ?? []) {
      nameByExIdAndProfile.set(`${ex.ex_id}::${ex.loading_profile ?? ""}`, ex.name);
    }
  }

  const displayNameByConstructKey = new Map<string, string>();
  for (const c of constructs) {
    const key = JSON.stringify(c.construct);
    const name = nameByExIdAndProfile.get(`${c.construct.exId}::${c.construct.loadingProfile ?? ""}`) ?? c.construct.exId;
    displayNameByConstructKey.set(key, name);
  }
  return displayNameByConstructKey;
}

export async function getClinicianPatientProgress(patientId: string): Promise<ClinicianPatientProgress | null> {
  const supabase = createServiceRoleClient();

  const { data: profile, error: profileError } = await supabase.from("profiles").select("id, name").eq("id", patientId).maybeSingle();
  if (profileError) throw new Error(`getClinicianPatientProgress failed: ${profileError.message}`);
  if (!profile) return null;

  const [brakeStatus, symptomsRows, trainingResponseRows, capacityRows] = await Promise.all([
    getActiveBrakeStatus(patientId),
    listLongitudinalInterpretationsForPatient(patientId, { domain: SYMPTOMS_DOMAIN, limit: HISTORY_DEPTH }),
    listLongitudinalInterpretationsForPatient(patientId, { domain: TRAINING_RESPONSE_DOMAIN, limit: HISTORY_DEPTH }),
    // Unfiltered by limit — every capacity_series row for the patient across
    // every construct, already ordered generated_at DESC (see
    // longitudinalInterpretationServer.ts). Grouped by construct below,
    // taking the first HISTORY_DEPTH rows per construct — construct identity
    // is already directly present per-row in window_definition.construct,
    // never reconstructed.
    listLongitudinalInterpretationsForPatient(patientId, { domain: CAPACITY_DOMAIN }),
  ]);

  const [symptomsCurrentRow, symptomsPreviousRow] = symptomsRows;
  const [trCurrentRow, trPreviousRow] = trainingResponseRows;

  const byConstruct = new Map<string, LongitudinalInterpretationRecord[]>();
  for (const row of capacityRows) {
    const construct = (row.windowDefinition as { construct?: unknown } | null)?.construct;
    if (!construct) continue;
    const key = JSON.stringify(construct);
    const list = byConstruct.get(key) ?? [];
    if (list.length < HISTORY_DEPTH) list.push(row);
    byConstruct.set(key, list);
  }

  const [symptomsProvenance, trProvenance, capacityProvenances] = await Promise.all([
    symptomsCurrentRow ? getInterpretationProvenance(symptomsCurrentRow.id) : Promise.resolve(null),
    trCurrentRow ? getInterpretationProvenance(trCurrentRow.id) : Promise.resolve(null),
    Promise.all([...byConstruct.values()].map(([currentRow]) => getInterpretationProvenance(currentRow.id))),
  ]);

  const [symptomsProvenanceView, trProvenanceView, ...capacityProvenanceViews] = await Promise.all([
    symptomsProvenance ? buildProvenanceView(supabase, symptomsProvenance) : Promise.resolve(null),
    trProvenance ? buildProvenanceView(supabase, trProvenance) : Promise.resolve(null),
    ...capacityProvenances.map((p) => buildProvenanceView(supabase, p)),
  ]);

  const symptoms: SymptomsSection = {
    current: symptomsCurrentRow ? toDomainInterpretation(symptomsCurrentRow, (raw) => parseSymptomsResultDetail(symptomsCurrentRow.resultState, raw)) : null,
    previous: symptomsPreviousRow ? toDomainInterpretation(symptomsPreviousRow, (raw) => parseSymptomsResultDetail(symptomsPreviousRow.resultState, raw)) : null,
    provenance: symptomsProvenanceView,
  };

  const capacityInterpretations = [...byConstruct.entries()].map(([key, rows]) => {
    const [currentRow, previousRow] = rows;
    return {
      constructKey: key,
      current: toDomainInterpretation(currentRow, parseCapacityResultDetail),
      previous: previousRow ? toDomainInterpretation(previousRow, parseCapacityResultDetail) : null,
    };
  });

  const trConstructResults = trCurrentRow ? parseTrainingResponseResultDetail(trCurrentRow.resultDetail) : { status: "insufficient" as const };
  const trConstructsForNaming =
    trConstructResults.status === "generated"
      ? trConstructResults.constructResults.map((c) => ({
          construct: c.construct,
          exemplarSessionIds: c.pairs.length > 0 ? [c.pairs[0].recentRehabSessionId] : [],
        }))
      : [];

  const [capacityDisplayNames, trDisplayNames] = await Promise.all([
    resolveExerciseDisplayNames(
      supabase,
      capacityInterpretations.map((c) => ({ construct: c.current.detail.construct, exemplarSessionIds: c.current.detail.recentOpportunities.map((o) => o.rehabSessionId) }))
    ),
    resolveExerciseDisplayNames(supabase, trConstructsForNaming),
  ]);

  const capacityConstructs: CapacityConstructSection[] = capacityInterpretations.map((c, index) => ({
    ...c,
    displayName: capacityDisplayNames.get(c.constructKey) ?? c.current.detail.construct.exId,
    provenance: capacityProvenanceViews[index] ?? null,
  }));

  const trainingResponse: TrainingResponseSection = {
    current: trCurrentRow ? toDomainInterpretation(trCurrentRow, parseTrainingResponseResultDetail) : null,
    previous: trPreviousRow ? toDomainInterpretation(trPreviousRow, parseTrainingResponseResultDetail) : null,
    provenance: trProvenanceView,
    constructDisplayNames: trDisplayNames,
  };

  return {
    patientId: profile.id as string,
    displayName: profile.name as string,
    acuteReviewActive: brakeStatus != null,
    symptoms,
    capacityConstructs,
    trainingResponse,
  };
}
