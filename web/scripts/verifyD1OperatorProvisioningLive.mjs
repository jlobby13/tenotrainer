// D1 — operator provisioning against the REAL development Supabase project
// (development intent, a per-run claim namespace, synthetic
// @example.invalid accounts; never production, never email — Auth
// admin.createUser with email_confirm sends nothing). Proves on Postgres:
// dry-run purity, apply, idempotent rerun, conflict refusals, partial
// failure + deterministic recovery, and DATABASE-LEVEL concurrency (two
// writers released together at the same insert; primary-key claims decide).
// Every fixture is purged by exact id with a zero-residue check.
//
//   TENOTRAINER_MODE=development node scripts/verifyD1OperatorProvisioningLive.mjs
import { register } from "node:module";
register("./lib/tsServerModuleHooks.mjs", import.meta.url);

const { createClient } = await import("@supabase/supabase-js");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { randomUUID } = await import("node:crypto");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { assertDevTestTarget } = await import("./lib/devProjectGuard.mjs");
const { FixtureRun, guardedSql, loadEnv, q } = await import("./lib/m32Fixtures.mjs");
const core = await import("./lib/operatorProvisioning.mjs");

const env = loadEnv(".env.local");
const REF = assertDevTestTarget(env); // TENOTRAINER_MODE=development + registered dev project, or refuse
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const RUN = randomUUID().slice(0, 8);
const TAG = `d1-${RUN}`;
const run = new FixtureRun(env, admin, TAG);
const tmp = mkdtempSync(join(tmpdir(), "d1-live-"));
const childEnv = { PATH: process.env.PATH, SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY };
const SECRETS = [env.SUPABASE_SERVICE_ROLE_KEY];
const outputs = [];

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`); }
};
const email = (label) => `${TAG}-${label}@example.invalid`;
const pw = () => `D1-live-${randomUUID()}`;

function writePlan(ns, { slug = `${TAG}-org-${ns}`, superUser = "founder", clinicians = [] } = {}) {
  const p = join(tmp, `plan-${randomUUID()}.json`);
  writeFileSync(p, JSON.stringify({
    target: { intent: "development", projectRef: REF, developmentNamespace: `${TAG}-${ns}` },
    organization: { name: `D1 Live ${ns}`, slug },
    superUser: { email: email(superUser), name: `D1 ${superUser}` },
    clinicians: clinicians.map(([label, role]) => ({ email: email(label), name: `D1 ${label}`, role })),
  }));
  return p;
}
function writePasswords(map) {
  const p = join(tmp, `pw-${randomUUID()}.json`);
  writeFileSync(p, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
  SECRETS.push(...map.values());
  return p;
}
const xf = promisify(execFile);
async function cli(args) {
  let code = 0;
  let out = "";
  try {
    const r = await xf(process.execPath, ["scripts/provisionStaff.mjs", ...args, "--json"], { env: childEnv, encoding: "utf8", timeout: 180000 });
    out = r.stdout + r.stderr;
  } catch (e) {
    code = e.code ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  outputs.push(out);
  const line = out.split("\n").find((l) => l.startsWith("{"));
  return { code, out, report: line ? JSON.parse(line) : null };
}
const targetFor = (ns) => ({
  organizationId: core.claimId(`${REF}:development:${TAG}-${ns}`, "initial-organization"),
  superUserMembershipId: core.claimId(`${REF}:development:${TAG}-${ns}`, "initial-super-user-membership"),
});
const NAMESPACES = ["a", "c", "s"];
const fingerprint = () => guardedSql(env, `SELECT
  (SELECT count(*) FROM auth.users WHERE email LIKE '${TAG}-%') AS users,
  (SELECT count(*) FROM organizations WHERE id IN (${NAMESPACES.map((n) => q(targetFor(n).organizationId)).join(", ")}) OR slug LIKE '${TAG}-%') AS orgs,
  (SELECT count(*) FROM organization_members m JOIN auth.users u ON u.id = m.user_id WHERE u.email LIKE '${TAG}-%') AS memberships`)[0];
async function membershipsOf(addr) {
  const rows = guardedSql(env, `SELECT m.id, m.organization_id, m.role FROM organization_members m JOIN auth.users u ON u.id = m.user_id WHERE u.email = '${addr}'`);
  return rows;
}
const userRow = (addr) => guardedSql(env, `SELECT u.id, u.email_confirmed_at IS NOT NULL AS confirmed, u.raw_app_meta_data -> 'tenotrainer_operator' AS marker, p.name AS profile_name
  FROM auth.users u LEFT JOIN profiles p ON p.id = u.id WHERE u.email = '${addr}'`)[0] ?? null;

let teardownOk = false;
try {
  // ------------------------------------------------------------- A. dry run
  console.log("--- dry run and identity ---");
  const pwA = new Map([[email("founder"), pw()], [email("clin1"), pw()]]);
  const planA = writePlan("a", { clinicians: [["clin1", "clinician"]] });
  const pwFileA = writePasswords(pwA);
  const before = fingerprint();
  const dry = await cli(["--plan", planA, "--target-ref", REF, "--passwords-file", pwFileA]);
  const afterDry = fingerprint();
  check("dry run: would apply, exit 0", dry.code === 0 && dry.report?.outcome === "would_apply" && dry.report?.writes === 0, dry.out);
  check("dry run: zero mutations (users, organizations, memberships)", JSON.stringify(before) === JSON.stringify(afterDry) && Number(afterDry.users) === 0 && Number(afterDry.orgs) === 0, JSON.stringify(afterDry));

  // ------------------------------------------------------------- B. production intent at the dev project
  const prodPlan = join(tmp, "prod-plan.json");
  writeFileSync(prodPlan, JSON.stringify({ target: { intent: "production", projectRef: REF }, organization: { name: "D1 Prod", slug: `${TAG}-prod` }, superUser: { email: email("prodfounder"), name: "Prod Founder" } }));
  const prod = await cli(["--plan", prodPlan, "--target-ref", REF, "--apply"]);
  check("production intent against the registered development project refused (exit 2)", prod.code === 2 && /registered DEVELOPMENT/.test(prod.out), prod.out);
  const wrongRef = await cli(["--plan", planA, "--target-ref", "abcdefghijklmnopqrst", "--apply"]);
  check("mismatched --target-ref refused (exit 2)", wrongRef.code === 2 && /does not match/.test(wrongRef.out), wrongRef.out);
  check("refusals wrote nothing", JSON.stringify(fingerprint()) === JSON.stringify(before));

  // ------------------------------------------------------------- C. apply
  console.log("\n--- apply and verify ---");
  const applied = await cli(["--plan", planA, "--target-ref", REF, "--passwords-file", pwFileA, "--apply"]);
  check("apply: organization, super user and clinician created (exit 0, 5 writes)", applied.code === 0 && applied.report?.outcome === "applied" && applied.report?.writes === 5, applied.out);
  const tA = targetFor("a");
  const orgA = guardedSql(env, `SELECT id, name, slug FROM organizations WHERE id = ${q(tA.organizationId)}`)[0];
  check("organization exists at its claim id with the plan's identity", orgA?.slug === `${TAG}-org-a` && orgA?.name === "D1 Live a");
  const founder = userRow(email("founder"));
  const founderM = await membershipsOf(email("founder"));
  check("super user: confirmed account, profile named, marker set", founder?.confirmed === true && founder?.profile_name === "D1 founder" && founder?.marker?.organization_id === tA.organizationId && founder?.marker?.role === "super_user", JSON.stringify(founder));
  check("super user: exactly one membership — the claim membership, role super_user", founderM.length === 1 && founderM[0].id === tA.superUserMembershipId && founderM[0].role === "super_user", JSON.stringify(founderM));
  const clin1M = await membershipsOf(email("clin1"));
  check("clinician: exactly one membership, role clinician, same organization", clin1M.length === 1 && clin1M[0].role === "clinician" && clin1M[0].organization_id === tA.organizationId);
  const signIn = await createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }).auth.signInWithPassword({ email: email("founder"), password: pwA.get(email("founder")) });
  check("the operator-supplied password works (account usable)", !signIn.error && !!signIn.data.session);

  // ------------------------------------------------------------- D. idempotent rerun
  const fpApplied = fingerprint();
  const rerun = await cli(["--plan", planA, "--target-ref", REF, "--apply"]);
  check("rerun: no change, zero writes, no password needed", rerun.code === 0 && rerun.report?.outcome === "no_change" && rerun.report?.writes === 0 && JSON.stringify(fingerprint()) === JSON.stringify(fpApplied), rerun.out);

  // ------------------------------------------------------------- E-H. conflicts
  console.log("\n--- conflicts ---");
  const conflictOrg = await cli(["--plan", writePlan("a", { slug: `${TAG}-other-slug`, clinicians: [["clin1", "clinician"]] }), "--target-ref", REF, "--apply"]);
  check("conflicting initial organization (different slug) refused", conflictOrg.code === 2 && /different name or slug/.test(conflictOrg.out) && JSON.stringify(fingerprint()) === JSON.stringify(fpApplied), conflictOrg.out);
  const unrelated = await run.user("unrelated");
  const unrelatedPlan = join(tmp, "unrelated.json");
  writeFileSync(unrelatedPlan, JSON.stringify({ target: { intent: "development", projectRef: REF, developmentNamespace: `${TAG}-a` }, organization: { name: "D1 Live a", slug: `${TAG}-org-a` }, superUser: { email: email("founder"), name: "D1 founder" }, clinicians: [{ email: unrelated.email, name: "Unrelated", role: "clinician" }] }));
  const unrel = await cli(["--plan", unrelatedPlan, "--target-ref", REF, "--apply"]);
  const unrelM = guardedSql(env, `SELECT count(*) AS n FROM organization_members WHERE user_id = ${q(unrelated.id)}`)[0];
  check("existing account not created by this workflow refused, never adopted", unrel.code === 2 && /not created by this workflow/.test(unrel.out) && Number(unrelM.n) === 0, unrel.out);
  const elsewhere = await run.user("elsewhere");
  run.setup({ orgName: `D1 other org ${RUN}`, members: [["fixture", elsewhere.id, "clinician"]], assignments: [], names: {} });
  const elsewherePlan = join(tmp, "elsewhere.json");
  writeFileSync(elsewherePlan, JSON.stringify({ target: { intent: "development", projectRef: REF, developmentNamespace: `${TAG}-a` }, organization: { name: "D1 Live a", slug: `${TAG}-org-a` }, superUser: { email: email("founder"), name: "D1 founder" }, clinicians: [{ email: elsewhere.email, name: "Elsewhere", role: "clinician" }] }));
  const els = await cli(["--plan", elsewherePlan, "--target-ref", REF, "--apply"]);
  check("account belonging to another organization refused", els.code === 2 && /another organization/.test(els.out), els.out);
  const roleChange = await cli(["--plan", writePlan("a", { clinicians: [["clin1", "clinician_admin"]] }), "--target-ref", REF, "--apply"]);
  const clin1After = await membershipsOf(email("clin1"));
  check("role change refused; membership unchanged", roleChange.code === 2 && /never changed silently/.test(roleChange.out) && clin1After.length === 1 && clin1After[0].role === "clinician", roleChange.out);
  const rivalSu = await cli(["--plan", writePlan("a", { superUser: "rival" }), "--target-ref", REF, "--passwords-file", writePasswords(new Map([[email("rival"), pw()]])), "--apply"]);
  check("a second initial super user for the same organization refused before any write", rivalSu.code === 2 && /different account/.test(rivalSu.out) && userRow(email("rival")) === null, rivalSu.out);

  // ------------------------------------------------------------- I. partial failure and recovery
  console.log("\n--- partial failure and recovery ---");
  const pwClin2 = new Map([[email("clin2"), pw()]]);
  SECRETS.push(...pwClin2.values());
  const planPartial = core.validatePlan(JSON.parse(JSON.stringify({
    target: { intent: "development", projectRef: REF, developmentNamespace: `${TAG}-a` }, organization: { name: "D1 Live a", slug: `${TAG}-org-a` },
    superUser: { email: email("founder"), name: "D1 founder" }, clinicians: [{ email: email("clin1"), name: "D1 clin1", role: "clinician" }, { email: email("clin2"), name: "D1 clin2", role: "clinician_admin" }],
  })));
  const target = core.resolveTarget({ plan: planPartial, targetRefArg: REF, env });
  const crashing = { ...core.supabaseStore(admin), async insertMembership() { throw new Error("simulated operator crash before the membership write"); } };
  const partial = await core.provision({ plan: planPartial, target, store: crashing, passwords: pwClin2, apply: true });
  const clin2 = userRow(email("clin2"));
  const clin2M = await membershipsOf(email("clin2"));
  check("crash after account creation: reported partial (exit-3 class), account has no membership", partial.outcome === "partial_failed" && clin2?.marker?.role === "clinician_admin" && clin2M.length === 0, JSON.stringify(partial));
  const planPartialFile = writePlan("a", { clinicians: [["clin1", "clinician"], ["clin2", "clinician_admin"]] });
  const recoverDry = await cli(["--plan", planPartialFile, "--target-ref", REF]);
  const clin2Step = recoverDry.report?.steps?.find((s) => s.email === email("clin2"));
  check("dry run of the partial state: membership 'recover', no password needed", clinStepOk(clin2Step), JSON.stringify(clin2Step));
  const recovered = await cli(["--plan", planPartialFile, "--target-ref", REF, "--apply"]);
  const clin2After = await membershipsOf(email("clin2"));
  check("rerun recovers deterministically (one membership, intended role)", recovered.code === 0 && recovered.report?.outcome === "applied" && recovered.report?.writes === 1 && clin2After.length === 1 && clin2After[0].role === "clinician_admin", recovered.out);

  // ------------------------------------------------------------- J. DB-level concurrency: rival super users
  console.log("\n--- database-level concurrency ---");
  const mkBarrier = () => {
    let release;
    let n = 0;
    const gate = new Promise((r) => (release = r));
    return async () => { n++; if (n >= 2) release(); await Promise.race([gate, new Promise((r) => setTimeout(r, 30000))]); };
  };
  const orgGate = mkBarrier();
  const memberGate = mkBarrier();
  const racing = () => {
    const s = core.supabaseStore(admin);
    return { ...s, insertOrganization: async (row) => { await orgGate(); return s.insertOrganization(row); }, insertMembership: async (row) => { if (row.role === "super_user") await memberGate(); return s.insertMembership(row); } };
  };
  const rivalPlan = (who) => core.validatePlan({ target: { intent: "development", projectRef: REF, developmentNamespace: `${TAG}-c` }, organization: { name: "D1 Live c", slug: `${TAG}-org-c` }, superUser: { email: email(who), name: `D1 ${who}` } });
  const pwRace = new Map([[email("racea"), pw()], [email("raceb"), pw()]]);
  SECRETS.push(...pwRace.values());
  const pA = rivalPlan("racea");
  const pB = rivalPlan("raceb");
  const [ra, rb] = await Promise.all([
    core.provision({ plan: pA, target: core.resolveTarget({ plan: pA, targetRefArg: REF, env }), store: racing(), passwords: pwRace, apply: true }),
    core.provision({ plan: pB, target: core.resolveTarget({ plan: pB, targetRefArg: REF, env }), store: racing(), passwords: pwRace, apply: true }),
  ]);
  const tC = targetFor("c");
  const cState = guardedSql(env, `SELECT
    (SELECT count(*) FROM organizations WHERE id = ${q(tC.organizationId)} OR slug = '${TAG}-org-c') AS orgs,
    (SELECT count(*) FROM organization_members WHERE organization_id = ${q(tC.organizationId)} AND role = 'super_user') AS supers,
    (SELECT count(*) FROM organization_members WHERE id = ${q(tC.superUserMembershipId)}) AS claim`)[0];
  const loser = ra.outcome === "applied" ? "raceb" : "racea";
  const loserM = await membershipsOf(email(loser));
  check("both writers reached the organization insert together; exactly one organization row", Number(cState.orgs) === 1, JSON.stringify(cState));
  check("rival super users released together: exactly one super user (the claim row)", Number(cState.supers) === 1 && Number(cState.claim) === 1, JSON.stringify(cState));
  check("the other writer stopped (partial_refused) and its account holds no membership", [ra.outcome, rb.outcome].sort().join(",") === "applied,partial_refused" && loserM.length === 0, `${ra.outcome}/${rb.outcome} ${ra.reason ?? ""}${rb.reason ?? ""}`);

  // ------------------------------------------------------------- K. same plan, two processes at once
  const pwS = new Map([[email("samefounder"), pw()], [email("sameclin"), pw()]]);
  const planS = writePlan("s", { superUser: "samefounder", clinicians: [["sameclin", "clinician"]] });
  const pwFileS = writePasswords(pwS);
  const [s1, s2] = await Promise.all([
    cli(["--plan", planS, "--target-ref", REF, "--passwords-file", pwFileS, "--apply"]),
    cli(["--plan", planS, "--target-ref", REF, "--passwords-file", pwFileS, "--apply"]),
  ]);
  const tS = targetFor("s");
  const sState = guardedSql(env, `SELECT
    (SELECT count(*) FROM organizations WHERE id = ${q(tS.organizationId)} OR slug = '${TAG}-org-s') AS orgs,
    (SELECT count(*) FROM organization_members WHERE organization_id = ${q(tS.organizationId)}) AS members,
    (SELECT count(*) FROM organization_members WHERE organization_id = ${q(tS.organizationId)} AND role = 'super_user') AS supers,
    (SELECT count(*) FROM auth.users WHERE email IN ('${email("samefounder")}', '${email("sameclin")}')) AS users`)[0];
  check("same plan in two concurrent processes: both succeed (exit 0)", s1.code === 0 && s2.code === 0, `${s1.out}\n${s2.out}`);
  check("…with no duplicates (1 org, 1 super user, 2 accounts, 2 memberships)", Number(sState.orgs) === 1 && Number(sState.supers) === 1 && Number(sState.users) === 2 && Number(sState.members) === 2, JSON.stringify(sState));

  // ------------------------------------------------------------- L. secrets
  console.log("\n--- output hygiene ---");
  const all = outputs.join("\n");
  check("no service credential or password appears in any CLI output", SECRETS.every((s) => !all.includes(s)));
} finally {
  // ------------------------------------------------------------- teardown (exact ids)
  console.log("\n--- teardown ---");
  try {
    const ids = guardedSql(env, `SELECT id FROM auth.users WHERE email LIKE '${TAG}-%'`).map((r) => r.id);
    run.users.push(...ids);
    run.organizations.push(...NAMESPACES.map((n) => targetFor(n).organizationId));
    const res = run.teardown();
    const residue = fingerprint();
    teardownOk = Number(residue.users) === 0 && Number(residue.orgs) === 0 && Number(residue.memberships) === 0;
    check(`fixtures purged by exact id (${run.users.length} users, ${run.organizations.length} orgs), zero residue`, teardownOk, JSON.stringify({ res: res.residue, residue }));
    const l5 = guardedSql(env, `SELECT status || '/' || attempt_count || '/' || coalesce(provider_message_id, '-') AS l5, (SELECT count(*) FROM safety_email_attempts) AS attempts FROM safety_email_outbox WHERE id = 'f73aeb4d-6517-481b-ac6e-cc73fa0afc67'`)[0];
    check("preserved L5 state unchanged (suppressed_episode_released/0/-, 0 attempts)", l5?.l5 === "suppressed_episode_released/0/-" && Number(l5?.attempts) === 0, JSON.stringify(l5));
  } catch (e) {
    check("teardown", false, e.message);
  }
  rmSync(tmp, { recursive: true, force: true });
}

function clinStepOk(step) {
  return step?.account === "exists" && step?.membership === "recover" && step?.password === "not needed";
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
