"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireClinicianAuth } from "@/lib/clinicianAuth";
import { cancelPatientInvitation, createPatientInvitation } from "@/lib/patientInvitationServer";
import { refuseActionInMaintenance } from "@/lib/modeActions";
import { isMutationAllowed } from "@/lib/operatingMode";

// M2 — clinician patient invitations. The inviting clinician is always the
// session user; the organization is re-checked by create_patient_invitation.

export type InviteFormState =
  | { kind: "idle" }
  | { kind: "created"; email: string; inviteUrl: string; emailed: boolean; emailWarning: string | null }
  | { kind: "error"; code: string };

export async function createPatientInvitationAction(_prev: InviteFormState, formData: FormData): Promise<InviteFormState> {
  if (!isMutationAllowed()) return { kind: "error", code: "MAINTENANCE" };
  const { clinicianId } = await requireClinicianAuth();
  const email = String(formData.get("email") ?? "");
  const organizationId = String(formData.get("organizationId") ?? "");
  const r = await createPatientInvitation({ clinicianId, organizationId, email });
  revalidatePath("/clinician/invitations");
  if (r.result === "created") {
    // The raw link is returned to this clinician's browser once (never put
    // in a URL or stored); the database holds only its hash.
    return { kind: "created", email: r.email, inviteUrl: r.inviteUrl, emailed: r.emailed, emailWarning: r.emailWarning };
  }
  return { kind: "error", code: r.result };
}

export async function cancelPatientInvitationAction(formData: FormData) {
  refuseActionInMaintenance("/clinician/invitations");
  const { clinicianId } = await requireClinicianAuth();
  const result = await cancelPatientInvitation(clinicianId, String(formData.get("invitationId") ?? ""));
  redirect(`/clinician/invitations?${result === "cancelled" ? "cancelled=1" : `error=${result}`}`);
}
