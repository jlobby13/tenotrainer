import "server-only";

import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";
import { legacyRetiredResponse } from "@/lib/modeHttp";

// Most recent non-terminal session for the authenticated patient — drives
// dashboard state and resume/idempotency checks. Returns null, not an error,
// when none exists.
export async function GET() {
  // M3.1 — legacy (FastAPI-era) route: exists only in development mode (410 LEGACY_RETIRED otherwise).
  const modeRefusal = legacyRetiredResponse();
  if (modeRefusal) return modeRefusal;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("rehab_sessions")
    .select()
    .neq("status", "response_complete")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ session: data ? mapRehabSessionRow(data) : null });
}
