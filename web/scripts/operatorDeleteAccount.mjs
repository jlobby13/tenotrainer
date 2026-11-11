#!/usr/bin/env node
// Alpha 1 — OPERATOR-ONLY participant account deletion / closure CLI.
// NOT product code: no route, action, RPC or UI reaches it. See
// docs/operator-account-deletion-runbook.md before using it.
//
//   Dry run (default; changes nothing):
//     node scripts/operatorDeleteAccount.mjs --project <ref> --user-id <uuid> --email <address>
//   Apply the plan reviewed in the dry run:
//     node scripts/operatorDeleteAccount.mjs --project <ref> --user-id <uuid> --email <address> --apply --plan-hash <hash>
//   Production additionally requires: --production --confirm-project <ref>
//
// Options: --json (machine-readable output), --fail-at <after_lock|mid_change|before_verify>
// (development only: an injected failure that must roll everything back).
//
// Database access: the Supabase Management API (POST /v1/projects/<ref>/database/query,
// runs as the migration owner) with the operator's personal access token from
// SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token. The token is never printed.
// Every run is ONE transaction: the dry run ends in ROLLBACK, an apply in COMMIT
// (any error rolls the whole apply back).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(HERE, "lib", "operatorDeleteAccount.sql");
const REGISTRY_PATH = resolve(HERE, "..", "config", "resourceIdentity.json");
const API = process.env.TENOTRAINER_ODA_API_BASE ?? "https://api.supabase.com";
const FAIL_POINTS = ["after_lock", "mid_change", "before_verify"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@'"\\]{1,200}@[^\s@'"\\]{1,200}$/;

export class OdaRefused extends Error {}

export function parseArgs(argv) {
  const a = { apply: false, production: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new OdaRefused(`missing value for ${k}`);
      return argv[++i];
    };
    if (k === "--project") a.project = next();
    else if (k === "--user-id") a.userId = next().toLowerCase();
    else if (k === "--email") a.email = next().trim();
    else if (k === "--plan-hash") a.planHash = next().toLowerCase();
    else if (k === "--confirm-project") a.confirmProject = next();
    else if (k === "--fail-at") a.failAt = next();
    else if (k === "--apply") a.apply = true;
    else if (k === "--production") a.production = true;
    else if (k === "--json") a.json = true;
    else throw new OdaRefused(`unknown argument ${k}`);
  }
  return a;
}

// Target identity: the ref must be a registered project; Production needs two
// explicit confirmations; test-only hooks never reach Production.
export function resolveTarget(a, registry) {
  if (!a.project || !/^[a-z]{20}$/.test(a.project)) throw new OdaRefused("--project <20-letter project ref> is required");
  if (!a.userId || !UUID_RE.test(a.userId)) throw new OdaRefused("--user-id <uuid> is required");
  if (!a.email || !EMAIL_RE.test(a.email)) throw new OdaRefused("--email <the account's exact address> is required");
  const isDev = registry.developmentSupabaseProjects.includes(a.project);
  const isProd = registry.productionSupabaseProjects.includes(a.project);
  if (isDev === isProd) throw new OdaRefused("the project is not a registered development or production project");
  if (isProd) {
    if (!a.production) throw new OdaRefused("a production project requires --production");
    if (a.confirmProject !== a.project) throw new OdaRefused("a production project requires --confirm-project <the same ref>");
    if (a.failAt) throw new OdaRefused("--fail-at is a development-only test hook");
  } else {
    if (a.production || a.confirmProject) throw new OdaRefused("--production / --confirm-project name a production project; this ref is development");
  }
  if (a.failAt && !FAIL_POINTS.includes(a.failAt)) throw new OdaRefused(`--fail-at must be one of ${FAIL_POINTS.join(", ")}`);
  if (a.failAt && !a.apply) throw new OdaRefused("--fail-at only applies to --apply");
  if (a.apply && !/^[0-9a-f]{64}$/.test(a.planHash ?? "")) throw new OdaRefused("--apply requires --plan-hash <the 64-hex hash from the dry run>");
  if (!a.apply && a.planHash) throw new OdaRefused("--plan-hash is only used with --apply");
  return { environment: isProd ? "production" : "development" };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The SQL module may only define functions: its top level must contain no
// transaction control (the batch's single BEGIN / ROLLBACK|COMMIT is added here).
export function buildBatch(sqlModule, a) {
  const top = sqlModule.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, "<BODY>").replace(/--[^\n]*/g, "");
  if (/(^|;)\s*(BEGIN|COMMIT|END|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|RELEASE|ABORT)\b/i.test(top)) {
    throw new OdaRefused("the SQL module contains top-level transaction control");
  }
  const call = a.apply
    ? `SELECT pg_temp.oda_apply(${lit(a.userId)}::uuid, ${lit(a.email)}, ${lit(a.project)}, ${lit(a.planHash)}, ${a.failAt ? lit(a.failAt) : "NULL"}) AS r;`
    : `SELECT pg_temp.oda_inventory(${lit(a.userId)}::uuid, ${lit(a.email)}, ${lit(a.project)}) AS r;`;
  return ["BEGIN;", sqlModule, call, a.apply ? "COMMIT;" : "ROLLBACK;", ""].join("\n");
}

function accessToken() {
  const env = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  if (env) return env;
  const p = join(homedir(), ".supabase", "access-token");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  throw new OdaRefused("no Supabase access token (SUPABASE_ACCESS_TOKEN or ~/.supabase/access-token)");
}

async function api(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

async function runBatch(ref, token, sql) {
  const r = await api(`/v1/projects/${ref}/database/query`, token, { query: sql });
  if (!r.ok || !Array.isArray(r.data)) {
    const msg = String(r.data?.message ?? `HTTP ${r.status}`);
    const code = msg.match(/ODA_[A-Z_]+/)?.[0] ?? "DATABASE_ERROR";
    return { error: code, detail: msg.replace(/^Failed to run sql query: /, "").slice(0, 400) };
  }
  return { result: r.data[0]?.r ?? null };
}

export const closedPlaceholder = (userId) => `closed+${userId}@deleted.invalid`;
const maskEmail = (e) => e.replace(/^(.)[^@]*(@.*)$/, "$1***$2");

function audit(record) {
  const dir = process.env.TENOTRAINER_ODA_AUDIT_DIR ?? join(homedir(), ".tenotrainer-account-deletions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${record.at.replace(/[:.]/g, "-")}-${record.mode}-${record.user_id.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return file;
}

function summarize(inv) {
  const lines = [`outcome: ${inv.outcome.toUpperCase()}`];
  if (inv.refusals?.length) lines.push(`refusals: ${inv.refusals.join(", ")}`);
  const block = (title, obj) => {
    const e = Object.entries(obj ?? {});
    if (e.length) lines.push(`${title}:`, ...e.map(([k, v]) => `  ${k}: ${v}`));
  };
  block("records about this account (removed on delete)", inv.subject_records);
  block("dependent records (removed with their parent on delete)", inv.dependent_records);
  block("PROTECTED safety records (never deleted; select CLOSE)", inv.protected_safety_records);
  block("records this account authored about OTHER people (refuses)", inv.authored_records_about_others);
  if (inv.reclose) lines.push(`RE-CLOSE: the closure is no longer intact (${(inv.closure_drift ?? []).join(", ")}); applying re-applies the de-identification`);
  if (inv.outcome === "close") block("identifiable data a closure retains", inv.retained_if_closed);
  if (inv.plan_hash) lines.push(`plan hash: ${inv.plan_hash}`);
  return lines.join("\n");
}

export async function main(argv) {
  const a = parseArgs(argv);
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const { environment } = resolveTarget(a, registry);
  const token = accessToken();
  const project = await api(`/v1/projects/${a.project}`, token);
  if (!project.ok || project.data?.ref !== a.project) throw new OdaRefused(`cannot confirm project ${a.project} with this access token (HTTP ${project.status})`);
  const sql = buildBatch(readFileSync(SQL_PATH, "utf8"), a);
  const at = new Date().toISOString();
  const header = `target: ${a.project} (${project.data.name}) — ${environment.toUpperCase()}\naccount: ${a.userId} <${maskEmail(a.email)}>\nmode: ${a.apply ? "APPLY" : "DRY RUN (no changes)"}`;

  const run = await runBatch(a.project, token, sql);
  const record = {
    at, mode: a.apply ? "apply" : "dry-run", project: a.project, environment, user_id: a.userId,
    email_sha256: createHash("sha256").update(a.email.toLowerCase()).digest("hex"),
    operator: `${userInfo().username}`, plan_hash: a.apply ? a.planHash : run.result?.plan_hash ?? null,
    outcome: run.error ? "error" : run.result?.outcome ?? null, error: run.error ?? null,
    changes: run.result?.changes ?? null,
  };
  let post = null;
  if (a.apply && !run.error) {
    // Independent confirmation in a fresh transaction. A closed account is
    // addressed by its placeholder email from now on.
    const postEmail = run.result.outcome === "close" ? closedPlaceholder(a.userId) : a.email;
    const check = await runBatch(a.project, token, buildBatch(readFileSync(SQL_PATH, "utf8"), { ...a, email: postEmail, apply: false, planHash: undefined, failAt: undefined }));
    post = check.error ? { error: check.error } : { refusals: check.result?.refusals ?? [] };
    const expected = run.result.outcome === "delete" ? "account_not_found" : "already_closed";
    record.post_check = post.refusals?.includes(expected) ? `confirmed (${expected})` : `UNEXPECTED ${JSON.stringify(post)}`;
  }
  const auditFile = audit(record);

  if (a.json) {
    process.stdout.write(JSON.stringify({ environment, mode: record.mode, ...run, post_check: record.post_check ?? null, audit_file: auditFile }) + "\n");
  } else {
    console.log(header);
    if (run.error) console.log(`\nFAILED: ${run.error} — nothing was changed (the transaction rolled back)\n${run.detail}`);
    else if (a.apply) {
      console.log(`\n${run.result.outcome === "delete" ? "DELETED" : "CLOSED (not deleted: protected safety records are retained)"} — verified in-transaction`);
      for (const [k, v] of Object.entries(run.result.changes ?? {})) console.log(`  ${k}: ${v}`);
      if (run.result.outcome === "close") console.log("retained identifiable data:", JSON.stringify(run.result.retained_if_closed));
      console.log(`post-check: ${record.post_check}`);
    } else console.log("\n" + summarize(run.result));
    console.log(`\naudit record: ${auditFile}`);
  }
  const ok = !run.error && (!a.apply || String(record.post_check).startsWith("confirmed")) && !(run.result?.outcome === "refused");
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof OdaRefused) {
        console.error(`REFUSED: ${e.message}`);
        process.exit(2);
      }
      console.error(`ERROR: ${e?.message ?? e}`);
      process.exit(1);
    }
  );
}
