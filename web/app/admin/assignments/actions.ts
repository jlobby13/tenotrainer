"use server";

import { redirect } from "next/navigation";
import { getSessionInfo } from "@/lib/auth";
import { addAssignment, endAssignment } from "@/lib/assignmentAdminServer";
import { withQuery } from "@/lib/safeRedirect";

// M2 — admin assignment changes. The actor is always the session user; the
// RPCs re-check that they are clinician_admin / super_user of the
// assignment's organization (anything else is refused / not found).

async function actorId(): Promise<string> {
  const session = await getSessionInfo();
  if (!session.user) redirect("/login");
  return session.user.id;
}

function back(org: string, patient: string, params: Record<string, string>): never {
  redirect(withQuery("/admin/assignments", { org, patient, ...params }));
}

export async function addAssignmentAction(formData: FormData) {
  const actor = await actorId();
  const org = String(formData.get("org") ?? "");
  const patient = String(formData.get("patient") ?? "");
  const clinician = String(formData.get("clinician") ?? "");
  const result = await addAssignment(actor, org, clinician, patient);
  back(org, patient, result === "added" ? { done: "added" } : { error: result });
}

export async function endAssignmentAction(formData: FormData) {
  const actor = await actorId();
  const org = String(formData.get("org") ?? "");
  const patient = String(formData.get("patient") ?? "");
  const assignment = String(formData.get("assignment") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const result = await endAssignment(actor, assignment, reason);
  back(org, patient, result === "ended" ? { done: "ended" } : { error: result });
}
