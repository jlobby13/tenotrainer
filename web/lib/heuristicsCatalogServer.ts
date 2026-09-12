import "server-only";

// Milestone 6, Stage 3A — server-only read access for the TenoTrainer
// Heuristics Catalog and Evidence Catalog. READ-ONLY: no seed/write helpers
// are added here. Writes to these tables go through clinician_admin/
// super_user's normal RLS-permitted INSERT/UPDATE (see
// supabase/migrations/20260911000006_m6_stage3a_heuristics_evidence_catalog.sql —
// same shape as the existing exercises/knowledge_entries policies), not a
// bespoke server function; nothing in this codebase yet has a UI that would
// call one, so none is invented here.
//
// Uses the service-role client for the same reason
// longitudinalInterpretationServer.ts does — these are read-only lookups
// for a server component/route that has already resolved which record it
// needs; an RLS-filtered anon-key round trip would not add safety here.

import { createServiceRoleClient } from "./supabase/server";
import {
  mapHeuristicRow,
  mapEvidenceSourceRow,
  mapHeuristicEvidenceLinkRow,
  type HeuristicRecord,
  type EvidenceSourceRecord,
} from "./heuristicsCatalogTypes";

// 4. Heuristic metadata, by catalog id or by stable key (whichever a caller
// already has on hand — an interpretation's provenance carries ids; a
// developer wiring up Stage 3B code will more often know the key).
export async function getHeuristicsByIds(heuristicIds: string[]): Promise<HeuristicRecord[]> {
  if (heuristicIds.length === 0) return [];
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("m6_heuristics").select().in("id", heuristicIds);
  if (error) throw new Error(`getHeuristicsByIds failed: ${error.message}`);
  return (data ?? []).map(mapHeuristicRow);
}

export async function getHeuristicByKey(heuristicKey: string): Promise<HeuristicRecord | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("m6_heuristics").select().eq("heuristic_key", heuristicKey).maybeSingle();
  if (error) throw new Error(`getHeuristicByKey failed: ${error.message}`);
  return data ? mapHeuristicRow(data) : null;
}

// 5. Evidence sources associated with a given heuristic, via
// m6_heuristic_evidence. Returns the evidence rows directly (not the join
// rows) since "what evidence backs this heuristic" is the shape every
// current/foreseeable caller (a future "View model logic" page) actually
// wants; getHeuristicEvidenceLinks below is available when the join
// metadata itself (ruleset_version/notes) is needed too.
export async function getEvidenceForHeuristic(heuristicId: string): Promise<EvidenceSourceRecord[]> {
  const supabase = createServiceRoleClient();
  const { data: links, error: linkError } = await supabase
    .from("m6_heuristic_evidence")
    .select("evidence_source_id")
    .eq("heuristic_id", heuristicId);
  if (linkError) throw new Error(`getEvidenceForHeuristic failed: ${linkError.message}`);
  const evidenceIds = (links ?? []).map((l) => l.evidence_source_id as string);
  if (evidenceIds.length === 0) return [];

  const { data, error } = await supabase.from("m6_evidence_sources").select().in("id", evidenceIds);
  if (error) throw new Error(`getEvidenceForHeuristic failed: ${error.message}`);
  return (data ?? []).map(mapEvidenceSourceRow);
}

export async function getHeuristicEvidenceLinks(heuristicId: string) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("m6_heuristic_evidence").select().eq("heuristic_id", heuristicId);
  if (error) throw new Error(`getHeuristicEvidenceLinks failed: ${error.message}`);
  return (data ?? []).map(mapHeuristicEvidenceLinkRow);
}
