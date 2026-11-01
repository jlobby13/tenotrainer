import "server-only";

import { NextResponse } from "next/server";
import { verifyDispatchAuthorization } from "@/lib/config/secrets";
import { getConfig } from "@/lib/config";
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

export async function POST(request: Request) {
  // M3.3 S3 — constant-time check against the configured credential (and
  // its rotation partner), inside the server-only secret boundary.
  if (!verifyDispatchAuthorization(request.headers.get("authorization"))) {
    structuredLog({ event: "tenotrainer.safety_dispatch.unauthorized" });
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  // M3.3 S3c — only development Resend dispatch reads a caller scope (the
  // explicit outbox ids); production / maintenance never read the body.
  let outboxIds: unknown = undefined;
  const config = getConfig();
  if (config.mode === "development" && config.email.provider === "resend") {
    try { outboxIds = ((await request.json()) as { outboxIds?: unknown })?.outboxIds; } catch { outboxIds = undefined; }
  }
  const r = await runSafetyDispatch({ outboxIds });
  if (!r.ok) {
    if (r.reason === "development_scope_required") return NextResponse.json({ error: "DEVELOPMENT_DISPATCH_SCOPE_REQUIRED" }, { status: 400 });
    return NextResponse.json({ error: r.reason === "provider_not_configured" ? "SAFETY_EMAIL_DISABLED" : "DISPATCH_FAILED" },
      { status: r.reason === "provider_not_configured" ? 503 : 500 });
  }
  return NextResponse.json({ result: "dispatched", ...r.summary });
}
