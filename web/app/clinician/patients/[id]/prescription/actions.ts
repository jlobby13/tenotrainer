"use server";

// C5.4A — Prescription Builder Foundation. Server Action backing the
// entry-point page's Create/Edit Prescription buttons. Draft creation
// remains a high-consequence operation: createDraft() re-runs the full
// C5.3 authoritative authorization (PG + synchronous legacy re-check) on
// its own — this action never treats its own requireClinicianAuth() call
// as sufficient for that.

import { redirect } from "next/navigation";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { createDraft } from "@/lib/prescriptionDraftServer";
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
