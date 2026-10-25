"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/safeRedirect";

export async function loginAction(formData: FormData) {
  const email = (formData.get("email") as string).toLowerCase().trim();
  const password = formData.get("password") as string;
  const next = safeInternalPath(formData.get("next"), "/dashboard");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const msg =
      error.message === "Invalid login credentials"
        ? "Invalid email or password."
        : error.message;
    const params = new URLSearchParams({ error: msg, email, next });
    redirect(`/login?${params}`);
  }

  redirect(next);
}
