import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { sanitizeImmediate, submitImmediateResponse } from "@/lib/c5ResponseServer";
import { badRequest, isUuid, readJson, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6E — submit the post-session check-in for one of the patient's own
// closed C5 sessions. Submission commits first; reconciliation and the fresh
// training state follow in their own transactions.
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return withC5Patient(async (patientId) => {
    if (!isUuid(sessionId)) return badRequest("Invalid session id");
    const body = await readJson(request);
    const response = sanitizeImmediate(body?.response);
    if (!response) return badRequest("Invalid response");
    return NextResponse.json(await submitImmediateResponse(patientId, sessionId, response));
  });
}
