// M3.1 — fail-closed startup validation (Node.js runtime only; M3.2 moved it
// out of instrumentation.ts so the Edge bundle never sees process.exit). An
// invalid configuration (missing/invalid TENOTRAINER_MODE, bridge
// configuration in production/maintenance, a runtime gate that could select
// legacy, ...) stops the process: the server does not start. The proxy
// re-validates per request as a backstop (503).
import { getServerConfig } from "./lib/env";

export function registerNode(): void {
  let mode: string;
  try {
    mode = getServerConfig().mode;
  } catch (e) {
    // Problems name variables, never secret values.
    console.error(`TenoTrainer refused to start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.info(`TenoTrainer operating mode: ${mode}`);
}
