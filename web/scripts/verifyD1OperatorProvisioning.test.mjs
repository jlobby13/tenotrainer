// D1 — operator provisioning core: plan validation, explicit target
// identity, registry classification (with injected registries — the
// committed production list stays empty until M3.4), dry-run purity,
// idempotency, conflict refusal, partial-failure recovery, claim-id
// concurrency semantics, password-file rules, redaction, and CLI refusals
// that never print secrets. No network: an in-memory store enforces the
// same uniqueness rules as Postgres (primary keys, organizations.slug,
// organization_members(org,user), Auth email). The DB-level proof is
// verifyD1OperatorProvisioningLive.mjs.
//
//   node scripts/verifyD1OperatorProvisioning.test.mjs
import { register } from "node:module";
register("./lib/tsServerModuleHooks.mjs", import.meta.url);

const { randomUUID } = await import("node:crypto");
const { chmodSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join, resolve, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { execFileSync } = await import("node:child_process");
const core = await import("./lib/operatorProvisioning.mjs");
const { fakeKeysFor } = await import("./lib/fakeSupabaseKeys.mjs");

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
};
const refusedWith = (fn, re) => {
  try { fn(); return false; } catch (e) { return e instanceof core.ProvisioningRefused && re.test(e.message); }
};

const DEV = "kpdxlzqtvueiytwjamiw";
const PROD = "prodrefzzzzzzzzzzzzz"; // synthetic, injected registry only
const OTHER = "otherrefzzzzzzzzzzzz";
const REGISTRY = { developmentSupabaseProjects: [DEV], productionSupabaseProjects: [PROD], developmentEmailDomains: [], productionEmailDomains: [] };
const envFor = (ref, key) => ({ SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: key ?? fakeKeysFor(ref).SUPABASE_SERVICE_ROLE_KEY });
const planFor = (over = {}) => core.validatePlan({
  target: { intent: "production", projectRef: PROD },
  organization: { name: "Founding Clinic", slug: "founding-clinic" },
  superUser: { email: "Founder@Example.invalid", name: "Founder Person" },
  clinicians: [{ email: "clin@example.invalid", name: "Clinician One", role: "clinician" }],
  ...over,
});

// ---------------------------------------------------------------- in-memory store
function memoryStore(shared = { users: new Map(), orgs: new Map(), members: new Map(), profiles: new Set() }, hooks = {}) {
  const s = shared;
  const counter = { writes: 0 };
  const store = {
    counter, shared: s,
    async probe() {},
    async findUserByEmail(email) { for (const u of s.users.values()) if (u.email === email) return { ...u }; return null; },
    async createUser({ email, name, marker }) {
      await hooks.beforeCreateUser?.(email);
      for (const u of s.users.values()) if (u.email === email) return { conflict: true };
      const id = randomUUID();
      s.users.set(id, { id, email, appMetadata: { [core.MARKER_KEY]: marker }, name });
      s.profiles.add(id); // the auth.users trigger
      counter.writes++;
      return { id };
    },
    async getOrganization(id) { return s.orgs.get(id) ?? null; },
    async organizationBySlug(slug) { for (const o of s.orgs.values()) if (o.slug === slug) return o; return null; },
    async otherOrganizations(excludeId) { return [...s.orgs.values()].filter((o) => o.id !== excludeId); },
    async superUserMemberships() { return [...s.members.values()].filter((m) => m.role === "super_user"); },
    async membershipsForUser(userId) { return [...s.members.values()].filter((m) => m.user_id === userId); },
    async membershipById(id) { return s.members.get(id) ?? null; },
    async profileExists(userId) { return s.profiles.has(userId); },
    async insertOrganization(row) {
      await hooks.beforeInsertOrganization?.();
      if (s.orgs.has(row.id) || [...s.orgs.values()].some((o) => o.slug === row.slug)) return { conflict: true };
      s.orgs.set(row.id, { ...row }); counter.writes++; return {};
    },
    async insertMembership(row) {
      await hooks.beforeInsertMembership?.(row);
      const id = row.id ?? randomUUID();
      if (s.members.has(id) || [...s.members.values()].some((m) => m.organization_id === row.organization_id && m.user_id === row.user_id)) return { conflict: true };
      s.members.set(id, { id, ...row }); counter.writes++; return {};
    },
  };
  return store;
}
const PASSWORDS = new Map([["founder@example.invalid", "a-long-operator-pass-1"], ["clin@example.invalid", "another-long-pass-22"]]);

// ---------------------------------------------------------------- plan validation
console.log("--- plan validation ---");
check("valid plan normalises email case", planFor().superUser.email === "founder@example.invalid");
check("unknown top-level field refused", refusedWith(() => planFor({ extra: 1 }), /unknown field 'extra'/));
check("unknown person field (e.g. password) refused", refusedWith(() => planFor({ superUser: { email: "a@b.cd", name: "Ab", password: "x" } }), /unknown field 'password'/));
check("bad intent refused", refusedWith(() => planFor({ target: { intent: "staging", projectRef: PROD } }), /intent/));
check("missing project ref refused", refusedWith(() => planFor({ target: { intent: "production" } }), /projectRef/));
check("developmentNamespace forbidden for production", refusedWith(() => planFor({ target: { intent: "production", projectRef: PROD, developmentNamespace: "abc" } }), /not allowed/));
check("developmentNamespace required for development", refusedWith(() => planFor({ target: { intent: "development", projectRef: DEV } }), /required/));
check("duplicate account emails refused", refusedWith(() => planFor({ clinicians: [{ email: "founder@example.invalid", name: "Dup", role: "clinician" }] }), /distinct/));
check("clinician role restricted (no super_user via clinicians)", refusedWith(() => planFor({ clinicians: [{ email: "x@example.invalid", name: "Xx", role: "super_user" }] }), /role must be/));
check("bad slug refused", refusedWith(() => planFor({ organization: { name: "Org", slug: "Bad Slug" } }), /slug/));

// ---------------------------------------------------------------- target identity
console.log("\n--- target identity ---");
const rt = (plan, arg, env, registry = REGISTRY) => () => core.resolveTarget({ plan, targetRefArg: arg, env, registry });
const devPlan = planFor({ target: { intent: "development", projectRef: DEV, developmentNamespace: "unit" } });
check("missing --target-ref refused", refusedWith(rt(planFor(), undefined, envFor(PROD)), /--target-ref .* required/));
check("--target-ref differing from the plan refused", refusedWith(rt(planFor(), OTHER, envFor(PROD)), /does not match/));
check("missing SUPABASE_URL refused", refusedWith(rt(planFor(), PROD, { SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" }), /SUPABASE_URL is not set/));
check("SUPABASE_URL of another project refused", refusedWith(rt(planFor(), PROD, envFor(OTHER, "sb_secret_abcdef")), /different project/));
check("local (loopback) Supabase cannot be positively identified", refusedWith(rt(planFor(), PROD, { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" }), /cannot be positively identified/));
check("URL with a path refused", refusedWith(rt(planFor(), PROD, { SUPABASE_URL: `https://${PROD}.supabase.co/rest`, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" }), /bare project URL/));
check("missing service credential refused", refusedWith(rt(planFor(), PROD, { SUPABASE_URL: `https://${PROD}.supabase.co` }), /SUPABASE_SERVICE_ROLE_KEY is not set/));
check("publishable key refused", refusedWith(rt(planFor(), PROD, envFor(PROD, "sb_publishable_abc")), /publishable/));
check("anon JWT refused", refusedWith(rt(planFor(), PROD, envFor(PROD, fakeKeysFor(PROD).SUPABASE_ANON_KEY)), /not a service_role/));
check("service JWT of another project refused", refusedWith(rt(planFor(), PROD, envFor(PROD, fakeKeysFor(OTHER).SUPABASE_SERVICE_ROLE_KEY)), /different project/));
check("unrecognised key refused", refusedWith(rt(planFor(), PROD, envFor(PROD, "plainstring")), /not a recognised/));
check("production intent refuses a registered development project", refusedWith(rt(planFor({ target: { intent: "production", projectRef: DEV } }), DEV, envFor(DEV)), /registered DEVELOPMENT/));
check("production intent refuses an unapproved project", refusedWith(rt(planFor({ target: { intent: "production", projectRef: OTHER } }), OTHER, envFor(OTHER)), /not an approved production project/));
check("committed registry: production intent refuses everything today (empty production list)",
  refusedWith(() => core.resolveTarget({ plan: planFor({ target: { intent: "production", projectRef: OTHER } }), targetRefArg: OTHER, env: envFor(OTHER) }), /not an approved production project/));
check("development intent refuses a registered production project", refusedWith(rt(planFor({ target: { intent: "development", projectRef: PROD, developmentNamespace: "unit" } }), PROD, envFor(PROD)), /registered PRODUCTION/));
check("development intent refuses an unregistered project", refusedWith(rt(planFor({ target: { intent: "development", projectRef: OTHER, developmentNamespace: "unit" } }), OTHER, envFor(OTHER)), /not a registered development/));
const tProd = core.resolveTarget({ plan: planFor(), targetRefArg: PROD, env: envFor(PROD), registry: REGISTRY });
const tProdSecret = core.resolveTarget({ plan: planFor(), targetRefArg: PROD, env: envFor(PROD, "sb_secret_abcdef"), registry: REGISTRY });
const tDev = core.resolveTarget({ plan: devPlan, targetRefArg: DEV, env: envFor(DEV), registry: REGISTRY });
check("approved production target accepted (JWT and sb_secret)", tProd.intent === "production" && tProdSecret.keyFormat === "sb_secret");
check("claim ids are deterministic per target", tProd.organizationId === tProdSecret.organizationId && tProd.superUserMembershipId !== tProd.organizationId);
check("development claims are namespaced away from production claims", tDev.organizationId !== core.claimId(DEV, "initial-organization"));

// ---------------------------------------------------------------- provisioning
console.log("\n--- dry run, apply, idempotency ---");
{
  const st = memoryStore();
  const dry = await core.provision({ plan: planFor(), target: tProd, store: st, passwords: PASSWORDS });
  check("dry run: would apply, zero writes", dry.outcome === "would_apply" && dry.writes === 0 && st.counter.writes === 0 && st.shared.users.size === 0);
  const noPw = await core.provision({ plan: planFor(), target: tProd, store: st });
  check("dry run without passwords reports them missing (no values printed)", noPw.outcome === "blocked_missing_passwords" && !JSON.stringify(noPw).includes("a-long-operator-pass-1"));
  const noPwApply = await core.provision({ plan: planFor(), target: tProd, store: st, apply: true });
  check("apply without required passwords refuses before any write", noPwApply.outcome === "refused" && st.counter.writes === 0);
  const r = await core.provision({ plan: planFor(), target: tProd, store: st, passwords: PASSWORDS, apply: true });
  const org = st.shared.orgs.get(tProd.organizationId);
  const su = st.shared.members.get(tProd.superUserMembershipId);
  const suUser = [...st.shared.users.values()].find((u) => u.email === "founder@example.invalid");
  const clinUser = [...st.shared.users.values()].find((u) => u.email === "clin@example.invalid");
  const clinM = [...st.shared.members.values()].find((m) => m.user_id === clinUser?.id);
  check("apply creates org (claim id), super user (claim membership), clinician", r.outcome === "applied" && r.writes === 5 && org?.slug === "founding-clinic" && su?.user_id === suUser?.id && su?.role === "super_user" && clinM?.role === "clinician", JSON.stringify(r));
  check("created accounts carry the inert operator marker", suUser?.appMetadata?.[core.MARKER_KEY]?.organization_id === tProd.organizationId && suUser.appMetadata[core.MARKER_KEY].role === "super_user");
  check("report contains no password", !JSON.stringify(r).includes("a-long-operator-pass-1"));
  const before = st.counter.writes;
  const again = await core.provision({ plan: planFor(), target: tProd, store: st, passwords: PASSWORDS, apply: true });
  check("rerun: no change, zero writes", again.outcome === "no_change" && st.counter.writes === before);
  const again2 = await core.provision({ plan: planFor(), target: tProd, store: st, apply: true });
  check("rerun needs no passwords (existing accounts are never re-passworded)", again2.outcome === "no_change");
  const addClin = await core.provision({ plan: planFor({ clinicians: [{ email: "clin@example.invalid", name: "Clinician One", role: "clinician" }, { email: "c2@example.invalid", name: "Clinician Two", role: "clinician_admin" }] }), target: tProd, store: st, passwords: new Map([["c2@example.invalid", "third-long-password-3"]]), apply: true });
  check("later run adds an explicitly requested clinician only", addClin.outcome === "applied" && addClin.writes === 2 && st.shared.orgs.size === 1 && st.shared.members.size === 3);
  const roleChange = await core.provision({ plan: planFor({ clinicians: [{ email: "clin@example.invalid", name: "Clinician One", role: "clinician_admin" }] }), target: tProd, store: st, apply: true });
  check("role change refused (never silent)", roleChange.outcome === "refused" && clinM.role === "clinician");
  const otherSlug = await core.provision({ plan: planFor({ organization: { name: "Founding Clinic", slug: "different-slug" } }), target: tProd, store: st, apply: true });
  check("conflicting initial organization refused", otherSlug.outcome === "refused" && /different name or slug/.test(JSON.stringify(otherSlug)));
  const otherSu = await core.provision({ plan: planFor({ superUser: { email: "intruder@example.invalid", name: "Intruder" }, clinicians: [] }), target: tProd, store: st, passwords: new Map([["intruder@example.invalid", "intruder-long-pass-9"]]), apply: true });
  check("second initial super user refused", otherSu.outcome === "refused" && ![...st.shared.users.values()].some((u) => u.email === "intruder@example.invalid"));
}

console.log("\n--- conflicting pre-existing state ---");
{
  const st = memoryStore();
  st.shared.orgs.set("11111111-1111-4111-8111-111111111111", { id: "11111111-1111-4111-8111-111111111111", name: "Existing", slug: "existing" });
  const r = await core.provision({ plan: planFor(), target: tProd, store: st, passwords: PASSWORDS, apply: true });
  check("production: an organization not created by this workflow → refused, zero writes", r.outcome === "refused" && st.counter.writes === 0);
  const rDev = await core.provision({ plan: devPlan, target: tDev, store: st, passwords: PASSWORDS });
  check("development intent tolerates unrelated organizations (shared dev project)", rDev.outcome === "would_apply");
  const slugClash = await core.provision({ plan: planFor({ organization: { name: "X Org", slug: "existing" } }), target: tDev, store: st, passwords: PASSWORDS });
  check("slug used by another organization → refused", slugClash.outcome === "refused");
}
{
  const st = memoryStore();
  st.shared.users.set("u1", { id: "u1", email: "founder@example.invalid", appMetadata: {} });
  const r = await core.provision({ plan: planFor(), target: tProd, store: st, passwords: PASSWORDS, apply: true });
  check("existing unrelated account (no marker) refused, never adopted", r.outcome === "refused" && st.counter.writes === 0 && st.shared.members.size === 0);
  st.shared.users.set("u2", { id: "u2", email: "clin@example.invalid", appMetadata: { [core.MARKER_KEY]: { v: 1, organization_id: "other", role: "clinician" } } });
  const r2 = await core.provision({ plan: planFor({ superUser: { email: "f2@example.invalid", name: "F Two" } }), target: tProd, store: st, passwords: new Map([["f2@example.invalid", "f-two-long-password"]]), apply: true });
  check("marker for a different organization refused", r2.outcome === "refused" && st.counter.writes === 0);
}
{
  const st = memoryStore();
  st.shared.users.set("u3", { id: "u3", email: "clin@example.invalid", appMetadata: {} });
  st.shared.orgs.set("o2", { id: "o2", name: "Other", slug: "other" });
  st.shared.members.set("m3", { id: "m3", organization_id: "o2", user_id: "u3", role: "clinician" });
  const r = await core.provision({ plan: planFor({ target: { intent: "development", projectRef: DEV, developmentNamespace: "unit" } }), target: tDev, store: st, passwords: PASSWORDS, apply: true });
  check("account belonging to another organization refused", r.outcome === "refused" && st.counter.writes === 0);
}
{
  const st = memoryStore();
  st.shared.users.set("u4", { id: "u4", email: "su@example.invalid", appMetadata: {} });
  st.shared.members.set("m4", { id: "m4", organization_id: "anywhere", user_id: "u4", role: "super_user" });
  const r = await core.provision({ plan: planFor(), target: tProd, store: st, passwords: PASSWORDS, apply: true });
  check("production: existing super user not created by this workflow → refused", r.outcome === "refused" && st.counter.writes === 0);
}

console.log("\n--- partial failure and recovery ---");
{
  const shared = { users: new Map(), orgs: new Map(), members: new Map(), profiles: new Set() };
  let crash = true;
  const crashing = memoryStore(shared, { beforeInsertMembership: async () => { if (crash) throw new Error("simulated crash"); } });
  const r = await core.provision({ plan: planFor(), target: tProd, store: crashing, passwords: PASSWORDS, apply: true });
  const su = [...shared.users.values()].find((u) => u.email === "founder@example.invalid");
  check("crash before the membership: reported partial, account has NO membership (no privilege)", r.outcome === "partial_failed" && su && shared.members.size === 0, JSON.stringify(r));
  crash = false;
  const dry = await core.provision({ plan: planFor(), target: tProd, store: memoryStore(shared), passwords: new Map([["clin@example.invalid", "another-long-pass-22"]]) });
  check("dry run of the partial state reports recover (no password needed for the existing account)", dry.outcome === "would_apply" && dry.steps[1].membership === "recover" && dry.steps[1].password === "not needed");
  const r2 = await core.provision({ plan: planFor(), target: tProd, store: memoryStore(shared), passwords: new Map([["clin@example.invalid", "another-long-pass-22"]]), apply: true });
  check("rerun completes deterministically (membership recovered, org reused)", r2.outcome === "applied" && shared.orgs.size === 1 && shared.members.get(tProd.superUserMembershipId)?.user_id === su.id);
}

console.log("\n--- concurrency semantics (claim ids) ---");
{
  const shared = { users: new Map(), orgs: new Map(), members: new Map(), profiles: new Set() };
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  const barrier = async () => { waiting++; if (waiting >= 2) release(); await gate; };
  const sA = memoryStore(shared, { beforeInsertOrganization: barrier });
  const sB = memoryStore(shared, { beforeInsertOrganization: barrier });
  const [a, b] = await Promise.all([
    core.provision({ plan: planFor(), target: tProd, store: sA, passwords: PASSWORDS, apply: true }),
    core.provision({ plan: planFor(), target: tProd, store: sB, passwords: PASSWORDS, apply: true }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort().join(",");
  check("same plan twice concurrently: no duplicates", shared.orgs.size === 1 && [...shared.members.values()].filter((m) => m.role === "super_user").length === 1 && shared.users.size === 2, outcomes);
}
{
  const shared = { users: new Map(), orgs: new Map(), members: new Map(), profiles: new Set() };
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  const barrier = async () => { waiting++; if (waiting >= 2) release(); await gate; };
  const pA = planFor({ clinicians: [] });
  const pB = planFor({ superUser: { email: "rival@example.invalid", name: "Rival" }, clinicians: [] });
  const [a, b] = await Promise.all([
    core.provision({ plan: pA, target: tProd, store: memoryStore(shared, { beforeInsertMembership: barrier }), passwords: PASSWORDS, apply: true }),
    core.provision({ plan: pB, target: tProd, store: memoryStore(shared, { beforeInsertMembership: barrier }), passwords: new Map([["rival@example.invalid", "rival-long-password"]]), apply: true }),
  ]);
  const supers = [...shared.members.values()].filter((m) => m.role === "super_user");
  check("conflicting super users concurrently: exactly one wins, the other stops", supers.length === 1 && [a.outcome, b.outcome].sort().join(",") === "applied,partial_refused", `${a.outcome},${b.outcome}`);
}

// ---------------------------------------------------------------- files and redaction
console.log("\n--- files, credentials and redaction ---");
const tmp = mkdtempSync(join(tmpdir(), "d1-unit-"));
const plan = planFor();
try {
  const pw = join(tmp, "pw.json");
  writeFileSync(pw, JSON.stringify({ "founder@example.invalid": "a-long-operator-pass-1" }));
  chmodSync(pw, 0o644);
  check("group/world-readable passwords file refused", refusedWith(() => core.readPasswordsFile(pw, plan), /owner only/));
  chmodSync(pw, 0o600);
  check("owner-only passwords file accepted", core.readPasswordsFile(pw, plan).get("founder@example.invalid") === "a-long-operator-pass-1");
  const link = join(tmp, "pw-link.json");
  symlinkSync(pw, link);
  check("symlinked passwords file refused", refusedWith(() => core.readPasswordsFile(link, plan), /regular file/));
  const unknown = join(tmp, "pw2.json");
  writeFileSync(unknown, JSON.stringify({ "stranger@example.invalid": "a-long-operator-pass-1" }), { mode: 0o600 });
  check("password for an account outside the plan refused", refusedWith(() => core.readPasswordsFile(unknown, plan), /not in the plan/));
  const short = join(tmp, "pw3.json");
  writeFileSync(short, JSON.stringify({ "founder@example.invalid": "short" }), { mode: 0o600 });
  check("short password refused", refusedWith(() => core.readPasswordsFile(short, plan), /12-72 bytes/));
  const inRepo = join(WEB, "scripts", `.d1-unit-${randomUUID()}.json`);
  writeFileSync(inRepo, "{}", { mode: 0o600 });
  try {
    check("passwords file inside the repository refused", refusedWith(() => core.readPasswordsFile(inRepo, plan), /outside the repository/));
    check("plan file inside the repository refused", refusedWith(() => core.readPlanFile(inRepo), /outside the repository/));
  } finally {
    rmSync(inRepo, { force: true });
  }
  const red = core.createRedactor(["SENTINEL-KEY-123456", "pass-word-sentinel"]);
  const msg = red("k=SENTINEL-KEY-123456 p=pass-word-sentinel jwt=eyJhbGciOi.eyJyb2xlIjoi.c2lnbmF0dXJl sb_secret_abc re_abcdefghij");
  check("redactor removes configured secrets, JWTs, sb_ and re_ keys", !/SENTINEL|sentinel|eyJ|sb_secret_abc|re_abcdefghij/.test(msg), msg);

  // ---- CLI: refusals before any network, and no secret ever printed.
  const SENTINEL_KEY = `sb_secret_D1SENTINEL${randomUUID().replace(/-/g, "")}`;
  const SENTINEL_PW = `D1-sentinel-password-${randomUUID()}`;
  const cliPlan = (target) => {
    const p = join(tmp, `plan-${randomUUID()}.json`);
    writeFileSync(p, JSON.stringify({ target, organization: { name: "Cli Org", slug: "cli-org" }, superUser: { email: "cli@example.invalid", name: "Cli Founder" } }));
    return p;
  };
  const cliPw = join(tmp, "cli-pw.json");
  writeFileSync(cliPw, JSON.stringify({ "cli@example.invalid": SENTINEL_PW }), { mode: 0o600 });
  const runCli = (args, env) => {
    try {
      const out = execFileSync(process.execPath, ["scripts/provisionStaff.mjs", ...args], { cwd: WEB, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const cases = [
    ["production intent at the development project", [ "--plan", cliPlan({ intent: "production", projectRef: DEV }), "--target-ref", DEV, "--passwords-file", cliPw, "--apply"], envFor(DEV, SENTINEL_KEY), /registered DEVELOPMENT/],
    ["unapproved production project", ["--plan", cliPlan({ intent: "production", projectRef: OTHER }), "--target-ref", OTHER, "--passwords-file", cliPw], envFor(OTHER, SENTINEL_KEY), /not an approved production/],
    ["target ref mismatch", ["--plan", cliPlan({ intent: "production", projectRef: OTHER }), "--target-ref", PROD], envFor(OTHER, SENTINEL_KEY), /does not match/],
    ["URL of another project", ["--plan", cliPlan({ intent: "development", projectRef: DEV, developmentNamespace: "cli" }), "--target-ref", DEV, "--passwords-file", cliPw], envFor(OTHER, SENTINEL_KEY), /different project/],
    ["missing target ref", ["--plan", cliPlan({ intent: "development", projectRef: DEV, developmentNamespace: "cli" })], envFor(DEV, SENTINEL_KEY), /--target-ref/],
    ["a secret passed as an argument", ["--plan", cliPlan({ intent: "development", projectRef: DEV, developmentNamespace: "cli" }), "--target-ref", DEV, "--service-key", SENTINEL_KEY], envFor(DEV, SENTINEL_KEY), /unknown argument/],
  ];
  for (const [label, args, env, re] of cases) {
    const r = runCli(args, env);
    check(`CLI refuses: ${label} (exit 2, no secret in output)`, r.code === 2 && re.test(r.out) && !r.out.includes(SENTINEL_KEY) && !r.out.includes(SENTINEL_PW) && !r.out.includes("D1SENTINEL"), `${r.code} ${r.out.slice(-300)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
