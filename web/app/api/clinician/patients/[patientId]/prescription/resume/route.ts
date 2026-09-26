import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { resumePrescription } from "@/lib/prescriptionDraftServer";

// POST — resumePrescription. High-consequence: PG + synchronous legacy check.
export async function POST(_request: Request, { params }: { params: Promise<{ patientId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { patientId } = await params;

  try {
    await resumePrescription({ clinicianId: auth.clinicianId, patientId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
