import { redirect } from "next/navigation";

// M2 — production v1 is invitation-only. /register is not an onboarding
// path: there is no public sign-up action anywhere in the app. Accounts are
// created only by accepting an invitation (/invite/accept). Disabling the
// Supabase public sign-up endpoint itself is M3 environment configuration.
export default function RegisterPage() {
  redirect("/login?notice=invitation_required");
}
