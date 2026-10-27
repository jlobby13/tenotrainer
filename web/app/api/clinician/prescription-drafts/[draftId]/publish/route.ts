import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { publishDraft } from "@/lib/prescriptionDraftServer";

// POST — publishDraft. High-consequence (Postgres assignment check)
// AND feature-gated (C5_PRESCRIPTION_PUBLISH_ENABLED) — both enforced
// inside publishDraft()/assertPublishEnabled(), never only by omitting a
// UI button. This is deliberately the "clinician-facing publish route"
// C5.3B's verification section names: hitting this route directly, with a
// valid clinician session, must still return PUBLISH_DISABLED whenever the
// gate is off, with no way to bypass it from here.
//
// C5.4D — optional JSON body { expectedFingerprint }: the content
// fingerprint Review rendered. When present, publishDraft() refuses with
// DRAFT_CHANGED if the draft no longer matches it. An empty body keeps the
// original C5.3 contract.
export async function POST(request: Request, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute({ mutation: true });
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  let expectedFingerprint: string | null = null;
  try {
    const text = await request.text();
    if (text) {
      const body: unknown = JSON.parse(text);
      const value = typeof body === "object" && body !== null ? (body as { expectedFingerprint?: unknown }).expectedFingerprint : undefined;
      if (value !== undefined && value !== null && typeof value !== "string") throw new Error("bad fingerprint");
      expectedFingerprint = (value as string | null | undefined) ?? null;
    }
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    const result = await publishDraft({ clinicianId: auth.clinicianId, draftId, expectedFingerprint });
    return NextResponse.json(result);
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
