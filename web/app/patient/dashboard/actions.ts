"use server";

import { redirect } from "next/navigation";
import { requireC5Patient } from "@/lib/c5RuntimeServer";
import { dismissProgramNotice } from "@/lib/programNoticesServer";
import { refuseActionInMaintenance } from "@/lib/modeActions";

// M2 — dismiss (acknowledge) a program notice. Patient identity from the
// authenticated session only; the notice id merely selects the row, and the
// update is scoped to that patient.
export async function dismissProgramNoticeAction(formData: FormData) {
  refuseActionInMaintenance("/patient/dashboard");
  const auth = await requireC5Patient();
  if (auth.ok) await dismissProgramNotice(auth.patientId, String(formData.get("noticeId") ?? ""));
  redirect("/patient/dashboard");
}
