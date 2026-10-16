import "server-only";

import { NextResponse } from "next/server";
import { getC5CheckIns } from "@/lib/c5ResponseServer";
import { withC5Patient } from "@/lib/c5RuntimeHttp";

// C5.6E — the authenticated patient's outstanding check-ins (read-only).
export async function GET() {
  return withC5Patient(async (patientId) => NextResponse.json({ checkIns: await getC5CheckIns(patientId) }));
}
