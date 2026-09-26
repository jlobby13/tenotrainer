import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute, prescriptionDraftErrorResponse } from "@/lib/prescriptionDraftHttp";
import { getDraft, updateDraftMetadata, discardDraft } from "@/lib/prescriptionDraftServer";
import type { RehabPhase, SchedulingMode, PerformanceFocus } from "@/lib/prescriptionDraftTypes";

// GET — getDraft. Read tier: any actively-supervising clinician may view.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  try {
    const result = await getDraft({ clinicianId: auth.clinicianId, draftId });
    return NextResponse.json(result);
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}

// PATCH — updateDraftMetadata. Editing-owner only (enforced inside).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  let body: { phase?: RehabPhase | null; schedulingMode?: SchedulingMode | null; performanceFocuses?: PerformanceFocus[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "VALIDATION_FAILED" }, { status: 422 });
  }

  try {
    await updateDraftMetadata({
      clinicianId: auth.clinicianId,
      draftId,
      phase: body.phase,
      schedulingMode: body.schedulingMode,
      performanceFocuses: body.performanceFocuses,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}

// DELETE — discardDraft. Editing-owner only (enforced inside).
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { draftId } = await params;

  try {
    await discardDraft({ clinicianId: auth.clinicianId, draftId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return prescriptionDraftErrorResponse(err);
  }
}
