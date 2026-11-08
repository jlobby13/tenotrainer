"use server";

import { redirect } from "next/navigation";
import { verifyRecoveryToken } from "@/lib/passwordRecoveryServer";

// M3.5 S4 — the only place a recovery token is spent (POST). The destination
// is fixed; no request parameter chooses it. Failures return to a clean URL
// without the token.
export async function verifyRecoveryAction(formData: FormData) {
  const outcome = await verifyRecoveryToken(formData.get("token_hash"), formData.get("type"));
  if (outcome === "verified") redirect("/account/password?recovery=1");
  redirect(`/auth/confirm?error=${outcome === "rate_limited" ? "rate_limited" : outcome === "error" ? "error" : "invalid"}`);
}
