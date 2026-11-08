"use server";

import { redirect } from "next/navigation";
import { requestPasswordRecovery } from "@/lib/passwordRecoveryServer";
import { AUTH_RESPONSE_FLOOR_MS, withMinimumDuration } from "@/lib/authRateLimit";

// M3.5 S4 — every submission ends on the same page with the same message,
// whatever happened (account or not, email limit, error). The address is
// never echoed back in the URL.
export async function requestPasswordResetAction(formData: FormData) {
  // M3.5 D3 — a timing floor: the response time says less about which
  // path was taken (sent, limited, suppressed, unknown address).
  await withMinimumDuration(AUTH_RESPONSE_FLOOR_MS, () => requestPasswordRecovery(formData.get("email")));
  redirect("/login/forgot?sent=1");
}
