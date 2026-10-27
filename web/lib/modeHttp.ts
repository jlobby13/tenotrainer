import "server-only";

// M3.1 — HTTP responses for operating-mode refusals. Route handlers call
// these first; the proxy applies the same rules coarsely in front of them.
import { NextResponse } from "next/server";
import { isLegacyAllowed, isMutationAllowed, MaintenanceError } from "./operatingMode";

// Legacy (FastAPI-era / bridge) routes exist only in development mode.
export function legacyRetiredResponse(): NextResponse | null {
  return isLegacyAllowed() ? null : NextResponse.json({ error: "LEGACY_RETIRED" }, { status: 410 });
}

// Clinical mutations are refused in maintenance mode.
export function maintenanceResponse(): NextResponse | null {
  return isMutationAllowed() ? null : NextResponse.json({ error: "MAINTENANCE" }, { status: 503 });
}

export function isMaintenanceError(err: unknown): err is MaintenanceError {
  return err instanceof MaintenanceError;
}
