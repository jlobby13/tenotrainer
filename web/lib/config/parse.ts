// M3.3 S3 — the ONE application configuration contract (successor of the
// M3.1/M3.2 envValidation.ts). Pure: no I/O, no "server-only" import, so
// unit tests can call it directly with a synthetic environment.
//
// TENOTRAINER_MODE is the sole operating-mode authority: development |
// production | maintenance, required, NO default. NODE_ENV and VERCEL_ENV
// are consistency checks only — never a source of the mode.
//
// Validation fails closed: every problem is collected and a ConfigError is
// thrown naming the VARIABLE and the violated RULE — never a value (not
// even a public one). Secret values are returned separately, wrapped in
// Secret (see secret.ts), and are reachable only through secrets.ts.
//
// Isolated test profile (test infrastructure, NOT a deployment
// configuration): production/maintenance behaviour is verified by spawning
// production-mode servers on isolated ports against the registered
// development project. A process is classified as such ONLY when its
// canonical origin's host is under the reserved .test TLD (RFC 6761 — it can
// never serve real users) AND neither VERCEL nor VERCEL_ENV is set (so it can
// never apply on Vercel). It relaxes exactly two production rules: a
// registered development Supabase project is accepted, and a .test/.invalid
// notification sender is accepted. There is no variable that enables it.
import { Secret } from "./secret";
import type {
  AppConfig,
  EmailProviderName,
  OperatingMode,
  ResourceIdentityRegistry,
  SupabaseKind,
} from "./types";
import { OPERATING_MODES } from "./types";
import { isLoopbackHost, isUnderTld, parseOrigin } from "./origin";
import { classifySupabaseKey, domainIn, parseSupabaseUrl, PROJECT_REF_PATTERN, RESOURCE_IDENTITY } from "./identity";

export type SecretStore = {
  serviceRoleKey: Secret | null;
  resendApiKey: Secret | null;
  // The current dispatch secret first, then the optional rotation partner.
  dispatchSecrets: readonly Secret[];
  legacyBridgeSecret: Secret | null;
  // M3.5 D3 — the rate limiter's dedicated hashing secret (required in real
  // production / maintenance; see parse below).
  authRateLimitSecret: Secret | null;
};

export type ValidatedConfig = { config: AppConfig; secrets: SecretStore };

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid TenoTrainer server configuration: ${problems.join("; ")}`);
    this.problems = problems;
    this.name = "ConfigError";
  }
}

// M3.2 — the internal dispatch credential must be long and random.
export const SAFETY_DISPATCH_SECRET_MIN_LENGTH = 32;
export const AUTH_RATE_LIMIT_SECRET_MIN_LENGTH = 32;
export const AUTH_RATE_LIMIT_SECRET_MIN_DISTINCT = 12;

// Configuration whose only purpose is the legacy FastAPI bridge. Forbidden
// in production and maintenance (FastAPI is not deployed — founder F7).
export const LEGACY_BRIDGE_VARS = ["FASTAPI_URL", "BRIDGE_SECRET"] as const;

// M3.3 S3 (C4) — build-frozen NEXT_PUBLIC_* names that used to carry
// application authority, and their server-only replacements.
export const RETIRED_PUBLIC_NAMES: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_APP_URL: "TENOTRAINER_APP_ORIGIN",
  NEXT_PUBLIC_SUPABASE_URL: "SUPABASE_URL",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "SUPABASE_ANON_KEY",
};
const PUBLIC_PREFIX = "NEXT_PUBLIC_";

const EMAIL_PROVIDERS: readonly EmailProviderName[] = ["disabled", "fake", "resend"];
const DEFAULT_LEGACY_FASTAPI_URL = "http://localhost:8000";

// Reserved / sandbox sender domains that a real deployment must never use.
const SANDBOX_SENDER_DOMAINS = ["resend.dev"];
const RESERVED_SENDER_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_SENDER_TLDS = ["test", "invalid", "example", "localhost"];
// The isolated test profile may use exactly these reserved TLDs.
const ISOLATED_PROFILE_SENDER_TLDS = ["test", "invalid"];

// M3.3 S3c — development email containment.
export const DEV_EMAIL_RECIPIENTS_MAX = 20;
const RESEND_KEY_PREFIX = "re_";
// A deliberately narrow ASCII address grammar (no wildcards, quotes,
// comments, IP literals or Unicode — confusables can never match).
const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

// The ONE normalization used both for the allow-list and for every
// recipient checked against it: trim, then lower-case; anything outside the
// ASCII grammar normalizes to null (and so can never be allowed).
export function normalizeEmailAddress(raw: string): string | null {
  const t = raw.trim();
  if (t.length === 0 || t.length > 254 || /[^\x21-\x7e]/.test(t)) return null;
  const lower = t.toLowerCase();
  return ADDRESS.test(lower) ? lower : null;
}

// Exact, comma-separated addresses; every entry must parse, no duplicates
// (after normalization), at most DEV_EMAIL_RECIPIENTS_MAX entries.
function parseRecipientAllowlist(raw: string, registry: ResourceIdentityRegistry): { recipients: string[]; problems: string[] } {
  const problems: string[] = [];
  const entries = raw.split(",");
  const recipients: string[] = [];
  if (entries.some((e) => e.trim() === "")) problems.push("TENOTRAINER_DEV_EMAIL_RECIPIENTS: contains an empty entry");
  for (const e of entries) {
    if (e.trim() === "") continue;
    const n = normalizeEmailAddress(e);
    if (n === null) { problems.push("TENOTRAINER_DEV_EMAIL_RECIPIENTS: every entry must be one exact email address (no wildcards, patterns or non-ASCII)"); continue; }
    const domain = n.slice(n.indexOf("@") + 1);
    if (domainIn(domain, SANDBOX_SENDER_DOMAINS)) problems.push("TENOTRAINER_DEV_EMAIL_RECIPIENTS: a sandbox provider domain is refused");
    if (domainIn(domain, registry.productionEmailDomains)) problems.push("TENOTRAINER_DEV_EMAIL_RECIPIENTS: a registered production email domain is refused");
    if (recipients.includes(n)) problems.push("TENOTRAINER_DEV_EMAIL_RECIPIENTS: contains a duplicate entry");
    else recipients.push(n);
  }
  if (entries.length > DEV_EMAIL_RECIPIENTS_MAX) problems.push(`TENOTRAINER_DEV_EMAIL_RECIPIENTS: at most ${DEV_EMAIL_RECIPIENTS_MAX} entries`);
  return { recipients, problems: [...new Set(problems)] };
}

type Env = Record<string, string | undefined>;

const present = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";
const value = (v: string | undefined): string | null => (present(v) ? v.trim() : null);

// "Name <local@domain>" or "local@domain" → the lowercased domain, or null.
function senderDomain(raw: string): string | null {
  const m = /^(?:[^<>]*<\s*([^\s<>]+)\s*>|([^\s<>]+))$/.exec(raw.trim());
  const address = m ? (m[1] ?? m[2]) : null;
  const parts = address ? /^[^\s@]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec(address) : null;
  return parts ? parts[1].toLowerCase() : null;
}

export function validateConfig(env: Env, options: { registry?: ResourceIdentityRegistry } = {}): ValidatedConfig {
  const registry = options.registry ?? RESOURCE_IDENTITY;
  const problems: string[] = [];
  const warnings: string[] = [];
  // M3.4e — a project can never be both development and production.
  if (registry.productionSupabaseProjects.some((r) => registry.developmentSupabaseProjects.includes(r))) {
    problems.push("resourceIdentity.json: developmentSupabaseProjects and productionSupabaseProjects must be disjoint");
  }

  // ------------------------------------------------------------ mode
  const rawMode = env.TENOTRAINER_MODE;
  const mode = OPERATING_MODES.find((m) => m === rawMode) as OperatingMode | undefined;
  if (!present(rawMode)) problems.push("TENOTRAINER_MODE: is required (development | production | maintenance)");
  else if (!mode) problems.push("TENOTRAINER_MODE: must be exactly development, production or maintenance");
  const prodLike = mode === "production" || mode === "maintenance";

  // ------------------------------------------------------------ platform (consistency only)
  const nodeEnv = env.NODE_ENV;
  const vercelEnv = value(env.VERCEL_ENV);
  const vercelMarked = env.VERCEL !== undefined || env.VERCEL_ENV !== undefined;
  if (prodLike && nodeEnv !== "production") problems.push(`NODE_ENV: must be production in ${mode} mode`);
  if (vercelEnv !== null) {
    if (prodLike && vercelEnv !== "production") problems.push(`VERCEL_ENV: must be production for ${mode} mode`);
    if (mode === "development" && vercelEnv === "production") problems.push("VERCEL_ENV: a production deployment must not run in development mode");
  }

  // ------------------------------------------------------------ canonical origin
  let appOrigin = "";
  let isolatedTestProfile = false;
  const rawOrigin = value(env.TENOTRAINER_APP_ORIGIN);
  if (rawOrigin === null) {
    problems.push("TENOTRAINER_APP_ORIGIN: is required");
  } else {
    const o = parseOrigin(rawOrigin);
    if (!o.ok) {
      problems.push(`TENOTRAINER_APP_ORIGIN: ${o.rule}`);
    } else if (prodLike && (o.protocol !== "https:" || isLoopbackHost(o.hostname))) {
      problems.push(`TENOTRAINER_APP_ORIGIN: must be a non-loopback https origin in ${mode} mode`);
    } else {
      appOrigin = o.origin;
      isolatedTestProfile = prodLike && isUnderTld(o.hostname, ["test"]) && !vercelMarked;
    }
  }
  // Alpha 1 — a Vercel Preview deployment's generated-link origin is its OWN
  // Git-branch alias, from the platform system variable VERCEL_BRANCH_URL
  // (set by Vercel for each deployment — never request metadata). One
  // Preview-scope TENOTRAINER_APP_ORIGIN is shared by every branch's Preview,
  // so it would hand each Preview another branch's host. Required (fail
  // closed) on a Preview; never consulted in production/maintenance (they
  // require VERCEL_ENV=production) or locally (no VERCEL_ENV).
  if (mode === "development" && vercelEnv === "preview") {
    const branchHost = value(env.VERCEL_BRANCH_URL);
    const b = branchHost === null ? null : parseOrigin(`https://${branchHost.toLowerCase()}`);
    if (b === null) {
      problems.push("VERCEL_BRANCH_URL: is required on a Vercel Preview deployment (its own branch alias is the link origin)");
    } else if (
      !b.ok ||
      b.origin !== `https://${b.hostname}` ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(b.hostname) ||
      isLoopbackHost(b.hostname)
    ) {
      problems.push("VERCEL_BRANCH_URL: must be a bare non-loopback hostname (no scheme, port, path or query)");
    } else {
      appOrigin = b.origin;
    }
  }

  // ------------------------------------------------------------ Supabase identity
  let supabaseUrl = "";
  let supabaseKind: SupabaseKind = "hosted";
  let supabaseRef: string | null = null;
  const rawSupabaseUrl = value(env.SUPABASE_URL);
  if (rawSupabaseUrl === null) {
    problems.push("SUPABASE_URL: is required");
  } else {
    const s = parseSupabaseUrl(rawSupabaseUrl);
    if (!s.ok) {
      problems.push(`SUPABASE_URL: ${s.rule}`);
    } else {
      supabaseUrl = s.url;
      supabaseKind = s.kind;
      supabaseRef = s.ref;
    }
  }
  const expectedRef = value(env.TENOTRAINER_SUPABASE_PROJECT_REF);
  if (expectedRef !== null && !PROJECT_REF_PATTERN.test(expectedRef)) {
    problems.push("TENOTRAINER_SUPABASE_PROJECT_REF: must be a Supabase project ref (20 lowercase letters)");
  }
  if (supabaseUrl) {
    const inDevelopment = supabaseRef !== null && registry.developmentSupabaseProjects.includes(supabaseRef);
    const inProduction = supabaseRef !== null && registry.productionSupabaseProjects.includes(supabaseRef);
    if (prodLike) {
      if (supabaseKind === "local") problems.push(`SUPABASE_URL: a local Supabase is refused in ${mode} mode`);
      if (expectedRef === null) problems.push(`TENOTRAINER_SUPABASE_PROJECT_REF: is required in ${mode} mode`);
      if (supabaseKind === "hosted") {
        if (expectedRef !== null && expectedRef !== supabaseRef) problems.push("TENOTRAINER_SUPABASE_PROJECT_REF: must equal the project ref of SUPABASE_URL");
        if (isolatedTestProfile) {
          if (!inDevelopment) problems.push("SUPABASE_URL: under the isolated test profile the project must be a registered development project");
          if (inProduction) problems.push("SUPABASE_URL: under the isolated test profile a registered production project is refused");
        } else if (inDevelopment) {
          problems.push(`SUPABASE_URL: is a registered development project and is refused in ${mode} mode`);
        } else if (!inProduction) {
          // M3.4e (N1) — positive identity: not being a development project
          // is insufficient; the project must be a reviewed production entry.
          problems.push(`SUPABASE_URL: must be a registered production project in ${mode} mode`);
        }
      }
    } else if (mode === "development") {
      if (supabaseKind === "hosted") {
        if (!inDevelopment) problems.push("SUPABASE_URL: a hosted project must be a registered development project in development mode");
        if (inProduction) problems.push("SUPABASE_URL: a registered production project is refused in development mode");
        if (expectedRef !== null && expectedRef !== supabaseRef) problems.push("TENOTRAINER_SUPABASE_PROJECT_REF: must equal the project ref of SUPABASE_URL");
      } else if (expectedRef !== null) {
        problems.push("TENOTRAINER_SUPABASE_PROJECT_REF: must not be set for a local Supabase");
      }
    }
  }

  const anonKey = value(env.SUPABASE_ANON_KEY);
  const serviceKey = value(env.SUPABASE_SERVICE_ROLE_KEY);
  if (anonKey === null) problems.push("SUPABASE_ANON_KEY: is required");
  if (serviceKey === null) problems.push("SUPABASE_SERVICE_ROLE_KEY: is required");
  const checkKey = (name: string, raw: string, jwtRole: string, prefixFormat: "publishable" | "secret") => {
    const k = classifySupabaseKey(raw);
    if (k.format === "unknown") {
      problems.push(`${name}: is not a recognised Supabase API key`);
    } else if (k.format === "jwt") {
      if (k.role !== jwtRole) problems.push(`${name}: has the wrong key role for this slot`);
      if (supabaseKind === "hosted" && supabaseRef !== null && k.ref !== supabaseRef) problems.push(`${name}: belongs to a different project than SUPABASE_URL`);
    } else if (k.format !== prefixFormat) {
      problems.push(`${name}: has the wrong key type for this slot`);
    }
  };
  if (anonKey !== null) checkKey("SUPABASE_ANON_KEY", anonKey, "anon", "publishable");
  if (serviceKey !== null) checkKey("SUPABASE_SERVICE_ROLE_KEY", serviceKey, "service_role", "secret");
  if (anonKey !== null && anonKey === serviceKey) problems.push("SUPABASE_SERVICE_ROLE_KEY: must differ from SUPABASE_ANON_KEY");

  // ------------------------------------------------------------ feature gates (mode outranks them)
  const runtimeRaw = value(env.C5_PATIENT_RUNTIME_ENABLED);
  const publishRaw = value(env.C5_PRESCRIPTION_PUBLISH_ENABLED);
  if (prodLike) {
    // The runtime gate can never select legacy outside development: "false"
    // (or any other value) is rejected so it cannot look like a rollback switch.
    if (runtimeRaw !== null && runtimeRaw !== "true") {
      problems.push(`C5_PATIENT_RUNTIME_ENABLED: must be unset or "true" in ${mode} mode (C5 is always the patient runtime)`);
    }
  } else if (runtimeRaw !== null && runtimeRaw !== "true" && runtimeRaw !== "false") {
    problems.push('C5_PATIENT_RUNTIME_ENABLED: must be "true" or "false"');
  }
  if (publishRaw !== null && publishRaw !== "true" && publishRaw !== "false") {
    problems.push('C5_PRESCRIPTION_PUBLISH_ENABLED: must be "true" or "false"');
  }

  // ------------------------------------------------------------ application email
  if (present(env.SAFETY_EMAIL_PROVIDER)) problems.push("SAFETY_EMAIL_PROVIDER: has been renamed; use TENOTRAINER_EMAIL_PROVIDER");
  const providerRaw = value(env.TENOTRAINER_EMAIL_PROVIDER);
  let provider: EmailProviderName = "disabled";
  if (providerRaw !== null) {
    const p = EMAIL_PROVIDERS.find((x) => x === providerRaw);
    if (p) provider = p;
    else problems.push('TENOTRAINER_EMAIL_PROVIDER: must be "disabled", "fake" or "resend"');
  }
  if (prodLike) {
    if (providerRaw === "fake") problems.push(`TENOTRAINER_EMAIL_PROVIDER: "fake" is forbidden in ${mode} mode`);
    else if (providerRaw !== "resend") problems.push(`TENOTRAINER_EMAIL_PROVIDER: must be "resend" in ${mode} mode`);
  }
  const resendKey = value(env.RESEND_API_KEY);
  const from = value(env.TENOTRAINER_NOTIFICATION_EMAIL_FROM);
  const emailRequired = provider === "resend" || prodLike;
  if (emailRequired && resendKey === null) problems.push("RESEND_API_KEY: is required for application email");
  if (emailRequired && from === null) problems.push("TENOTRAINER_NOTIFICATION_EMAIL_FROM: is required for application email");
  if (emailRequired && resendKey !== null && !resendKey.startsWith(RESEND_KEY_PREFIX)) problems.push("RESEND_API_KEY: is not a Resend API key");
  // The Resend SDK reads RESEND_BASE_URL itself: it would redirect provider
  // traffic (and the API key) to another host. Not an application setting.
  if (present(env.RESEND_BASE_URL)) problems.push("RESEND_BASE_URL: would redirect email provider traffic and is refused");
  // M3.3 S3c — development email containment (exact recipient allow-list).
  let devEmailRecipients: string[] | null = null;
  const recipientsRaw = value(env.TENOTRAINER_DEV_EMAIL_RECIPIENTS);
  if (prodLike) {
    if (recipientsRaw !== null) problems.push(`TENOTRAINER_DEV_EMAIL_RECIPIENTS: is a development-only control and is refused in ${mode} mode`);
    for (const key of ["SAFETY_FAKE_PROVIDER_LOG", "SAFETY_FAKE_PROVIDER_SCRIPT"]) {
      if (present(env[key])) problems.push(`${key}: is a test-only fake-provider control and is refused in ${mode} mode`);
    }
  } else if (mode === "development") {
    if (provider === "resend") {
      if (recipientsRaw === null) problems.push('TENOTRAINER_DEV_EMAIL_RECIPIENTS: is required when TENOTRAINER_EMAIL_PROVIDER is "resend" in development');
      else {
        const parsed = parseRecipientAllowlist(recipientsRaw, registry);
        problems.push(...parsed.problems);
        devEmailRecipients = parsed.recipients;
      }
    } else if (recipientsRaw !== null) {
      problems.push('TENOTRAINER_DEV_EMAIL_RECIPIENTS: is only valid with TENOTRAINER_EMAIL_PROVIDER "resend"');
    }
  }
  if (from !== null) {
    const domain = senderDomain(from);
    if (domain === null) {
      problems.push("TENOTRAINER_NOTIFICATION_EMAIL_FROM: must be an email address (optionally \"Name <address>\")");
    } else if (prodLike) {
      const sandbox = domainIn(domain, SANDBOX_SENDER_DOMAINS);
      const reserved = domainIn(domain, RESERVED_SENDER_DOMAINS) || isUnderTld(domain, RESERVED_SENDER_TLDS);
      const isolatedAllowed = isolatedTestProfile && isUnderTld(domain, ISOLATED_PROFILE_SENDER_TLDS);
      if (sandbox) problems.push(`TENOTRAINER_NOTIFICATION_EMAIL_FROM: a sandbox sender domain is refused in ${mode} mode`);
      else if (reserved && !isolatedAllowed) problems.push(`TENOTRAINER_NOTIFICATION_EMAIL_FROM: a reserved sender domain is refused in ${mode} mode`);
      if (domainIn(domain, registry.developmentEmailDomains)) problems.push(`TENOTRAINER_NOTIFICATION_EMAIL_FROM: a registered development sender domain is refused in ${mode} mode`);
    } else if (mode === "development" && provider === "resend") {
      // Development delivery only from an explicitly registered development
      // sending domain — never a sandbox or production identity.
      if (domainIn(domain, SANDBOX_SENDER_DOMAINS)) problems.push("TENOTRAINER_NOTIFICATION_EMAIL_FROM: a sandbox sender domain is refused");
      if (domainIn(domain, registry.productionEmailDomains)) problems.push("TENOTRAINER_NOTIFICATION_EMAIL_FROM: a registered production sender domain is refused in development mode");
      if (!domainIn(domain, registry.developmentEmailDomains)) problems.push("TENOTRAINER_NOTIFICATION_EMAIL_FROM: development delivery requires a registered development sending domain");
    }
  }

  // ------------------------------------------------------------ internal dispatch credential
  const dispatchCurrent = value(env.SAFETY_DISPATCH_SECRET);
  const dispatchNext = value(env.SAFETY_DISPATCH_SECRET_NEXT);
  if (dispatchCurrent !== null && dispatchCurrent.length < SAFETY_DISPATCH_SECRET_MIN_LENGTH) {
    problems.push(`SAFETY_DISPATCH_SECRET: must be at least ${SAFETY_DISPATCH_SECRET_MIN_LENGTH} characters`);
  }
  if (dispatchNext !== null) {
    if (dispatchNext.length < SAFETY_DISPATCH_SECRET_MIN_LENGTH) problems.push(`SAFETY_DISPATCH_SECRET_NEXT: must be at least ${SAFETY_DISPATCH_SECRET_MIN_LENGTH} characters`);
    if (dispatchCurrent === null) problems.push("SAFETY_DISPATCH_SECRET_NEXT: requires SAFETY_DISPATCH_SECRET");
    else if (dispatchNext === dispatchCurrent) problems.push("SAFETY_DISPATCH_SECRET_NEXT: must differ from SAFETY_DISPATCH_SECRET");
  }
  if (prodLike && dispatchCurrent === null) problems.push(`SAFETY_DISPATCH_SECRET: is required in ${mode} mode`);

  // ------------------------------------------------------------ rate-limit hashing secret (M3.5 D3)
  // Required in real production / maintenance. Development and the isolated
  // production-mode test profile (a reserved .test origin on a registered
  // development project, never on Vercel — structurally unable to be a real
  // deployment) may omit it and then use a public, development-only key.
  const rateLimitSecret = value(env.AUTH_RATE_LIMIT_SECRET);
  if (rateLimitSecret !== null) {
    if (rateLimitSecret.length < AUTH_RATE_LIMIT_SECRET_MIN_LENGTH) problems.push(`AUTH_RATE_LIMIT_SECRET: must be at least ${AUTH_RATE_LIMIT_SECRET_MIN_LENGTH} characters`);
    else if (new Set(rateLimitSecret).size < AUTH_RATE_LIMIT_SECRET_MIN_DISTINCT) problems.push(`AUTH_RATE_LIMIT_SECRET: must be random (at least ${AUTH_RATE_LIMIT_SECRET_MIN_DISTINCT} distinct characters)`);
    if (rateLimitSecret === serviceKey || rateLimitSecret === dispatchCurrent || rateLimitSecret === dispatchNext) {
      problems.push("AUTH_RATE_LIMIT_SECRET: must differ from every other credential");
    }
  } else if (prodLike && !isolatedTestProfile) {
    problems.push(`AUTH_RATE_LIMIT_SECRET: is required in ${mode} mode`);
  } else if (mode === "development") {
    warnings.push("AUTH_RATE_LIMIT_SECRET is not set; rate limiting uses the public development-only key");
  }

  // ------------------------------------------------------------ refused / retired configuration
  const retiredSenderName = "RESEND_FROM";
  if (prodLike) {
    for (const key of LEGACY_BRIDGE_VARS) {
      if (present(env[key])) problems.push(`${key}: is legacy bridge configuration and is forbidden in ${mode} mode`);
    }
    if (present(env.ANTHROPIC_API_KEY)) problems.push(`ANTHROPIC_API_KEY: is not a declared credential of the Next.js application and is refused in ${mode} mode`);
    if (present(env[retiredSenderName])) problems.push(`${retiredSenderName}: has been renamed to TENOTRAINER_NOTIFICATION_EMAIL_FROM and is refused in ${mode} mode`);
  } else if (mode === "development" && present(env[retiredSenderName])) {
    warnings.push(`${retiredSenderName} is ignored; use TENOTRAINER_NOTIFICATION_EMAIL_FROM`);
  }
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(PUBLIC_PREFIX) || !present(env[key])) continue;
    const replacement = RETIRED_PUBLIC_NAMES[key];
    if (prodLike) {
      problems.push(`${key}: NEXT_PUBLIC_* configuration is refused in ${mode} mode (application configuration is server-only${replacement ? `; use ${replacement}` : ""})`);
    } else if (mode === "development") {
      warnings.push(replacement ? `${key} is ignored; use ${replacement}` : `${key} is ignored (NEXT_PUBLIC_* configuration is not read)`);
    }
  }

  // ------------------------------------------------------------ legacy bridge (development only)
  let fastapiUrl = DEFAULT_LEGACY_FASTAPI_URL;
  if (mode === "development") {
    const rawFastapi = value(env.FASTAPI_URL);
    if (rawFastapi !== null) {
      try {
        const u = new URL(rawFastapi);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
        fastapiUrl = rawFastapi;
      } catch {
        problems.push("FASTAPI_URL: must be an absolute http(s) URL");
      }
    }
  }

  if (problems.length > 0 || !mode) throw new ConfigError(problems);

  const secrets: SecretStore = {
    serviceRoleKey: serviceKey !== null ? new Secret(serviceKey) : null,
    resendApiKey: resendKey !== null ? new Secret(resendKey) : null,
    dispatchSecrets: [dispatchCurrent, dispatchNext].filter((s): s is string => s !== null).map((s) => new Secret(s)),
    legacyBridgeSecret: mode === "development" && present(env.BRIDGE_SECRET) ? new Secret(env.BRIDGE_SECRET.trim()) : null,
    authRateLimitSecret: rateLimitSecret !== null ? new Secret(rateLimitSecret) : null,
  };
  const base = {
    appOrigin,
    supabase: { url: supabaseUrl, anonKey: anonKey!, kind: supabaseKind, ref: supabaseRef },
    runtimeGate: runtimeRaw === "true",
    publishGate: publishRaw === "true",
    email: { provider, from },
    safetyDispatchConfigured: dispatchCurrent !== null,
    platform: { isDevServer: nodeEnv === "development", onVercel: vercelMarked },
    warnings: Object.freeze(warnings),
  };
  const config: AppConfig =
    mode === "development"
      ? {
          ...base,
          mode,
          isolatedTestProfile: false,
          legacyBridge: { fastapiUrl },
          fakeProvider: {
            logPath: env.SAFETY_FAKE_PROVIDER_LOG || undefined,
            scriptPath: env.SAFETY_FAKE_PROVIDER_SCRIPT || undefined,
          },
          devEmailRecipients: devEmailRecipients ? Object.freeze([...devEmailRecipients]) : null,
        }
      : { ...base, mode, isolatedTestProfile };
  return { config, secrets };
}
