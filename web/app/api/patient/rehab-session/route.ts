import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";
import { getOldestOutstandingMorningResponse } from "@/lib/morningResponseServer";

// M4 Stage 3: creates (or idempotently recovers) the durable rehab_sessions
// row through the atomic create_rehab_session_if_allowed() RPC — see
// supabase/migrations/20260907000001_m4_stage3_atomic_session_gate.sql for
// the concurrency guarantee (a transaction-scoped, per-patient advisory
// lock; existing-session recovery always wins before the morning-response
// gate is even checked). This is now the single authoritative point where
// "may this patient begin a new prescribed rehab session" is decided —
// SessionPlayer.handleBegin calls this and WAITS for the result before
// starting Active Rehab; it is no longer fire-and-forget.
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

  const { data, error } = await supabase.rpc("create_rehab_session_if_allowed", {
    p_session_id: sessionInstanceId,
    p_plan_id: planId ?? null,
    p_prescription_instance_id: prescriptionInstanceId,
    p_patient_local_date: patientLocalDate,
    p_started_at: startedAt,
    p_prescription_snapshot: prescriptionSnapshot,
  });

  if (error) {
    if (error.message === "MORNING_RESPONSE_REQUIRED") {
      // Fetch obligation details for client routing — this is a separate,
      // non-transactional read purely for the response payload; the
      // clinical decision itself already happened atomically inside the RPC.
      const outstanding = await getOldestOutstandingMorningResponse(user.id).catch(() => null);
      return NextResponse.json(
        {
          error: "Morning response required",
          code: "MORNING_RESPONSE_REQUIRED",
          morningResponseId: outstanding?.id ?? null,
          redirectTo: "/patient/morning-response",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ session: mapRehabSessionRow(data) });
}
