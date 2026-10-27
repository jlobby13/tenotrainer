import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { getMode } from "@/lib/operatingMode";

export async function GET(request: NextRequest) {
  // M3.1 — development diagnostics only; TENOTRAINER_MODE (not NODE_ENV) decides.
  if (getMode() !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const session = await getSessionInfo();
  return NextResponse.json({ authenticated: true, ...session });
}
