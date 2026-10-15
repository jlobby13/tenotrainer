import "server-only";

import { NextResponse } from "next/server";
import { getC5TrainingState } from "@/lib/c5RuntimeServer";
import { withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6D — the single authoritative training-state read (reconcile, then
// c5_get_start_eligibility). Read-only: never creates a session.
export async function GET() {
  return withC5Patient(async (patientId) => NextResponse.json({ state: await getC5TrainingState(patientId) }));
}
