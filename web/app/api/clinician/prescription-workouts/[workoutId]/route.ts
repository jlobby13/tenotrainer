import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { updateWorkout, removeWorkout } from "@/lib/prescriptionDraftServer";

// PATCH — updateWorkout. Editing-owner only (enforced inside).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ workoutId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { workoutId } = await params;

  let body: { label?: string | null; daysOfWeek?: number[] | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await updateWorkout({ clinicianId: auth.clinicianId, workoutId, label: body.label, daysOfWeek: body.daysOfWeek });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}

// DELETE — removeWorkout. Editing-owner only (enforced inside).
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ workoutId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { workoutId } = await params;

  try {
    await removeWorkout({ clinicianId: auth.clinicianId, workoutId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
