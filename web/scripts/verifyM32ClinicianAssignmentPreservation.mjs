// M3.2 — regression proof: the C5.6D / C5.6E / C5.6F suites' teardown removes
// only the assignment / membership rows THEY created for the shared
// development fixture clinician, never the clinician's unrelated assignments.
//
//   1. seed an unrelated assignment for that clinician (a disposable
//      organization + patient of THIS proof, recorded by exact id);
//   2. run the three suites (each creates its own fixture assignments);
//   3. the seeded row must be byte-identical and no suite-created
//      assignment may remain;
//   4. remove the seed by exact ids (guarded purge for its users / org).
//
// Run from web/ (servers as for the suites):
//   TENOTRAINER_MODE=development node scripts/verifyM32ClinicianAssignmentPreservation.mjs <gate-on url> <gate-off url>
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { FixtureRun, guardedSql, loadEnv, q } from "./lib/m32Fixtures.mjs";
import { assertPurgeTarget } from "./lib/safetyFixturePurge.mjs";

const [ON, OFF] = process.argv.slice(2);
if (!ON || !OFF) { console.error("usage: <gate-on url> <gate-off url>"); process.exit(2); }
const env = loadEnv(".env.local");
assertPurgeTarget(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLINICIAN = "44197ef7-7421-47ed-a164-75d2765fc019";
let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`); }
};
const clinicianRows = () => guardedSql(env, `SELECT id, to_jsonb(sp) AS row FROM supervisor_patients sp WHERE supervisor_id = ${q(CLINICIAN)} ORDER BY id`);

const run = new FixtureRun(env, admin, "keep");
let seedAssignment = null;
let seedMembership = null;
const initial = clinicianRows();
try {
  const p0 = await run.user("p0");
  const { orgId } = run.setup({ orgName: "M3.2 unrelated-assignment org", members: [["fixture", p0.id, "member"]], assignments: [], names: { [p0.id]: "Unrelated Patient" } });
  seedMembership = guardedSql(env, `INSERT INTO organization_members (organization_id, user_id, role) VALUES (${q(orgId)}, ${q(CLINICIAN)}, 'clinician') RETURNING id`)[0].id;
  seedAssignment = guardedSql(env, `INSERT INTO supervisor_patients (organization_id, supervisor_id, patient_id) VALUES (${q(orgId)}, ${q(CLINICIAN)}, ${q(p0.id)}) RETURNING id`)[0].id;
  const before = clinicianRows();
  check("seed: the clinician has an unrelated, pre-existing active assignment", before.some((r) => r.id === seedAssignment && r.row.status === "active"));

  for (const [name, args] of [["C5.6D", ["scripts/verifyC5Stage6dPatientRuntime.mjs", ON, OFF]], ["C5.6E", ["scripts/verifyC5Stage6eCheckIns.mjs", ON, OFF]], ["C5.6F", ["scripts/verifyC5Stage6fRecoveryUi.mjs", ON, OFF]]]) {
    let out = ""; let code = 0;
    try { out = execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2_400_000, env: { ...process.env, TENOTRAINER_MODE: "development" } }); }
    catch (e) { out = String(e.stdout ?? ""); code = e.status ?? 1; }
    const summary = out.match(/(\d+) passed, (\d+) failed/g)?.pop() ?? "no summary";
    check(`${name}: suite passed including its exact-id teardown (${summary})`, code === 0 && /, 0 failed/.test(summary), out.split("\n").filter((l) => l.startsWith("FAIL")).join(" | "));
    const after = clinicianRows();
    check(`${name}: the unrelated assignment is byte-for-byte unchanged`,
      JSON.stringify(after.find((r) => r.id === seedAssignment)?.row) === JSON.stringify(before.find((r) => r.id === seedAssignment)?.row));
    check(`${name}: every assignment the suite created for the clinician is gone (only the unrelated row remains)`,
      after.length === before.length && after.every((r) => before.some((b) => b.id === r.id)), `${before.length} -> ${after.length}`);
    check(`${name}: the clinician's seeded membership is untouched`, Number(guardedSql(env, `SELECT count(*) AS n FROM organization_members WHERE id = ${q(seedMembership)}`)[0].n) === 1);
  }
} catch (e) {
  check("proof ran without an unexpected error", false, e?.stack ?? e);
} finally {
  try {
    if (seedAssignment) guardedSql(env, `DELETE FROM supervisor_patients WHERE id = ${q(seedAssignment)}; SELECT 1 AS ok`);
    if (seedMembership) guardedSql(env, `DELETE FROM organization_members WHERE id = ${q(seedMembership)}; SELECT 1 AS ok`);
    run.teardown();
    check("cleanup: the seed removed by exact ids; the clinician's assignments are exactly as before this proof",
      JSON.stringify(clinicianRows()) === JSON.stringify(initial));
  } catch (e) {
    check("cleanup", false, e.message);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
