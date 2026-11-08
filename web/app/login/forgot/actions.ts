"use server";

import { redirect } from "next/navigation";
import { requestPasswordRecovery } from "@/lib/passwordRecoveryServer";

// M3.5 S4 — every submission ends on the same page with the same message,
// whatever happened (account or not, email limit, error). The address is
// never echoed back in the URL.
export async function requestPasswordResetAction(formData: FormData) {
  await requestPasswordRecovery(formData.get("email"));
  redirect("/login/forgot?sent=1");
}
