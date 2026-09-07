import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isValidIanaTimezone } from "@/lib/morningEligibility";

// Milestone 4, Stage 1 — timezone INITIALIZATION only, not a general
// "change my timezone" endpoint. Writes profiles.timezone only when it is
// currently NULL; never overwrites an already-stored value just because the
// browser reports a different one (e.g. travel). Intentional timezone
// editing is deferred to a later stage.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const timezone = body.timezone;
  if (typeof timezone !== "string" || !isValidIanaTimezone(timezone)) {
    return NextResponse.json({ error: "Invalid or unrecognized IANA timezone" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ timezone })
    .eq("id", user.id)
    .is("timezone", null)
    .select("timezone")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // `updated` is null when the row already had a non-null timezone (the
  // .is("timezone", null) filter matched no row) — that's success, not a
  // failure: initializing an already-initialized value is a correct no-op.
  return NextResponse.json({ initialized: updated !== null });
}
