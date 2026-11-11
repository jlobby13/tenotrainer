// Alpha 1 — end-to-end check of the operator account-deletion CLI against the
// DEVELOPMENT project, with synthetic @example.invalid fixtures created by this
// run only (a patient who accepted a real invitation with the Participation
// Agreement, and a clinician). The CLI deletes the patient; the clinician and
// the fixture organization are removed by the guarded development purge.
// A second patient with REAL protected safety history (built through the real
// C5 RPCs, committed) signs in, is CLOSED by the CLI, and its old tokens are
// replayed; its re-check / re-close is exercised. Its synthetic address is
// restored only so the guarded development purge (which accepts only
// @example.invalid fixtures of this run) can remove it.
// (The full clinical / safety graph is also proven, rolled back, by
// scripts/verifyOperatorDeleteAccount.sql.)
//
// Run from web/:  TENOTRAINER_MODE=development node scripts/verifyOperatorDeleteAccountCli.mjs
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertDevTestTarget } from "./lib/devProjectGuard.mjs";
import { loadEnv } from "./lib/harnessEnv.mjs";
import { guardedFixtureTeardown } from "./lib/safetyFixturePurge.mjs";

const RUN_STARTED_AT = new Date(Date.now() - 60_000).toISOString();
const env = loadEnv(".env.local");
const DEV_REF = assertDevTestTarget(env);
const registry = JSON.parse(readFileSync("config/resourceIdentity.json", "utf8"));
const PROD_REF = registry.productionSupabaseProjects[0];
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const AUDIT_DIR = mkdtempSync(join(tmpdir(), "oda-audit-"));
const TOKEN = (process.env.SUPABASE_ACCESS_TOKEN ?? readFileSync(join(homedir(), ".supabase", "access-token"), "utf8")).trim();
const RUN = randomUUID().slice(0, 8);
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const AGREEMENT_SHA = readFileSync("lib/__tests__/alpha1Agreement.test.ts", "utf8").match(/PINNED_SHA256 = "([0-9a-f]{64})"/)[1];

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  [${String(detail).slice(0, 400)}]` : ""}`);
};
const outputs = [];
function cli(args) {
  try {
    const out = execFileSync(process.execPath, ["scripts/operatorDeleteAccount.mjs", ...args], {
      encoding: "utf8", env: { ...process.env, TENOTRAINER_ODA_AUDIT_DIR: AUDIT_DIR }, stdio: ["ignore", "pipe", "pipe"],
    });
    outputs.push(out);
    return { code: 0, out, json: args.includes("--json") ? JSON.parse(out) : null };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    outputs.push(out);
    let json = null;
    try { json = args.includes("--json") ? JSON.parse(e.stdout) : null; } catch {}
    return { code: e.status, out, json };
  }
}
async function state(userId, email) {
  const q = async (t, col, v) => (await admin.from(t).select("*", { count: "exact", head: true }).eq(col, v)).count ?? 0;
  const { data: u } = await admin.auth.admin.getUserById(userId);
  return {
    user: u?.user ? 1 : 0, profile: await q("profiles", "id", userId), members: await q("organization_members", "user_id", userId),
    assignments: await q("supervisor_patients", "patient_id", userId), agreement: await q("participation_agreement_acceptances", "user_id", userId),
    invitations: await q("invitations", "email", email),
  };
}

const createdUsers = [];
const createdOrgs = [];
const createdExercises = [];
const restoreEmails = [];
async function mgmt(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${DEV_REF}/database/query`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: sql }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`management query failed: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
async function main() {
  // ---------------------------------------------------------------- fixtures
  const { data: org, error: orgErr } = await admin.from("organizations").insert({ name: `ODA CLI fixture ${RUN}`, slug: `oda-cli-${RUN}` }).select("id").single();
  if (orgErr) throw orgErr;
  createdOrgs.push(org.id);
  const mk = async (label) => {
    const email = `oda-cli-${label}-${RUN}@example.invalid`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: `oda-${randomUUID()}`, email_confirm: true, user_metadata: { name: `ODA ${label}` } });
    if (error) throw error;
    createdUsers.push(data.user.id);
    return { id: data.user.id, email };
  };
  const clin = await mk("clinician");
  const pat = await mk("patient");
  await admin.from("organization_members").insert({ organization_id: org.id, user_id: clin.id, role: "clinician" });
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const { data: inv } = await admin.rpc("create_patient_invitation", { p_clinician_id: clin.id, p_organization_id: org.id, p_email: pat.email, p_token_hash: sha256(token) });
  const { data: acc } = await admin.rpc("accept_patient_invitation_with_agreement", {
    p_token_hash: sha256(token), p_user_id: pat.id, p_agreement_key: "alpha1_participation", p_agreement_version: "1.0", p_agreement_sha256: AGREEMENT_SHA,
  });
  check("fixture: synthetic patient accepted a real invitation with the agreement", inv?.result === "created" && acc?.result === "accepted", JSON.stringify({ inv, acc }));
  const base = ["--project", DEV_REF, "--user-id", pat.id, "--email", pat.email];
  const before = await state(pat.id, pat.email);
  check("fixture: account, profile, membership, assignment, agreement, invitation exist", Object.values(before).every((n) => n === 1), JSON.stringify(before));

  // ---------------------------------------------------------------- 6: identity / environment refusals (before any network call)
  let r = cli(["--project", "abcdefghijklmnopqrst", "--user-id", pat.id, "--email", pat.email]);
  check("6. an unregistered project ref is refused", r.code === 2 && /not a registered development or production project/.test(r.out), r.out);
  r = cli(["--project", PROD_REF, "--user-id", pat.id, "--email", pat.email]);
  check("6. the production project without --production is refused", r.code === 2 && /requires --production/.test(r.out), r.out);
  r = cli(["--project", PROD_REF, "--production", "--user-id", pat.id, "--email", pat.email]);
  check("6. the production project without --confirm-project is refused", r.code === 2 && /--confirm-project/.test(r.out), r.out);
  r = cli(["--project", PROD_REF, "--production", "--confirm-project", "abcdefghijklmnopqrst", "--user-id", pat.id, "--email", pat.email]);
  check("6. a mismatched --confirm-project is refused", r.code === 2 && /--confirm-project/.test(r.out), r.out);
  r = cli(["--project", PROD_REF, "--production", "--confirm-project", PROD_REF, "--user-id", pat.id, "--email", pat.email, "--apply", "--plan-hash", "0".repeat(64), "--fail-at", "mid_change"]);
  check("6. test-only failure injection can never target production", r.code === 2 && /development-only/.test(r.out), r.out);
  r = cli([...base, "--production"]);
  check("6. --production on the development ref is refused", r.code === 2 && /this ref is development/.test(r.out), r.out);
  r = cli([...base, "--apply"]);
  check("8. --apply without a plan hash is refused", r.code === 2 && /requires --plan-hash/.test(r.out), r.out);
  r = cli(["--project", DEV_REF, "--user-id", "not-a-uuid", "--email", pat.email]);
  check("5. a malformed UUID is refused", r.code === 2 && /--user-id/.test(r.out), r.out);

  // ---------------------------------------------------------------- 5 / 4: database-side refusals (dry run)
  r = cli(["--project", DEV_REF, "--user-id", pat.id, "--email", clin.email, "--json"]);
  check("5. an email that does not match the UUID is refused, nothing else revealed",
    r.code === 1 && r.json?.result?.outcome === "refused" && JSON.stringify(r.json.result.refusals) === '["email_does_not_match_account"]' && !("subject_records" in r.json.result), r.out);
  r = cli(["--project", DEV_REF, "--user-id", clin.id, "--email", clin.email, "--json"]);
  check("4. a clinician account is refused", r.code === 1 && r.json?.result?.refusals?.includes("non_patient_role:clinician"), r.out);

  // ---------------------------------------------------------------- 7: dry run changes nothing
  r = cli([...base, "--json"]);
  const plan = r.json?.result;
  check("7. dry run: outcome DELETE with an inventory and a plan hash", r.code === 0 && plan?.outcome === "delete" && /^[0-9a-f]{64}$/.test(plan?.plan_hash ?? ""), r.out);
  check("7. dry run: nothing changed", JSON.stringify(await state(pat.id, pat.email)) === JSON.stringify(before));
  r = cli(base);
  check("7. human-readable dry run shows the outcome, records and plan hash; email masked", r.code === 0 && /DRY RUN/.test(r.out) && /outcome: DELETE/.test(r.out) && r.out.includes(plan.plan_hash) && !r.out.includes(pat.email), r.out);

  // ---------------------------------------------------------------- 8 / 10: stale hash, injected failure (real transactions)
  r = cli([...base, "--apply", "--plan-hash", "f".repeat(64), "--json"]);
  check("8. apply with a wrong plan hash fails, nothing changed", r.code === 1 && r.json?.error === "ODA_PLAN_STALE" && JSON.stringify(await state(pat.id, pat.email)) === JSON.stringify(before), r.out);
  for (const point of ["after_lock", "mid_change", "before_verify"]) {
    r = cli([...base, "--apply", "--plan-hash", plan.plan_hash, "--fail-at", point, "--json"]);
    check(`10. failure injected at ${point}: whole transaction rolled back`, r.code === 1 && r.json?.error === "ODA_INJECTED_FAILURE" && JSON.stringify(await state(pat.id, pat.email)) === JSON.stringify(before), r.out);
  }

  // ---------------------------------------------------------------- 1: apply
  r = cli([...base, "--apply", "--plan-hash", plan.plan_hash, "--json"]);
  check("1. apply: DELETE verified in-transaction, independent post-check confirmed",
    r.code === 0 && r.json?.result?.outcome === "delete" && r.json?.result?.verified === true && /^confirmed \(account_not_found\)/.test(r.json?.post_check ?? ""), r.out);
  const after = await state(pat.id, pat.email);
  check("1. apply: account, profile, membership, assignment, agreement, invitation all gone", Object.values(after).every((n) => n === 0), JSON.stringify(after));
  const { data: clinStill } = await admin.from("organization_members").select("role").eq("user_id", clin.id);
  check("11. the clinician and its membership are untouched", clinStill?.length === 1 && clinStill[0].role === "clinician");

  // ---------------------------------------------------------------- 9: repeated execution
  r = cli([...base, "--apply", "--plan-hash", plan.plan_hash, "--json"]);
  check("9. a repeated apply is refused (account_not_found), nothing done", r.code === 1 && r.json?.error === "ODA_REFUSED", r.out);
  r = cli([...base, "--json"]);
  check("9. a repeated dry run reports account_not_found", r.json?.result?.refusals?.includes("account_not_found"), r.out);

  // ---------------------------------------------------------------- 2: CLOSE with a real signed-in participant
  const PW = `oda-${randomUUID()}-Zz9!`;
  const p2 = await mk("closepatient");
  await admin.auth.admin.updateUserById(p2.id, { password: PW });
  const { data: ce } = await admin.from("canonical_exercises").insert({ name: `ODA CLI ex ${RUN}`, visibility: "global", active: true }).select("id").single();
  createdExercises.push(ce.id);
  const tok2 = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  await admin.rpc("create_patient_invitation", { p_clinician_id: clin.id, p_organization_id: org.id, p_email: p2.email, p_token_hash: sha256(tok2) });
  await admin.rpc("accept_patient_invitation_with_agreement", { p_token_hash: sha256(tok2), p_user_id: p2.id, p_agreement_key: "alpha1_participation", p_agreement_version: "1.0", p_agreement_sha256: AGREEMENT_SHA });
  const helpers = readFileSync("scripts/verifyM32SafetyNotificationsHelpers.sql", "utf8");
  await mgmt(`BEGIN;\n${helpers}\nDO $x$ DECLARE rx JSONB; BEGIN rx := pg_temp.rx('${p2.id}'::uuid, '${clin.id}'::uuid, '${ce.id}'::uuid); PERFORM pg_temp.closed('${p2.id}'::uuid, rx, 1, '{"pop_felt_or_heard": true}', '{"peak_session_pain": 6, "overall_session_rpe": 5, "sudden_or_sharp_pain": false, "new_functional_difficulty": false}'); PERFORM pg_temp.reconcile('${p2.id}'::uuid); END $x$;\nCOMMIT;`);
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email: p2.email, password: PW });
  check("2. fixture: participant with protected safety history is signed in", !sErr && !!sess?.session, sErr?.message);
  const AT = sess.session.access_token;
  const RT = sess.session.refresh_token;
  const base2 = ["--project", DEV_REF, "--user-id", p2.id, "--email", p2.email];
  const placeholder = `closed+${p2.id}@deleted.invalid`;
  r = cli([...base2, "--json"]);
  const plan2 = r.json?.result;
  check("2. dry run: outcome CLOSE with protected safety records listed", plan2?.outcome === "close" && Object.keys(plan2?.protected_safety_records ?? {}).length >= 2, r.out);
  r = cli([...base2, "--apply", "--plan-hash", plan2.plan_hash, "--json"]);
  check("2. apply: CLOSE verified, independent post-check confirmed (addressed by its placeholder)",
    r.code === 0 && r.json?.result?.outcome === "close" && r.json?.result?.verified === true && /^confirmed \(already_closed\)/.test(r.json?.post_check ?? ""), r.out);
  restoreEmails.push({ id: p2.id, email: p2.email, placeholder });
  const authUser = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${AT}` } });
  check("2. the old access token is rejected by Supabase Auth (the app's getUser check)", authUser.status === 403 || authUser.status === 401, authUser.status);
  const refresh = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: RT }) });
  check("2. the old refresh token is refused", refresh.status >= 400, refresh.status);
  const { error: reLogin } = await createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } }).auth.signInWithPassword({ email: p2.email, password: PW });
  check("2. password sign-in with the old address is refused", !!reLogin);
  const noKey = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=name&id=eq.${p2.id}`, { headers: { Authorization: `Bearer ${AT}` } });
  check("2. the Data API refuses the old token without the (server-only) API key", noKey.status === 401, noKey.status);
  // The measured residual: with the anon key, the still-valid token can edit the own profile until it expires.
  const patch = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${p2.id}`, { method: "PATCH", headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${AT}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ name: "Re-identified" }) });
  r = cli(["--project", DEV_REF, "--user-id", p2.id, "--email", placeholder, "--json"]);
  check("2. re-check detects the profile edited with the still-valid token and offers a re-close",
    patch.status === 204 && r.json?.result?.outcome === "close" && r.json?.result?.reclose === true && r.json?.result?.closure_drift?.includes("profile"), `${patch.status} ${r.out}`);
  r = cli(["--project", DEV_REF, "--user-id", p2.id, "--email", placeholder, "--apply", "--plan-hash", r.json.result.plan_hash, "--json"]);
  const { data: prof2 } = await admin.from("profiles").select("name, timezone").eq("id", p2.id).single();
  check("2. re-close restores the de-identification; post-check confirms an intact closure",
    r.code === 0 && /^confirmed \(already_closed\)/.test(r.json?.post_check ?? "") && prof2?.name === "Closed participant" && prof2?.timezone === null, `${r.out} ${JSON.stringify(prof2)}`);
  const { count: ev } = await admin.from("safety_notification_events").select("id", { count: "exact", head: true }).eq("patient_id", p2.id);
  check("2. protected safety history is retained after closure and re-close", (ev ?? 0) >= 1, ev);

  // ---------------------------------------------------------------- security: output and audit records
  check("security: the access token never appears in any output", outputs.every((o) => !o.includes(TOKEN)));
  const audits = readdirSync(AUDIT_DIR).map((f) => readFileSync(join(AUDIT_DIR, f), "utf8"));
  check("audit: a record per run (dry runs and applies), with plan hash, outcome, operator, email hash — no plaintext email, no token",
    audits.length >= 8 && audits.every((a) => !a.includes(pat.email) && !a.includes(clin.email) && !a.includes(TOKEN))
      && audits.some((a) => JSON.parse(a).mode === "apply" && JSON.parse(a).outcome === "delete" && JSON.parse(a).email_sha256 === sha256(pat.email)), `${audits.length} records`);
}

try {
  await main();
} catch (e) {
  fail++;
  console.log(`FAIL  harness: ${e.message}`);
} finally {
  // Restore the closed fixture's synthetic address (the guarded development
  // purge only accepts @example.invalid fixtures of this run), then purge
  // whatever remains of THIS run.
  for (const r of restoreEmails) {
    await mgmt(`UPDATE auth.users SET email = '${r.email}' WHERE id = '${r.id}'::uuid AND email = '${r.placeholder}';`);
  }
  const remaining = [];
  for (const id of createdUsers) {
    const { data } = await admin.auth.admin.getUserById(id);
    if (data?.user) remaining.push(id);
  }
  try {
    guardedFixtureTeardown(env, { userIds: remaining.length ? remaining : [], organizationIds: createdOrgs, exerciseIds: createdExercises, runStartedAt: RUN_STARTED_AT });
    if (!remaining.length && createdOrgs.length) {
      // No users left: remove the empty fixture organization directly.
      await admin.from("organizations").delete().in("id", createdOrgs);
    }
    const { data: leftOrgs } = await admin.from("organizations").select("id").in("id", createdOrgs);
    const left = [];
    for (const id of createdUsers) if ((await admin.auth.admin.getUserById(id)).data?.user) left.push(id);
    const { data: leftEx } = await admin.from("canonical_exercises").select("id").in("id", createdExercises.length ? createdExercises : ["00000000-0000-0000-0000-000000000000"]);
    check("cleanup: zero residual fixtures (users, organization, exercise, safety history)", left.length === 0 && (leftOrgs ?? []).length === 0 && (leftEx ?? []).length === 0, JSON.stringify({ left, leftOrgs, leftEx }));
  } catch (e) {
    fail++;
    console.log(`FAIL  cleanup: ${e.message}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
