// M3.1 — the application operating mode is the SOLE authority for whether
// the application permits clinical operations right now (database
// authorization separately answers WHO may perform them). TENOTRAINER_MODE
// outranks every legacy feature gate:
//
//   development  legacy behaviour may exist; the C5 gates select C5 vs legacy
//   production   C5 is always the patient runtime; legacy is unreachable;
//                the publish gate is normal (true) or a publication freeze
//   maintenance  legacy unreachable; patients see the unavailable page;
//                clinicians read-only; NO clinical mutation of any kind
//
// No "server-only" import: the proxy uses this too.
import { getServerConfig } from "./env";
import type { OperatingMode } from "./envValidation";

export type { OperatingMode } from "./envValidation";

export function getMode(): OperatingMode {
  return getServerConfig().mode;
}

// The ONLY way into legacy (FastAPI / legacy patient runtime) code paths.
export function isLegacyAllowed(): boolean {
  return getMode() === "development";
}

// C5 is the patient runtime unless development explicitly selects legacy.
export function isC5RuntimeAuthoritative(): boolean {
  const { mode, runtimeGate } = getServerConfig();
  return mode !== "development" || runtimeGate;
}

export function isPublishAllowedByMode(): boolean {
  const { mode, publishGate } = getServerConfig();
  if (mode === "maintenance") return false;
  return publishGate;
}

export function isMutationAllowed(): boolean {
  return getMode() !== "maintenance";
}

export class MaintenanceError extends Error {
  readonly code = "MAINTENANCE";
  constructor() {
    super("TenoTrainer is in maintenance mode: clinical operations are unavailable.");
    this.name = "MaintenanceError";
  }
}

// Every clinical mutation boundary calls this (HTTP, server action and the
// clinical server libraries themselves), so a new internal caller cannot
// bypass maintenance by calling a helper directly.
export function assertMutationAllowed(): void {
  if (!isMutationAllowed()) throw new MaintenanceError();
}

export const MAINTENANCE_COPY = "TenoTrainer is temporarily unavailable. Your progress is saved.";
