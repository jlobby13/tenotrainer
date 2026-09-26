import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { reorderExercises } from "@/lib/prescriptionDraftServer";

// POST — reorderExercises. Transaction-safe two-phase reindex RPC.
export async function POST(request: NextRequest, { params }: { params: Promise<{ workoutId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { workoutId } = await params;

  let body: { orderedExerciseIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (!Array.isArray(body.orderedExerciseIds)) {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await reorderExercises({ clinicianId: auth.clinicianId, workoutId, orderedExerciseIds: body.orderedExerciseIds });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
