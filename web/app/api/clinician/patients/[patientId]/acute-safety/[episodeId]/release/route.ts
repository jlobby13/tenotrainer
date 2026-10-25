import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute } from "@/lib/prescriptionDraftHttp";
import { releaseAcuteEpisodeAsClinician } from "@/lib/clinicianSafetyServer";

// POST { note } — explicit clinician release of a professional-review
// training hold (effective level >= 4, or professionally held). M1.
// Identity comes from the authenticated clinician session; the patient and
// episode come from the URL and are verified server-side (the episode must
// belong to that patient, and the clinician must pass the high-consequence
// authorization for that patient). The patient id is never trusted alone.
export async function POST(request: Request, { params }: { params: Promise<{ patientId: string; episodeId: string }> }) {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;
  const { patientId, episodeId } = await params;

  let note: unknown = null;
  try {
    note = ((await request.json()) as { note?: unknown })?.note ?? null;
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  if (typeof note !== "string") return NextResponse.json({ error: "NOTE_REQUIRED", result: "invalid_note" }, { status: 400 });

  const r = await releaseAcuteEpisodeAsClinician({ clinicianId: auth.clinicianId, patientId, episodeId, note });
  return NextResponse.json(r.body, { status: r.status });
}
