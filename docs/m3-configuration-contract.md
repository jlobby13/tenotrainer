# M3.3 S3 — the TenoTrainer configuration contract

This is the authoritative description of how the Next.js application (`web/`)
is configured. It describes what the code enforces today; nothing here is
aspirational. The enforcing code is `web/lib/config/` (the contract itself is
`web/lib/config/parse.ts`). The legacy FastAPI app (`app/`, root `.env`) is
outside this contract and is development-only.

**Completing M3.3 S3 does not make TenoTrainer production-ready.** See
[Remaining production blockers](#remaining-production-blockers).

## Contents

- [Principles](#principles)
- [Variables](#variables)
- [Mode matrix](#mode-matrix)
- [Canonical origin](#canonical-origin)
- [Supabase identity](#supabase-identity)
- [Secret boundary](#secret-boundary)
- [Application email](#application-email)
- [Readiness (`/api/ready`)](#readiness-apiready)
- [Resource identity registry](#resource-identity-registry)
- [Isolated test profile (test infrastructure)](#isolated-test-profile-test-infrastructure)
- [Preview deployments](#preview-deployments)
- [Static enforcement and verification](#static-enforcement-and-verification)
- [Phase 2: local `.env.local` cleanup](#phase-2-local-envlocal-cleanup)
- [M3.4 handoff](#m34-handoff)
- [Known follow-up issues (not S3 failures)](#known-follow-up-issues-not-s3-failures)
- [Remaining production blockers](#remaining-production-blockers)

## Principles

1. **`TENOTRAINER_MODE` is the only operating-mode authority**:
   `development` | `production` | `maintenance`. Required, no default. It is
   never inferred from `NODE_ENV`, `VERCEL_ENV`, a hostname, a Supabase
   project, a deployment URL or the presence of credentials.
2. **One reader.** `web/lib/config/index.ts` is the only application module
   that reads `process.env` (lazily, at first use, through a variable — so no
   value can be inlined into a build). The single permitted exception is
   `process.env.NEXT_RUNTIME` in `web/instrumentation.ts` (Next requires it
   for runtime-conditional imports).
3. **No build-time configuration.** Nothing reads `NEXT_PUBLIC_*`; a build
   needs no environment at all, and no configured value is frozen into
   `.next/server` or `.next/static`. Configuration is validated at runtime.
4. **Fail closed.** Every problem is collected and reported as
   `VARIABLE: rule` — never the supplied value (not even a public one).
   - At process start (`web/instrumentation-node.ts`): an invalid
     configuration logs the problems and the process exits.
   - Per request, in the proxy: an invalid configuration answers 503, or
     `503 {"status":"unavailable"}` for `/api/ready`.
5. **Mode outranks feature gates.** Production and maintenance can never
   route to the legacy runtime, whatever a gate says.

## Variables

### Application variables (founder-managed)

| Variable | Purpose | Secret |
|---|---|---|
| `TENOTRAINER_MODE` | `development` \| `production` \| `maintenance` | no |
| `TENOTRAINER_APP_ORIGIN` | The canonical application origin, an exact `scheme://host[:port]`. The only base for generated links and trusted redirects. | no |
| `SUPABASE_URL` | Supabase API URL (server-only) | no |
| `SUPABASE_ANON_KEY` | Supabase anon / publishable key (server-only; never sent to the browser by the app) | no (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role / secret key | **yes** |
| `TENOTRAINER_SUPABASE_PROJECT_REF` | The expected Supabase project ref (identity pin) | no |
| `C5_PATIENT_RUNTIME_ENABLED` | Development only: `true` selects the C5 patient runtime, `false` legacy | no |
| `C5_PRESCRIPTION_PUBLISH_ENABLED` | `true` enables prescription publication; `false`/unset = publication freeze | no |
| `TENOTRAINER_EMAIL_PROVIDER` | `disabled` \| `fake` \| `resend` — the single application email authority | no |
| `RESEND_API_KEY` | Resend API key (`re_…`) | **yes** |
| `TENOTRAINER_NOTIFICATION_EMAIL_FROM` | Application-notification sender, `local@domain` or `Name <local@domain>` | no |
| `TENOTRAINER_DEV_EMAIL_RECIPIENTS` | Development-only exact recipient allow-list (see [Application email](#application-email)) | no |
| `SAFETY_DISPATCH_SECRET` | Bearer credential for the internal safety-dispatch endpoint (≥ 32 chars) | **yes** |
| `SAFETY_DISPATCH_SECRET_NEXT` | Optional rotation partner (≥ 32 chars, distinct, needs the current secret) | **yes** |

### Legacy, development-only (temporary — removed with the M6 legacy retirement)

| Variable | Purpose | Secret |
|---|---|---|
| `FASTAPI_URL` | Legacy FastAPI base URL (default `http://localhost:8000`) | no |
| `BRIDGE_SECRET` | Legacy Next.js ↔ FastAPI bridge credential | **yes** |

### Test-only (never set in a deployment)

| Variable | Purpose |
|---|---|
| `SAFETY_FAKE_PROVIDER_LOG`, `SAFETY_FAKE_PROVIDER_SCRIPT` | Controls of the development fake safety-email provider |

### Platform-owned consistency inputs (not founder-managed, not secrets)

| Variable | Set by | Used for |
|---|---|---|
| `NODE_ENV` | Next.js (`next start` / `next build` → `production`, `next dev` → `development`) | production/maintenance require `production`; development's dev-server CSP allowances |
| `VERCEL_ENV`, `VERCEL` | Vercel | consistency checks only (see the matrix); presence also disables the isolated test profile |
| `NEXT_RUNTIME` | Next.js | `instrumentation.ts` runtime-conditional import only |

These never supply a mode and must not be configured by hand.

### Retired (never configure these)

| Retired name | Replacement | development | production / maintenance |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `TENOTRAINER_APP_ORIGIN` | ignored, startup warning | **refused** |
| `NEXT_PUBLIC_SUPABASE_URL` | `SUPABASE_URL` | ignored, startup warning | **refused** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `SUPABASE_ANON_KEY` | ignored, startup warning | **refused** |
| any other `NEXT_PUBLIC_*` | (none: configuration is server-only) | ignored, startup warning | **refused** |
| `RESEND_FROM` | `TENOTRAINER_NOTIFICATION_EMAIL_FROM` | ignored, startup warning | **refused** |
| `SAFETY_EMAIL_PROVIDER` | `TENOTRAINER_EMAIL_PROVIDER` | **refused** | **refused** |

`NEXT_PUBLIC_*` values are frozen into a build at build time (in server code
too), so they can never carry application authority. A future browser
Supabase client would be a separate, explicit public-configuration design.

The developer `web/.env.local` still carries `NEXT_PUBLIC_APP_URL`,
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`RESEND_FROM` **only** because the normal checkout still runs pre-S3 code.
They are removed in [Phase 2](#phase-2-local-envlocal-cleanup).

### Always refused (not application settings)

| Variable | Where | Why |
|---|---|---|
| `RESEND_BASE_URL` | every mode | The Resend SDK reads it; it would redirect provider traffic (and the API key) to another host. |
| `ANTHROPIC_API_KEY` | production / maintenance | Not a declared credential of the Next.js application. This is not a permanent prohibition: a future AI subsystem would add its own gated configuration after a separate data-minimization, privacy, clinical-authority and credential review. Development does not read it. |
| `FASTAPI_URL`, `BRIDGE_SECRET` | production / maintenance | FastAPI is never deployed. |

## Mode matrix

R = required · O = optional · F = refused at startup · W = ignored with a startup warning.

| Variable / rule | development | production | maintenance |
|---|---|---|---|
| `TENOTRAINER_MODE` | R | R | R |
| `NODE_ENV` | any | must be `production` | must be `production` |
| `VERCEL_ENV` (only when set) | must not be `production` | must be `production` | must be `production` |
| `TENOTRAINER_APP_ORIGIN` | R; exact http(s) origin, loopback allowed | R; exact **https**, non-loopback origin | R (as production) |
| `SUPABASE_URL` | R; registered development project, or local loopback | R; `https://<ref>.supabase.co`, not a registered development project | R (as production) |
| `TENOTRAINER_SUPABASE_PROJECT_REF` | O; must match when set; must not be set for a local Supabase | R; must equal the URL's ref | R |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | R | R | R |
| `C5_PATIENT_RUNTIME_ENABLED` | O; `"true"` / `"false"` | unset or `"true"` only (C5 is always the patient runtime) | unset or `"true"` only |
| `C5_PRESCRIPTION_PUBLISH_ENABLED` | O; `"true"` / `"false"` | O; `"true"` / `"false"` (`false`/unset = freeze) | validated, but publication is always frozen |
| `TENOTRAINER_EMAIL_PROVIDER` | O; unset = `disabled` | R `resend` (`fake` F, `disabled`/unset F) | R `resend` |
| `RESEND_API_KEY` | R only with `resend`; `re_…` | R; `re_…` | R |
| `TENOTRAINER_NOTIFICATION_EMAIL_FROM` | R only with `resend`; registered development sending domain | R; not sandbox / reserved / registered-development domain | R |
| `TENOTRAINER_DEV_EMAIL_RECIPIENTS` | R only with `resend`; F otherwise | F | F |
| `SAFETY_DISPATCH_SECRET` | O; ≥ 32 | R; ≥ 32 | R; ≥ 32 |
| `SAFETY_DISPATCH_SECRET_NEXT` | O | O | O |
| `SAFETY_FAKE_PROVIDER_*` | O (test-only) | F | F |
| `FASTAPI_URL`, `BRIDGE_SECRET` | O (legacy) | F | F |
| `ANTHROPIC_API_KEY` | not read | F | F |
| Retired names | see [Retired](#retired-never-configure-these) | F | F |

Booleans are strict (`"true"` / `"false"` only). Empty or whitespace-only
values count as unset. Secrets are trimmed.

### Development

- **Configuration.** An explicit `TENOTRAINER_APP_ORIGIN` is required. The
  Supabase project must be a registered development project
  (`web/config/resourceIdentity.json`) or a local (loopback) Supabase.
- **Patient runtime.** `C5_PATIENT_RUNTIME_ENABLED` selects C5 or the legacy
  runtime. The legacy FastAPI bridge, the bridge routes and the tester/admin
  invitation workflow exist only here.
- **Email.** Disabled by default. `fake` never reaches the network. `resend`
  works only under the full containment contract (see
  [Application email](#application-email)).
- **Origin and redirects.** No host canonicalization. Redirects are
  request-local, so localhost, 127.0.0.1 and spawned test ports redirect to
  themselves. Generated links (invitations, safety notifications) use
  `TENOTRAINER_APP_ORIGIN`.
- **Retired names.** Retired `NEXT_PUBLIC_*` names and `RESEND_FROM` are
  ignored with a startup warning (the transition).

### Production

- **Configuration requirements:**
  - an explicit `TENOTRAINER_MODE=production`;
  - `NODE_ENV=production`, and `VERCEL_ENV=production` when present;
  - a canonical https non-loopback origin;
  - the pinned Supabase project identity;
  - C5 always the patient runtime;
  - the Resend-only application email contract, with a dispatch secret.
- **Refused:** development and test email controls, the FastAPI bridge,
  Anthropic, and retired / `NEXT_PUBLIC_*` names.
- **Runtime behaviour:**
  - canonical-host enforcement and exact mutation `Origin`;
  - safety dispatch claims every eligible due intent (scope NULL; the request
    body is never read);
  - `/api/ready` reports readiness.

### Maintenance

The same configuration and security requirements as production. On top of
them:

- Patients see the unavailable experience.
- Clinicians and super users are read-only, and every clinical mutation is
  refused. This is enforced in the proxy, the HTTP and Server Action
  boundaries, and the clinical libraries.
- Prescription publication is frozen.
- The safety-dispatch endpoint keeps working (the narrow M3.2 operational
  exception).
- `/api/ready` reports **ready** when the configuration and the database
  probe succeed.

Maintenance is an intentional operating state, not an unhealthy or crashed
deployment.

## Canonical origin

`TENOTRAINER_APP_ORIGIN` is authoritative in production and maintenance.
Request-controlled metadata (`Host`, `X-Forwarded-Host`,
`X-Forwarded-Proto`, `request.url`, `nextUrl.origin`, deployment URLs) never
chooses a trusted URL.

### Algorithm (proxy, before the mode and cross-origin rules)

1. **Observed host.** The first `X-Forwarded-Host` value, else `Host`,
   trimmed and lower-cased. It is used only for comparison.
2. **Match.** If it equals the canonical origin's host (name plus any
   non-default port), the request proceeds.
3. **Wrong host, GET/HEAD.** `308` to `TENOTRAINER_APP_ORIGIN + path + query`.
   Scheme, host and port come only from configuration.
   - Next re-serializes the query, so it is preserved parameter for
     parameter.
   - Next itself answers repeated-slash paths with a relative, path-only
     308.
4. **Wrong host, any other method (including OPTIONS).** `403
   {"error":"NONCANONICAL_HOST_REFUSED"}`. The request never reaches a
   handler and is never redirected.
5. **Mutation Origin.** For unsafe methods, a present `Origin` must equal
   the canonical origin serialization **exactly** (scheme, host and port).
   - `null`, malformed and multiple values are refused.
   - `Sec-Fetch-Site` `cross-site` / `same-site` / unknown values are
     refused.
   - With neither `Origin` nor `Sec-Fetch-Site` (a non-browser caller), the
     request continues to the route's own authentication.
6. **`X-Forwarded-Proto`** is never consulted.

### Where the configured origin is used

- **Trusted redirects:** proxy login and dashboard redirects, the auth
  callback, logout and the legacy launch route. In development these go to
  the request's own origin instead.
- **Generated links:** invitation and safety-notification links.

### Development

No host canonicalization, and the host-based mutation comparison is kept.

### M3.4 verification requirement

The algorithm assumes Vercel delivers the **public host as the first
`X-Forwarded-Host` value, else `Host`**. M3.4 must confirm this with a real
deployed probe. If deployment evidence shows an internal host there (a
redirect loop), M3.4 changes the rule to Host-only. This is not resolved by
speculation.

M3.4a provides the probe (`web/scripts/deploymentProbe.mjs`; see
`docs/m3-deployment-readiness.md`). It reports; it never changes the rule.

## Supabase identity

- **URL classification.** `SUPABASE_URL` is classified as:
  - **hosted:** exactly `https://<20-letter ref>.supabase.co`;
  - **local:** a loopback host;
  - otherwise refused. Custom Supabase domains are unsupported in v1.
- **Production / maintenance:**
  - hosted only;
  - `TENOTRAINER_SUPABASE_PROJECT_REF` is required and must equal the URL's
    ref;
  - a ref registered as a development project is refused (except under the
    isolated test profile);
  - **M3.4e (N1):** the ref must be registered in `productionSupabaseProjects`.
    Not being a development project is not enough: an unregistered hosted
    project is refused;
  - the development and production project lists must be disjoint (checked
    in every mode).
- **Development:**
  - a hosted ref must be a registered development project and must not be a
    registered production project;
  - local Supabase is allowed.
- **Keys:**
  - **Legacy JWT keys** are classified without verification. Their `role`
    claim must fit the slot (`anon` / `service_role`, which catches swapped
    keys), and their `ref` claim must equal the URL's ref on a hosted
    project.
  - **New-format keys** must be in the right slot: `sb_publishable_…` for
    anon, `sb_secret_…` for service. **Limitation:** they carry no project
    ref, so a cross-project new-format key cannot be detected at startup.
    `/api/ready` (which uses the anon key) and the M3.4 deployment
    verification are the backstops.
  - The anon and service keys must differ.

## Secret boundary

- **Storage.** Every secret is a `Secret` (`web/lib/config/secret.ts`).
  Logging, interpolating, JSON-serializing or inspecting one yields
  `[redacted]`.
- **Access.** `web/lib/config/secrets.ts` (server-only) is the only place a
  secret is revealed, and `.reveal()` appears nowhere else. Its importers are
  an approved, statically enforced list:
  - `lib/supabase/server.ts`;
  - `lib/safetyEmail/index.ts`;
  - `lib/email.ts`;
  - the safety-dispatch route;
  - **temporarily** the four legacy bridge consumers: `lib/fastapi.ts`,
    `api/auth/validate-bridge`, `api/internal/prescription-versions` and
    `api/internal/supervisor-patients-sync`. They are development-only and
    removed with M6. They receive no raw secret: they call
    `legacyBridgeAuthorizationHeader()` /
    `verifyLegacyBridgeAuthorization()`, and verification is constant-time
    via SHA-256 digests.
- **Isolation.** The proxy, instrumentation, `next.config`, readiness and
  every client module cannot reach `secrets.ts`, not even transitively. No
  secret value or secret variable name reaches the client bundle.
- **Dispatch credential.** Compared in constant time against the current
  secret and, during a rotation, `SAFETY_DISPATCH_SECRET_NEXT`.

### Service role (least privilege)

The clinical C5 runtime, safety, prescription, invitation and assignment RPCs
are granted only to `service_role` by design: the server authenticates the
user and passes the actor in. The service role is therefore required in every
mode. Exposure is contained in code (one accessor). Vercel scopes environment
variables per environment, not per function, so process-level exposure cannot
be narrowed within one deployment.

## Application email

TenoTrainer has **two separate email systems**.

| | TenoTrainer application email | Supabase authentication / security email |
|---|---|---|
| What | patient & tester invitations; clinician safety notifications | Supabase-managed auth flows (password recovery, confirmations) |
| Configured by | `TENOTRAINER_EMAIL_PROVIDER` and this contract | Supabase project Auth / SMTP settings (M3.4 / S4) — **not** by any application variable |
| Sender | `TENOTRAINER_NOTIFICATION_EMAIL_FROM` (application-notification identity) | a separate auth/security identity on the same verified domain (founder C5) |

Configuring Resend for the application does **not** configure Supabase auth
email. Password-recovery email (M3.5 S4) is sent by Supabase Auth through the
project's own SMTP settings and recovery template; see
[Password recovery (M3.5 S4)](#password-recovery-m35-s4).

### Password recovery (M3.5 S4)

Same flow for patients and staff; roles and memberships are never touched.

1. `/login` → **Forgot password?** → `/login/forgot`. The server action calls
   `resetPasswordForEmail` with `redirectTo` built only from configuration
   (`TENOTRAINER_APP_ORIGIN` + `/auth/confirm`; `web/lib/passwordRecoveryServer.ts`).
   Every outcome (account or not, malformed address, Supabase limit, error)
   ends on the same page with the same message. In development the
   application email policy applies: only an allow-listed recipient can
   cause a recovery email (the default `disabled` provider sends none).
2. The Supabase recovery template must link to
   `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery` (no
   `{{ .ConfirmationURL }}`). No PKCE verifier is involved, so the link works
   from a mail app's browser or on another device.
3. `/auth/confirm` **GET** only renders a button (link scanners cannot spend
   the one-time token); its **POST** calls `verifyOtp({ type: "recovery" })`.
   Expired, used, unknown and malformed links are one neutral outcome. No
   `next` / redirect parameter is read.
4. `/account/password` (signed in; also reachable from patient Settings and
   the staff navigation): new password + confirmation under the shared policy
   (`web/lib/passwordPolicy.ts`: at least 10 characters, at most 72 bytes,
   not blank, not the account email). Supabase's own project minimum is a
   second check. Afterwards `/dashboard` routes each role home.
5. **Sessions.** Changing the password inside a session makes Supabase Auth
   delete every OTHER session of the user (`UpdatePassword` →
   `LogoutAllExceptMe`); the application also calls
   `signOut({ scope: "others" })` as a second, independent revocation. The
   current session survives. Revoked sessions' refresh tokens are refused and
   their access tokens are refused by the Auth server immediately (403
   `session_not_found`) — every page request is checked that way by the
   proxy — but an unexpired access token is still accepted by the Data API
   (PostgREST checks only its signature) until it expires (`jwt_exp`, 1 h).
   Verified in `verifyS4PasswordRecovery.mjs`.

Login failures travel as fixed codes (`invalid_credentials`, `rate_limited`,
`unavailable`, `link_invalid`, `account_created`), rendered from fixed copy;
Supabase's message text (which can disclose account state) and free-text
`?error=` values are never displayed.

**Supabase Auth settings required** (checked read-only by
`web/scripts/verifyS4AuthConfig.mjs`): Site URL = the canonical origin;
redirect allowlist exactly `<origin>/auth/confirm` (no wildcards; no
localhost in production); public sign-up disabled; custom SMTP (Resend);
the recovery template above; minimum password length ≥ 8; reauthentication
for password change; "password changed" notification; leaked-password
(HIBP) check; links expire within 1 hour.

### The one delivery policy (`web/lib/emailPolicy.ts`)

Every application email asks this policy first. **A Resend API key existing
is never, by itself, permission to send.**

| Provider | production / maintenance | development |
|---|---|---|
| `disabled` | refused at startup | **default**; never sent (`email_disabled`) |
| `fake` | refused at startup | never reaches the network (`email_fake_provider`); safety uses the fake provider |
| `resend` | sent | sent **only** to an address exactly in `TENOTRAINER_DEV_EMAIL_RECIPIENTS`, otherwise suppressed (`email_suppressed_development_recipient`) with no provider call |

The browser only ever sees fixed result codes, never provider text.

### Development `resend` requires all of

1. **A Resend-shaped key.** Use a separate development credential (see M3.4).
2. **A registered development sending domain.** The sender must be on a
   domain listed in `developmentEmailDomains` of
   `web/config/resourceIdentity.json`; sandbox (`resend.dev`) and registered
   production domains are refused.
   **The only registered development domain today is
   `dev-mail.tenotrainer.test`, which is RFC 6761 reserved and can never
   deliver. Real development email is therefore not available.** Enabling it
   requires registering a real development sending domain through a reviewed
   change.
3. **`TENOTRAINER_DEV_EMAIL_RECIPIENTS`**, which must be:
   - comma-separated exact addresses, normalized by trim + lower-case under
     a narrow ASCII grammar;
   - at most 20;
   - free of empty entries and duplicates;
   - free of wildcards, patterns, domain-only entries, display names and
     non-ASCII / confusables;
   - free of `resend.dev` and registered production domains.

   Matching is exact membership only: no suffix, substring, plus-folding or
   same-domain matching. Reserved `.invalid` fixture addresses are accepted;
   they cannot deliver.

### Development safety dispatch with `resend`

- **Explicit scope.** The caller must POST `{"outboxIds":[…]}` with 1 to 50
  UUIDs. Otherwise the answer is `400 DEVELOPMENT_DISPATCH_SCOPE_REQUIRED`.
- **Pre-claim intersection.** Only IDs whose recipient's address is exactly
  allow-listed are passed to the existing scoped claim.
- **Post-claim recheck.** `ContainedSafetyEmailProvider` refuses a
  non-allowed recipient as `rejected_permanent` /
  `dev_recipient_not_allowlisted`, with no provider call.
- **Production** is unchanged: scope NULL, and the body is never read.

### Test harness

- **Spawning.** Every harness-spawned server goes through
  `withEmailContainment()` / `assertNoRealEmail()` (`scripts/lib/harnessEnv.mjs`):
  - non-`resend` servers never receive a Resend key or recipient list;
  - `resend` servers (production-mode servers must be) always run with
    `scripts/lib/resendInterceptor.mjs` preloaded.
- **Interception.** The interceptor answers `api.resend.com` locally and
  records each attempted call (never the key). Tests prove transport-call
  counts, and no test can reach the network.

## Readiness (`/api/ready`)

### Public contract

| | |
|---|---|
| Methods | `GET`, `HEAD` (HEAD: same status and headers, no body); other methods get the framework's 405 |
| Ready | `200 {"status":"ready"}` |
| Not ready | `503 {"status":"unavailable"}` |
| Headers | `Cache-Control: no-store` plus the standard security headers |
| Access | public; no authentication of any kind |
| Details | none (no mode, project, provider, version, latency or reason) |

**M3.4a deployment-host exception.** GET and HEAD of exactly `/api/ready`
are answered on any host, without the canonical 308, so a staged deployment
can be health-checked on its own deployment URL before promotion. Every other
path still gets the 308, and every other method on `/api/ready` still gets
`403 NONCANONICAL_HOST_REFUSED`. See `docs/m3-deployment-readiness.md`.

### Engineering detail (`web/lib/readiness.ts`)

**Checks.** Ready means:

1. the configuration is valid; this is evaluated on every request and never
   served from a cache;
2. one anonymous, read-only PostgREST GET succeeds within **1.5 s** (aborted
   on timeout).

**The probe.** It reads `canonical_exercises` filtered to the nil UUID, so
it always returns zero rows. It reads no clinical data and needs no record
to exist, but still runs through the anon role and RLS in Postgres.
`canonical_exercises` was already anon-readable through its pre-existing
`"canonical_exercises: global read"` policy (migration
`20260916000001_c5_stage2_prescription_schema_foundation.sql`). No migration
was added.

**Cache.** Only the probe result is cached: instance-local, in memory, for
**5 s**, keyed by the configured Supabase identity.

**Not checked:** Resend, the safety provider, FastAPI, the scheduler, the
dispatcher, Anthropic and the service role. Readiness never uses the service
role or `secrets.ts`, and never sends email.

**Maintenance** reports ready when both checks pass.

## Resource identity registry

`web/config/resourceIdentity.json` is a committed, non-secret **development
and test safety registry**. It holds allow-list and deny-list information
only; the runtime configuration is always the authority, and the registry is
never a substitute for production configuration.

| List | Meaning |
|---|---|
| `developmentSupabaseProjects` | Projects development servers and write-capable test harnesses may target; production and maintenance refuse them. |
| `productionSupabaseProjects` | Projects production and maintenance require (M3.4e N1) and development refuses. M3.4e: `wfaalpfobpmojohetjlr`. Never add a guessed identity. |
| `developmentEmailDomains` | The only sender domains development Resend delivery may use; production and maintenance refuse them. Currently only the undeliverable `dev-mail.tenotrainer.test`. |
| `productionEmailDomains` | Sender and recipient domains development refuses. Empty until M3.4. |

The test-harness guard (`scripts/lib/devProjectGuard.mjs`) reads
`developmentSupabaseProjects`.

## Isolated test profile (test infrastructure)

This is **not** a `TENOTRAINER_MODE` and **not** a deployable configuration.
It exists only so that locally spawned production / maintenance servers can
be verified against the registered development project.

- **Eligibility:** a production or maintenance process whose canonical
  origin's host is under the reserved `.test` TLD **and** with neither
  `VERCEL` nor `VERCEL_ENV` set. There is no variable that enables it, and it
  can never apply on Vercel.
- **The only relaxations:**
  1. a registered development Supabase ref is accepted (unknown and
     production refs are still refused, and the expected ref, key role/ref
     and slot checks all still apply);
  2. a `.test` / `.invalid` notification sender is accepted.

  Everything else in production still applies.
- **Test gateway.** `scripts/lib/canonicalGateway.mjs` terminates TLS for
  `*.tenotrainer.test`, so the browser genuinely reaches these servers at
  their canonical https origin with no application bypass.

## Preview deployments

Approved contract (founder C2):

- `TENOTRAINER_MODE=development`;
- the development Supabase project, with its development keys;
- Vercel Deployment Protection enabled;
- no production-scoped secrets, no production Resend credential and no
  production identity;
- email disabled or fake (development-safe behaviour).

**Why this works on Vercel.** Vercel builds and runs previews with
`NODE_ENV=production` and `VERCEL_ENV=preview`. Neither makes a preview
"production": the mode comes only from `TENOTRAINER_MODE`. The parser
accepts development with any `NODE_ENV`, and refuses development only when
`VERCEL_ENV=production`. A preview can never run in production or
maintenance mode, because they require `VERCEL_ENV=production`.

**Preview behaviour to expect.**

- **Origin and identity.** `TENOTRAINER_APP_ORIGIN` must be set to the
  preview's stable alias; generated links use it. The preview's Supabase
  project must be the registered development project.
- **Development-only surfaces.** The legacy bridge routes and the
  tester/admin invitation workflow exist in development mode. With no
  `FASTAPI_URL` / `BRIDGE_SECRET` configured, the bridge is unconfigured.
  Deployment Protection is what keeps these surfaces private.

**Production deployments** are built independently from Production-scope
configuration. A Preview build is never promoted to Production. Even if one
were, nothing configured is frozen into a build, so it would run with
Production's runtime values, which must then validate.

## Static enforcement and verification

`web/scripts/verifyM33ConfigBoundary.test.mjs` fails if a change:

- reintroduces an application `process.env` read (beyond `config/index.ts`
  and instrumentation's `NEXT_RUNTIME`);
- uses `NEXT_PUBLIC_*` (beyond the parser's refusal list);
- adds a `secrets.ts` importer;
- reveals a secret outside the boundary;
- lets the proxy, instrumentation, `next.config`, readiness or a client
  module reach `secrets.ts`;
- leaks a secret or sentinel value into build output (`--build`).

Adding an exception requires founder approval.

| Suite | Proves |
|---|---|
| `lib/__tests__/config.test.ts`, `emailPolicy.test.ts`, `readiness.test.ts`, `mutationOrigin.test.ts` | the contract, delivery policy, readiness core and origin rules (unit) |
| `scripts/verifyM3EnvAndGuard.test.mjs`, `verifyM32SafetyEnv.test.mjs` | the M3.1/M3.2 rules on the new contract; harness guard |
| `scripts/verifyM33LegacyBridgeSecret.test.mjs` | constant-time bridge verification, refusal outside development, redaction |
| `scripts/verifyM33CanonicalOrigin.mjs` | canonical host, exact Origin, open-redirect attempts, development behaviour (spawned servers) |
| `scripts/verifyM33EmailContainment.mjs` | transport-counted email containment, dispatch scoping, secret rotation, refusals |
| `scripts/verifyM33Readiness.mjs` | readiness semantics, timeout, cache, disclosure, canonical host |
| `scripts/verifyM33WebSecurity.mjs`, `verifyM3OperatingModes.mjs` | S2 headers / CSP / mutation boundary and the mode matrices at real canonical origins |

**Build proofs:**

- an empty-environment build succeeds;
- a sentinel build freezes no value into `.next/server` or `.next/static`;
- a normal build has 0 static routes.

## Phase 2: local `.env.local` cleanup

Only **after** the normal checkout runs the completed S3 code, remove from
`web/.env.local`:

```
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
RESEND_FROM
```

They are the founder-managed transition (Phase 1 added the server-only names
alongside them). Until then, development ignores them with a startup
warning; afterwards the warnings disappear. The test harness reads
`SUPABASE_URL` / `SUPABASE_ANON_KEY` first (`scripts/lib/harnessEnv.mjs`), so
no harness depends on the retired names.

## M3.4 handoff

Intentionally not part of S3:

- **Hosting:** the actual Vercel project and deployments (Production
  scope; Preview scope per [Preview deployments](#preview-deployments);
  Deployment Protection).
- **Forwarded-host probe:** confirm on a real deployment whether the public
  host is the first `X-Forwarded-Host` value or `Host`; switch to Host-only
  if the evidence requires it.
- **Production Supabase project:** provision it from reviewed migrations and
  approved reference data (no development data), then:
  - set `TENOTRAINER_SUPABASE_PROJECT_REF`;
  - add the ref to `productionSupabaseProjects`;
  - prefer an individually revocable `sb_secret_` service key.
- **Supabase Auth settings:** disable public signup (required before the
  project is attached to an externally reachable deployment); set the Site URL and an
  exact redirect allow-list on the canonical origin; configure Resend custom
  SMTP with the auth/security sender identity.
- **Resend:**
  - a production sending domain (SPF / DKIM / DMARC);
  - a domain-restricted production key, Production scope only;
  - a separate domain-restricted development key, if real development email
    is ever wanted (plus a reviewed registry entry);
  - add the production domain to `productionEmailDomains`.
- **Secrets:** provision production secrets in Vercel's Production scope
  (the dispatch secret, with optional rotation via
  `SAFETY_DISPATCH_SECRET_NEXT`).
- **Dispatcher scheduling.** The endpoint is POST-only and must be called on
  the canonical origin; Vercel Cron issues GETs. M3.4f chose pg_cron +
  pg_net with Vault-held credentials (`docs/m3-safety-notifications.md`,
  Production scheduler).
- **Readiness as a gate:** M3.4a: `web/scripts/readinessGate.mjs` checks the
  candidate deployment's own URL before promotion (the deployment-host
  exception above), then the canonical origin after it. A startup refusal on
  Vercel crashes the function instance but leaves the deployment "Ready".
- **CSP:** move from Report-Only to enforcement before launch (D4).

## Known follow-up issues (not S3 failures)

- **P3 — DST "tomorrow" wording.** `web/lib/c5ResponseTypes.ts` decides
  "tomorrow" with `now + 24h`. In the first local hour of a DST fall-back day
  (and the mirror edge in spring), the patient sees the explicit, correct
  date instead of the word "tomorrow". Informational only.
- **M3.2 purge-check heartbeat flake.** `verifyM32FixturePurgeCheck.sql`
  fingerprints `safety_notification_heartbeats`, which the `pg_cron` sweep
  rewrites every minute at :00. The suite fails if its run spans a minute
  boundary; it passes when started a few seconds after one. This is a
  test-harness issue, not a product behaviour.

## Remaining production blockers

- **D1 `/setup` (P0): resolved.** `/setup` is development-only (proxy,
  page and server action). Production organizations and staff come from the
  operator workflow; see `docs/m3-production-provisioning.md`. Public
  Supabase signup must still be disabled on the production project before it
  is attached to an externally reachable deployment.
- **S4 password recovery:** implemented in the application (M3.5 S4,
  [Password recovery](#password-recovery-m35-s4)); the production Supabase
  Auth settings it requires are still to be made (run
  `web/scripts/verifyS4AuthConfig.mjs`).
- **Login-abuse protection** (Postgres-backed application rate limiter plus
  Vercel protection; reviewed design first).
- **CSP enforcement** (still Report-Only).
- **The M3.4 infrastructure items** above.
