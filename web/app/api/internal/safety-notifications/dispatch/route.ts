import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runSafetyDispatch, structuredLog } from "@/lib/safetyEmail";

// M3.2 — protected internal safety email dispatch ("dispatch eligible
// work"). Server-to-server only: authenticated by SAFETY_DISPATCH_SECRET
// (Authorization: Bearer …), compared in constant time; no session, no
// browser authority, no caller-chosen scope (the dispatcher always runs
// with scope NULL). Replay-safe: every call just claims whatever is due —
// leases and idempotency keys make repeated or concurrent calls harmless.
// Allowed in maintenance as the narrow M3.2 operational exception (founder
// D1); it performs no clinical mutation. No FastAPI / SQLite dependency.
export const runtime = "nodejs";
export const maxDuration = 60;

function digest(v: string): Buffer {
  return createHash("sha256").update(v, "utf8").digest();
}

function authorized(request: Request): boolean {
  const secret = process.env.SAFETY_DISPATCH_SECRET ?? "";
  if (secret.trim().length < 32) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(presented), digest(secret)) && presented.length > 0;
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    structuredLog({ event: "tenotrainer.safety_dispatch.unauthorized" });
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const r = await runSafetyDispatch();
  if (!r.ok) {
    return NextResponse.json({ error: r.reason === "provider_not_configured" ? "SAFETY_EMAIL_DISABLED" : "DISPATCH_FAILED" },
      { status: r.reason === "provider_not_configured" ? 503 : 500 });
  }
  return NextResponse.json({ result: "dispatched", ...r.summary });
}
