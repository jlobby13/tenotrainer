"use server";

import { redirect } from "next/navigation";
import { updateAccountPassword } from "@/lib/passwordRecoveryServer";

// M3.5 S4 — set a new password (after recovery, or while signed in). The
// outcome travels as a code only; the destination is fixed.
export async function updatePasswordAction(formData: FormData) {
  const recovery = formData.get("recovery") === "1" ? "&recovery=1" : "";
  const result = await updateAccountPassword(formData.get("password"), formData.get("confirm_password"));
  if (result.ok) redirect("/account/password?updated=1");
  if (result.code === "not_signed_in") redirect("/login?next=/account/password");
  redirect(`/account/password?error=${result.code}${recovery}`);
}
