import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { getDraftPublicationOutcome } from "@/lib/prescriptionDraftServer";

// GET — C5.4D publication reconciliation. Read-only: reports whether this
// draft was actually published (and as which version), so a client whose
// publish response was lost can show the true state instead of guessing or
// blindly retrying a consequential operation.
export async function GET(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  try {
    const outcome = await getDraftPublicationOutcome({ clinicianId: auth.clinicianId, draftId });
    return NextResponse.json(outcome, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
