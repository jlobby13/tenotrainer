import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { mapMorningResponseRow } from "@/lib/morningResponseTypes";

const NOTE_MAX_LENGTH = 500;

// Raw fields the patient may progressively submit — never submitted_at,
// never anything derived. Ownership is enforced entirely by RLS: the
// patient's own client simply cannot see/update a row that isn't theirs
// (a mismatched id resolves to zero affected rows, treated as 404 below),
// rather than this route re-implementing an ownership check.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  const updates: Record<string, unknown> = {};
  if (body.nextMorningPain !== undefined) updates.next_morning_pain = body.nextMorningPain;
  if (body.nextMorningStiffness !== undefined) updates.next_morning_stiffness = body.nextMorningStiffness;
  if (body.patientNote !== undefined) {
    updates.patient_note = body.patientNote === null ? null : String(body.patientNote).slice(0, NOTE_MAX_LENGTH);
  }

  if (Object.keys(updates).length > 0) {
    const { data: updated, error: updateError } = await supabase
      .from("morning_responses")
      .update(updates)
      .eq("id", id)
      .select();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: "Morning response not found" }, { status: 404 });
    }
  }

  if (!body.finalize) {
    const { data: current } = await supabase.from("morning_responses").select().eq("id", id).maybeSingle();
    if (!current) return NextResponse.json({ error: "Morning response not found" }, { status: 404 });
    return NextResponse.json({ morningResponse: mapMorningResponseRow(current) });
  }

  // --- Finalize ---
  const { data: current, error: fetchError } = await supabase.from("morning_responses").select().eq("id", id).maybeSingle();
  if (fetchError || !current) return NextResponse.json({ error: "Morning response not found" }, { status: 404 });

  // Idempotent: a repeat finalize call (double-click, refresh, retry, Strict
  // Mode) is a safe no-op returning the already-submitted state, never a
  // re-write of submitted_at to a new, later time.
  if (current.submitted_at !== null) {
    return NextResponse.json({ morningResponse: mapMorningResponseRow(current) });
  }

  const missing: string[] = [];
  if (current.next_morning_pain == null) missing.push("nextMorningPain");
  if (current.next_morning_stiffness == null) missing.push("nextMorningStiffness");
  if (missing.length > 0) {
    return NextResponse.json({ error: "Missing required fields", missing }, { status: 400 });
  }

  // Trusted server path only, from here — service role bypasses the column
  // grant that blocks `authenticated` from writing submitted_at at all, and
  // owns the rehab_sessions status transition.
  const serviceClient = createServiceRoleClient();

  const { data: finalized, error: finalizeError } = await serviceClient
    .from("morning_responses")
    .update({ submitted_at: new Date().toISOString() })
    .eq("id", id)
    .is("submitted_at", null) // belt-and-suspenders against a concurrent finalize race
    .select()
    .maybeSingle();
  if (finalizeError) return NextResponse.json({ error: finalizeError.message }, { status: 500 });

  // finalized is null only if a concurrent request won the race above —
  // re-fetch and return that result rather than erroring.
  const finalRow = finalized ?? (await serviceClient.from("morning_responses").select().eq("id", id).maybeSingle()).data;
  if (!finalRow) return NextResponse.json({ error: "Failed to finalize morning response" }, { status: 500 });

  const { error: statusError } = await serviceClient
    .from("rehab_sessions")
    .update({ status: "response_complete" })
    .eq("id", finalRow.rehab_session_id)
    .neq("status", "response_complete");
  if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });

  return NextResponse.json({ morningResponse: mapMorningResponseRow(finalRow) });
}
