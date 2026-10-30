// M3.2 — guarded development test-harness fixture purge (NOT product code).
//
// Migration 62 makes safety-notification history immutable, so a suite can
// no longer delete the fixtures it created through ordinary deletes. This
// harness removes EXACTLY the fixtures of the current run:
//
//   1. Guard (before any SQL is built or run): TENOTRAINER_MODE must be
//      exactly "development", the .env project ref AND the linked CLI
//      project must both be on the allow-list, and they must be the same
//      project (M3.1 devProjectGuard). Anything else refuses.
//   2. Inputs: the exact fixture user / organization / canonical-exercise
//      ids the suite created, and the run start time. All ids are
//      validated as UUIDs; REAL_ORG is refused.
//   3. Execution: one transaction (BEGIN … COMMIT) around the temporary
//      function in m32FixturePurge.sql. Any error rolls the whole purge
//      back, including the history-guard state.
//
// There is no database function, RPC, route, action or UI behind this.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDevSqlTarget, assertDevTestTarget, TestTargetRefused } from "./devProjectGuard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PURGE_SQL = join(HERE, "m32FixturePurge.sql");
const REPO = resolve(HERE, "..", "..", "..");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REAL_ORG_ID = "07f342fd-075c-42b5-a885-30ca64953d46";
const FAIL_POINTS = new Set(["recipients", "episodes", "verification"]);

export class FixturePurgeError extends Error {}

function ids(label, list) {
  const out = [...new Set((list ?? []).map(String))];
  for (const id of out) if (!UUID_RE.test(id)) throw new TestTargetRefused(`Refusing fixture purge: ${label} id is not a UUID`);
  return out;
}
const sqlArray = (list) => `ARRAY[${list.map((id) => `'${id.toLowerCase()}'`).join(", ")}]::uuid[]`;

// Builds the guarded purge SQL. Exported for the unit test; never runs SQL.
export function buildPurgeSql({ userIds, organizationIds = [], exerciseIds = [], runStartedAt, failAfter = null }) {
  const users = ids("user", userIds);
  const orgs = ids("organization", organizationIds);
  const exercises = ids("exercise", exerciseIds);
  if (users.length === 0) throw new TestTargetRefused("Refusing fixture purge: no fixture user ids");
  if (orgs.some((o) => o.toLowerCase() === REAL_ORG_ID)) throw new TestTargetRefused("Refusing fixture purge: REAL_ORG is never a disposable fixture");
  const started = new Date(runStartedAt);
  if (Number.isNaN(started.getTime())) throw new TestTargetRefused("Refusing fixture purge: run start time required");
  if (failAfter !== null && !FAIL_POINTS.has(failAfter)) throw new TestTargetRefused("Refusing fixture purge: unknown fail point");
  return [
    "BEGIN;",
    readFileSync(PURGE_SQL, "utf8"),
    `SELECT pg_temp.m32_fixture_purge(${sqlArray(users)}, ${orgs.length ? sqlArray(orgs) : "'{}'::uuid[]"}, ${exercises.length ? sqlArray(exercises) : "'{}'::uuid[]"}, '${started.toISOString()}'::timestamptz, ${failAfter ? `'${failAfter}'` : "NULL"}) AS purge;`,
    "COMMIT;",
    "",
  ].join("\n");
}

function runCli(sql) {
  const path = join(mkdtempSync(join(tmpdir(), "m32-purge-")), "purge.sql");
  writeFileSync(path, sql);
  return execFileSync("supabase", ["db", "query", "--linked", "--file", path], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Guard FIRST: nothing is built or executed unless the target is the
// approved development project in development mode.
export function assertPurgeTarget(env, guardOptions = {}) {
  const urlRef = assertDevTestTarget(env, guardOptions);
  const linkedRef = assertDevSqlTarget(guardOptions);
  if (urlRef !== linkedRef) throw new TestTargetRefused("Refusing fixture purge: the .env project and the linked CLI project differ");
  return urlRef;
}

// Throws (FixturePurgeError) on any failure — callers must fail the suite.
export function purgeSafetyFixtures(env, { userIds, organizationIds = [], exerciseIds = [], runStartedAt, failAfter = null }, { exec = runCli, guardOptions = {} } = {}) {
  assertPurgeTarget(env, guardOptions);
  if (!userIds || userIds.length === 0) return { result: "nothing_to_purge" };
  const sql = buildPurgeSql({ userIds, organizationIds, exerciseIds, runStartedAt, failAfter });
  let out;
  try {
    out = exec(sql);
  } catch (e) {
    const detail = String(e?.stdout ?? e?.message ?? e).match(/ERROR: [^\\"]*/)?.[0] ?? "purge failed";
    throw new FixturePurgeError(`fixture purge rolled back: ${detail}`);
  }
  const start = out.indexOf("{");
  const parsed = start >= 0 ? JSON.parse(out.slice(start)) : null;
  const result = parsed?.rows?.[0]?.purge;
  if (!result || result.result !== "purged" || result.residue !== 0) throw new FixturePurgeError(`fixture purge did not confirm zero residue: ${out.slice(0, 300)}`);
  return result;
}

// Suite teardown: purge this run's exact fixtures or THROW (a suite whose
// cleanup failed must fail — never "tests passed, cleanup failed").
export function guardedFixtureTeardown(env, { userIds, organizationIds = [], exerciseIds = [], runStartedAt }) {
  if (!userIds || userIds.length === 0) return { result: "nothing_to_purge" };
  const result = purgeSafetyFixtures(env, { userIds, organizationIds, exerciseIds, runStartedAt });
  console.log(`\nteardown: guarded purge removed exactly ${userIds.length} fixture user(s), ${organizationIds.length} org(s), ${exerciseIds.length} exercise(s); residue 0 — ${JSON.stringify(result.deleted ?? {})}`);
  return result;
}
