import "server-only";

import { NextResponse } from "next/server";
import { getSessionViewForPatient } from "@/lib/c5RuntimeServer";
import { badRequest, isUuid, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6D — read-only: the patient's own session snapshot + recorded units
// (used to re-sync after an authoritative rejection).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withC5Patient(async (patientId) => {
    if (!isUuid(id)) return badRequest("Invalid session id");
    const session = await getSessionViewForPatient(patientId, id);
    if (!session) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ session });
  });
}
