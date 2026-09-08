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

  // Founder-acceptance patch: reconcile any orphaned Level 3/5 escalation
  // into its missing acute_safety_episodes row FIRST, as its own
  // independently-committed call, BEFORE ever invoking
  // create_rehab_session_if_allowed(). This must happen as a separate
  // transaction — PostgreSQL rolls back an entire transaction on a raised
  // exception, so reconciliation cannot safely happen inside the same
  // transaction that later raises the brake-active exception (see
  // supabase/migrations/20260911000005's header comment for the full
  // reasoning). Fails CLOSED: if reconciliation itself errors, session
  // creation is never attempted — an authoritative safety fact must never
  // be silently bypassed because its own repair step failed.
  const { error: reconcileError } = await supabase.rpc("reconcile_missing_acute_episodes", { p_user_id: user.id });
  if (reconcileError) {
    console.error("Acute safety reconciliation failed — failing closed:", reconcileError);
    return NextResponse.json(
      {
        error: "Unable to verify safety status before starting a new session. Please try again.",
        code: "ACUTE_SAFETY_RECONCILIATION_FAILED",
      },
      { status: 503 }
    );
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
    // Acute Safety Gate milestone — checked server-side, ahead of the M4
    // gate, inside the RPC itself (read-only there — see that migration's
    // comment for why). Never trusts browser-supplied safety state;
    // redirectTo lets the client route to the reassessment flow (Level 3)
    // or a professional-review-focused message (Level 4/5) without the
    // client ever deciding the gating itself.
    if (error.message === "ACUTE_SAFETY_REVIEW_REQUIRED" || error.message === "ACUTE_SAFETY_PROFESSIONAL_REVIEW_REQUIRED") {
      // Recording the blocked opportunity is a SEPARATE, independently-
      // committed call: the RPC transaction that just raised this
      // exception was rolled back in its entirety (PostgreSQL semantics —
      // an insert immediately before a raised exception in the same
      // transaction never persists), so this durable fact is written here
      // instead, in its own transaction, after the gate's decision is
      // already final. Best-effort: a failure here must not hide the real
      // gating error from the patient, and get_patient_acute_brake_status
      // is idempotent-safe to call repeatedly.
      try {
        const { data: brakeRows } = await supabase.rpc("get_patient_acute_brake_status", { p_user_id: user.id });
        const brake = (brakeRows ?? [])[0];
        if (brake) {
          await supabase.rpc("record_blocked_loading_opportunity", {
            p_acute_safety_episode_id: brake.episode_id,
            p_prescription_instance_id: prescriptionInstanceId,
            p_brake_level: brake.effective_level,
          });
        }
      } catch (e) {
        console.error("Failed to record blocked loading opportunity:", e);
      }
      return NextResponse.json(
        {
          error: "Acute safety review required before your next rehab session",
          code: error.message,
          redirectTo: "/patient/acute-safety",
        },
        { status: 409 }
      );
    }
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
    if (error.message === "PRESCRIPTION_VERSION_REQUIRED") {
      // M5 Stage 1 LOCKED invariant: the RPC never creates a prescription
      // version opportunistically. A patient reaching session creation with
      // no version on file at all is a data-integrity/configuration
      // failure (missed onboarding sync, missed legacy bootstrap) — surface
      // it explicitly rather than silently inventing clinical state.
      return NextResponse.json(
        {
          error: "No prescription version on file for this patient",
          code: "PRESCRIPTION_VERSION_REQUIRED",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ session: mapRehabSessionRow(data) });
}
