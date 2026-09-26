import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { updateDosage } from "@/lib/prescriptionDraftServer";
import type { DosageInput } from "@/lib/prescriptionDraftTypes";

// PUT — updateDosage. Editing-owner only; DB CHECK constraints are the
// authoritative shape validation (exact/range mutual exclusivity, per-type
// field requirements, load consistency) — this route does not re-implement
// them, it only maps VALIDATION_FAILED through cleanly.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ exerciseId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { exerciseId } = await params;

  let body: { dosage?: DosageInput };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (!body.dosage?.dosageType) {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await updateDosage({ clinicianId: auth.clinicianId, exerciseId, dosage: body.dosage });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
