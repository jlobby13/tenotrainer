import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { publishDraft } from "@/lib/prescriptionDraftServer";

// POST — publishDraft. High-consequence (PG + synchronous legacy check)
// AND feature-gated (C5_PRESCRIPTION_PUBLISH_ENABLED) — both enforced
// inside publishDraft()/assertPublishEnabled(), never only by omitting a
// UI button. This is deliberately the "clinician-facing publish route"
// C5.3B's verification section names: hitting this route directly, with a
// valid clinician session, must still return PUBLISH_DISABLED whenever the
// gate is off, with no way to bypass it from here.
export async function POST(_request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  try {
    const result = await publishDraft({ clinicianId: auth.clinicianId, draftId });
    return NextResponse.json(result);
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
