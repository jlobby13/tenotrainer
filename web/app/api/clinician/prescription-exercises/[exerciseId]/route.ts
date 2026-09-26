import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { updateExercise, removeExercise } from "@/lib/prescriptionDraftServer";
import type { ExerciseStatus } from "@/lib/prescriptionDraftTypes";

// PATCH — updateExercise (including exercise pause/unpause within draft
// content — immutable once published, editable only here). Editing-owner
// only (enforced inside).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ exerciseId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { exerciseId } = await params;

  let body: { status?: ExerciseStatus; additionalInstructions?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await updateExercise({
      clinicianId: auth.clinicianId,
      exerciseId,
      status: body.status,
      additionalInstructions: body.additionalInstructions,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}

// DELETE — removeExercise. Editing-owner only (enforced inside).
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ exerciseId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { exerciseId } = await params;

  try {
    await removeExercise({ clinicianId: auth.clinicianId, exerciseId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
