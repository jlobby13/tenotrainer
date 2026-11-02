// M3.4a — schema catalog snapshot and comparison for drift detection
// (test / operator infrastructure). ONE read-only SELECT, identical on any
// PostgreSQL target, returning a normalized JSON description of what the
// application's migrations own. It never reads user rows.
//
// Scope (application-owned objects only):
//   - public schema: tables/views/sequences (+ RLS flags), columns (type,
//     nullability, default, identity/generated), constraints (definition),
//     indexes (definition), functions (identity, kind, volatility, security,
//     config, md5 of the full definition), triggers, RLS policies, enum and
//     domain types, view definitions (md5);
//   - grants to the API roles (anon, authenticated, service_role, PUBLIC) on
//     public tables, sequences and functions, and schema USAGE;
//   - triggers on auth.users (application triggers on the platform table);
//   - extensions present (name only; versions are informational);
//   - pg_cron job definitions (jobname, schedule, command);
//   - event triggers whose function is in public (the same application scope
//     as functions; the platform's own event triggers, owned by
//     supabase_admin with functions in the extensions schema, are outside it).
// Excluded as platform/system differences: extension-owned objects
// (pg_depend 'e'), owners, OIDs, other schemas, roles beyond the API roles,
// statistics, and every row of every table.
export const API_ROLES = ["anon", "authenticated", "service_role"];

export const CATALOG_SQL = `
WITH
ext_owned AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
    AND c.oid NOT IN (SELECT objid FROM ext_owned)
),
fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prokind, p.provolatile, p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.oid NOT IN (SELECT objid FROM ext_owned)
),
api AS (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') UNION ALL SELECT 0, 'PUBLIC')
SELECT jsonb_build_object(
  'relations', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', relname, 'kind', relkind, 'rls', relrowsecurity, 'force_rls', relforcerowsecurity) ORDER BY relname), '[]') FROM rel),
  'columns', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', r.relname, 'column', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated) ORDER BY r.relname, a.attname), '[]')
    FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE r.relkind IN ('r','p','v','m','f')),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', r.relname, 'name', co.conname, 'type', co.contype, 'def', pg_get_constraintdef(co.oid)) ORDER BY r.relname, co.conname), '[]')
    FROM rel r JOIN pg_constraint co ON co.conrelid = r.oid),
  'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', r.relname, 'name', ic.relname, 'def', pg_get_indexdef(i.indexrelid)) ORDER BY r.relname, ic.relname), '[]')
    FROM rel r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ic ON ic.oid = i.indexrelid),
  'functions', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', proname, 'args', args, 'kind', prokind, 'volatility', provolatile, 'security_definer', prosecdef,
      'config', proconfig, 'def_md5', CASE WHEN prokind IN ('f','p') THEN md5(pg_get_functiondef(oid)) END) ORDER BY proname, args), '[]') FROM fn),
  'function_grants', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'fn', x->>'grantee', x->>'privilege'), '[]') FROM (
      SELECT jsonb_build_object('fn', f.proname || '(' || f.args || ')', 'grantee', api.rolname, 'privilege', g.privilege_type) AS x
      FROM fn f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl, acldefault('f'::"char", (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) g
      JOIN api ON api.oid = g.grantee) s),
  'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', n.nspname || '.' || c.relname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled) ORDER BY n.nspname, c.relname, t.tgname), '[]')
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND (n.nspname = 'public' OR (n.nspname = 'auth' AND c.relname = 'users'))
      AND t.oid NOT IN (SELECT objid FROM ext_owned)
      AND (n.nspname = 'public' OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace WHERE p.oid = t.tgfoid AND pn.nspname = 'public'))),
  'policies', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname, 'permissive', permissive, 'roles', roles, 'cmd', cmd, 'qual', qual, 'with_check', with_check) ORDER BY tablename, policyname), '[]')
    FROM pg_policies WHERE schemaname = 'public'),
  'types', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', t.typname, 'kind', t.typtype,
      'labels', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid),
      'domain', CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END) ORDER BY t.typname), '[]')
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e','d') AND t.oid NOT IN (SELECT objid FROM ext_owned)),
  'views', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', relname, 'def_md5', md5(pg_get_viewdef(oid))) ORDER BY relname), '[]') FROM rel WHERE relkind IN ('v','m')),
  'table_grants', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', r.relname, 'grantee', api.rolname, 'privilege', g.privilege_type) ORDER BY r.relname, api.rolname, g.privilege_type), '[]')
    FROM rel r JOIN pg_class c ON c.oid = r.oid CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault((CASE WHEN r.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) g JOIN api ON api.oid = g.grantee),
  'schema_usage', (SELECT jsonb_agg(jsonb_build_object('role', rolname, 'usage', has_schema_privilege(rolname, 'public', 'USAGE')) ORDER BY rolname) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')),
  'event_triggers', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', e.evtname, 'event', e.evtevent, 'function', e.evtfoid::regproc::text, 'tags', e.evttags, 'enabled', e.evtenabled) ORDER BY e.evtname), '[]')
    FROM pg_event_trigger e JOIN pg_proc ep ON ep.oid = e.evtfoid
    WHERE ep.pronamespace = 'public'::regnamespace AND e.oid NOT IN (SELECT objid FROM ext_owned)),
  'extensions', (SELECT coalesce(jsonb_agg(extname ORDER BY extname), '[]') FROM pg_extension),
  'extension_versions', (SELECT coalesce(jsonb_object_agg(extname, extversion), '{}') FROM pg_extension),
  'cron_jobs', (SELECT CASE WHEN to_regclass('cron.job') IS NULL THEN '[]'::jsonb ELSE
    (SELECT coalesce(jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'command', command, 'active', active) ORDER BY jobname), '[]') FROM cron.job) END)
) AS catalog`;

const key = {
  relations: (x) => x.name,
  columns: (x) => `${x.table}.${x.column}`,
  constraints: (x) => `${x.table}.${x.name}`,
  indexes: (x) => `${x.table}.${x.name}`,
  functions: (x) => `${x.name}(${x.args})`,
  function_grants: (x) => `${x.fn} ${x.grantee} ${x.privilege}`,
  triggers: (x) => `${x.table}.${x.name}`,
  policies: (x) => `${x.table}.${x.name}`,
  types: (x) => x.name,
  views: (x) => x.name,
  table_grants: (x) => `${x.table} ${x.grantee} ${x.privilege}`,
  schema_usage: (x) => x.role,
  cron_jobs: (x) => x.jobname,
  event_triggers: (x) => x.name,
};

// M3.4a (founder Decision 2) — EXACT named exclusions: external /
// platform-managed objects found on the development project that the
// TenoTrainer migration set does not own; provenance currently unverified
// (M3.4c verifies them on the real production project). Each matches only
// one object with its exact observed attributes and definition hash, and
// only when it is present on the observed side alone; any other object, or
// a changed definition, is still drift. RLS on application tables never
// depends on them: the migrations enable it explicitly (checked separately).
export const PLATFORM_OBJECT_EXCLUSIONS = Object.freeze([
  { category: "functions", key: "rls_auto_enable()", match: { name: "rls_auto_enable", args: "", kind: "f", security_definer: true, volatility: "v", config: ["search_path=pg_catalog"], def_md5: "6998ea6b4c2480f5d2e34b5dcf3f8d36" } },
  ...["anon", "authenticated", "PUBLIC", "service_role"].map((g) => ({ category: "function_grants", key: `rls_auto_enable() ${g} EXECUTE`, match: { fn: "rls_auto_enable()", grantee: g, privilege: "EXECUTE" } })),
  { category: "event_triggers", key: "ensure_rls", match: { name: "ensure_rls", event: "ddl_command_end", function: "rls_auto_enable", tags: ["CREATE TABLE", "CREATE TABLE AS", "SELECT INTO"], enabled: "O" } },
]);

// Platform extensions that a hosted Supabase project installs for itself;
// their presence on one side only is not application drift.
export const PLATFORM_EXTENSIONS = new Set(["plpgsql", "pg_graphql", "pg_stat_statements", "supabase_vault", "uuid-ossp", "pgjwt", "pgsodium", "pg_net"]);

// Key-order-independent serialization (drivers return jsonb keys in
// different orders).
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// Compare migrations-built (expected) with the target (observed). Returns
// { categories: { name: { missing, unexpected, changed } }, total }.
export function diffCatalogs(expected, observed) {
  const out = {};
  let total = 0;
  for (const [cat, k] of Object.entries(key)) {
    const a = new Map((expected[cat] ?? []).map((x) => [k(x), x]));
    const b = new Map((observed[cat] ?? []).map((x) => [k(x), x]));
    const missing = [...a.keys()].filter((x) => !b.has(x));
    const excluded = [];
    const unexpected = [...b.keys()].filter((x) => !a.has(x)).filter((x) => {
      const ex = PLATFORM_OBJECT_EXCLUSIONS.find((e) => e.category === cat && e.key === x);
      if (ex && stable(b.get(x)) === stable(ex.match)) { excluded.push(x); return false; }
      return true;
    });
    if (excluded.length) (out.__excluded ??= []).push(...excluded.map((x) => `${cat}: ${x}`));
    const changed = [...a.keys()].filter((x) => b.has(x) && stable(a.get(x)) !== stable(b.get(x)))
      .map((x) => ({ key: x, expected: a.get(x), observed: b.get(x) }));
    if (missing.length || unexpected.length || changed.length) {
      out[cat] = { missing, unexpected, changed };
      total += missing.length + unexpected.length + changed.length;
    }
  }
  const extExpected = new Set(expected.extensions ?? []);
  const extObserved = new Set(observed.extensions ?? []);
  const extMissing = [...extExpected].filter((x) => !extObserved.has(x) && !PLATFORM_EXTENSIONS.has(x));
  const extUnexpected = [...extObserved].filter((x) => !extExpected.has(x) && !PLATFORM_EXTENSIONS.has(x));
  if (extMissing.length || extUnexpected.length) {
    out.extensions = { missing: extMissing, unexpected: extUnexpected, changed: [] };
    total += extMissing.length + extUnexpected.length;
  }
  const excludedPlatformObjects = out.__excluded ?? [];
  delete out.__excluded;
  return { categories: out, total, excludedPlatformObjects };
}

export function summarizeCatalog(c) {
  return Object.fromEntries(Object.entries(key).map(([cat]) => [cat, (c[cat] ?? []).length]));
}
