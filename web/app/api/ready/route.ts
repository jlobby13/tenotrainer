import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { checkReadiness } from "@/lib/readiness";

// M3.3 S3d — public, minimal readiness (see lib/readiness.ts). Exactly
// 200 {"status":"ready"} or 503 {"status":"unavailable"}; HEAD carries the
// same status and headers with no body. Never cached by HTTP (no-store);
// the proxy adds the S2 security headers and S3b canonical-host rules.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = (event: string) => console.info(JSON.stringify({ at: new Date().toISOString(), event }));

async function answer(withBody: boolean): Promise<NextResponse> {
  const ready = await checkReadiness({ getConfig, log });
  const status = ready ? 200 : 503;
  const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  return withBody
    ? NextResponse.json({ status: ready ? "ready" : "unavailable" }, { status, headers })
    : new NextResponse(null, { status, headers });
}

export async function GET() {
  return answer(true);
}

export async function HEAD() {
  return answer(false);
}
