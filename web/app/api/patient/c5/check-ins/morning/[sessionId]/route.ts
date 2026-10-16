import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { sanitizeMorning, submitMorningResponse } from "@/lib/c5ResponseServer";
import { badRequest, isUuid, readJson, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6E — submit the next-morning check-in (answered or "I don't remember")
// for one of the patient's own C5 sessions, once it is due.
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return withC5Patient(async (patientId) => {
    if (!isUuid(sessionId)) return badRequest("Invalid session id");
    const body = await readJson(request);
    const response = sanitizeMorning(body?.response);
    if (!response) return badRequest("Invalid response");
    return NextResponse.json(await submitMorningResponse(patientId, sessionId, response));
  });
}
