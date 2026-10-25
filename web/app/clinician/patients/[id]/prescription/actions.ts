"use server";

// C5.4A — Prescription Builder Foundation. Server Action backing the
// entry-point page's Create/Edit Prescription buttons. Draft creation
// remains a high-consequence operation: createDraft() re-runs the full
// high-consequence authorization (Postgres assignment authority) on
// its own — this action never treats its own requireClinicianAuth() call
// as sufficient for that.

import { redirect } from "next/navigation";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { createDraft, pausePrescription, resumePrescription } from "@/lib/prescriptionDraftServer";
import { PrescriptionDraftError } from "@/lib/prescriptionDraftErrors";
import type { DraftSource } from "@/lib/prescriptionDraftTypes";

export async function createDraftAction(formData: FormData) {
  const patientId = formData.get("patientId") as string;
  const source = formData.get("source") as DraftSource;
  const sourceVersionId = (formData.get("sourceVersionId") as string | null) || null;

  const { clinicianId } = await requireClinicianAuth();

  try {
    await createDraft({ clinicianId, patientId, source, sourceVersionId });
  } catch (err) {
    const code = err instanceof PrescriptionDraftError ? err.code : "INTERNAL_ERROR";
    redirect(`/clinician/patients/${patientId}/prescription?error=${code}`);
  }

  redirect(`/clinician/patients/${patientId}/prescription/builder`);
}

// M2 — clinician pause / resume controls. Thin wrappers over the
// authoritative pausePrescription / resumePrescription (high-consequence
// authorization + the existing pause_prescription / resume_prescription
// database functions — there is exactly one pause state). The clinician is
// always the session's; the patient id only selects the target and is
// authorized server-side.
export async function pauseProgramAction(formData: FormData) {
  const patientId = String(formData.get("patientId") ?? "");
  const { clinicianId } = await requireClinicianAuth();
  let notice = "paused";
  try {
    await pausePrescription({ clinicianId, patientId });
  } catch (err) {
    notice = err instanceof PrescriptionDraftError ? err.code : "INTERNAL_ERROR";
  }
  redirect(`/clinician/patients/${encodeURIComponent(patientId)}/prescription?${notice === "paused" ? "notice=paused" : `error=${notice}`}`);
}

export async function resumeProgramAction(formData: FormData) {
  const patientId = String(formData.get("patientId") ?? "");
  const { clinicianId } = await requireClinicianAuth();
  let notice = "resumed";
  try {
    await resumePrescription({ clinicianId, patientId });
  } catch (err) {
    notice = err instanceof PrescriptionDraftError ? err.code : "INTERNAL_ERROR";
  }
  redirect(`/clinician/patients/${encodeURIComponent(patientId)}/prescription?${notice === "resumed" ? "notice=resumed" : `error=${notice}`}`);
}
