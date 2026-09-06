import "server-only";

import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";

// Date-independent by design. /current returns the single most recent
// non-complete session, which can be SUPERSEDED by a newer same-day session
// once one exists — so it cannot reliably answer "is there a prior,
// unresolved awaiting_morning_response session" once today's own session
// has started. This route asks that question directly: the most recent row
// in that exact status, regardless of which day it was started, so it never
// disappears just because the calendar date changed.
export async function GET() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("rehab_sessions")
    .select()
    .eq("status", "awaiting_morning_response")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ session: data ? mapRehabSessionRow(data) : null });
}
