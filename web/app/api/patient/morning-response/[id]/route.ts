import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { mapMorningResponseRow, mapToleranceEvaluationRow } from "@/lib/morningResponseTypes";
import { evaluateTolerance, TOLERANCE_RULE_VERSION, type ToleranceEvaluationInputs } from "@/lib/toleranceEvaluation";
import {
  EXTERNAL_LOAD_CATEGORIES,
  M4_FIXED_TIMING,
  type ExternalLoadCategory,
} from "@/lib/sessionLoadObservations";
import { generateCapacityInterpretations } from "@/lib/capacityInterpretationEngine";
import { generateTrainingResponseInterpretation } from "@/lib/trainingResponseInterpretationEngine";
import { isScheduledEligible } from "@/lib/morningEligibility";

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
  // externalLoad is handled separately below (session_load_observations,
  // not a morning_responses column — see the founder-acceptance patch note
  // at the top of sessionLoadObservations.ts). morning_responses.external_load_*
  // are deprecated and no longer written here.

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
  // M6 Stage 4: true only for the request that actually wins the
  // compare-and-swap below (the real null->submitted transition) — never
  // for a retry/double-click/refresh that finds submitted_at already set
  // (which skips this whole block, leaving this false). Longitudinal
  // interpretation generation is gated on this exact flag further down, so
  // a repeat finalize call never re-triggers it — see the note at that
  // call site for why.
  let didFinalizeThisRequest = false;
  if (current.submitted_at === null) {
    // Core Patient Experience v1 blocker fix — authoritative write-boundary
    // enforcement of the ALREADY-PERSISTED scheduled_eligible_at (computed
    // once, at row-creation/reconciliation time, in morningResponseServer.ts
    // — never recomputed or re-derived here). Reuses the exact same pure
    // function the dashboard already uses to decide whether to show the
    // "Complete Check-In" CTA (lib/morningEligibility.ts's
    // isScheduledEligible), so there is exactly one eligibility calculation
    // in the whole app, not a second independent one. Direct navigation to
    // this route bypassing the dashboard's own (UI-only) gating previously
    // had nothing stopping it from finalizing same-day — this closes that
    // gap at the actual write boundary. Checked BEFORE the missing-fields
    // validation (a too-early attempt is rejected on its own terms, not
    // reported as if the patient merely forgot to answer something) and
    // before ANY mutation below — nothing is written, no tolerance is
    // evaluated, and no M6 interpretation is generated for a rejected
    // attempt. Scoped to the finalize transition only — the progressive
    // save path above (plain field updates, no `finalize: true`) is
    // untouched, since a draft value is never "finalized truth."
    if (!isScheduledEligible(current.scheduled_eligible_at as string | null, new Date())) {
      return NextResponse.json(
        {
          error: "This morning response is not eligible for check-in yet.",
          code: "MORNING_RESPONSE_NOT_YET_ELIGIBLE",
          scheduledEligibleAt: current.scheduled_eligible_at,
        },
        { status: 409 }
      );
    }

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
    didFinalizeThisRequest = finalized != null;

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

    // --- Founder-acceptance patch: M4-provenance external-load capture ---
    // Optional, exposure-only, non-blocking (never in `missing`) — matches
    // the original Stage 4 behavior of being sent once, at finalize, rather
    // than progressively checkpointed. M4 asks about exactly one temporal
    // window (after the rehab session, before this morning response), so
    // timing is never accepted from the client — it is always M4_FIXED_TIMING
    // for every real category, and NULL for the explicit "none" answer.
    // Scoped strictly to captured_during='m4_morning_response': this never
    // reads or deletes M3-provenance rows, satisfying "M4 does not overwrite
    // M3 context." A retried finalize call safely replaces only its own
    // prior M4 rows (delete-then-insert), never duplicating them.
    if (body.externalLoad && Array.isArray(body.externalLoad.categories) && body.externalLoad.categories.length > 0) {
      const categories = body.externalLoad.categories as ExternalLoadCategory[];
      const validCategories = categories.filter(
        (c): c is ExternalLoadCategory => c === "none" || EXTERNAL_LOAD_CATEGORIES.includes(c)
      );
      if (validCategories.length > 0) {
        const { error: deleteError } = await serviceClient
          .from("session_load_observations")
          .delete()
          .eq("rehab_session_id", finalRow.rehab_session_id)
          .eq("captured_during", "m4_morning_response");
        if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

        const isExplicitNone = validCategories.length === 1 && validCategories[0] === "none";
        const rows = isExplicitNone
          ? [{ category: "none" as const, timing: null }]
          : validCategories.filter((c) => c !== "none").map((category) => ({ category, timing: M4_FIXED_TIMING }));

        const { error: insertError } = await serviceClient.from("session_load_observations").insert(
          rows.map((r) => ({
            rehab_session_id: finalRow.rehab_session_id,
            user_id: user.id,
            category: r.category,
            timing: r.timing,
            captured_during: "m4_morning_response",
          }))
        );
        if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }
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

  // Combines M3- and M4-provenance observations into one list for the
  // evaluator — "M3 and M4 observations should combine into the session's
  // external-loading context while retaining their provenance/timing"
  // (provenance/timing are retained in session_load_observations itself;
  // the evaluator only needs "was anything reported" per its existing,
  // never-classification-affecting contextual check).
  const { data: loadObservations } = await serviceClient
    .from("session_load_observations")
    .select("category")
    .eq("rehab_session_id", finalRow.rehab_session_id);
  const externalLoadCategories: ExternalLoadCategory[] | null =
    loadObservations && loadObservations.length > 0 ? (loadObservations.map((r) => r.category) as ExternalLoadCategory[]) : null;

  const evaluationInputs: ToleranceEvaluationInputs = {
    peakSessionPain: session.peak_session_pain,
    nextMorningPain: finalRow.next_morning_pain,
    nextMorningStiffness: finalRow.next_morning_stiffness,
    stiffnessDuration: finalRow.stiffness_duration,
    morningPainTolerability: finalRow.morning_pain_tolerability,
    escalationLevel: session.current_escalation_level,
    externalLoadCategories,
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

  // --- M6 Stage 4: longitudinal interpretation generation ---
  // Triggered exactly once per session, only on the request that actually
  // performed the real finalize transition (didFinalizeThisRequest) and
  // only once a real tolerance evaluation is confirmed persisted for this
  // session (evaluationRow) — Capacity's own "base episode" gate requires
  // one (capacityInterpretationEngine.ts). A retry/double-click/refresh of
  // this route never re-enters this block: didFinalizeThisRequest stays
  // false whenever submitted_at was already set on entry, exactly
  // mirroring the compare-and-swap idempotency this route already uses for
  // the morning_responses -> rehab_sessions status transition above.
  //
  // Order matters: generateTrainingResponseInterpretation() ALREADY calls
  // generateShortWindowSymptomInterpretation() as its own first step
  // (regenerating and re-persisting that exact Symptoms interpretation —
  // see trainingResponseInterpretationEngine.ts's header note). Calling
  // generateShortWindowSymptomInterpretation() again here directly would
  // therefore persist a second, duplicate Symptoms row every time — so it
  // is deliberately NOT called a second time; Training Response's own call
  // is this route's only Symptoms-generation trigger.
  //
  // Failure isolation (patient-critical write vs. derived data): each call
  // is independently try/caught and logged, never allowed to turn an
  // already-successful morning-response finalize into an apparent failure
  // — mirrors the existing ensureMorningResponseExists/
  // confirmAcuteSafetyEpisode precedent in
  // app/api/patient/rehab-session/[id]/response/route.ts. Unlike that
  // precedent, there is no lazy-backfill-on-read recovery for a failed
  // attempt here — see the M6 Stage 4 report's "failure isolation"
  // section for this known limitation. Clinical logic itself
  // (generateCapacityInterpretations/generateTrainingResponseInterpretation)
  // is untouched by this change.
  if (didFinalizeThisRequest && evaluationRow) {
    try {
      await generateCapacityInterpretations(user.id, finalRow.rehab_session_id);
    } catch (e) {
      console.error(`M6 Stage 4: Capacity interpretation generation failed for session ${finalRow.rehab_session_id}:`, e);
    }
    try {
      await generateTrainingResponseInterpretation(user.id);
    } catch (e) {
      console.error(`M6 Stage 4: Training Response interpretation generation failed for session ${finalRow.rehab_session_id}:`, e);
    }
  }

  return NextResponse.json({
    morningResponse: mapMorningResponseRow(finalRow),
    toleranceEvaluation: evaluationRow ? mapToleranceEvaluationRow(evaluationRow) : null,
  });
}
