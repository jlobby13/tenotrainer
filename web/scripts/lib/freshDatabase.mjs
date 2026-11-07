// M3.4a — migration-reconstruction test infrastructure for the scratch
// cluster (scripts/lib/scratchPostgres.mjs): a minimal Supabase platform
// STAND-IN derived from the development project (read-only), then the
// repository migrations applied one transaction each.
//
// The stand-in exists only so the migrations can run on plain PostgreSQL:
// the API roles, the auth schema (auth.users' column list and the auth
// helper functions copied from the development project), the extensions
// schema and search_path, and Supabase's default privileges on public.
// pg_cron and pg_net are test doubles that record jobs / requests, and Vault
// is a plaintext test double of vault.decrypted_secrets (M3.4f). None of this
// is evidence of real Supabase platform behaviour (real pg_cron, Auth,
// platform grants and objects are verified on the real project in M3.4c;
// real pg_net and Vault in M3.4f Stage B).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { guardedSql } from "./m32Fixtures.mjs";

export const MIGRATIONS_DIR = join("..", "supabase", "migrations");
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

// Read-only: what the stand-in copies from the development project.
export function readPlatformShape(env) {
  return guardedSql(env, `SELECT
    (SELECT jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull) ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = 'auth.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped) AS users_columns,
    (SELECT jsonb_agg(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'auth' AND p.proname IN ('uid', 'role', 'jwt', 'email')) AS auth_functions,
    (SELECT jsonb_object_agg(e.extname, n.nspname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace) AS extension_schemas`)[0];
}

export async function installPlatformStandIn(db, shape, database) {
  const cols = shape.users_columns.map((c) => `${ident(c.name)} ${/\bauth\./.test(c.type) ? "text" : c.type}${c.name === "id" ? " PRIMARY KEY" : ""}`).join(",\n  ");
  const extInExtensions = ["pgcrypto", "pg_trgm", "uuid-ossp"].filter((e) => shape.extension_schemas?.[e] === "extensions");
  await db.query(`
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
${extInExtensions.map((e) => `CREATE EXTENSION IF NOT EXISTS ${ident(e)} WITH SCHEMA extensions;`).join("\n")}
ALTER DATABASE ${ident(database)} SET search_path = "$user", public, extensions;
CREATE TABLE auth.users (
  ${cols}
);
-- M3.4f — Vault TEST DOUBLE (plaintext; never a real secret store). No
-- unique name constraint, so the scheduler wrapper's duplicate-name refusal
-- is testable; real Vault's name uniqueness is checked in Stage B.
CREATE SCHEMA vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
CREATE TABLE vault.secrets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, description TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL);
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, description, secret, secret AS decrypted_secret FROM vault.secrets;
`);
  for (const def of shape.auth_functions) await db.query(def);
  await db.query(`SET search_path = "$user", public, extensions`);
  return { columns: shape.users_columns.length, authFunctions: shape.auth_functions.length, extensionsSchema: extInExtensions };
}

// Applies `files` (default: every migration, version order), one
// transaction each. Returns { applied, failed: { file, error } | null }.
export async function applyMigrations(db, files = migrationFiles()) {
  let applied = 0;
  for (const f of files) {
    try {
      await db.query("BEGIN");
      await db.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      await db.query("COMMIT");
      applied++;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      return { applied, failed: { file: f, error: e.message } };
    }
  }
  return { applied, failed: null };
}
