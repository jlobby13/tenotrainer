import { NextResponse, type NextRequest } from "next/server";
import { safeInternalPath } from "@/lib/safeRedirect";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";
import { createBridgeToken, FASTAPI_ROLE } from "@/lib/bridge";
import { legacyRetiredResponse } from "@/lib/modeHttp";

const FASTAPI_URL = process.env.FASTAPI_URL ?? "http://localhost:8000";

export async function GET(request: NextRequest) {
  // M3.1 — legacy (FastAPI-era) route: exists only in development mode (410 LEGACY_RETIRED otherwise).
  const modeRefusal = legacyRetiredResponse();
  if (modeRefusal) return modeRefusal;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const session = await getSessionInfo();
  const supabaseRole = session.memberships[0]?.role ?? "member";

  // Super-users stay on :3000 — dedicated Next.js dashboard
  if (supabaseRole === "super_user") {
    return NextResponse.redirect(new URL("/super/dashboard", request.url));
  }

  const fastapiRole = FASTAPI_ROLE[supabaseRole] ?? "patient";
  const name = session.profile?.name ?? user.email ?? "";

  const token = createBridgeToken(user.email!, user.id, fastapiRole, name);

  const dest = new URL(`${FASTAPI_URL}/auth/supabase`);
  dest.searchParams.set("token", token);

  // Optional deep-link: ?dest=/daily-log gets forwarded as ?next= to FastAPI
  // (shared same-origin path validator — see lib/safeRedirect.ts)
  const destPath = safeInternalPath(request.nextUrl.searchParams.get("dest"), "");
  if (destPath) {
    dest.searchParams.set("next", destPath);
  }

  return NextResponse.redirect(dest.toString());
}
