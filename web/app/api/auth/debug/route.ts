import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionInfo } from "@/lib/auth";

// Authenticated-only JSON endpoint. Returns session/profile/org info.
// Useful for curl-based testing and verifying session state.
export async function GET(request: NextRequest) {
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
