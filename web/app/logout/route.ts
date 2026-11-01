import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { trustedRedirectUrl } from "@/lib/config";

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  // M3.3 S3b — the configured canonical origin in production/maintenance
  // (request-local in development), never the request's Host.
  return NextResponse.redirect(trustedRedirectUrl(request.url, "/login"));
}
