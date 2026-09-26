import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { addExercise } from "@/lib/prescriptionDraftServer";

// POST — addExercise. Editing-owner only; canonical exercise existence
// checked inside (EXERCISE_UNAVAILABLE if not found).
export async function POST(request: NextRequest, { params }: { params: Promise<{ workoutId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { workoutId } = await params;

  let body: { canonicalExerciseId?: string; orderIndex?: number; additionalInstructions?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (!body.canonicalExerciseId || typeof body.orderIndex !== "number") {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    const result = await addExercise({
      clinicianId: auth.clinicianId,
      workoutId,
      canonicalExerciseId: body.canonicalExerciseId,
      orderIndex: body.orderIndex,
      additionalInstructions: body.additionalInstructions ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
