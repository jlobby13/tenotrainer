import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { evaluateEscalation } from "@/lib/escalation";
import { acuteAssessmentRequired, mapRehabSessionRow } from "@/lib/rehabSessionTypes";
import { ensureMorningResponseExists } from "@/lib/morningResponseServer";

// Raw fields the patient may progressively submit. Deliberately excludes
// escalation_level/escalation_reason/rule_version — those are never accepted
// from the browser; the column-level grant on rehab_sessions makes this
// unenforceable even if a bug here tried to pass one through.
const RAW_FIELD_KEYS = [
  "peakSessionPain",
  "difficulty",
  "contributorReason",
  "contributorExerciseId",
  "contributorOtherText",
  "suddenOrSharpPain",
  "newFunctionalDifficulty",
  "popFeltOrHeard",
] as const;

const RAW_FIELD_COLUMN: Record<(typeof RAW_FIELD_KEYS)[number], string> = {
  peakSessionPain: "peak_session_pain",
  difficulty: "difficulty",
  contributorReason: "contributor_reason",
  contributorExerciseId: "contributor_exercise_id",
  contributorOtherText: "contributor_other_text",
  suddenOrSharpPain: "sudden_or_sharp_pain",
  newFunctionalDifficulty: "new_functional_difficulty",
  popFeltOrHeard: "pop_felt_or_heard",
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Progressive checkpoint: update whichever raw fields were provided.
  const updates: Record<string, unknown> = {};
  for (const key of RAW_FIELD_KEYS) {
    if (body[key] !== undefined) updates[RAW_FIELD_COLUMN[key]] = body[key];
  }
  if (Object.keys(updates).length > 0) {
    // First checkpoint moves status forward; later ones stay at response_in_progress.
    const { data: current } = await supabase.from("rehab_sessions").select("status").eq("id", id).maybeSingle();
    if (!current) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (current.status === "exercises_complete") updates.status = "response_in_progress";

    const { error: updateError } = await supabase.from("rehab_sessions").update(updates).eq("id", id);
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  if (!body.finalize) {
    const { data: session } = await supabase.from("rehab_sessions").select().eq("id", id).maybeSingle();
    return NextResponse.json({ session: session ? mapRehabSessionRow(session) : null });
  }

  // --- Finalize: validate, evaluate escalation server-side, commit. ---
  const { data: session, error: fetchError } = await supabase.from("rehab_sessions").select().eq("id", id).maybeSingle();
  if (fetchError || !session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const { data: events } = await supabase.from("session_events").select("type").eq("rehab_session_id", id);
  const hasPainLimitingEvent = (events ?? []).some((e) => e.type === "pain_limiting");
  const hasPopEvent = (events ?? []).some((e) => e.type === "pop_reported");

  const missing: string[] = [];
  if (session.peak_session_pain == null) missing.push("peakSessionPain");
  if (session.difficulty == null) missing.push("difficulty");

  const acuteRequired = acuteAssessmentRequired({
    exerciseOutcome: session.exercise_outcome,
    earlyEndReason: session.early_end_reason,
    hasPopEvent,
    hasPainLimitingEvent,
  });
  if (acuteRequired) {
    if (session.sudden_or_sharp_pain == null) missing.push("suddenOrSharpPain");
    if (session.pop_felt_or_heard == null) missing.push("popFeltOrHeard");
    if (session.new_functional_difficulty == null) missing.push("newFunctionalDifficulty");
  }

  const contributorTriggered = session.exercise_outcome === "ended_early" && hasPainLimitingEvent;
  if (contributorTriggered && session.contributor_reason == null) missing.push("contributorReason");

  if (missing.length > 0) {
    return NextResponse.json({ error: "Missing required fields", missing }, { status: 400 });
  }

  const escalation = evaluateEscalation({
    peakSessionPain: session.peak_session_pain,
    suddenOrSharpPain: session.sudden_or_sharp_pain,
    popFeltOrHeard: session.pop_felt_or_heard,
    newFunctionalDifficulty: session.new_functional_difficulty,
    hasPainLimitingEvent,
    endedEarlyForSymptoms: session.exercise_outcome === "ended_early" && session.early_end_reason === "pain_symptoms",
  });

  // Trusted server path only, from here — service role bypasses the column
  // grants that block `authenticated` from writing escalation data at all.
  const serviceClient = createServiceRoleClient();

  const { error: evalInsertError } = await serviceClient.from("escalation_evaluations").insert({
    rehab_session_id: id,
    escalation_level: escalation.level,
    escalation_reason: escalation.reason,
    rule_version: escalation.ruleVersion,
    inputs_snapshot: {
      peakSessionPain: session.peak_session_pain,
      suddenOrSharpPain: session.sudden_or_sharp_pain,
      popFeltOrHeard: session.pop_felt_or_heard,
      newFunctionalDifficulty: session.new_functional_difficulty,
      hasPainLimitingEvent,
      endedEarlyForSymptoms: session.exercise_outcome === "ended_early" && session.early_end_reason === "pain_symptoms",
    },
  });
  if (evalInsertError) return NextResponse.json({ error: evalInsertError.message }, { status: 500 });

  const { data: finalSession, error: finalizeError } = await serviceClient
    .from("rehab_sessions")
    .update({
      current_escalation_level: escalation.level,
      status: "awaiting_morning_response",
      response_recorded_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (finalizeError) return NextResponse.json({ error: finalizeError.message }, { status: 500 });

  // M4 Stage 1: the morning-response OBLIGATION is created as part of this
  // exact lifecycle transition, not lazily discovered later — this is what
  // lets scheduled_eligible_at be frozen using the reminder preference in
  // effect right now. A failure here must not silently lose the M3 result
  // the patient just successfully submitted; log and continue rather than
  // erroring the whole finalize response, since getOldestOutstandingMorningResponse's
  // lazy backfill will recover this session's obligation on next access anyway.
  try {
    await ensureMorningResponseExists(id);
  } catch (e) {
    console.error(`Failed to create morning_responses row for session ${id} during finalize:`, e);
  }

  return NextResponse.json({ session: mapRehabSessionRow(finalSession), escalation });
}
