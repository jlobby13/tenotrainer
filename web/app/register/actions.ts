"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function registerAction(formData: FormData) {
  const name = (formData.get("name") as string).trim();
  const email = (formData.get("email") as string).toLowerCase().trim();
  const password = formData.get("password") as string;
  const passwordConfirm = formData.get("password_confirm") as string;

  const fail = (msg: string) => {
    const params = new URLSearchParams({ error: msg, name, email });
    redirect(`/register?${params}`);
  };

  if (password !== passwordConfirm) fail("Passwords do not match.");
  if (password.length < 8) fail("Password must be at least 8 characters.");
  if (!email.includes("@")) fail("Please enter a valid email address.");

  const supabase = await createServerSupabaseClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name },
      emailRedirectTo: `${appUrl}/auth/callback`,
    },
  });

  if (error) {
    fail(
      error.message === "User already registered"
        ? "An account with that email already exists."
        : error.message
    );
  }

  // Supabase sends a confirmation email by default.
  // Redirect to a "check your email" page.
  redirect("/register/confirm");
}
