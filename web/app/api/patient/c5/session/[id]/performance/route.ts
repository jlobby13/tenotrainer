import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { sanitizePerformance, writePerformance } from "@/lib/c5RuntimeServer";
import { badRequest, isUuid, readJson, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6D — one unit after Start. edit=false -> c5_record_performance (first
// write wins; an identical retry is a replay). edit=true ->
// c5_edit_performance (the only path that changes a recorded unit).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withC5Patient(async (patientId) => {
    if (!isUuid(id)) return badRequest("Invalid session id");
    const body = await readJson(request);
    const performance = sanitizePerformance(body?.performance);
    if (!body || !performance) return badRequest("Invalid performance");
    return NextResponse.json(await writePerformance(patientId, id, performance, body.edit === true));
  });
}
