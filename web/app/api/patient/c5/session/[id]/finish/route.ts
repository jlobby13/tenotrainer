import "server-only";

import { NextResponse } from "next/server";
import { closeSession } from "@/lib/c5RuntimeServer";
import { badRequest, isUuid, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6D — explicit Finish (c5_finish_session). The server refuses it with
// no performed work or under an active acute brake.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withC5Patient(async (patientId) => {
    if (!isUuid(id)) return badRequest("Invalid session id");
    return NextResponse.json(await closeSession(patientId, id, "finish", null));
  });
}
