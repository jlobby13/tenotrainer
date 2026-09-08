import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { submitReassessmentAndMaybeRelease } from "@/lib/acuteSafetyServer";

// The Section 5 "critical conditional UI rule" is enforced HERE
// server-side (never just in the client form): if evaluatedByProfessional
// is not true, clearedByProfessional is forced to null regardless of what
// the request body claims — UNKNOWN != NO, and a patient cannot manufacture
// a clearance answer for a question they were never asked. The DB CHECK
// constraint (acute_safety_reassessments_clearance_requires_evaluation)
// backs this up independently.
export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { episodeId, suddenOrSharpPainResolved, newFunctionalDifficultyResolved, evaluatedByProfessional } = body;

  if (!episodeId || typeof episodeId !== "string") {
    return NextResponse.json({ error: "episodeId is required" }, { status: 400 });
  }
  if (typeof evaluatedByProfessional !== "boolean") {
    return NextResponse.json({ error: "evaluatedByProfessional must be a boolean" }, { status: 400 });
  }

  const clearedByProfessional = evaluatedByProfessional === true ? (body.clearedByProfessional === true ? true : body.clearedByProfessional === false ? false : null) : null;

  try {
    const { reassessment, release } = await submitReassessmentAndMaybeRelease({
      userId: user.id,
      episodeId,
      answers: {
        suddenOrSharpPainResolved: suddenOrSharpPainResolved === true ? true : suddenOrSharpPainResolved === false ? false : null,
        newFunctionalDifficultyResolved: newFunctionalDifficultyResolved === true ? true : newFunctionalDifficultyResolved === false ? false : null,
        evaluatedByProfessional,
        clearedByProfessional,
      },
    });
    return NextResponse.json({ reassessment, release });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to submit reassessment";
    if (message === "REHAB_SESSION_NOT_FOUND") {
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
