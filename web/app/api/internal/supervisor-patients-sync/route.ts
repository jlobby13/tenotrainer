import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { resolveSupabaseUserIdByEmail } from "@/lib/prescriptionVersionsServer";

// C1A — server-to-server only, mirrors the exact BRIDGE_SECRET pattern
// already used by web/app/api/internal/prescription-versions/route.ts (that
// endpoint's own header note traces the precedent back to
// validate-bridge.ts/_require_bridge). This route is the ONLY forward-sync
// write path from the legacy dismiss/reinstate lifecycle
// (app/supervisor.py) into the canonical Postgres `supervisor_patients`
// table — never a public clinician API, never reachable from a browser
// session.
//
// Legacy SQLite remains the temporary WRITE AUTHORITY for the assignment
// lifecycle during this transitional period (founder decision) — this
// route is a best-effort MIRROR of an already-committed legacy change,
// never the thing that decides whether a dismissal/reinstatement is valid.
// A failure here must never be reported as anything other than what it is:
// the caller (app/supervisor.py) is responsible for treating a non-2xx
// response as "sync failed, log it, do not roll back the legacy write" —
// see that module's own comment for the matching half of this contract.
//
// Identity resolution mirrors scripts/backfillSupervisorPatients.mjs's own
// classification exactly (same CACHE_MISSING_BUT_RESOLVED/CACHE_MISMATCH/
// NO_SUPABASE_USER vocabulary) so a human reading either one recognizes the
// other — deliberately NOT reimplemented as a different, weaker check.
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

const VALID_STATUSES = new Set(["active", "dismissed"]);

type Identity = { email?: string; supabaseId?: string | null };

type Body = {
  supervisor?: Identity;
  patient?: Identity;
  status?: string;
  dismissedAt?: string | null;
  dismissedReason?: string | null;
  dismissedBy?: Identity | null;
};

type ResolvedIdentity =
  | { kind: "RESOLVED" | "CACHE_MISSING_BUT_RESOLVED"; uuid: string }
  | { kind: "CACHE_MISMATCH" | "NO_SUPABASE_USER" | "MISSING_EMAIL"; uuid: null };

// Same classification vocabulary as the backfill script's classifyIdentity
// — never trusts a cached UUID that disagrees with a fresh email lookup,
// never guesses when email is absent or unresolvable.
async function resolveIdentity(identity: Identity | null | undefined): Promise<ResolvedIdentity> {
  const email = identity?.email?.trim().toLowerCase();
  if (!email) return { kind: "MISSING_EMAIL", uuid: null };
  const cachedUuid = identity?.supabaseId || null;
  const freshUuid = await resolveSupabaseUserIdByEmail(email);
  if (!freshUuid) return { kind: "NO_SUPABASE_USER", uuid: null };
  if (cachedUuid && cachedUuid !== freshUuid) return { kind: "CACHE_MISMATCH", uuid: null };
  return { kind: cachedUuid ? "RESOLVED" : "CACHE_MISSING_BUT_RESOLVED", uuid: freshUuid };
}

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

  if (!body.status || !VALID_STATUSES.has(body.status)) {
    return NextResponse.json({ error: `status must be one of ${[...VALID_STATUSES].join(", ")}` }, { status: 400 });
  }
  if (!body.supervisor?.email || !body.patient?.email) {
    return NextResponse.json({ error: "supervisor.email and patient.email are required" }, { status: 400 });
  }

  const [supervisorIdentity, patientIdentity] = await Promise.all([
    resolveIdentity(body.supervisor),
    resolveIdentity(body.patient),
  ]);

  // Never silently trust conflicting or missing identity information —
  // reject outright rather than writing a partial/guessed relationship.
  if (supervisorIdentity.kind !== "RESOLVED" && supervisorIdentity.kind !== "CACHE_MISSING_BUT_RESOLVED") {
    return NextResponse.json({ error: "supervisor identity could not be safely resolved", reason: supervisorIdentity.kind }, { status: 422 });
  }
  if (patientIdentity.kind !== "RESOLVED" && patientIdentity.kind !== "CACHE_MISSING_BUT_RESOLVED") {
    return NextResponse.json({ error: "patient identity could not be safely resolved", reason: patientIdentity.kind }, { status: 422 });
  }

  // dismissed_by is auxiliary provenance, exactly like the backfill script's
  // own resolveDismissedByUuid — an unresolved dismisser never blocks the
  // relationship sync itself, it's just written as NULL.
  let dismissedByUuid: string | null = null;
  if (body.dismissedBy?.email) {
    const dismissedByIdentity = await resolveIdentity(body.dismissedBy);
    if (dismissedByIdentity.kind === "RESOLVED" || dismissedByIdentity.kind === "CACHE_MISSING_BUT_RESOLVED") {
      dismissedByUuid = dismissedByIdentity.uuid;
    }
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("supervisor_patients").upsert(
    {
      supervisor_id: supervisorIdentity.uuid,
      patient_id: patientIdentity.uuid,
      status: body.status,
      dismissed_at: body.status === "dismissed" ? (body.dismissedAt ?? null) : null,
      dismissed_reason: body.status === "dismissed" ? (body.dismissedReason ?? null) : null,
      dismissed_by: body.status === "dismissed" ? dismissedByUuid : null,
    },
    { onConflict: "supervisor_id,patient_id" }
  );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, supervisorId: supervisorIdentity.uuid, patientId: patientIdentity.uuid, status: body.status });
}
