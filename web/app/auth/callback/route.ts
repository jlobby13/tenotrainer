import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/safeRedirect";
import { trustedRedirectUrl } from "@/lib/config";

// Supabase redirects here after email confirmation / magic-link / OAuth.
// Exchanges the one-time code for a persistent session.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // M3.3 S3b — the configuration chooses the origin (canonical in
  // production/maintenance, request-local in development); the validated
  // internal path chooses the destination within it.
  const to = (path: string) => trustedRedirectUrl(request.url, path);
  const code = searchParams.get("code");
  // Same-origin paths only (shared validator) — never an open redirect.
  const next = safeInternalPath(searchParams.get("next"), "/dashboard");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (error) {
    const url = to("/login");
    url.searchParams.set("error", errorDescription ?? error);
    return NextResponse.redirect(url);
  }

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error: exchangeError } =
      await supabase.auth.exchangeCodeForSession(code);

    if (!exchangeError) {
      return NextResponse.redirect(to(next));
    }

    const url = to("/login");
    url.searchParams.set("error", "Could not verify your link. Please try signing in again.");
    return NextResponse.redirect(url);
  }

  const url = to("/login");
  url.searchParams.set("error", "Invalid confirmation link.");
  return NextResponse.redirect(url);
}
