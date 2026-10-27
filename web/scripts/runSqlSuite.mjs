// M3.1 — guarded runner for write-capable SQL verification suites.
// Refuses unless TENOTRAINER_MODE=development and the linked Supabase CLI
// project is on the approved test-project allow-list, then runs the suite
// through `supabase db query --linked` from the repository root.
//
// A line `-- @@include <path relative to the repo root>` is replaced by that
// file's exact contents (used to prove a migration file verbatim inside a
// rolled-back transaction); the included file's sha256 is printed to stderr.
//
//   TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyM2NativeOnboarding.sql
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDevSqlTarget } from "./lib/devProjectGuard.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/runSqlSuite.mjs <suite.sql>");
  process.exit(2);
}
try {
  assertDevSqlTarget();
} catch (e) {
  console.error(e.message);
  process.exit(3);
}
const REPO = resolve("..");
let sql = readFileSync(resolve(file), "utf8");
let path = resolve(file);
if (/^-- @@include /m.test(sql)) {
  sql = sql.replace(/^-- @@include (\S+)\s*$/gm, (_, rel) => {
    const content = readFileSync(join(REPO, rel), "utf8");
    console.error(`included ${rel} sha256=${createHash("sha256").update(content).digest("hex")}`);
    return content;
  });
  path = join(mkdtempSync(join(tmpdir(), "m31-sql-")), "suite.sql");
  writeFileSync(path, sql);
}
const out = execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
process.stdout.write(out);
