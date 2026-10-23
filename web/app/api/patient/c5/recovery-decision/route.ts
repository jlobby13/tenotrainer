import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { recordRecoveryDecision } from "@/lib/c5RuntimeServer";
import { badRequest, isUuid, readJson, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6F — the patient's answer to ADVISORY recovery guidance. Only the
// idempotency key and the choice come from the browser; every date, the
// recommendation and the anchor are recomputed by the database.
export async function POST(request: NextRequest) {
  return withC5Patient(async (patientId) => {
    const body = await readJson(request);
    if (!body) return badRequest("Invalid JSON body");
    const { clientRequestId, decision } = body;
    if (!isUuid(clientRequestId)) return badRequest("Invalid clientRequestId");
    if (decision !== "take_recovery_day" && decision !== "continue") return badRequest("Invalid decision");
    return NextResponse.json(await recordRecoveryDecision(patientId, clientRequestId, decision));
  });
}
