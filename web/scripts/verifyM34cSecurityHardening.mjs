// M3.4c — SECURITY DEFINER hardening (migration 64) on a scratch cluster
// (scripts/lib/scratchPostgres.mjs; never dev or production; the development
// project is only read for the platform stand-in shape).
//
//   1. Build the 63-migration state, snapshot the catalog, apply migration
//      64 in the same database, snapshot again: the change set must be
//      EXACTLY the 15 search_path configs and the 17 removed EXECUTE grants
//      (nothing else changed, nothing added — no privilege broadening).
//   2. The privilege matrix for every flagged function, as the API roles.
//   3. Linter-equivalent counts (expected post-deployment Security Advisor:
//      16 invoker search_path, 4 anon + 6 authenticated SECURITY DEFINER).
//   4. Behaviour, each in a rolled-back transaction AS the API roles: the
//      auth.users profile trigger and the acute-release guard still fire for
//      a role without EXECUTE; the anonymous readiness read and RLS helper
//      chain work; own-user reconcile allowed, cross-user refused; the
//      revoked helpers are refused; create_rehab_session_if_allowed is
//      unchanged and still refuses an unscheduled day.
//   5. Fresh-state invariants after 64 migrations.
//
// Requires TENOTRAINER_PG_TOOLING (scripts/lib/scratchPostgres.mjs).
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyM34cSecurityHardening.mjs
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/m32Fixtures.mjs";
import { SCRATCH_DB, ScratchPostgres } from "./lib/scratchPostgres.mjs";
import { applyMigrations, installPlatformStandIn, migrationFiles, readPlatformShape } from "./lib/freshDatabase.mjs";
import { CATALOG_SQL, diffCatalogs, stable } from "./lib/schemaCatalog.mjs";

const env = loadEnv(".env.local");
assertDevTestTarget(env);
const M64 = "20261104000001_m34c_security_definer_hardening.sql";
const NIL = "00000000-0000-0000-0000-000000000000";
const SEARCH_PATH_15 = [
  "can_access_prescription_workout(p_workout_id uuid)",
  "clinician_can_access_exercise(p_clinician_id uuid, p_exercise_id uuid)",
  "copy_prescription_version_content_into_draft(p_version_id uuid, p_draft_id uuid)",
  "copy_template_content_into_draft(p_template_id uuid, p_draft_id uuid)",
  "create_prescription_draft(p_patient_id uuid, p_clinician_id uuid, p_source text, p_source_version_id uuid, p_template_id uuid)",
  "get_org_role(org_id uuid)",
  "handle_new_auth_user()",
  "has_org_role(org_id uuid, check_role org_role)",
  "is_org_clinician(org_id uuid)",
  "is_org_clinician_admin(org_id uuid)",
  "is_org_member(org_id uuid)",
  "is_org_super_user(org_id uuid)",
  "is_platform_super_user()",
  "reorder_prescription_exercises(p_workout_id uuid, p_clinician_id uuid, p_ordered_ids uuid[])",
  "reorder_prescription_workouts(p_draft_id uuid, p_clinician_id uuid, p_ordered_ids uuid[])",
];
const REVOKED = {
  "handle_new_auth_user()": ["PUBLIC", "anon", "authenticated", "service_role"],
  "trg_acute_safety_releases_guard()": ["PUBLIC", "anon", "authenticated", "service_role"],
  "get_org_role(org_id uuid)": ["PUBLIC", "anon", "authenticated"],
  "has_org_role(org_id uuid, check_role org_role)": ["PUBLIC", "anon", "authenticated"],
  "is_org_clinician_admin(org_id uuid)": ["PUBLIC", "anon", "authenticated"],
};
// Expected EXECUTE after migration 64 (PUBLIC, anon, authenticated, service_role).
const MATRIX = {
  "handle_new_auth_user()": [false, false, false, false],
  "trg_acute_safety_releases_guard()": [false, false, false, false],
  "get_org_role(org_id uuid)": [false, false, false, true],
  "has_org_role(org_id uuid, check_role org_role)": [false, false, false, true],
  "is_org_clinician_admin(org_id uuid)": [false, false, false, true],
  "is_org_clinician(org_id uuid)": [true, true, true, true],
  "can_access_prescription_workout(p_workout_id uuid)": [true, true, true, true],
  "is_org_member(org_id uuid)": [true, true, true, true],
  "is_org_super_user(org_id uuid)": [true, true, true, true],
  "is_platform_super_user()": [false, false, true, true],
  "reconcile_missing_acute_episodes(p_user_id uuid)": [false, false, true, true],
};
const EXPECTED_ANON_DEFINER = ["can_access_prescription_workout", "is_org_clinician", "is_org_member", "is_org_super_user"];
const EXPECTED_AUTH_DEFINER = [...EXPECTED_ANON_DEFINER, "is_platform_super_user", "reconcile_missing_acute_episodes"].sort();

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 600)}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);

const PRIV_SQL = `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
  EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_x,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x, p.prosecdef AS secdef, p.proconfig AS config
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`;

// Runs `body` in a transaction that is always rolled back; returns its
// result, or { error } with the database error message.
async function inTx(db, body) {
  await db.query("BEGIN");
  try {
    return await body();
  } catch (e) {
    return { error: e.message };
  } finally {
    await db.query("ROLLBACK");
  }
}
const asRole = async (db, role, claims) => {
  await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
  await db.query(`SET LOCAL ROLE ${role}`);
};

const sp = new ScratchPostgres();
try {
  const files = migrationFiles();
  section("migrations");
  // Later migrations (M3.4f onward) are not applied here: this suite proves
  // migration 64's own change set on the 63-migration state.
  check("migration 64 (filename order) is the M3.4c hardening migration", files.indexOf(M64) === 63, `${files.indexOf(M64)} ${files.length}`);
  const db = await sp.start();
  const standIn = await installPlatformStandIn(db, readPlatformShape(env), SCRATCH_DB);
  const ver = (await db.query("SHOW server_version")).rows[0].server_version;
  console.log(`      scratch PostgreSQL ${ver}; stand-in: ${standIn.columns} auth.users columns (test infrastructure, not platform evidence)`);
  const r63 = await applyMigrations(db, files.slice(0, 63));
  check("the first 63 migrations apply in filename order", !r63.failed && r63.applied === 63, JSON.stringify(r63.failed));
  const cat63 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const priv63 = new Map((await db.query(PRIV_SQL)).rows.map((r) => [r.fn, r]));
  const r64 = await applyMigrations(db, [M64]);
  check("migration 64 applies on top", !r64.failed && r64.applied === 1, JSON.stringify(r64.failed));
  const cat64 = (await db.query(CATALOG_SQL)).rows[0].catalog;
  const priv64 = new Map((await db.query(PRIV_SQL)).rows.map((r) => [r.fn, r]));

  section("1. exact change set of migration 64");
  const d = diffCatalogs(cat63, cat64);
  const cats = Object.keys(d.categories).sort();
  check("only functions and function_grants change", stable(cats) === stable(["function_grants", "functions"]), cats.join(","));
  const fnChanged = (d.categories.functions?.changed ?? []).map((c) => c.key).sort();
  check("exactly the 15 SECURITY DEFINER functions change (config + rendered definition)", stable(fnChanged) === stable([...SEARCH_PATH_15].sort()), fnChanged.join("; "));
  const onlyConfig = (d.categories.functions?.changed ?? []).every((c) => {
    const { config: c1, def_md5: m1, ...a } = c.expected;
    const { config: c2, def_md5: m2, ...b } = c.observed;
    return stable(a) === stable(b) && c1 === null && stable(c2) === stable(["search_path=public"]);
  });
  check("…each gains only search_path=public (was unset); kind, volatility, security unchanged", onlyConfig);
  const srcCheck = await db.query(`SELECT count(*) AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1)`, [SEARCH_PATH_15.map((f) => f.slice(0, f.indexOf("(")))]);
  check("…the 15 still exist (no function dropped or recreated)", Number(srcCheck.rows[0].n) === 15);
  const missing = (d.categories.function_grants?.missing ?? []).sort();
  const expectedMissing = Object.entries(REVOKED).flatMap(([fn, roles]) => roles.map((r) => `${fn} ${r} EXECUTE`)).sort();
  check("exactly the 17 intended EXECUTE grants are removed", stable(missing) === stable(expectedMissing), `missing=${missing.join("; ")}`);
  check("no grant is added anywhere (no privilege broadening)", (d.categories.function_grants?.unexpected ?? []).length === 0 && (d.categories.functions?.unexpected ?? []).length === 0, JSON.stringify(d.categories.function_grants?.unexpected));
  const otherConfigChanges = [...priv64.keys()].filter((fn) => !SEARCH_PATH_15.includes(fn) && stable(priv63.get(fn)?.config) !== stable(priv64.get(fn)?.config));
  check("no other function's configuration changed", otherConfigChanges.length === 0, otherConfigChanges.join(","));

  section("2. privilege matrix (PUBLIC, anon, authenticated, service_role)");
  for (const [fn, want] of Object.entries(MATRIX)) {
    const p = priv64.get(fn);
    const got = p ? [p.public_x, p.anon_x, p.auth_x, p.svc_x] : null;
    check(`${fn}: ${want.map((x) => (x ? "X" : "-")).join("")}`, stable(got) === stable(want), stable(got));
  }

  section("3. linter-equivalent findings after migration 64");
  const rows = [...priv64.values()];
  const mutable = rows.filter((r) => !(r.config ?? []).some((c) => c.startsWith("search_path=")));
  check("16 functions without a fixed search_path, all SECURITY INVOKER (create_rehab_session_if_allowed among them, unaltered)",
    mutable.length === 16 && mutable.every((r) => !r.secdef) && mutable.some((r) => r.fn.startsWith("create_rehab_session_if_allowed(")), `${mutable.length}: ${mutable.filter((r) => r.secdef).map((r) => r.fn).join(",")}`);
  const anonDef = rows.filter((r) => r.secdef && r.anon_x).map((r) => r.fn.slice(0, r.fn.indexOf("("))).sort();
  const authDef = rows.filter((r) => r.secdef && r.auth_x).map((r) => r.fn.slice(0, r.fn.indexOf("("))).sort();
  check("anon-executable SECURITY DEFINER: exactly the 4 intentional RLS helpers", stable(anonDef) === stable(EXPECTED_ANON_DEFINER), anonDef.join(","));
  check("authenticated-executable SECURITY DEFINER: exactly the 6 intentional functions", stable(authDef) === stable(EXPECTED_AUTH_DEFINER), authDef.join(","));
  const trgmPublic = (await db.query(`SELECT extnamespace::regnamespace::text AS s FROM pg_extension WHERE extname = 'pg_trgm'`)).rows[0]?.s;
  check("pg_trgm still in public (accepted warning)", trgmPublic === "public");
  console.log(`      expected Security Advisor after deployment: ${mutable.length} + 1 + ${anonDef.length} + ${authDef.length} = ${mutable.length + 1 + anonDef.length + authDef.length} warnings, 0 errors`);

  section("4. behaviour (each in a rolled-back transaction, as the API roles)");
  const uid = "11111111-2222-4333-8444-555555555555";
  const other = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  // A. Profile trigger fires for a role WITHOUT EXECUTE on handle_new_auth_user.
  const a = await inTx(db, async () => {
    await db.query("GRANT INSERT ON auth.users TO service_role"); // scratch stand-in only (real Supabase: supabase_auth_admin)
    await db.query("SET LOCAL ROLE service_role");
    await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, 'trigger-proof@example.invalid', '{"name":"Trigger Proof"}')`, [uid]);
    await db.query("RESET ROLE");
    return (await db.query(`SELECT name FROM public.profiles WHERE id = $1`, [uid])).rows[0];
  });
  check("A. auth.users insert by a role without EXECUTE still creates the profile (trigger)", a?.name === "Trigger Proof", JSON.stringify(a));
  const aDirect = await inTx(db, async () => { await asRole(db, "authenticated", { role: "authenticated", sub: uid }); await db.query("SELECT public.handle_new_auth_user()"); return {}; });
  check("A. calling handle_new_auth_user() directly is refused", /permission denied|trigger functions can only be called as triggers/i.test(aDirect.error ?? ""), aDirect.error);
  // B. Release guard fires for a role without EXECUTE on the guard.
  const b = await inTx(db, async () => {
    await db.query("SET LOCAL ROLE service_role");
    await db.query(`INSERT INTO public.acute_safety_releases (acute_safety_episode_id, user_id, release_path) VALUES ($1, $2, 'self_resolved_no_evaluation')`, [NIL, uid]);
    return {};
  });
  check("B. an invalid acute_safety_releases insert is still refused by the guard (ACUTE_RELEASE_EPISODE_NOT_FOUND)", /ACUTE_RELEASE_EPISODE_NOT_FOUND/.test(b.error ?? ""), b.error);
  // C. Anonymous readiness read and the RLS helper chain.
  const c = await inTx(db, async () => {
    await asRole(db, "anon", { role: "anon" });
    const probe = (await db.query(`SELECT id FROM public.canonical_exercises WHERE id = $1`, [NIL])).rows.length;
    const visible = Number((await db.query(`SELECT count(*) AS n FROM public.canonical_exercises`)).rows[0].n);
    const pe = Number((await db.query(`SELECT count(*) AS n FROM public.prescription_exercises`)).rows[0].n);
    const orgs = Number((await db.query(`SELECT count(*) AS n FROM public.organizations`)).rows[0].n);
    return { probe, visible, pe, orgs };
  });
  check("C. anonymous readiness-equivalent read succeeds (0 rows, no function-permission error)", c && !c.error && c.probe === 0, JSON.stringify(c));
  check("C. anon RLS evaluation through the helper chain works (47 global exercises; prescription and organization reads return 0, not an error)", c && !c.error && c.visible === 47 && c.pe === 0 && c.orgs === 0, JSON.stringify(c));
  const cAuth = await inTx(db, async () => {
    await asRole(db, "authenticated", { role: "authenticated", sub: uid });
    return (await db.query(`SELECT public.is_org_member($1) AS m, public.is_org_clinician($1) AS c, public.is_platform_super_user() AS s, public.can_access_prescription_workout($1) AS w`, [NIL])).rows[0];
  });
  check("C. authenticated can still execute the intentional helpers (all false for a non-member)", cAuth && !cAuth.error && cAuth.m === false && cAuth.c === false && cAuth.s === false && cAuth.w === false, JSON.stringify(cAuth));
  // D. Reconcile authorization.
  const dOwn = await inTx(db, async () => {
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'reconcile-proof@example.invalid')`, [uid]);
    await asRole(db, "authenticated", { role: "authenticated", sub: uid });
    return { rows: (await db.query(`SELECT * FROM public.reconcile_missing_acute_episodes($1)`, [uid])).rows.length };
  });
  check("D. authenticated own-user reconcile is permitted", dOwn && !dOwn.error && dOwn.rows === 0, JSON.stringify(dOwn));
  const dOther = await inTx(db, async () => {
    await asRole(db, "authenticated", { role: "authenticated", sub: uid });
    await db.query(`SELECT * FROM public.reconcile_missing_acute_episodes($1)`, [other]);
    return {};
  });
  check("D. cross-user reconcile is refused (UNAUTHENTICATED)", /UNAUTHENTICATED/.test(dOther.error ?? ""), dOther.error);
  // Revoked helpers.
  for (const [role, sql] of [["anon", "SELECT public.get_org_role($1)"], ["authenticated", "SELECT public.has_org_role($1, 'member')"], ["authenticated", "SELECT public.is_org_clinician_admin($1)"], ["anon", "SELECT public.is_org_clinician_admin($1)"]]) {
    const r = await inTx(db, async () => { await asRole(db, role, { role, sub: uid }); await db.query(sql, [NIL]); return {}; });
    check(`revoked: ${role} → ${sql.match(/public\.(\w+)/)[1]} refused (permission denied)`, /permission denied/i.test(r.error ?? ""), r.error);
  }
  const svc = await inTx(db, async () => { await asRole(db, "service_role", { role: "service_role" }); return (await db.query("SELECT public.get_org_role($1) AS r, public.has_org_role($1, 'member') AS h, public.is_org_clinician_admin($1) AS a", [NIL])).rows[0]; });
  check("service_role still executes get_org_role / has_org_role / is_org_clinician_admin", svc && !svc.error && svc.h === false && svc.a === false, JSON.stringify(svc));
  // E. create_rehab_session_if_allowed unchanged; schedule gate.
  const fn = (await db.query(`SELECT md5(pg_get_functiondef(p.oid)) AS def, p.proacl::text AS acl, p.prosecdef AS secdef, p.proconfig AS config FROM pg_proc p WHERE p.proname = 'create_rehab_session_if_allowed' AND p.pronamespace = 'public'::regnamespace`)).rows[0];
  check("E. create_rehab_session_if_allowed unchanged (definition 63dc9e76…, invoker, no config, EXECUTE postgres + service_role)",
    fn.def === "63dc9e766bc4b8f6aea9eaf148899130" && fn.secdef === false && fn.config === null && fn.acl === "{postgres=X/postgres,service_role=X/postgres}", JSON.stringify(fn));
  const e = await inTx(db, async () => {
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'gate-proof@example.invalid')`, [uid]);
    const pp = (await db.query(`INSERT INTO public.patient_prescriptions (patient_id) VALUES ($1) RETURNING id`, [uid])).rows[0].id;
    await db.query(`INSERT INTO public.prescription_versions (user_id, source, patient_prescription_id, version_number, published_at, published_by, scheduling_mode, target_sessions_per_week, rehab_days_of_week)
      VALUES ($1, 'clinician_change', $2, 1, now(), $1, 'sequence', 3, ARRAY[3,5]::smallint[])`, [uid, pp]);
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.query(`SELECT public.create_rehab_session_if_allowed(gen_random_uuid(), 'plan', 'inst-1', '2026-11-02'::date, now(), '{}'::jsonb)`); // a Monday (DOW 1)
    return {};
  });
  check("E. an unscheduled day is still refused with REHAB_NOT_SCHEDULED_TODAY", /REHAB_NOT_SCHEDULED_TODAY/.test(e.error ?? ""), e.error);

  section("5. fresh-state invariants after 64 migrations");
  const st = (await db.query(`SELECT
    (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p')) AS tables,
    (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') AND NOT relrowsecurity) AS no_rls,
    (SELECT count(*) FROM public.canonical_exercises) AS ce, (SELECT count(*) FROM public.exercise_reference_dosage) AS erd,
    (SELECT count(*) FROM public.m6_heuristics) AS h, (SELECT count(*) FROM public.safety_notification_heartbeats) AS hb,
    (SELECT count(*) FROM auth.users) AS users, (SELECT count(*) FROM public.organizations) AS orgs, (SELECT count(*) FROM public.profiles) AS profiles,
    (SELECT jsonb_agg(jsonb_build_object('n', jobname, 's', schedule, 'c', command)) FROM cron.job) AS cron`)).rows[0];
  check("76 tables, RLS on all; reference 47/46/16 + 2 heartbeats; no users/organizations/profiles", Number(st.tables) === 76 && Number(st.no_rls) === 0 && Number(st.ce) === 47 && Number(st.erd) === 46 && Number(st.h) === 16 && Number(st.hb) === 2 && Number(st.users) === 0 && Number(st.orgs) === 0 && Number(st.profiles) === 0, JSON.stringify(st));
  check("cron unchanged: the single SQL sweep", stable(st.cron) === stable([{ n: "tenotrainer_m32_safety_notification_sweep", s: "* * * * *", c: "SELECT public.safety_notifications_sweep()" }]), JSON.stringify(st.cron));
} catch (e) {
  check("suite completed", false, e.stack ?? e.message);
} finally {
  await sp.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
