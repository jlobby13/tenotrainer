import "server-only";

// M3.1 — operating-mode refusals for SERVER ACTIONS (the server-action
// boundary). Each clinical action calls one of these first. The clinical
// libraries they call assert again (defense in depth).
import { redirect } from "next/navigation";
import { isLegacyAllowed, isMutationAllowed } from "./operatingMode";
import { withQuery } from "./safeRedirect";

// Clinical mutations are refused in maintenance mode.
export function refuseActionInMaintenance(returnPath: string): void {
  if (!isMutationAllowed()) redirect(withQuery(returnPath, { error: "MAINTENANCE" }));
}

// Development-only workflows (F9: tester/admin invitations) are refused in
// production and maintenance.
export function refuseActionOutsideDevelopment(returnPath: string): void {
  if (!isLegacyAllowed()) redirect(withQuery(returnPath, { error: "UNAVAILABLE" }));
}
