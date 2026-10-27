import { MaintenanceScreen } from "./MaintenanceScreen";

export const metadata = { title: "Temporarily unavailable — TenoTrainer" };

// M3.1 — the proxy rewrites patient routes here in maintenance mode.
export default function MaintenancePage() {
  return <MaintenanceScreen />;
}
