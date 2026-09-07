import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import {
  createPrescriptionVersion,
  hasAnyPrescriptionVersion,
  resolveSupabaseUserIdByEmail,
} from "@/lib/prescriptionVersionsServer";
import type { Irritability, PrescriptionVersionSource } from "@/lib/prescriptionVersionTypes";

// Milestone 5, Stage 1 — server-to-server only, mirrors the existing
// FastAPI<->Next.js bridge-secret pattern used by
// web/app/api/auth/validate-bridge/route.ts (that route authenticates a
// Next.js->FastAPI->Next.js round trip; this one authenticates FastAPI
// calling Next.js directly, in the same style _require_bridge uses on the
// FastAPI side for /api/patient/summary etc.).
//
// The two explicit prescription-creation events this endpoint currently
// serves:
//   - source='onboarding'       — called by app/main.py's onboarding_post
//                                  right after it commits the legacy
//                                  rehab_plans row.
//   - source='legacy_bootstrap' — called by web/scripts/bootstrapPrescriptionVersions.ts
//                                  for pre-Stage-1 patients.
// clinician_change/system_progression are NOT reachable from this endpoint
// (no caller exists yet for either — see the M5 Stage 1 report).
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

const CALLABLE_SOURCES: PrescriptionVersionSource[] = ["onboarding", "legacy_bootstrap"];
const VALID_IRRITABILITY: Irritability[] = ["low", "moderate", "high"];

type Body = {
  email?: string;
  supabaseId?: string;
  stage?: number;
  irritability?: string;
  isInsertional?: boolean;
  legacyPlanId?: string | number | null;
  source?: string;
};

export async function POST(request: NextRequest) {
  const auth = request.headers.get("Authorization");
  if (!BRIDGE_SECRET || auth !== `Bearer ${BRIDGE_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const { email, supabaseId, stage, irritability, isInsertional, legacyPlanId, source } = body;

  if (!source || !CALLABLE_SOURCES.includes(source as PrescriptionVersionSource)) {
    return NextResponse.json({ error: `source must be one of ${CALLABLE_SOURCES.join(", ")}` }, { status: 400 });
  }
  if (typeof stage !== "number" || !Number.isInteger(stage) || stage < 1) {
    return NextResponse.json({ error: "stage must be a positive integer" }, { status: 400 });
  }
  if (!irritability || !VALID_IRRITABILITY.includes(irritability as Irritability)) {
    return NextResponse.json({ error: `irritability must be one of ${VALID_IRRITABILITY.join(", ")}` }, { status: 400 });
  }
  if (typeof isInsertional !== "boolean") {
    return NextResponse.json({ error: "isInsertional must be a boolean" }, { status: 400 });
  }
  if (!supabaseId && !email) {
    return NextResponse.json({ error: "one of supabaseId or email is required" }, { status: 400 });
  }

  // Prefer a caller-supplied Supabase id (FastAPI's cached users.supabase_id,
  // or the bootstrap script's own listUsers-derived id) — only fall back to
  // the email scan when it's genuinely unknown to the caller.
  const userId = supabaseId ?? (email ? await resolveSupabaseUserIdByEmail(email) : null);
  if (!userId) {
    return NextResponse.json({ error: "No matching Supabase user for the given identity" }, { status: 404 });
  }

  // Idempotency for the legacy bootstrap event only: never add a redundant
  // version for a patient who already has one (from onboarding-sync or a
  // prior bootstrap run). 'onboarding' has no such check — each call is a
  // genuinely new prescription-creation event.
  if (source === "legacy_bootstrap" && (await hasAnyPrescriptionVersion(userId))) {
    return NextResponse.json({ skipped: true, reason: "prescription_version_already_exists" });
  }

  try {
    const version = await createPrescriptionVersion({
      userId,
      stage,
      irritability: irritability as Irritability,
      isInsertional,
      source: source as PrescriptionVersionSource,
      legacyPlanId: legacyPlanId != null ? String(legacyPlanId) : null,
    });
    return NextResponse.json({ prescriptionVersion: version });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Unique-violation race on the one-bootstrap-per-user index: another
    // concurrent call already created it — idempotent-safe, not an error.
    if (source === "legacy_bootstrap" && message.includes("prescription_versions_one_bootstrap_per_user")) {
      return NextResponse.json({ skipped: true, reason: "prescription_version_already_exists" });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
