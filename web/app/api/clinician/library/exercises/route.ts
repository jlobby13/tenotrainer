import "server-only";

import { NextResponse } from "next/server";
import { requireClinicianForRoute } from "@/lib/prescriptionDraftHttp";
import { listCanonicalExercisesForClinician } from "@/lib/canonicalExerciseLibraryServer";

// GET — the full authorized+active canonical exercise library for this
// clinician (global exercises today; private/org_shared once those visibility
// tiers are ever populated). No query params: search/filter/facets are
// computed client-side over this one payload (C5.4A §8 — 47 exercises does
// not justify server-side search infrastructure). Any authenticated
// clinician may browse the library; it is not patient-scoped.
export async function GET() {
  const auth = await requireClinicianForRoute();
  if ("response" in auth) return auth.response;

  try {
    const exercises = await listCanonicalExercisesForClinician(auth.clinicianId);
    return NextResponse.json({ exercises });
  } catch (err) {
    console.error("GET /api/clinician/library/exercises failed:", err);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
