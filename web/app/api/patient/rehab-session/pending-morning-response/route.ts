import "server-only";

import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";
import { getOldestOutstandingMorningResponse } from "@/lib/morningResponseServer";

// Date-independent by design, and — as of M4 Stage 1 — oldest-outstanding-
// first: querying "most recent awaiting_morning_response session" alone
// (the original M3 implementation) could hide an older unresolved session
// once a newer one exists. getOldestOutstandingMorningResponse ensures every
// awaiting session has a morning_responses row (covering pre-M4 sessions
// too) and returns the oldest one still unsubmitted.
//
// The response contract is unchanged from M3 ({ session: ... | null }) so
// existing callers (MorningResponsePendingNotice) need no changes — this is
// a correctness fix to this route's underlying query, not new API surface.
export async function GET() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const oldest = await getOldestOutstandingMorningResponse(user.id);
  if (!oldest) return NextResponse.json({ session: null });

  const { data: session, error } = await supabase
    .from("rehab_sessions")
    .select()
    .eq("id", oldest.rehabSessionId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ session: session ? mapRehabSessionRow(session) : null });
}
