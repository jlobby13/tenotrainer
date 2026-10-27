import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { legacyRetiredResponse } from "@/lib/modeHttp";

// RETIRED in M2. This was the C1A forward-sync write path from the legacy
// SQLite dismiss/reinstate lifecycle (app/supervisor.py) into Postgres
// `supervisor_patients`. Postgres is now the authoritative assignment
// record: legacy SQLite state must never overwrite it, so the route writes
// nothing and answers 410 Gone. The legacy caller already treats any
// non-2xx as "sync failed, logged" without rolling its own write back.
// (The database independently refuses the old upsert shape: the
// (supervisor_id, patient_id) unique constraint it targeted no longer
// exists, and an ended assignment period can never be reactivated.)
// Assignment changes are made natively: patient invitation acceptance and
// the admin assignment page (/admin/assignments).
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

export async function POST(request: NextRequest) {
  // M3.1 — legacy (FastAPI-era) route: exists only in development mode (410 LEGACY_RETIRED otherwise).
  const modeRefusal = legacyRetiredResponse();
  if (modeRefusal) return modeRefusal;
  const auth = request.headers.get("Authorization");
  if (!BRIDGE_SECRET || auth !== `Bearer ${BRIDGE_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: "RETIRED", message: "Postgres is the assignment authority; legacy assignment sync is retired." },
    { status: 410 }
  );
}
