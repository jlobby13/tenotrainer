import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isValidMorningReminderTime, normalizeMorningReminderTime } from "@/lib/morningEligibility";

// Changing this preference affects FUTURE morning-response obligations
// only — ensureMorningResponseExists() computes and freezes
// scheduled_eligible_at once, at obligation-creation time, so this write
// can never retroactively alter an already-established row. No special
// handling is needed here to preserve that; it's guaranteed by how the
// obligation lifecycle is built (see morningResponseServer.ts).
export async function PATCH(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const time = body.morningReminderTime;
  if (typeof time !== "string" || !isValidMorningReminderTime(time)) {
    return NextResponse.json(
      { error: "Invalid reminder time — must be HH:MM in 15-minute increments" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("profiles")
    .update({ morning_reminder_time: normalizeMorningReminderTime(time) })
    .eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ morningReminderTime: normalizeMorningReminderTime(time) });
}
