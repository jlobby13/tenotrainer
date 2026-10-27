// M3.1 — fail-closed startup validation. register() runs once before the
// server handles requests; an invalid configuration (missing/invalid
// TENOTRAINER_MODE, bridge configuration in production/maintenance, a
// runtime gate that could select legacy, ...) stops the process: the server
// does not start. The proxy re-validates per request as a backstop (503).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServerConfig } = await import("./lib/env");
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
