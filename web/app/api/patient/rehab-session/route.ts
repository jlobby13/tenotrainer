import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";

// Creates (or idempotently returns) the durable rehab_sessions row for a
// guided exercise session. Uses the user's own RLS-scoped client — the
// column-level INSERT grant on rehab_sessions already restricts this to
// exactly the fields a session-creation request needs (see
// supabase/migrations/20260905000002_m3_insert_grant_fix.sql); no derived
// escalation field is reachable from this path at all.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { sessionInstanceId, planId, prescriptionInstanceId, patientLocalDate, startedAt, prescriptionSnapshot } = body;
  if (!sessionInstanceId || !prescriptionInstanceId || !patientLocalDate || !startedAt || !prescriptionSnapshot) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("rehab_sessions")
    .insert({
      id: sessionInstanceId,
      user_id: user.id,
      plan_id: planId ?? null,
      prescription_instance_id: prescriptionInstanceId,
      patient_local_date: patientLocalDate,
      started_at: startedAt,
      prescription_snapshot: prescriptionSnapshot,
    })
    .select()
    .maybeSingle();

  if (!insertError) {
    return NextResponse.json({ session: mapRehabSessionRow(inserted) });
  }

  // Idempotency: a retry with the same id, or a genuinely new id for a
  // prescription instance that already has a session, both resolve to the
  // existing row rather than erroring.
  const isUniqueViolation = insertError.code === "23505";
  if (isUniqueViolation) {
    const { data: byId } = await supabase.from("rehab_sessions").select().eq("id", sessionInstanceId).maybeSingle();
    if (byId) return NextResponse.json({ session: mapRehabSessionRow(byId) });

    const { data: byInstance } = await supabase
      .from("rehab_sessions")
      .select()
      .eq("prescription_instance_id", prescriptionInstanceId)
      .maybeSingle();
    if (byInstance) return NextResponse.json({ session: mapRehabSessionRow(byInstance) });
  }

  return NextResponse.json({ error: insertError.message }, { status: 500 });
}
