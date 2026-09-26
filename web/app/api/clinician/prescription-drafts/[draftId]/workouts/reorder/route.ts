import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { reorderWorkouts } from "@/lib/prescriptionDraftServer";

// POST — reorderWorkouts. Transaction-safe two-phase reindex RPC.
export async function POST(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  let body: { orderedWorkoutIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (!Array.isArray(body.orderedWorkoutIds)) {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await reorderWorkouts({ clinicianId: auth.clinicianId, draftId, orderedWorkoutIds: body.orderedWorkoutIds });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
