import "server-only";

// C5.6D — shared HTTP plumbing for /api/patient/c5/**. Business results are
// returned with 200 and a stable `result` code (the RPC's own); only
// gate/auth faults, malformed bodies, a failed safety check and unexpected
// errors use non-2xx so the client can tell "retry" from "authoritative no".

import { NextResponse } from "next/server";
import { C5SafetyCheckError, requireC5Patient } from "./c5RuntimeServer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function badRequest(error: string) {
  return NextResponse.json({ code: "BAD_REQUEST", error }, { status: 400 });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Authenticates, then runs `handler` with the session's patient id.
export async function withC5Patient(handler: (patientId: string) => Promise<Response>): Promise<Response> {
  const auth = await requireC5Patient();
  if (!auth.ok) return NextResponse.json({ code: auth.code }, { status: auth.status });
  try {
    return await handler(auth.patientId);
  } catch (e) {
    if (e instanceof C5SafetyCheckError) {
      return NextResponse.json({ code: "SAFETY_CHECK_FAILED", error: "We couldn't confirm your safety status. Please try again." }, { status: 503 });
    }
    console.error("C5 runtime API error:", e);
    return NextResponse.json({ code: "UNEXPECTED", error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
