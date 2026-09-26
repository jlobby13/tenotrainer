import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { addWorkout } from "@/lib/prescriptionDraftServer";

// POST — addWorkout. Editing-owner only (enforced inside).
export async function POST(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  let body: { label?: string | null; orderIndex?: number; daysOfWeek?: number[] | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (typeof body.orderIndex !== "number") {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    const result = await addWorkout({
      clinicianId: auth.clinicianId,
      draftId,
      label: body.label ?? null,
      orderIndex: body.orderIndex,
      daysOfWeek: body.daysOfWeek ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
