import { NextResponse, type NextRequest } from "next/server";
import { consumeBridgeToken } from "@/lib/bridge";

const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

export async function POST(request: NextRequest) {
  // Validate shared secret — this endpoint is server-to-server only
  const auth = request.headers.get("Authorization");
  if (!BRIDGE_SECRET || auth !== `Bearer ${BRIDGE_SECRET}`) {
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
