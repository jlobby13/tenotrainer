// Alpha 1 — offline guards for the operator account-deletion procedure (no
// database, no network). Run from web/:  node scripts/verifyOperatorDeleteAccount.test.mjs
import { readFileSync } from "node:fs";
import { buildBatch, OdaRefused, parseArgs, resolveTarget } from "./operatorDeleteAccount.mjs";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${detail}]` : ""}`);
};
const refuses = (fn, re) => {
  try { fn(); return false; } catch (e) { return e instanceof OdaRefused && re.test(e.message); }
};

const sql = readFileSync("scripts/lib/operatorDeleteAccount.sql", "utf8");
const code = sql.replace(/--[^\n]*/g, "");
const cli = readFileSync("scripts/operatorDeleteAccount.mjs", "utf8");
check("SQL never disables or alters a trigger", !/DISABLE\s+TRIGGER|ENABLE\s+TRIGGER|ALTER\s+TABLE/i.test(code));
check("SQL never bypasses triggers or constraints (session_replication_role / SET CONSTRAINTS)", !/session_replication_role|SET\s+CONSTRAINTS/i.test(code));
check("SQL never truncates and never drops", !/\bTRUNCATE\b|\bDROP\s+(TABLE|FUNCTION|TRIGGER)\b/i.test(code));
check("SQL defines only temporary functions (no schema object created)", (code.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+pg_temp\./gi) ?? []).length === (code.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) ?? []).length && !/CREATE\s+(TABLE|VIEW|TRIGGER|POLICY|ROLE)/i.test(code));
check("SQL deletes the auth account only by its exact id", /DELETE FROM auth\.users WHERE id = p_user;/.test(code) && (code.match(/DELETE FROM auth\.users/g) ?? []).length === 1);
check("apply re-derives the plan under a row lock and refuses a mismatched hash",
  /PERFORM 1 FROM auth\.users WHERE id = p_user FOR UPDATE;[\s\S]*oda_inventory\(p_user[\s\S]*ODA_PLAN_STALE/.test(code));
check("apply verifies trigger state is unchanged before returning", /oda_trigger_state\(\) IS DISTINCT FROM v_triggers/.test(code));
check("CLI never prints the access token", !/console\.(log|error)\([^)]*token/i.test(cli.replace(/no Supabase access token/g, "")));

const REG = { developmentSupabaseProjects: ["kpdxlzqtvueiytwjamiw"], productionSupabaseProjects: ["wfaalpfobpmojohetjlr"] };
const U = "083bf421-7bf8-41c7-9f35-ed430ebc238e";
const base = ["--project", "kpdxlzqtvueiytwjamiw", "--user-id", U, "--email", "a@example.invalid"];
check("development dry run resolves", resolveTarget(parseArgs(base), REG).environment === "development");
check("production requires --production", refuses(() => resolveTarget(parseArgs(["--project", "wfaalpfobpmojohetjlr", "--user-id", U, "--email", "a@b.c"]), REG), /requires --production/));
check("production requires a matching --confirm-project", refuses(() => resolveTarget(parseArgs(["--project", "wfaalpfobpmojohetjlr", "--production", "--confirm-project", "kpdxlzqtvueiytwjamiw", "--user-id", U, "--email", "a@b.c"]), REG), /confirm-project/));
check("production with both confirmations resolves", resolveTarget(parseArgs(["--project", "wfaalpfobpmojohetjlr", "--production", "--confirm-project", "wfaalpfobpmojohetjlr", "--user-id", U, "--email", "a@b.c"]), REG).environment === "production");
check("an unregistered ref is refused", refuses(() => resolveTarget(parseArgs(["--project", "abcdefghijklmnopqrst", "--user-id", U, "--email", "a@b.c"]), REG), /not a registered/));
check("an email with quotes / backslashes / spaces is refused", ["a'b@c.d", "a\\b@c.d", "a b@c.d", "nope"].every((e) => refuses(() => resolveTarget(parseArgs(["--project", "kpdxlzqtvueiytwjamiw", "--user-id", U, "--email", e]), REG), /--email/)));
check("--apply requires a 64-hex plan hash", refuses(() => resolveTarget(parseArgs([...base, "--apply", "--plan-hash", "abc"]), REG), /plan-hash/));
check("--fail-at requires --apply and a known point", refuses(() => resolveTarget(parseArgs([...base, "--fail-at", "mid_change"]), REG), /only applies to --apply/) && refuses(() => resolveTarget(parseArgs([...base, "--apply", "--plan-hash", "0".repeat(64), "--fail-at", "x"]), REG), /must be one of/));
check("unknown arguments are refused", refuses(() => parseArgs(["--force"]), /unknown argument/));
const dry = buildBatch(sql, parseArgs(base));
const apply = buildBatch(sql, { ...parseArgs([...base, "--apply", "--plan-hash", "0".repeat(64)]) });
check("dry run batch: BEGIN … oda_inventory … ROLLBACK (never COMMIT)", dry.startsWith("BEGIN;\n") && /oda_inventory\(/.test(dry) && dry.trimEnd().endsWith("ROLLBACK;") && !/COMMIT;/.test(dry));
check("apply batch: BEGIN … oda_apply … COMMIT", apply.startsWith("BEGIN;\n") && /oda_apply\(/.test(apply) && apply.trimEnd().endsWith("COMMIT;"));
check("a SQL module with top-level transaction control is refused", refuses(() => buildBatch("COMMIT;\n" + sql, parseArgs(base)), /transaction control/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
