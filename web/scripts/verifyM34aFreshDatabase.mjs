// M3.4a — fresh-database migration proof and schema-drift check.
//
//   1. A throwaway local PostgreSQL 17.6 cluster (scripts/lib/scratchPostgres.mjs;
//      127.0.0.1:3190, new temp directory, positively identified before any
//      statement). Never the development project; no Supabase CLI for it.
//   2. A minimal Supabase platform shim, DERIVED from the development
//      project (read-only): the API roles, the auth schema with auth.users'
//      columns and the auth.uid()/role()/jwt() definitions, the extensions
//      schema + search_path, Supabase's default privileges on public. pg_cron
//      is a scratch test double that records jobs (scripts/lib/scratch-pg-cron).
//   3. Every repository migration applied in filename order, one
//      transaction each — exactly the files a new production project gets.
//   4. Fresh-state proof: extensions, reference data (row-for-row equal to
//      the development project's migration-owned rows), no user / auth /
//      organization / patient / invitation / safety-notification / L5 data,
//      RLS on every public table, the sweep job.
//   5. Drift: the migrations-built catalog, at the development project's
//      ledger position, vs the development project's catalog (read-only;
//      scripts/lib/schemaCatalog.mjs). Any difference fails and is listed.
//      Repository migrations dev has not yet received are listed and must
//      apply on top (migration 64's own exact change set is proven by
//      verifyM34cSecurityHardening.mjs).
//
// Requires TENOTRAINER_PG_TOOLING (see scratchPostgres.mjs).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM34aFreshDatabase.mjs [--report <file.json>]
import { writeFileSync } from "node:fs";
import { assertDevSqlTarget, assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { guardedSql, loadEnv } from "./lib/m32Fixtures.mjs";
import { SCRATCH_DB, ScratchPostgres } from "./lib/scratchPostgres.mjs";
import { applyMigrations, installPlatformStandIn, migrationFiles, readPlatformShape } from "./lib/freshDatabase.mjs";
import { CATALOG_SQL, diffCatalogs, stable, summarizeCatalog } from "./lib/schemaCatalog.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
assertDevSqlTarget(); // the read-only development catalog read goes through the linked dev project only
const EXPECTED_MIGRATIONS = 65; // 62 + the M3.4a corrective migration + the M3.4c security hardening + the M3.4f dispatch scheduler
const L5_OUTBOX = "f73aeb4d-6517-481b-ac6e-cc73fa0afc67";
const reportArg = process.argv.indexOf("--report");
const REPORT = reportArg > 0 ? process.argv[reportArg + 1] : null;

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 600)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Tables whose rows the migrations insert; everything else must be empty.
// Runtime-state tables are compared by key only (their timestamps move).
// Natural key per reference table (random surrogate ids and timestamps
// are excluded from the row comparison).
const REFERENCE_TABLES = new Map([
  // canonical_exercises: the bootstrap contract leaves the audit fields
  // created_at/updated_at/updated_by to runtime; a development edit that set
  // updated_by is development data mutation, not reference content. Every
  // clinical/reference column (name, capabilities, body parts, notes, ...)
  // is still compared.
  ["canonical_exercises", { key: "id", exclude: ["created_at", "updated_at", "updated_by"] }],
  ["exercise_reference_dosage", { key: "exercise_id", exclude: ["id", "created_at", "updated_at"] }],
  ["m6_heuristics", { key: "heuristic_key", exclude: ["id", "created_at", "updated_at"] }],
]);
const RUNTIME_STATE_TABLES = new Set(["safety_notification_heartbeats"]);
const MUST_BE_EMPTY = ["organizations", "organization_members", "profiles", "invitations", "supervisor_patients", "patient_prescriptions",
  "prescription_versions", "rehab_sessions", "acute_safety_episodes", "safety_notification_events", "safety_notification_recipients",
  "safety_email_outbox", "safety_email_attempts", "safety_acute_stop_notices"];

const scratch = new ScratchPostgres();
const report = {};
try {
  // ------------------------------------------------------------- platform shim (derived from dev, read-only)
  section("platform stand-in from the development project (read-only)");
  const shape = readPlatformShape(env);
  check("development auth.users columns and auth helper functions read", shape.users_columns?.length > 10 && shape.auth_functions?.length >= 2, JSON.stringify({ cols: shape.users_columns?.length, fns: shape.auth_functions?.length }));
  const db = await scratch.start();
  check("scratch cluster positively identified (127.0.0.1:3190, its own data directory, tenotrainer_scratch_m34a)", true);
  const standIn = await installPlatformStandIn(db, shape, SCRATCH_DB);
  check(`platform stand-in installed (API roles, auth.users with ${standIn.columns} columns, ${standIn.authFunctions} auth helpers, extensions schema: ${standIn.extensionsSchema.join(", ")}) — test infrastructure, not platform evidence`, true);

  section("migrations on an empty database");
  const files = migrationFiles();
  report.migrations = files.length;
  check(`migration count is ${EXPECTED_MIGRATIONS}`, files.length === EXPECTED_MIGRATIONS, files.length);
  // Drift is measured at the development project's own ledger position:
  // build exactly the versions dev has applied, snapshot that catalog for
  // the comparison, then apply any repository migrations dev has not yet
  // received (they must apply too; the fresh-state proof uses the final
  // state).
  const devLedger = guardedSql(env, "SELECT coalesce(jsonb_agg(version ORDER BY version), '[]') AS v FROM supabase_migrations.schema_migrations")[0].v;
  const atDev = files.filter((f) => devLedger.includes(f.slice(0, 14)));
  const pending = files.filter((f) => !devLedger.includes(f.slice(0, 14)));
  report.devLedger = devLedger.length;
  report.pendingForDev = pending;
  check("every migration dev has applied exists in the repository, and they are a filename-order prefix", atDev.length === devLedger.length && stable(atDev) === stable(files.slice(0, atDev.length)), JSON.stringify({ dev: devLedger.length, matched: atDev.length }));
  console.log(`      dev ledger: ${devLedger.length}; repository migrations not yet applied to dev: ${pending.length ? pending.join(", ") : "none"}`);
  const first = await applyMigrations(db, atDev);
  if (first.failed) check(`migration ${first.failed.file} applies`, false, first.failed.error);
  var builtAtDev = first.failed ? null : (await db.query(CATALOG_SQL)).rows[0].catalog;
  const second = first.failed ? { applied: 0, failed: null } : await applyMigrations(db, pending);
  if (second.failed) check(`migration ${second.failed.file} applies`, false, second.failed.error);
  const applied = first.applied + second.applied;
  check(`all ${files.length} migrations applied in filename order, one transaction each`, applied === files.length, `${applied}/${files.length}`);
  if (applied !== files.length) throw new Error("STOP: the migrations cannot reconstruct a fresh database");

  // ------------------------------------------------------------- fresh state
  section("fresh-state proof");
  const ext = (await db.query("SELECT extname FROM pg_extension ORDER BY 1")).rows.map((r) => r.extname);
  check("required extensions established (pgcrypto, pg_trgm, pg_cron, pg_net)", ["pgcrypto", "pg_trgm", "pg_cron", "pg_net"].every((e) => ext.includes(e)), ext.join(","));
  const queued = Number((await db.query("SELECT count(*) AS n FROM net.http_request_queue")).rows[0].n);
  check("applying every migration made no outbound request (pg_net queue empty)", queued === 0, queued);
  const tables = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`)).rows.map((r) => r.relname);
  const counts = {};
  for (const t of tables) counts[t] = Number((await db.query(`SELECT count(*) AS n FROM public.${ident(t)}`)).rows[0].n);
  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0).map(([t]) => t);
  report.nonEmptyTables = Object.fromEntries(nonEmpty.map((t) => [t, counts[t]]));
  const unexpectedRows = nonEmpty.filter((t) => !REFERENCE_TABLES.has(t) && !RUNTIME_STATE_TABLES.has(t));
  check(`only reference / runtime-state tables hold rows (${nonEmpty.map((t) => `${t}=${counts[t]}`).join(", ")})`, unexpectedRows.length === 0, unexpectedRows.join(","));
  check("canonical exercise library present (47 bootstrap exercises)", counts.canonical_exercises === 47, counts.canonical_exercises);
  check("reference dosage and M6 heuristics present", counts.exercise_reference_dosage > 0 && counts.m6_heuristics > 0, JSON.stringify({ dosage: counts.exercise_reference_dosage, heuristics: counts.m6_heuristics }));
  check("safety heartbeat rows exist (sweep, dispatch) — runtime state, no history", counts.safety_notification_heartbeats === 2);
  const authUsers = Number((await db.query("SELECT count(*) AS n FROM auth.users")).rows[0].n);
  check("no Auth users", authUsers === 0, authUsers);
  check(`no organizations, memberships, profiles, invitations, assignments, prescriptions, sessions, safety events / outbox / attempts (${MUST_BE_EMPTY.length} tables)`, MUST_BE_EMPTY.every((t) => counts[t] === 0), JSON.stringify(Object.fromEntries(MUST_BE_EMPTY.map((t) => [t, counts[t]]))));
  const l5 = Number((await db.query("SELECT count(*) AS n FROM safety_email_outbox WHERE id = $1", [L5_OUTBOX])).rows[0].n);
  check("the preserved L5 outbox row does not exist in a fresh database", l5 === 0);
  const noRls = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity ORDER BY 1`)).rows.map((r) => r.relname);
  report.tablesWithoutRls = noRls;
  check(`RLS enabled on every public table (${tables.length})`, noRls.length === 0, noRls.join(","));
  const jobs = (await db.query("SELECT jobname, schedule, command, active FROM cron.job ORDER BY jobname")).rows;
  const sweep = jobs.find((j) => j.jobname === "tenotrainer_m32_safety_notification_sweep");
  const dispatchJob = jobs.find((j) => j.jobname === "tenotrainer_m34f_safety_dispatch");
  check("exactly two cron jobs: the M3.2 sweep and the M3.4f dispatch job", jobs.length === 2 && !!sweep && !!dispatchJob, JSON.stringify(jobs));
  check("the safety-notification sweep job is defined (every minute, SQL only, active)", sweep?.schedule === "* * * * *" && /safety_notifications_sweep\(\)/.test(sweep?.command ?? "") && sweep?.active === true, JSON.stringify(sweep));
  check("the M3.4f dispatch job is defined INACTIVE (every minute, the bare wrapper call)", dispatchJob?.schedule === "* * * * *" && dispatchJob?.command === "SELECT private.safety_dispatch_tick()" && dispatchJob?.active === false, JSON.stringify(dispatchJob));

  // Reference rows: row-for-row equal to the development project's rows
  // with the same keys (timestamps excluded) — the migrations reproduce the
  // reference data; nothing was copied from development.
  for (const [t, { key, exclude }] of REFERENCE_TABLES) {
    const strip = exclude.map((c) => ` - '${c}'`).join("");
    const rowSql = (where) => `SELECT ${ident(key)}::text AS k, (to_jsonb(x)${strip}) AS j FROM public.${ident(t)} x ${where} ORDER BY 1`;
    const mine = (await db.query(rowSql(""))).rows;
    const keys = mine.map((r) => `'${r.k.replace(/'/g, "''")}'`).join(",");
    const theirs = new Map(guardedSql(env, rowSql(`WHERE ${ident(key)}::text IN (${keys})`)).map((r) => [r.k, r.j]));
    const differ = [];
    for (const r of mine) {
      const o2 = theirs.get(r.k);
      if (!o2) { differ.push({ key: r.k, missingInDev: true }); continue; }
      const cols = [...new Set([...Object.keys(r.j), ...Object.keys(o2)])].filter((c) => stable(r.j[c]) !== stable(o2[c]));
      if (cols.length) differ.push({ key: r.k, columns: cols.map((c) => ({ column: c, migrations: r.j[c], dev: o2[c] })) });
    }
    report[`reference_${t}`] = differ;
    check(`${t}: all ${mine.length} migration-built rows equal the development project's rows (by ${key})`, differ.length === 0, JSON.stringify(differ.slice(0, 3)));
  }

  // ------------------------------------------------------------- drift
  section("schema drift: migrations-built (at dev's ledger position) vs the development project");
  const built = builtAtDev;
  const dev = guardedSql(env, CATALOG_SQL)[0].catalog;
  report.catalogBuilt = summarizeCatalog(built);
  report.catalogDev = summarizeCatalog(dev);
  report.extensionVersions = { built: built.extension_versions, dev: dev.extension_versions };
  console.log(`      built: ${JSON.stringify(report.catalogBuilt)}`);
  console.log(`      dev:   ${JSON.stringify(report.catalogDev)}`);
  const d = diffCatalogs(built, dev);
  report.drift = d;
  console.log(`      excluded platform-managed objects (exact, named; provenance unverified; M3.4c item): ${d.excludedPlatformObjects.length ? d.excludedPlatformObjects.join("; ") : "none present"}`);
  check("only the exact named platform objects were excluded", d.excludedPlatformObjects.every((x) => /rls_auto_enable|ensure_rls/.test(x)), d.excludedPlatformObjects.join("; "));
  const finalCat = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const fn = finalCat.functions.find((f) => f.name === "create_rehab_session_if_allowed");
  const fnDev = dev.functions.find((f) => f.name === "create_rehab_session_if_allowed");
  check("create_rehab_session_if_allowed ends (after every migration) in the accepted (development) definition", fn && fnDev && fn.def_md5 === fnDev.def_md5 && stable(fn) === stable(fnDev), `${fn?.def_md5} vs ${fnDev?.def_md5}`);
  const devNoRls = dev.relations.filter((r) => ["r", "p"].includes(r.kind) && !r.rls).map((r) => r.name);
  check("development application tables: RLS enabled on every one as well (security does not rely on platform automation)", devNoRls.length === 0, devNoRls.join(","));
  for (const [cat, x] of Object.entries(d.categories)) {
    console.log(`      ${cat}: missing in dev ${x.missing.length}, unexpected in dev ${x.unexpected.length}, changed ${x.changed.length}`);
    for (const m of x.missing.slice(0, 8)) console.log(`        - missing:    ${m}`);
    for (const u of x.unexpected.slice(0, 8)) console.log(`        + unexpected: ${u}`);
    for (const c of x.changed.slice(0, 8)) console.log(`        ~ changed:    ${c.key}\n            built: ${JSON.stringify(c.expected).slice(0, 300)}\n            dev:   ${JSON.stringify(c.observed).slice(0, 300)}`);
  }
  // Exact definitions for changed / dev-only functions (for review).
  const fnKeys = [...(d.categories.functions?.changed ?? []).map((c) => c.key), ...(d.categories.functions?.unexpected ?? [])];
  report.functionDefinitions = {};
  for (const k of fnKeys) {
    const name = k.slice(0, k.indexOf("("));
    const q2 = `SELECT pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${name}'`;
    const pick = (rows) => rows.find((r) => `${name}(${r.args})` === k)?.def ?? null;
    const b = pick((await db.query(q2)).rows);
    const v = pick(guardedSql(env, q2));
    report.functionDefinitions[k] = { migrations: b, dev: v };
    const bl = (b ?? "").split("\n");
    const vl = (v ?? "").split("\n");
    console.log(`      definition difference for ${k}:`);
    for (const l of vl.filter((x) => !bl.includes(x)).slice(0, 25)) console.log(`        dev only:        ${l}`);
    for (const l of bl.filter((x) => !vl.includes(x)).slice(0, 25)) console.log(`        migrations only: ${l}`);
  }
  check("no schema drift between the migrations and the development project", d.total === 0, `${d.total} differences`);
} catch (e) {
  check("fresh-database proof completed", false, e.message);
} finally {
  await scratch.stop();
  if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
