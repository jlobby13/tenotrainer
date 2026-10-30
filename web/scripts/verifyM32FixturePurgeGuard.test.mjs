// M3.2 — adversarial unit test for the guarded fixture purge. Every refusal
// must happen BEFORE any SQL is executed (the executor stub records calls).
// No database access.
//
// Run from web/ (any parent-shell TENOTRAINER_MODE):  node scripts/verifyM32FixturePurgeGuard.test.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { purgeSafetyFixtures, buildPurgeSql } from "./lib/safetyFixturePurge.mjs";
import { TestTargetRefused } from "./lib/devProjectGuard.mjs";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const dir = mkdtempSync(join(tmpdir(), "m32-purge-guard-"));
const allow = join(dir, "allow.json");
const empty = join(dir, "empty.json");
const linked = join(dir, "project-ref");
const linkedOther = join(dir, "project-ref-other");
writeFileSync(allow, JSON.stringify({ projects: ["abcdefghijklmnopqrst", "bbbbbbbbbbbbbbbbbbbb"] }));
writeFileSync(empty, JSON.stringify({ projects: [] }));
writeFileSync(linked, "abcdefghijklmnopqrst\n");
writeFileSync(linkedOther, "bbbbbbbbbbbbbbbbbbbb\n");
const DEV_ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
const PROD_ENV = { NEXT_PUBLIC_SUPABASE_URL: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" };
const FIXTURE = { userIds: [randomUUID()], runStartedAt: new Date().toISOString() };

function attempt(label, env, guardOptions, args = FIXTURE, expectRefusal = true) {
  const calls = [];
  const exec = (sql) => { calls.push(sql); return '{"rows":[{"purge":{"result":"purged","residue":0}}]}'; };
  let refusedErr = null;
  try {
    purgeSafetyFixtures(env, args, { exec, guardOptions });
  } catch (e) {
    refusedErr = e;
  }
  if (expectRefusal) {
    check(`refuses before any SQL: ${label}`, refusedErr instanceof TestTargetRefused && calls.length === 0, refusedErr ? refusedErr.message : `executed ${calls.length}`);
  } else {
    check(`allowed: ${label}`, refusedErr === null && calls.length === 1, refusedErr?.message);
  }
  return calls;
}

const ok = { allowListPath: allow, linkedRefPath: linked };
attempt("TENOTRAINER_MODE missing", DEV_ENV, { ...ok, mode: "" });
attempt("TENOTRAINER_MODE production", DEV_ENV, { ...ok, mode: "production" });
attempt("TENOTRAINER_MODE maintenance", DEV_ENV, { ...ok, mode: "maintenance" });
attempt("TENOTRAINER_MODE invalid", DEV_ENV, { ...ok, mode: "Development" });
attempt("unknown (e.g. production) project in .env", PROD_ENV, { ...ok, mode: "development" });
attempt("missing allow-list", DEV_ENV, { mode: "development", allowListPath: join(dir, "missing.json"), linkedRefPath: linked });
attempt("empty allow-list", DEV_ENV, { mode: "development", allowListPath: empty, linkedRefPath: linked });
attempt("no linked CLI project", DEV_ENV, { mode: "development", allowListPath: allow, linkedRefPath: join(dir, "none") });
attempt(".env project and linked CLI project differ (both allow-listed)", DEV_ENV, { mode: "development", allowListPath: allow, linkedRefPath: linkedOther });
const dev = { ...ok, mode: "development" };
attempt("non-UUID user id (SQL injection attempt)", DEV_ENV, dev, { userIds: ["x'); DROP TABLE organizations; --"], runStartedAt: FIXTURE.runStartedAt });
attempt("REAL_ORG passed as a disposable organization", DEV_ENV, dev, { ...FIXTURE, organizationIds: ["07f342fd-075c-42b5-a885-30ca64953d46"] });
attempt("missing run start time", DEV_ENV, dev, { userIds: FIXTURE.userIds });
attempt("unknown induced-failure point", DEV_ENV, dev, { ...FIXTURE, failAfter: "everything" });
const calls = attempt("development + allow-listed + same linked project", DEV_ENV, dev, FIXTURE, false);
check("the executed SQL is one transaction around the temporary function only",
  calls.length === 1 && calls[0].startsWith("BEGIN;") && calls[0].trimEnd().endsWith("COMMIT;")
  && (calls[0].match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) ?? []).length === 1 && calls[0].includes("CREATE FUNCTION pg_temp.m32_fixture_purge")
  && !/\bGRANT\b/i.test(calls[0]) && !/CREATE\s+(UNLOGGED\s+)?TABLE\s+(public\.)?[a-z]/i.test(calls[0]));
check("the SQL carries exactly the given fixture ids", calls[0].includes(FIXTURE.userIds[0]) && (calls[0].match(/::uuid\[\]/g) ?? []).length === 3);
check("no email-suffix selector: the purge never scans by email alone",
  !/WHERE[^;]*email LIKE '%@example\.invalid'[^;]*DELETE/is.test(buildPurgeSql(FIXTURE)) && buildPurgeSql(FIXTURE).includes("unnest(p_users)"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
