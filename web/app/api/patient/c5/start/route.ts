import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { recordFirstPerformance, sanitizePerformance } from "@/lib/c5RuntimeServer";
import { badRequest, isUuid, readJson, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6D — the Start boundary: the first confirmed performed unit, through
// the atomic c5_record_first_performance transaction. clientRequestId is the
// idempotency key — the browser reuses it on every retry of the same Start.
export async function POST(request: NextRequest) {
  return withC5Patient(async (patientId) => {
    const body = await readJson(request);
    if (!body) return badRequest("Invalid JSON body");
    const { clientRequestId, expectedVersionId, workoutId, sequenceChoice } = body;
    if (!isUuid(clientRequestId) || !isUuid(expectedVersionId) || !isUuid(workoutId)) return badRequest("Missing or invalid identifiers");
    if (sequenceChoice != null && sequenceChoice !== "repeat_previous" && sequenceChoice !== "advance_next") return badRequest("Invalid sequenceChoice");
    const performance = sanitizePerformance(body.performance);
    if (!performance) return badRequest("Invalid performance");
    const rawSkips = body.preStartSkips ?? [];
    if (!Array.isArray(rawSkips)) return badRequest("Invalid preStartSkips");
    const preStartSkips = rawSkips.map((s) => ({ exercise_id: (s as { exercise_id?: unknown })?.exercise_id, unit_index: (s as { unit_index?: unknown })?.unit_index }));
    if (preStartSkips.some((s) => typeof s.exercise_id !== "string" || typeof s.unit_index !== "number")) return badRequest("Invalid preStartSkips");

    const response = await recordFirstPerformance(patientId, {
      clientRequestId,
      expectedVersionId,
      workoutId,
      performance,
      preStartSkips: preStartSkips as { exercise_id: string; unit_index: number }[],
      sequenceChoice: (sequenceChoice as "repeat_previous" | "advance_next" | null) ?? null,
    });
    return NextResponse.json(response);
  });
}
