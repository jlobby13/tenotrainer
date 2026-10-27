import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { pausePrescription } from "@/lib/prescriptionDraftServer";

// POST — pausePrescription. High-consequence: Postgres assignment check.
export async function POST(_request: Request, { params }: { params: Promise<{ patientId: string }> }) {
  const auth = await requireClinicianForRoute({ mutation: true });
  if ("response" in auth) return auth.response;
  const { patientId } = await params;

  try {
    await pausePrescription({ clinicianId: auth.clinicianId, patientId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
