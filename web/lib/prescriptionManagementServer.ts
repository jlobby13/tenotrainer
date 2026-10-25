import "server-only";

// C5.4A — Prescription Builder Foundation. Server composition for the
// clinician-facing prescription-management entry point
// (/clinician/patients/[id]/prescription). Same contract as
// clinicianPatientOverviewServer.ts: assumes requireClinicianAuth() +
// assertSupervises() have ALREADY run — nothing here performs its own
// authorization check. Read-only; draft CREATION still goes through
// createDraft() (prescriptionDraftServer.ts), which re-runs the full
// high-consequence authorization on its own.

import { createServiceRoleClient } from "./supabase/server";
import type { DraftSource } from "./prescriptionDraftTypes";

export type PrescriptionManagementState = {
  // null = no patient_prescriptions row exists yet (never had a prescription
  // or draft) — distinct from 'active' (a real, if empty, row).
  operationalStatus: "active" | "paused" | null;
  // M2 — pause context for the Program controls (null unless paused).
  pause: { pausedAt: string | null; pausedByName: string | null } | null;
  hasActivePrescription: boolean;
  activeSummary: { versionId: string; versionNumber: number; stage: number; publishedAt: string } | null;
  draft: {
    id: string;
    source: DraftSource;
    createdAt: string;
    editingClinicianId: string;
    editingClinicianName: string;
    isOwnedByCaller: boolean;
    workoutCount: number;
    exerciseCount: number;
  } | null;
};

export async function getPrescriptionManagementState(params: { clinicianId: string; patientId: string }): Promise<PrescriptionManagementState> {
  const supabase = createServiceRoleClient();

  const { data: pp } = await supabase
    .from("patient_prescriptions")
    .select("id, operational_status, current_prescription_version_id, paused_at, paused_by")
    .eq("patient_id", params.patientId)
    .maybeSingle();

  if (!pp) {
    return { operationalStatus: null, pause: null, hasActivePrescription: false, activeSummary: null, draft: null };
  }

  let activeSummary: PrescriptionManagementState["activeSummary"] = null;
  if (pp.current_prescription_version_id) {
    const { data: version } = await supabase
      .from("prescription_versions")
      .select("id, version_number, stage, published_at")
      .eq("id", pp.current_prescription_version_id)
      .maybeSingle();
    if (version) {
      activeSummary = {
        versionId: version.id as string,
        versionNumber: version.version_number as number,
        stage: version.stage as number,
        publishedAt: version.published_at as string,
      };
    }
  }

  const { data: draftRow } = await supabase
    .from("prescription_drafts")
    .select("id, source, created_at, editing_clinician_id, prescription_workouts(id, prescription_exercises(id))")
    .eq("patient_prescription_id", pp.id)
    .eq("status", "editing")
    .maybeSingle();

  let draft: PrescriptionManagementState["draft"] = null;
  if (draftRow) {
    const { data: profile } = await supabase.from("profiles").select("name").eq("id", draftRow.editing_clinician_id).maybeSingle();
    const workouts = (draftRow.prescription_workouts ?? []) as { id: string; prescription_exercises: { id: string }[] | null }[];
    draft = {
      id: draftRow.id as string,
      source: draftRow.source as DraftSource,
      createdAt: draftRow.created_at as string,
      editingClinicianId: draftRow.editing_clinician_id as string,
      editingClinicianName: (profile?.name as string | undefined) ?? "Another clinician",
      isOwnedByCaller: draftRow.editing_clinician_id === params.clinicianId,
      workoutCount: workouts.length,
      exerciseCount: workouts.reduce((sum, w) => sum + (w.prescription_exercises?.length ?? 0), 0),
    };
  }

  let pause: PrescriptionManagementState["pause"] = null;
  if (pp.operational_status === "paused") {
    const { data: pauser } = pp.paused_by
      ? await supabase.from("profiles").select("name").eq("id", pp.paused_by).maybeSingle()
      : { data: null };
    pause = { pausedAt: (pp.paused_at as string | null) ?? null, pausedByName: ((pauser?.name as string | undefined) ?? "").trim() || null };
  }

  return {
    operationalStatus: pp.operational_status as "active" | "paused",
    pause,
    hasActivePrescription: !!pp.current_prescription_version_id,
    activeSummary,
    draft,
  };
}

// The builder route needs only the id of the currently-open draft (if any)
// for this patient — a lighter lookup than the full management state above.
export async function findEditingDraftId(patientId: string): Promise<string | null> {
  const supabase = createServiceRoleClient();
  const { data: pp } = await supabase.from("patient_prescriptions").select("id").eq("patient_id", patientId).maybeSingle();
  if (!pp) return null;
  const { data: draftRow } = await supabase
    .from("prescription_drafts")
    .select("id")
    .eq("patient_prescription_id", pp.id)
    .eq("status", "editing")
    .maybeSingle();
  return (draftRow?.id as string | undefined) ?? null;
}

export async function getClinicianDisplayName(clinicianId: string): Promise<string> {
  const supabase = createServiceRoleClient();
  const { data: profile } = await supabase.from("profiles").select("name").eq("id", clinicianId).maybeSingle();
  return (profile?.name as string | undefined) ?? "Another clinician";
}
