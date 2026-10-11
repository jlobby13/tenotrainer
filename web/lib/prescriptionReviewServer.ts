import "server-only";

// C5.4D — server composition for the Review page and the read-only published
// prescription view. Same contract as prescriptionManagementServer.ts: the
// calling page has ALREADY run requireClinicianAuth() + assertSupervises();
// everything here is read-only. Publication itself only ever happens through
// prescriptionDraftServer.publishDraft(), which re-derives every check.

import { createServiceRoleClient } from "./supabase/server";
import { isPublishEnabled } from "./prescriptionDraftAuth";
import {
  buildReviewIssues,
  DRAFT_BASE_CURRENT_RULE,
  type ProgramSnapshot,
  type ReviewIssue,
} from "./prescriptionProgram";
import { loadProgramContent, attachExerciseNames, computeDraftFingerprint } from "./prescriptionProgramServer";
import type { ValidationRuleResult } from "./prescriptionDraftTypes";

export type VersionSummary = { id: string; versionNumber: number; publishedAt: string | null };

export type PrescriptionReviewState =
  | { kind: "no_draft"; currentVersion: VersionSummary | null }
  | {
      kind: "draft";
      draftId: string;
      isOwner: boolean;
      editingClinicianName: string;
      program: ProgramSnapshot;
      issues: ReviewIssue[];
      fingerprint: string;
      publishEnabled: boolean;
      paused: boolean;
      currentVersion: VersionSummary | null;
    };

async function clinicianName(supabase: ReturnType<typeof createServiceRoleClient>, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await supabase.from("profiles").select("name").eq("id", id).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

async function loadVersionSummary(supabase: ReturnType<typeof createServiceRoleClient>, versionId: string | null): Promise<VersionSummary | null> {
  if (!versionId) return null;
  const { data } = await supabase.from("prescription_versions").select("id, version_number, published_at").eq("id", versionId).maybeSingle();
  if (!data) return null;
  return { id: data.id as string, versionNumber: data.version_number as number, publishedAt: (data.published_at as string | null) ?? null };
}

// Review operates on the patient's CURRENT open draft and never creates one
// (C5.4D §3) — no draft means kind "no_draft", nothing is written.
export async function getPrescriptionReviewState(params: { clinicianId: string; patientId: string }): Promise<PrescriptionReviewState> {
  const supabase = createServiceRoleClient();
  const { data: pp } = await supabase
    .from("patient_prescriptions")
    .select("id, operational_status, current_prescription_version_id")
    .eq("patient_id", params.patientId)
    .maybeSingle();
  if (!pp) return { kind: "no_draft", currentVersion: null };

  const currentVersionId = (pp.current_prescription_version_id as string | null) ?? null;
  const [{ data: draft }, currentVersion] = await Promise.all([
    supabase.from("prescription_drafts").select("*").eq("patient_prescription_id", pp.id).eq("status", "editing").maybeSingle(),
    loadVersionSummary(supabase, currentVersionId),
  ]);
  if (!draft) return { kind: "no_draft", currentVersion };

  const draftId = draft.id as string;
  // The SAME validate_prescription_draft RPC publish_prescription_draft runs
  // — never re-implemented here.
  const [content, rpcResult] = await Promise.all([
    loadProgramContent(supabase, { kind: "draft", id: draftId }, draft),
    supabase.rpc("validate_prescription_draft", { p_draft_id: draftId }),
  ]);
  if (rpcResult.error) throw new Error("validate_prescription_draft failed");

  const rules: ValidationRuleResult[] = [
    {
      rule: DRAFT_BASE_CURRENT_RULE,
      passed: (draft.stale_base_prescription_version_id ?? null) === currentVersionId,
      detail: "the patient's current version must still be the one this draft was started against",
    },
    ...((rpcResult.data ?? []) as ValidationRuleResult[]),
  ];

  let unavailableExerciseIds: Set<string> | undefined;
  if (rules.some((r) => r.rule === "exercises_active_and_accessible" && !r.passed)) {
    unavailableExerciseIds = await findUnavailableExercises(supabase, draft.editing_clinician_id as string, content);
  }

  const program = await attachExerciseNames(content);
  const isOwner = draft.editing_clinician_id === params.clinicianId;
  return {
    kind: "draft",
    draftId,
    isOwner,
    editingClinicianName: isOwner ? "You" : ((await clinicianName(supabase, draft.editing_clinician_id as string)) ?? "Another clinician"),
    program,
    issues: buildReviewIssues({ patientId: params.patientId, rules, program, unavailableExerciseIds }),
    fingerprint: computeDraftFingerprint(draft, content),
    publishEnabled: isPublishEnabled(),
    paused: pp.operational_status === "paused",
    currentVersion,
  };
}

// Only runs when the RPC's exercises_active_and_accessible rule has already
// failed, to name WHICH exercises — using the RPC's own
// clinician_can_access_exercise() rather than re-expressing visibility.
async function findUnavailableExercises(
  supabase: ReturnType<typeof createServiceRoleClient>,
  editingClinicianId: string,
  program: ProgramSnapshot
): Promise<Set<string>> {
  const ids = Array.from(new Set(program.workouts.flatMap((w) => w.exercises.map((e) => e.canonicalExerciseId))));
  const { data: rows } = await supabase.from("canonical_exercises").select("id, active").in("id", ids);
  const activeById = new Map((rows ?? []).map((r) => [r.id as string, r.active as boolean]));
  const unavailable = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      if (activeById.get(id) !== true) {
        unavailable.add(id);
        return;
      }
      const { data: accessible } = await supabase.rpc("clinician_can_access_exercise", { p_clinician_id: editingClinicianId, p_exercise_id: id });
      if (accessible !== true) unavailable.add(id);
    })
  );
  return unavailable;
}

// ---------------------------------------------------------------------------
// Published versions (read-only)
// ---------------------------------------------------------------------------

export type PublishedVersionListItem = VersionSummary & { isCurrent: boolean };

// Only C5 published versions (those attached to the patient's
// patient_prescriptions row) — pre-C5 legacy clinical-state rows in
// prescription_versions carry no program content and are not listed.
export async function listPublishedVersions(patientId: string): Promise<PublishedVersionListItem[]> {
  const supabase = createServiceRoleClient();
  const { data: pp } = await supabase.from("patient_prescriptions").select("id, current_prescription_version_id").eq("patient_id", patientId).maybeSingle();
  if (!pp) return [];
  const { data } = await supabase
    .from("prescription_versions")
    .select("id, version_number, published_at")
    .eq("patient_prescription_id", pp.id)
    .order("version_number", { ascending: false });
  return (data ?? []).map((v) => ({
    id: v.id as string,
    versionNumber: v.version_number as number,
    publishedAt: (v.published_at as string | null) ?? null,
    isCurrent: v.id === pp.current_prescription_version_id,
  }));
}

export type PublishedVersionView = {
  version: VersionSummary & { isCurrent: boolean; publishedByName: string | null };
  program: ProgramSnapshot;
  paused: boolean;
  openDraft: { isOwnedByCaller: boolean; editingClinicianName: string } | null;
};

// Returns null unless versionId is a published version of THIS patient's
// prescription — a version id from another patient is never readable here.
// Every value comes from the version's own immutable rows, never from the
// current draft.
export async function getPublishedVersionView(params: { clinicianId: string; patientId: string; versionId: string }): Promise<PublishedVersionView | null> {
  const supabase = createServiceRoleClient();
  const { data: pp } = await supabase
    .from("patient_prescriptions")
    .select("id, operational_status, current_prescription_version_id")
    .eq("patient_id", params.patientId)
    .maybeSingle();
  if (!pp) return null;

  const [{ data: version }, { data: draft }] = await Promise.all([
    supabase
      .from("prescription_versions")
      .select("id, version_number, published_at, published_by, phase, scheduling_mode, target_sessions_per_week")
      .eq("id", params.versionId)
      .eq("patient_prescription_id", pp.id)
      .maybeSingle(),
    supabase.from("prescription_drafts").select("editing_clinician_id").eq("patient_prescription_id", pp.id).eq("status", "editing").maybeSingle(),
  ]);
  if (!version) return null;

  const [content, publishedByName, draftEditorName] = await Promise.all([
    loadProgramContent(supabase, { kind: "version", id: version.id as string }, version),
    clinicianName(supabase, (version.published_by as string | null) ?? null),
    draft && draft.editing_clinician_id !== params.clinicianId ? clinicianName(supabase, draft.editing_clinician_id as string) : Promise.resolve(null),
  ]);

  return {
    version: {
      id: version.id as string,
      versionNumber: version.version_number as number,
      publishedAt: (version.published_at as string | null) ?? null,
      publishedByName,
      isCurrent: version.id === pp.current_prescription_version_id,
    },
    program: await attachExerciseNames(content),
    paused: pp.operational_status === "paused",
    openDraft: draft
      ? { isOwnedByCaller: draft.editing_clinician_id === params.clinicianId, editingClinicianName: draftEditorName ?? "Another clinician" }
      : null,
  };
}
