import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { mapMorningResponseRow, mapToleranceEvaluationRow } from "@/lib/morningResponseTypes";
import { evaluateTolerance, TOLERANCE_RULE_VERSION, type ToleranceEvaluationInputs } from "@/lib/toleranceEvaluation";

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
  if (body.patientNote !== undefined) {
    updates.patient_note = body.patientNote === null ? null : String(body.patientNote).slice(0, NOTE_MAX_LENGTH);
  }
  if (body.morningPainTolerability !== undefined) updates.morning_pain_tolerability = body.morningPainTolerability;
  if (body.externalLoadCategories !== undefined) updates.external_load_categories = body.externalLoadCategories;
  if (body.externalLoadTiming !== undefined) updates.external_load_timing = body.externalLoadTiming;

  // Stage 4 / UNKNOWN != ZERO: stiffness=0 means duration is genuinely not
  // applicable (never asked, never left unanswered-looking); a stiffness
  // value changing away from 0 without an accompanying duration answer must
  // NOT silently keep a stale "not_applicable" — that would misrepresent an
  // unanswered duration as resolved. An explicit stiffnessDuration in the
  // same request (handled just below) always wins over this default.
  if (body.nextMorningStiffness !== undefined) {
    updates.next_morning_stiffness = body.nextMorningStiffness;
    if (body.nextMorningStiffness === 0) {
      updates.stiffness_duration = "not_applicable";
    } else if (body.stiffnessDuration === undefined) {
      updates.stiffness_duration = null;
    }
  }
  if (body.stiffnessDuration !== undefined) {
    updates.stiffness_duration = body.stiffnessDuration;
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

  const serviceClient = createServiceRoleClient();

  // Idempotent: a repeat finalize call (double-click, refresh, retry, Strict
  // Mode) is a safe no-op returning the already-submitted state, never a
  // re-write of submitted_at to a new, later time — the evaluation lookup
  // below still runs so an already-submitted response reliably returns its
  // (already-computed, or defensively-recovered) evaluation too.
  let finalRow = current;
  if (current.submitted_at === null) {
    const missing: string[] = [];
    if (current.next_morning_pain == null) missing.push("nextMorningPain");
    if (current.next_morning_stiffness == null) missing.push("nextMorningStiffness");
    if (current.next_morning_stiffness > 0 && current.stiffness_duration == null) missing.push("stiffnessDuration");
    if (current.next_morning_pain === 5 && current.morning_pain_tolerability == null) missing.push("morningPainTolerability");
    if (missing.length > 0) {
      return NextResponse.json({ error: "Missing required fields", missing }, { status: 400 });
    }

    // Trusted server path only, from here — service role bypasses the
    // column grant that blocks `authenticated` from writing submitted_at at
    // all, and owns the rehab_sessions status transition.
    const { data: finalized, error: finalizeError } = await serviceClient
      .from("morning_responses")
      .update({ submitted_at: new Date().toISOString() })
      .eq("id", id)
      .is("submitted_at", null) // belt-and-suspenders against a concurrent finalize race
      .select()
      .maybeSingle();
    if (finalizeError) return NextResponse.json({ error: finalizeError.message }, { status: 500 });

    // finalized is null only if a concurrent request won the race above —
    // re-fetch and use that result rather than erroring.
    finalRow = finalized ?? (await serviceClient.from("morning_responses").select().eq("id", id).maybeSingle()).data;
    if (!finalRow) return NextResponse.json({ error: "Failed to finalize morning response" }, { status: 500 });

    const { error: statusError } = await serviceClient
      .from("rehab_sessions")
      .update({ status: "response_complete" })
      .eq("id", finalRow.rehab_session_id)
      .neq("status", "response_complete");
    if (statusError) return NextResponse.json({ error: statusError.message }, { status: 500 });
  }

  // --- Stage 4: single-session tolerance evaluation ---
  // Idempotent per rule version (tolerance_evaluations_session_rule_version_unique):
  // check for an existing evaluation at the CURRENT rule version first;
  // only compute+persist a new one if none exists yet. Historical
  // evaluations are never overwritten — a future rule version would produce
  // an additional row, not rewrite this one.
  const { data: session, error: sessionError } = await serviceClient
    .from("rehab_sessions")
    .select("peak_session_pain, current_escalation_level, contributor_reason, exercise_outcome, early_end_reason")
    .eq("id", finalRow.rehab_session_id)
    .maybeSingle();
  if (sessionError || !session) {
    return NextResponse.json({ error: "Associated rehab session not found" }, { status: 500 });
  }

  const evaluationInputs: ToleranceEvaluationInputs = {
    peakSessionPain: session.peak_session_pain,
    nextMorningPain: finalRow.next_morning_pain,
    nextMorningStiffness: finalRow.next_morning_stiffness,
    stiffnessDuration: finalRow.stiffness_duration,
    morningPainTolerability: finalRow.morning_pain_tolerability,
    escalationLevel: session.current_escalation_level,
    externalLoadCategories: finalRow.external_load_categories,
    hasExerciseSpecificSymptomResponse: session.contributor_reason === "specific_exercise",
    hasPainLimitedTermination: session.exercise_outcome === "ended_early" && session.early_end_reason === "pain_symptoms",
  };

  const { data: existingEvaluation } = await serviceClient
    .from("tolerance_evaluations")
    .select()
    .eq("rehab_session_id", finalRow.rehab_session_id)
    .eq("rule_version", TOLERANCE_RULE_VERSION)
    .maybeSingle();

  let evaluationRow = existingEvaluation;
  if (!evaluationRow) {
    const result = evaluateTolerance(evaluationInputs);
    // Defensive only — unreachable in the normal flow, since the required-
    // field validation above already blocks an incomplete finalize. Never
    // persist a fabricated recommendation for genuinely incomplete data.
    if (result.classification !== "insufficient_data") {
      const { data: inserted, error: insertError } = await serviceClient
        .from("tolerance_evaluations")
        .insert({
          rehab_session_id: finalRow.rehab_session_id,
          morning_response_id: finalRow.id,
          tolerance_classification: result.classification,
          immediate_guidance: result.guidance,
          patient_facing_label: result.patientFacingLabel,
          reason: result.reason,
          reason_codes: result.reasonCodes,
          rule_version: result.ruleVersion,
          inputs_snapshot: evaluationInputs,
        })
        .select()
        .maybeSingle();
      if (insertError) {
        // Unique-violation race: a concurrent finalize call already
        // inserted the evaluation for this (session, rule_version) between
        // our SELECT and INSERT — idempotent-safe, fetch the row that won.
        if (insertError.code === "23505") {
          const { data: raced } = await serviceClient
            .from("tolerance_evaluations")
            .select()
            .eq("rehab_session_id", finalRow.rehab_session_id)
            .eq("rule_version", result.ruleVersion)
            .maybeSingle();
          evaluationRow = raced ?? null;
        } else {
          return NextResponse.json({ error: insertError.message }, { status: 500 });
        }
      } else {
        evaluationRow = inserted;
      }
    }
  }

  return NextResponse.json({
    morningResponse: mapMorningResponseRow(finalRow),
    toleranceEvaluation: evaluationRow ? mapToleranceEvaluationRow(evaluationRow) : null,
  });
}
