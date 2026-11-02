// D1 — operator-controlled production provisioning (core). Creates the
// initial organization, its initial super user and explicitly requested
// clinician staff accounts directly in Supabase with the service-role
// credential. Never routed through the Next.js application; /setup is
// development-only.
//
// Safety model (docs/m3-production-provisioning.md):
//   - Target identity: the operator names the expected project ref twice
//     (plan + --target-ref); the ref observed in SUPABASE_URL (S3
//     parseSupabaseUrl) and any ref in a legacy JWT key must equal it, and
//     the S3 resource registry must classify it for the declared intent.
//   - Dry-run by default: reads only; every write needs --apply.
//   - Concurrency: the initial organization and the initial super-user
//     membership use DETERMINISTIC primary keys derived from the target
//     (claim ids). Postgres primary-key uniqueness lets exactly one
//     concurrent writer create each; every other writer re-reads and either
//     finds the identical intended row or refuses. Existing UNIQUE
//     constraints (organizations.slug, organization_members(org, user),
//     auth email) cover the rest. No process-local lock is relied on.
//   - Privilege is granted only by the membership row, written last. An
//     Auth account created by this workflow carries an inert app_metadata
//     marker (tenotrainer_operator) so a rerun can recognise and complete
//     it; any other pre-existing account is refused, never adopted.
//
// Requires the tsServerModuleHooks loader (the CLI registers it) because it
// imports the app's real S3 identity module.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySupabaseKey, parseSupabaseUrl, PROJECT_REF_PATTERN, RESOURCE_IDENTITY } from "../../lib/config/identity.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const MARKER_KEY = "tenotrainer_operator";
export const CLINICIAN_ROLES = Object.freeze(["clinician", "clinician_admin"]);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 72; // bcrypt input limit in Supabase Auth
const MAX_CLINICIANS = 50;
const USER_PAGE_SIZE = 1000;
const MAX_USER_PAGES = 200;

// A refusal is an expected, operator-facing stop (never a crash).
export class ProvisioningRefused extends Error {
  constructor(message, { afterWrites = false } = {}) {
    super(message);
    this.name = "ProvisioningRefused";
    this.afterWrites = afterWrites;
  }
}
const refuse = (msg) => {
  throw new ProvisioningRefused(msg);
};

// ---------------------------------------------------------------- redaction
export function createRedactor(secrets = []) {
  const values = secrets.filter((s) => typeof s === "string" && s.length >= 6).sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const v of values) out = out.split(v).join("[redacted]");
    return out
      .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]")
      .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]")
      .replace(/\bre_[A-Za-z0-9_]{8,}/g, "[redacted-key]");
  };
}

// ---------------------------------------------------------------- claim ids
// Deterministic UUID (RFC 9562 version 8 layout) from the claim namespace.
export function claimId(namespace, kind) {
  const h = createHash("sha256").update(`tenotrainer:operator-bootstrap:v1:${namespace}:${kind}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---------------------------------------------------------------- files
function insideRepo(path) {
  const real = realpathSync(path);
  return real === REPO_ROOT || real.startsWith(REPO_ROOT + sep);
}

// The plan is not secret but names real people: it must live outside the
// repository so it can never be committed by accident.
export function readPlanFile(path) {
  if (!path) refuse("--plan <file> is required");
  let st;
  try {
    st = lstatSync(path);
  } catch {
    refuse("the plan file does not exist");
  }
  if (!st.isFile()) refuse("the plan file must be a regular file (not a symlink or directory)");
  if (insideRepo(path)) refuse("the plan file must be stored outside the repository");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse("the plan file is not valid JSON");
  }
}

// Passwords for accounts that must be CREATED come only from an
// owner-only file outside the repository ({"email": "password"}); never
// from arguments, the plan, or the environment.
export function readPasswordsFile(path, plan) {
  if (!path) return new Map();
  let st;
  try {
    st = lstatSync(path);
  } catch {
    refuse("the passwords file does not exist");
  }
  if (!st.isFile()) refuse("the passwords file must be a regular file (not a symlink or directory)");
  if ((st.mode & 0o077) !== 0) refuse("the passwords file must be readable by its owner only (chmod 600)");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) refuse("the passwords file must be owned by the operator");
  if (insideRepo(path)) refuse("the passwords file must be stored outside the repository");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse("the passwords file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) refuse("the passwords file must be a JSON object of email -> password");
  const planEmails = new Set(planPeople(plan).map((p) => p.email));
  const out = new Map();
  for (const [rawEmail, pw] of Object.entries(parsed)) {
    const email = String(rawEmail).trim().toLowerCase();
    if (!planEmails.has(email)) refuse("the passwords file names an account that is not in the plan");
    if (typeof pw !== "string") refuse(`the password for ${email} must be a string`);
    const bytes = Buffer.byteLength(pw, "utf8");
    if (bytes < MIN_PASSWORD_BYTES || bytes > MAX_PASSWORD_BYTES) refuse(`the password for ${email} must be ${MIN_PASSWORD_BYTES}-${MAX_PASSWORD_BYTES} bytes`);
    if (pw.toLowerCase().includes(email.split("@")[0])) refuse(`the password for ${email} must not contain the address`);
    out.set(email, pw);
  }
  return out;
}

// ---------------------------------------------------------------- plan
function exactKeys(obj, allowed, required, where) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) refuse(`${where} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) refuse(`${where}: unknown field '${k}'`);
  for (const k of required) if (obj[k] === undefined) refuse(`${where}: '${k}' is required`);
}
function person(raw, where, roleRequired) {
  exactKeys(raw, roleRequired ? ["email", "name", "role"] : ["email", "name"], roleRequired ? ["email", "name", "role"] : ["email", "name"], where);
  const email = String(raw.email).trim().toLowerCase();
  const name = String(raw.name).trim();
  if (!EMAIL_RE.test(email) || email.length > 254) refuse(`${where}: invalid email`);
  if (name.length < 2 || name.length > 100) refuse(`${where}: name must be 2-100 characters`);
  const out = { email, name };
  if (roleRequired) {
    if (!CLINICIAN_ROLES.includes(raw.role)) refuse(`${where}: role must be one of ${CLINICIAN_ROLES.join(", ")}`);
    out.role = raw.role;
  }
  return out;
}

export function validatePlan(raw) {
  exactKeys(raw, ["target", "organization", "superUser", "clinicians"], ["target", "organization", "superUser"], "plan");
  exactKeys(raw.target, ["intent", "projectRef", "developmentNamespace"], ["intent", "projectRef"], "plan.target");
  const { intent, projectRef, developmentNamespace } = raw.target;
  if (intent !== "production" && intent !== "development") refuse("plan.target.intent must be 'production' or 'development'");
  if (typeof projectRef !== "string" || !PROJECT_REF_PATTERN.test(projectRef)) refuse("plan.target.projectRef must be a Supabase project ref");
  if (intent === "production" && developmentNamespace !== undefined) refuse("plan.target.developmentNamespace is not allowed for production");
  if (intent === "development" && (typeof developmentNamespace !== "string" || !NAMESPACE_RE.test(developmentNamespace))) {
    refuse("plan.target.developmentNamespace is required for development (lowercase letters, digits, hyphens)");
  }
  exactKeys(raw.organization, ["name", "slug"], ["name", "slug"], "plan.organization");
  const orgName = String(raw.organization.name).trim();
  const slug = String(raw.organization.slug).trim();
  if (orgName.length < 2 || orgName.length > 100) refuse("plan.organization.name must be 2-100 characters");
  if (!SLUG_RE.test(slug) || slug.length > 63) refuse("plan.organization.slug must be lowercase letters, digits and single hyphens");
  const superUser = person(raw.superUser, "plan.superUser", false);
  if (raw.clinicians !== undefined && !Array.isArray(raw.clinicians)) refuse("plan.clinicians must be an array");
  const clinicians = (raw.clinicians ?? []).map((c, i) => person(c, `plan.clinicians[${i}]`, true));
  if (clinicians.length > MAX_CLINICIANS) refuse(`plan.clinicians: at most ${MAX_CLINICIANS} per run`);
  const emails = [superUser.email, ...clinicians.map((c) => c.email)];
  if (new Set(emails).size !== emails.length) refuse("plan: every account email must be distinct");
  return Object.freeze({
    target: Object.freeze({ intent, projectRef, developmentNamespace: developmentNamespace ?? null }),
    organization: Object.freeze({ name: orgName, slug }),
    superUser: Object.freeze(superUser),
    clinicians: Object.freeze(clinicians.map((c) => Object.freeze(c))),
  });
}

export function planPeople(plan) {
  return [{ ...plan.superUser, role: "super_user" }, ...plan.clinicians];
}

// ---------------------------------------------------------------- target identity
// Fails closed unless the target is positively identified and classified
// for the declared intent. `registry` is injectable for tests only; the CLI
// always uses the committed registry.
export function resolveTarget({ plan, targetRefArg, env, registry = RESOURCE_IDENTITY }) {
  if (!targetRefArg) refuse("--target-ref <project-ref> is required (the operator must name the target explicitly)");
  if (!PROJECT_REF_PATTERN.test(targetRefArg)) refuse("--target-ref is not a Supabase project ref");
  const expected = plan.target.projectRef;
  if (targetRefArg !== expected) refuse("--target-ref does not match plan.target.projectRef");

  const rawUrl = env.SUPABASE_URL;
  if (!rawUrl) refuse("SUPABASE_URL is not set in the operator environment");
  const url = parseSupabaseUrl(rawUrl);
  if (!url.ok) refuse(`SUPABASE_URL ${url.rule}`);
  if (url.kind !== "hosted" || !url.ref) refuse("SUPABASE_URL does not identify a hosted Supabase project (a local stack cannot be positively identified)");
  if (url.ref !== expected) refuse("SUPABASE_URL belongs to a different project than the expected target");

  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) refuse("SUPABASE_SERVICE_ROLE_KEY is not set in the operator environment");
  const kind = classifySupabaseKey(key);
  if (kind.format === "publishable") refuse("SUPABASE_SERVICE_ROLE_KEY is a publishable key, not a service credential");
  if (kind.format === "unknown") refuse("SUPABASE_SERVICE_ROLE_KEY is not a recognised Supabase key");
  if (kind.format === "jwt") {
    if (kind.role !== "service_role") refuse("SUPABASE_SERVICE_ROLE_KEY is not a service_role key");
    if (kind.ref !== expected) refuse("SUPABASE_SERVICE_ROLE_KEY belongs to a different project than the expected target");
  }

  const dev = registry.developmentSupabaseProjects.includes(expected);
  const prod = registry.productionSupabaseProjects.includes(expected);
  if (plan.target.intent === "production") {
    if (dev) refuse("the target is a registered DEVELOPMENT project; production provisioning refuses it");
    if (!prod) refuse("the target is not an approved production project (web/config/resourceIdentity.json productionSupabaseProjects; add it by reviewed change)");
  } else {
    if (prod) refuse("the target is a registered PRODUCTION project; development provisioning refuses it");
    if (!dev) refuse("the target is not a registered development project");
  }

  const namespace = plan.target.intent === "production" ? expected : `${expected}:development:${plan.target.developmentNamespace}`;
  return Object.freeze({
    ref: expected,
    url: url.url,
    intent: plan.target.intent,
    keyFormat: kind.format === "secret" ? "sb_secret" : "legacy service_role JWT",
    organizationId: claimId(namespace, "initial-organization"),
    superUserMembershipId: claimId(namespace, "initial-super-user-membership"),
  });
}

// ---------------------------------------------------------------- store (Supabase)
export function supabaseStore(admin) {
  const fail = (what, error) => {
    throw new Error(`${what} failed: ${error?.code ?? ""} ${error?.message ?? "unknown error"}`.trim());
  };
  const isUnique = (error) => error?.code === "23505";
  return {
    async probe() {
      const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (error) refuse("the target did not accept the service credential");
    },
    async findUserByEmail(email) {
      for (let page = 1; page <= MAX_USER_PAGES; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
        if (error) fail("listing Auth users", error);
        const users = data?.users ?? [];
        const hit = users.find((u) => (u.email ?? "").toLowerCase() === email);
        if (hit) return { id: hit.id, email: hit.email, appMetadata: hit.app_metadata ?? {} };
        if (users.length < USER_PAGE_SIZE) return null;
      }
      refuse("too many Auth users to search safely; operator review required");
    },
    async createUser({ email, password, name, marker }) {
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name }, app_metadata: { [MARKER_KEY]: marker },
      });
      if (error) {
        if (error.status === 422 || /already|registered|exists/i.test(error.message ?? "")) return { conflict: true };
        fail("creating the Auth account", error);
      }
      return { id: data.user.id };
    },
    async getOrganization(id) {
      const { data, error } = await admin.from("organizations").select("id, name, slug").eq("id", id).maybeSingle();
      if (error) fail("reading the organization", error);
      return data;
    },
    async organizationBySlug(slug) {
      const { data, error } = await admin.from("organizations").select("id, name, slug").eq("slug", slug).maybeSingle();
      if (error) fail("reading organizations", error);
      return data;
    },
    async otherOrganizations(excludeId) {
      const { data, error } = await admin.from("organizations").select("id").neq("id", excludeId).limit(5);
      if (error) fail("reading organizations", error);
      return data ?? [];
    },
    async superUserMemberships() {
      const { data, error } = await admin.from("organization_members").select("id, organization_id, user_id, role").eq("role", "super_user").limit(10);
      if (error) fail("reading memberships", error);
      return data ?? [];
    },
    async membershipsForUser(userId) {
      const { data, error } = await admin.from("organization_members").select("id, organization_id, user_id, role").eq("user_id", userId);
      if (error) fail("reading memberships", error);
      return data ?? [];
    },
    async membershipById(id) {
      const { data, error } = await admin.from("organization_members").select("id, organization_id, user_id, role").eq("id", id).maybeSingle();
      if (error) fail("reading memberships", error);
      return data;
    },
    async profileExists(userId) {
      const { data, error } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
      if (error) fail("reading the profile", error);
      return !!data;
    },
    async insertOrganization(row) {
      const { error } = await admin.from("organizations").insert(row);
      if (isUnique(error)) return { conflict: true };
      if (error) fail("creating the organization", error);
      return {};
    },
    async insertMembership(row) {
      const { error } = await admin.from("organization_members").insert(row);
      if (isUnique(error)) return { conflict: true };
      if (error) fail("creating the membership", error);
      return {};
    },
  };
}

// ---------------------------------------------------------------- evaluation
async function evaluateOrganization(store, plan, target) {
  const id = target.organizationId;
  const existing = await store.getOrganization(id);
  if (existing) {
    if (existing.name === plan.organization.name && existing.slug === plan.organization.slug) return { id, status: "exists" };
    return { id, status: "refuse", reason: "the initial organization already exists with a different name or slug" };
  }
  const bySlug = await store.organizationBySlug(plan.organization.slug);
  if (bySlug) return { id, status: "refuse", reason: "the slug is already used by another organization" };
  if (target.intent === "production" && (await store.otherOrganizations(id)).length > 0) {
    return { id, status: "refuse", reason: "the production project already contains an organization this workflow did not create" };
  }
  return { id, status: "create" };
}

async function evaluateAccount(store, target, who) {
  const orgId = target.organizationId;
  const claim = who.role === "super_user" ? target.superUserMembershipId : null;
  const user = await store.findUserByEmail(who.email);

  if (claim) {
    const claimed = await store.membershipById(claim);
    if (claimed && (!user || claimed.user_id !== user.id)) {
      return { status: "refuse", reason: "the initial super user is already provisioned for a different account" };
    }
    if (target.intent === "production") {
      const others = (await store.superUserMemberships()).filter((m) => m.id !== claim);
      if (others.length > 0) return { status: "refuse", reason: "the production project already has a super user this workflow did not create" };
    }
  }
  if (!user) return { status: "ready", account: "create", membership: "create", userId: null };

  const memberships = await store.membershipsForUser(user.id);
  if (memberships.some((m) => m.organization_id !== orgId)) {
    return { status: "refuse", reason: "the existing account belongs to another organization" };
  }
  const inOrg = memberships.find((m) => m.organization_id === orgId);
  if (inOrg) {
    if (inOrg.role !== who.role) return { status: "refuse", reason: `the existing account already has role '${inOrg.role}' in the organization (roles are never changed silently)` };
    if (claim && inOrg.id !== claim) return { status: "refuse", reason: "the account is a super user through a membership this workflow did not create" };
    return { status: "ready", account: "exists", membership: "exists", userId: user.id };
  }
  const marker = user.appMetadata?.[MARKER_KEY];
  if (marker && marker.organization_id === orgId && marker.role === who.role) {
    return { status: "ready", account: "exists", membership: "recover", userId: user.id };
  }
  return { status: "refuse", reason: "an account with this email already exists and was not created by this workflow" };
}

// ---------------------------------------------------------------- run
// Returns a structured, secret-free report. Never writes unless apply=true
// AND the whole evaluation has no refusal and every account to create has
// an operator-supplied password.
export async function provision({ plan, target, store, passwords = new Map(), apply = false }) {
  const report = { mode: apply ? "apply" : "dry-run", target: { ref: target.ref, intent: target.intent, keyFormat: target.keyFormat }, steps: [], writes: 0, outcome: null };
  await store.probe();

  const org = await evaluateOrganization(store, plan, target);
  report.steps.push({ kind: "organization", slug: plan.organization.slug, id: org.id, status: org.status, reason: org.reason });
  const accounts = [];
  for (const who of planPeople(plan)) {
    const ev = await evaluateAccount(store, target, who);
    const needsPassword = ev.account === "create";
    const step = {
      kind: who.role === "super_user" ? "super_user" : "clinician", email: who.email, role: who.role,
      account: ev.account ?? null, membership: ev.membership ?? null, status: ev.status, reason: ev.reason,
      password: needsPassword ? (passwords.has(who.email) ? "supplied" : "missing") : "not needed",
    };
    report.steps.push(step);
    accounts.push({ who, ev, step });
  }

  const refusals = report.steps.filter((s) => s.status === "refuse");
  const missing = report.steps.filter((s) => s.password === "missing");
  const pending = org.status === "create" || accounts.some((a) => a.ev.account === "create" || a.ev.membership !== "exists");
  if (refusals.length > 0) {
    report.outcome = "refused";
    return report;
  }
  if (missing.length > 0) {
    report.outcome = apply ? "refused" : "blocked_missing_passwords";
    if (apply) report.reason = "a password is required for every account to be created";
    return report;
  }
  if (!pending) {
    report.outcome = "no_change";
    return report;
  }
  if (!apply) {
    report.outcome = "would_apply";
    return report;
  }

  // ---- apply: organization, then each account, membership last.
  const stop = (msg) => {
    throw new ProvisioningRefused(msg, { afterWrites: report.writes > 0 });
  };
  try {
    if (org.status === "create") {
      const r = await store.insertOrganization({ id: org.id, name: plan.organization.name, slug: plan.organization.slug });
      if (r.conflict) {
        const again = await evaluateOrganization(store, plan, target);
        if (again.status !== "exists") stop(`organization: ${again.reason ?? "conflicting concurrent provisioning"}`);
        report.steps[0].status = "exists (concurrent)";
      } else {
        report.writes++;
        report.steps[0].status = "created";
      }
    }
    for (const { who, ev, step } of accounts) {
      let userId = ev.userId;
      let membership = ev.membership;
      if (ev.account === "create") {
        const created = await store.createUser({
          email: who.email, password: passwords.get(who.email), name: who.name,
          marker: { v: 1, organization_id: target.organizationId, role: who.role },
        });
        if (created.conflict) {
          const again = await evaluateAccount(store, target, who);
          if (again.status !== "ready") stop(`${who.email}: ${again.reason}`);
          if (again.account === "create") stop(`${who.email}: the Auth service reported an existing account that cannot be found; operator review`);
          userId = again.userId;
          membership = again.membership;
          step.account = "exists (concurrent)";
        } else {
          report.writes++;
          userId = created.id;
          step.account = "created";
          if (!(await store.profileExists(userId))) stop(`${who.email}: the Auth account exists but its profile row is missing (account left without any membership; operator review)`);
        }
      }
      if (membership === "create" || membership === "recover") {
        const row = { organization_id: target.organizationId, user_id: userId, role: who.role };
        if (who.role === "super_user") row.id = target.superUserMembershipId;
        const r = await store.insertMembership(row);
        if (r.conflict) {
          const again = await evaluateAccount(store, target, who);
          if (again.status !== "ready" || again.membership !== "exists") stop(`${who.email}: ${again.reason ?? "conflicting concurrent provisioning"}`);
          step.membership = "exists (concurrent)";
        } else {
          report.writes++;
          step.membership = membership === "recover" ? "recovered" : "created";
        }
      }
      step.status = "done";
    }
  } catch (e) {
    if (e instanceof ProvisioningRefused) {
      report.outcome = e.afterWrites || report.writes > 0 ? "partial_refused" : "refused";
      report.reason = e.message;
      return report;
    }
    report.outcome = report.writes > 0 ? "partial_failed" : "failed";
    report.reason = e.message;
    return report;
  }
  report.outcome = "applied";
  return report;
}
