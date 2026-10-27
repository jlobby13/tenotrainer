import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { requireClinicianForRoute } from "@/lib/prescriptionDraftHttp";
import { setExerciseFavorite } from "@/lib/canonicalExerciseLibraryServer";

// POST — favorite. Clinician-specific (C5.4A §10); clinicianId always comes
// from the server-derived session, never the request body.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ exerciseId: string }> }) {
  const auth = await requireClinicianForRoute({ mutation: true });
  if ("response" in auth) return auth.response;
  const { exerciseId } = await params;

  try {
    await setExerciseFavorite({ clinicianId: auth.clinicianId, exerciseId, favorite: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "INTERNAL_ERROR";
    const status = message === "EXERCISE_UNAVAILABLE" ? 422 : 500;
    return NextResponse.json({ error: message === "EXERCISE_UNAVAILABLE" ? message : "INTERNAL_ERROR" }, { status });
  }
}

// DELETE — unfavorite.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ exerciseId: string }> }) {
  const auth = await requireClinicianForRoute({ mutation: true });
  if ("response" in auth) return auth.response;
  const { exerciseId } = await params;

  try {
    await setExerciseFavorite({ clinicianId: auth.clinicianId, exerciseId, favorite: false });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "INTERNAL_ERROR";
    const status = message === "EXERCISE_UNAVAILABLE" ? 422 : 500;
    return NextResponse.json({ error: message === "EXERCISE_UNAVAILABLE" ? message : "INTERNAL_ERROR" }, { status });
  }
}
