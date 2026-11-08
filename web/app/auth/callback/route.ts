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

  if (error) {
    const url = to("/login");
    // M3.5 S4 — a fixed code; the provider's description is never echoed.
    url.searchParams.set("error", "link_invalid");
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
    url.searchParams.set("error", "link_invalid");
    return NextResponse.redirect(url);
  }

  const url = to("/login");
  url.searchParams.set("error", "link_invalid");
  return NextResponse.redirect(url);
}
