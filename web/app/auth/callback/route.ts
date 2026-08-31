import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Supabase redirects here after email confirmation / magic-link / OAuth.
// Exchanges the one-time code for a persistent session.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (error) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", errorDescription ?? error);
    return NextResponse.redirect(url);
  }

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);

    if (!exchangeError) {
      const redirectUrl = new URL(next, origin);
      return NextResponse.redirect(redirectUrl);
    }

    const url = new URL("/login", origin);
    url.searchParams.set("error", "Could not verify your link. Please try signing in again.");
    return NextResponse.redirect(url);
  }

  const url = new URL("/login", origin);
  url.searchParams.set("error", "Invalid confirmation link.");
  return NextResponse.redirect(url);
}
