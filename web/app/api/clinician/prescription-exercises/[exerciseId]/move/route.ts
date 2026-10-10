import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { moveExercise } from "@/lib/prescriptionDraftServer";

// POST — moveExercise (C5.4C §14). Editing-owner only (enforced inside).
// Moves an existing prescription_exercises row to a different workout in
// the SAME draft, appending it at the end — never recreates the exercise or
// its dosage row, never merges dosage on a duplicate-canonical collision
// (rejected instead, see moveExercise's own comment).
export async function POST(request: NextRequest, { params }: { params: Promise<{ exerciseId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { exerciseId } = await params;

  let body: { targetWorkoutId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (!body.targetWorkoutId) {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await moveExercise({ clinicianId: auth.clinicianId, exerciseId, targetWorkoutId: body.targetWorkoutId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
