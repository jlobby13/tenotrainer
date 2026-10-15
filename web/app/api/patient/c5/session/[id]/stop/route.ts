import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { closeSession, type C5AcuteReport } from "@/lib/c5RuntimeServer";
import { badRequest, isUuid, readJson, withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6D — Stop (c5_stop_session). The browser never names the stop reason:
// the server classifies stopped_early / stopped_pause / stopped_acute. The
// optional acuteReport carries only what the patient reported in-session.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withC5Patient(async (patientId) => {
    if (!isUuid(id)) return badRequest("Invalid session id");
    const body = (await readJson(request)) ?? {};
    let acuteReport: C5AcuteReport | null = null;
    if (body.acuteReport != null) {
      const r = body.acuteReport as Record<string, unknown>;
      if (typeof r !== "object" || Array.isArray(r)) return badRequest("Invalid acuteReport");
      acuteReport = {};
      for (const k of ["sudden_or_sharp_pain", "pop_felt_or_heard", "new_functional_difficulty"] as const) {
        if (r[k] === true) acuteReport[k] = true;
      }
      if (Object.keys(acuteReport).length === 0) acuteReport = null;
    }
    return NextResponse.json(await closeSession(patientId, id, "stop", acuteReport));
  });
}
