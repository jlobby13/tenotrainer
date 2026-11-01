import { NextResponse, type NextRequest } from "next/server";
import { consumeBridgeToken } from "@/lib/bridge";
import { legacyRetiredResponse } from "@/lib/modeHttp";
// M3.3 S3 — temporary legacy debt (removed with M6 legacy retirement): constant-time
// bridge-credential check inside the server-only secret boundary.
import { verifyLegacyBridgeAuthorization } from "@/lib/config/secrets";

export async function POST(request: NextRequest) {
  // M3.1 — legacy (FastAPI-era) route: exists only in development mode (410 LEGACY_RETIRED otherwise).
  const modeRefusal = legacyRetiredResponse();
  if (modeRefusal) return modeRefusal;
  // Validate shared secret — this endpoint is server-to-server only
  if (!verifyLegacyBridgeAuthorization(request.headers.get("Authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const { token } = body;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const payload = consumeBridgeToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  return NextResponse.json({
    email: payload.email,
    supabase_id: payload.supabaseId,
    fastapi_role: payload.fastapiRole,
    name: payload.name,
  });
}
