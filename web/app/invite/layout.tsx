import { connection } from "next/server";
import { isMutationAllowed } from "@/lib/operatingMode";
import { MaintenanceScreen } from "@/app/maintenance/MaintenanceScreen";

// M3.1 — in maintenance mode nothing under /invite renders (defense in depth
// behind the proxy rewrite): the patient-facing unavailable experience only.
export default async function MaintenanceAwareLayout({ children }: { children: React.ReactNode }) {
  // The mode is a runtime property: never evaluate it while prerendering.
  await connection();
  if (!isMutationAllowed()) return <MaintenanceScreen />;
  return <>{children}</>;
}
