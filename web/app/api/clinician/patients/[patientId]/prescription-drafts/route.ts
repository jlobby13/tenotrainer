import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { createDraft } from "@/lib/prescriptionDraftServer";
import type { DraftSource } from "@/lib/prescriptionDraftTypes";

const VALID_SOURCES: DraftSource[] = ["empty", "clone_active", "clone_historical", "from_template"];

// POST — createDraft. High-consequence: PG + synchronous legacy check
// inside createDraft() itself (verifyHighConsequenceAuthorization).
export async function POST(request: NextRequest, { params }: { params: Promise<{ patientId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { patientId } = await params;

  let body: { source?: string; sourceVersionId?: string; templateId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }
  if (!body.source || !VALID_SOURCES.includes(body.source as DraftSource)) {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    const result = await createDraft({
      clinicianId: auth.clinicianId,
      patientId,
      source: body.source as DraftSource,
      sourceVersionId: body.sourceVersionId ?? null,
      templateId: body.templateId ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
