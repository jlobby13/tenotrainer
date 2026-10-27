// M6 Stage 3B/3C verification harness: runs the REAL authoritative
// interpretation engines (web/lib/*InterpretationEngine.ts) in-process
// against the linked database — the same functions the production
// morning-response finalize route calls (that wiring is verified
// separately by verifyM6Stage4GeneratorWiring.mjs). Replaces the
// temporary, never-committed /api/internal/dev-verify-symptom-engine route
// the Stage 3B/3C suites were written against; no HTTP/dev endpoint.
//
// Run the importing suite with:
//   node --conditions=react-server --experimental-strip-types <suite>.mjs
import { register } from "node:module";
import { readFileSync } from "node:fs";

register("./tsServerModuleHooks.mjs", import.meta.url);

// M3.1 — the engines write to the database: development + allow-listed project only.
import { assertDevTestTarget } from "./devProjectGuard.mjs";

// The engines read Supabase credentials from process.env, as under Next.
for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const eq = t.indexOf("=");
  const key = t.slice(0, eq).trim();
  if (process.env[key] === undefined) process.env[key] = t.slice(eq + 1).trim();
}
assertDevTestTarget(process.env);

const { generateShortWindowSymptomInterpretation } = await import("../../lib/longitudinalInterpretationEngine.ts");
const { generateCapacityInterpretations } = await import("../../lib/capacityInterpretationEngine.ts");
const { generateTrainingResponseInterpretation } = await import("../../lib/trainingResponseInterpretationEngine.ts");

export { generateShortWindowSymptomInterpretation, generateCapacityInterpretations, generateTrainingResponseInterpretation };
