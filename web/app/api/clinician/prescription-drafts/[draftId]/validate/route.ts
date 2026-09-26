import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { validateDraft } from "@/lib/prescriptionDraftServer";

// GET — validateDraft. Read-only preview of publish-readiness; the SAME
// rule set publishDraft enforces (validate_prescription_draft RPC), never
// duplicated.
export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  try {
    const rules = await validateDraft({ clinicianId: auth.clinicianId, draftId });
    return NextResponse.json({ rules, publishable: rules.every((r) => r.passed) });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
