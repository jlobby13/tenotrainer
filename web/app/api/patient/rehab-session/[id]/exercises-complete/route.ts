import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { mapRehabSessionRow } from "@/lib/rehabSessionTypes";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const setOutcomes: Array<{
    exerciseId: string;
    exerciseOrderIndex: number;
    setIndex: number;
    outcome: "completed" | "skipped";
    prescribedReps: number | null;
    prescribedLoad: number | null;
    actualReps: number | null;
    actualLoad: number | null;
    wasEdited: boolean;
    occurredAt: string;
  }> = body.setOutcomes ?? [];
  const sessionEvents: Array<{
    exerciseId: string | null;
    setIndex: number | null;
    type: string;
    note: string | null;
    occurredAt: string;
  }> = body.sessionEvents ?? [];

  // A pop is safety-critical: force acute_terminated regardless of what the
  // client's exercise_outcome claims, so a client bug can't suppress it.
  const hasPop = sessionEvents.some((e) => e.type === "pop_reported");
  const exerciseOutcome = hasPop ? "acute_terminated" : (body.exerciseOutcome ?? "completed");
  const earlyEndReason = hasPop ? null : (body.earlyEndReason ?? null);

  // Ownership check — RLS would also block a cross-user write, but failing
  // fast here gives a clearer error than a silent RLS no-op.
  const { data: existing, error: fetchError } = await supabase
    .from("rehab_sessions")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchError || !existing) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  if (setOutcomes.length > 0) {
    const rows = setOutcomes.map((s) => ({
      rehab_session_id: id,
      exercise_id: s.exerciseId,
      exercise_order_index: s.exerciseOrderIndex,
      set_index: s.setIndex,
      outcome: s.outcome,
      prescribed_reps: s.prescribedReps,
      prescribed_load: s.prescribedLoad,
      actual_reps: s.outcome === "completed" ? s.actualReps : null,
      actual_load: s.outcome === "completed" ? s.actualLoad : null,
      was_edited: s.wasEdited,
      occurred_at: s.occurredAt,
    }));
    const { error: setError } = await supabase
      .from("set_outcomes")
      .upsert(rows, { onConflict: "rehab_session_id,exercise_id,set_index" });
    if (setError) return NextResponse.json({ error: setError.message }, { status: 500 });
  }

  if (sessionEvents.length > 0) {
    const rows = sessionEvents.map((e) => ({
      rehab_session_id: id,
      exercise_id: e.exerciseId,
      set_index: e.setIndex,
      type: e.type,
      note: e.note,
      occurred_at: e.occurredAt,
    }));
    // Idempotent against resubmission (e.g. a refresh mid-flow re-runs the
    // whole bootstrap): duplicates of the exact same report are silently
    // dropped rather than inserted again — see
    // session_events_natural_key in 20260905000004_m3_session_events_idempotent.sql.
    const { error: eventError } = await supabase
      .from("session_events")
      .upsert(rows, { onConflict: "rehab_session_id,exercise_id_key,set_index_key,type,occurred_at", ignoreDuplicates: true });
    if (eventError) return NextResponse.json({ error: eventError.message }, { status: 500 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("rehab_sessions")
    .update({
      status: "exercises_complete",
      exercise_outcome: exerciseOutcome,
      early_end_reason: earlyEndReason,
      exercises_ended_at: new Date().toISOString(),
      // A pop is an explicit, already-unambiguous patient report — no need
      // to re-ask it later as one of the three acute questions.
      ...(hasPop ? { pop_felt_or_heard: true } : {}),
    })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  return NextResponse.json({ session: mapRehabSessionRow(updated) });
}
