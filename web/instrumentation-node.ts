// M3.1 — fail-closed startup validation (Node.js runtime only; M3.2 moved it
// out of instrumentation.ts so the Edge bundle never sees process.exit). An
// invalid configuration (missing/invalid TENOTRAINER_MODE, bridge
// configuration in production/maintenance, a runtime gate that could select
// legacy, ...) stops the process: the server does not start. The proxy
// re-validates per request as a backstop (503).
import { getConfig, type AppConfig } from "./lib/config";

export function registerNode(): void {
  let config: AppConfig;
  try {
    config = getConfig();
  } catch (e) {
    // Problems name variables and rules, never values.
    console.error(`TenoTrainer refused to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.info(`TenoTrainer operating mode: ${config.mode}`);
  // M3.3 S3 — test infrastructure only; never a supported deployment.
  if (config.isolatedTestProfile) console.info("TenoTrainer configuration profile: isolated test (production-mode verification only)");
  for (const w of config.warnings) console.warn(`TenoTrainer configuration warning: ${w}`);
}
