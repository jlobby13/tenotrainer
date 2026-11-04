# M3.4a — local deployment readiness

What M3.4a prepared, locally, for the first hosted deployments, and what it
deliberately left for later slices. No Vercel, production Supabase, Resend,
DNS or other cloud resource was created.

## Contents

- [Readiness deployment-host exception](#readiness-deployment-host-exception)
- [Pre-promotion readiness gate](#pre-promotion-readiness-gate)
- [Forwarded-host deployment probe](#forwarded-host-deployment-probe)
- [CSP verification before enforcement](#csp-verification-before-enforcement)
- [Fresh database and schema drift](#fresh-database-and-schema-drift)
- [Drift incident: create_rehab_session_if_allowed](#drift-incident-create_rehab_session_if_allowed)
- [Build and configuration proofs](#build-and-configuration-proofs)
- [Vercel configuration](#vercel-configuration)
- [What M3.4b Preview requires](#what-m34b-preview-requires)
- [Deferred](#deferred)
- [Verification](#verification)

## Readiness deployment-host exception

A staged Vercel deployment has its own deployment URL. Under the S3b
canonical-origin rule, a readiness check there was redirected (308) to the
canonical origin, which serves the **currently live** deployment. The check
would then have validated the wrong deployment.

The exception (`web/proxy.ts`, `canonicalHostRefusal`) is deliberately narrow:

- **Matches:** `GET` and `HEAD` of exactly `/api/ready`, on any host. A query
  string doesn't change the match.
- **Response:** unchanged. It is the minimal public contract
  (`{"status":"ready"}` / `{"status":"unavailable"}`), with `no-store`, the S2
  headers and HSTS. Configuration is validated on every request, the 1.5 s
  probe timeout and 5 s cache are unchanged, and maintenance still reports
  ready.
- **Still redirected (308):** `/api/ready/x`, `/api/readyz`, `/api/READY`,
  other API routes and every page.
- **Still refused (403):** `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS` on
  `/api/ready`, with or without the canonical `Origin` or a forged
  `X-Forwarded-Host`.

Proof: `web/scripts/verifyM33Readiness.mjs` (part B).

## Pre-promotion readiness gate

```
node web/scripts/readinessGate.mjs --origin https://<candidate deployment host> [--attempts 3] [--timeout-ms 10000] [--json]
```

- **Scope:** checks exactly the origin it is given. `GET` and `HEAD`
  `/api/ready` must both return `200`, with exactly `{"status":"ready"}`,
  `application/json` and `Cache-Control: no-store`.
- **Redirects:** never followed. A 3xx fails the gate, because it could
  validate a different deployment.
- **Failures:** timeouts, network errors, `401`/`403` (protection or host
  refusal), `503` after bounded retries (cold starts), and malformed bodies.
- **Output and exit codes:** non-secret. Exit 0 means ready, 1 means not
  ready, 2 means a usage error. `--resolve host=ip:port` pins the connection
  target while keeping the Host header and TLS name.
- **Protected deployments:** set `TENOTRAINER_PROBE_PROTECTION_BYPASS` in the
  environment (never as an argument). It is sent as
  `x-vercel-protection-bypass` and never printed.

**Intended use (M3.4b / M3.4e):**

1. Create the deployment without assigning the production domain.
2. Gate the deployment URL. Any failure means it is not promoted.
3. Promote.
4. Gate the canonical origin. A failure means instant rollback.

Vercel itself does not gate promotion on a health URL. The operator or CI runs
the gate.

## Forwarded-host deployment probe

```
node web/scripts/deploymentProbe.mjs --canonical-origin https://<canonical> --deployment-origin https://<deployment URL> [--json]
```

Both origins are operator-supplied; no domain is written into the code.

**Safety:** the probe is read-only. It sends GET/HEAD to public pages and
readiness, and POSTs only to `/api/ready`, which has no POST handler (those
requests are refused, or answered 405). No authenticated mutation is used.

**Results:** each check is `PASS`, `FAIL`, `OBSERVATION` (requires founder
review) or `MANUAL`.

| # | Check |
|---|---|
| 1, 1b, 2 | Canonical GET/HEAD serve directly (no redirect loop), with HSTS |
| 3 | Deployment-host GET/HEAD → `308` to the canonical origin, path and query preserved |
| 4 | Deployment-host POST → `403 NONCANONICAL_HOST_REFUSED` |
| 5 | A client-supplied `X-Forwarded-Host: <canonical>` on the deployment host is not honoured |
| 6 | A client-supplied wrong `X-Forwarded-Host` on the canonical host is ignored |
| 7, 8 | Same-origin mutation `Origin` passes the proxy (handler 405); a foreign `Origin` → `403` |
| 9, 9b | The readiness gate passes on the deployment origin (directly) and on the canonical origin |
| 10 | An unauthenticated redirect goes to the canonical `/login` |
| 10b | **MANUAL:** generated links (invitation, safety email) use the canonical origin. Verify in the M3.4e founder smoke. |

**What calls for Host-only reconsideration:**

- **Check 1 FAIL with a redirect loop.** The platform's first
  `X-Forwarded-Host` (or Host) is not the public canonical host.
- **Check 5 or 6 OBSERVATION.** The client-supplied `X-Forwarded-Host`
  reaches the app.

Either result carries the Host-only review note. The probe never changes the
rule; a Host-only comparison would be a separately reviewed code change.
Locally there is no platform in front of the app, so checks 5 and 6 are
expected OBSERVATIONS; the suite uses that to prove the probe detects the
condition.

Exit codes: 0 means all PASS (MANUAL allowed), 1 means any FAIL, 2 means
OBSERVATION only, 3 means a usage error.

## CSP verification before enforcement

The production CSP stays **Report-Only** until M3.4g.

`web/scripts/verifyM34aCspProduction.mjs` runs an isolated production server
at its canonical origin through the TLS gateway, with exact-id fixtures, in
two passes:

1. **The policy as served** (Report-Only).
2. **An enforcement rehearsal:** the browser rewrites only the header name to
   `Content-Security-Policy`, with the same policy value. The application is
   unchanged.

**Surfaces covered:**

- login;
- invitation acceptance (pending and invalid);
- a signed-out unknown path;
- `/setup` (404);
- the patient dashboard, session, progress and settings;
- the application 404;
- the clinician dashboard, patient page, invitations and notifications;
- the logins themselves under enforcement.

**On every surface it checks:**

- zero violations (browser-extension noise is classified separately);
- no page errors;
- no request to another origin;
- React hydrated, and only nonce'd inline scripts;
- same-origin stylesheets applied;
- the self-hosted font loaded.

It also asserts the policy's shape: a nonce plus `'strict-dynamic'`, no
`unsafe-*`, no hosts, and `img`/`font`/`connect` set to `'self'`.

**Finding fixed:** Next's built-in not-found page uses un-nonced inline
styles. It is replaced by `web/app/not-found.tsx`; the policy was not
relaxed.

**Remaining for M3.4g:**

- Next's built-in global-error page also uses inline style attributes. Under
  enforcement an unexpected-error screen would lose its styling. Add an
  app-owned error page with an isolated failure trigger to verify it.
- The Vercel Preview toolbar injects third-party scripts. Disable it for
  Preview; it must not drive the policy.

## Fresh database and schema drift

```
TENOTRAINER_MODE=development TENOTRAINER_PG_TOOLING=<dir> node web/scripts/verifyM34aFreshDatabase.mjs [--report <file.json>]
```

**Method (founder-approved for M3.4a):**

- **Cluster:** a throwaway local PostgreSQL 17.6 cluster (real binaries,
  matching the development project) on `127.0.0.1:3190`, in a fresh temporary
  directory with a random credential. Its identity is proven before any
  statement.
- **Tooling:** installed outside the repository; the one-time command is in
  `web/scripts/lib/scratchPostgres.mjs`. There is no dependency or lockfile
  change.
- **Isolation:** the Supabase CLI is never used for the cluster, the
  development database is only read, and the cluster is fully removed
  afterwards.
- **Stand-in:** a minimal Supabase platform stand-in, derived read-only from
  the development project (API roles, `auth.users` columns, auth helper
  functions, extensions schema, default privileges), plus a `pg_cron` test
  double that only records jobs. It applies every migration in filename
  order, one transaction each.

**The stand-ins are migration-reconstruction test infrastructure only.** They
are not evidence of real Supabase behaviour. M3.4c verifies these on the real
production project:

- real `pg_cron`;
- Supabase Auth;
- platform-managed objects;
- platform grants and defaults;
- extensions;
- RLS and security-advisor results.

**Fresh-state proof:**

- the expected migration count (64 since M3.4c; drift is measured at the
  development project's own ledger position, and migrations dev has not yet
  received must apply on top);
- the required extensions;
- only reference tables hold rows (canonical exercises, reference dosage,
  M6 heuristics), plus the two safety-heartbeat state rows;
- the reference rows equal the development project's by natural key;
- no auth users, organizations, memberships, profiles, invitations,
  assignments, prescriptions, sessions, safety events, outbox or attempts,
  and no L5 row;
- RLS on every public table;
- the sweep job is defined.

**Audit fields in the reference comparison:** `created_at`, `updated_at`,
and `updated_by` on canonical exercises are excluded. A development edit
that set `updated_by` on one exercise is development data mutation, not
reference content. Every clinical/reference column is still compared.

**Drift check:** `web/scripts/lib/schemaCatalog.mjs` compares the
application-owned catalog of the migrations-built database with the
development project, read-only. It covers:

- public tables, columns, constraints and indexes;
- functions (definition hash) and their grants;
- triggers, including those on `auth.users`;
- RLS policies and RLS flags;
- enum and domain types;
- views;
- grants to `anon`, `authenticated`, `service_role` and `PUBLIC`;
- event triggers whose function is in `public`;
- extensions;
- `pg_cron` jobs.

**Exact named exclusions (founder Decision 2).** `rls_auto_enable()`, with its
exact definition hash and its four EXECUTE grants, and the `ensure_rls` event
trigger are classified as *external / platform-managed schema objects not
owned by the TenoTrainer migration set; provenance currently unverified*.

- They are reported as excluded, never silently dropped.
- A changed definition, or any other object, is still drift.
- Security does not depend on them: every application table gets RLS from the
  migrations, and the suite checks that on both sides.
- The platform's own event triggers (`issue_*`, `pgrst_*`) are owned by
  `supabase_admin` with functions in the `extensions` schema, so they are
  outside the application scope.

## Drift incident: create_rehab_session_if_allowed

- **Root cause.** `20260909000003_m5_stage4_rehab_schedule_eligibility.sql`
  (the M5 Stage 4 schedule gate, `REHAB_NOT_SCHEDULED_TODAY`) was committed
  after the `20260910*`/`20260911*` migrations but numbered before them. The
  development project applied them in authoring order and has the gate. A
  fresh database applies them in version order; the later-numbered
  redefinitions drop the gate.
- **Fix.** `20261102000001_m34a_restore_rehab_session_schedule_gate.sql` is a
  forward migration that re-creates the function with the development
  project's definition, verbatim. Historical migrations are untouched.
- **Proof, on scratch clusters:**
  - Version order without the fix reproduces the defect: a session is created
    on an unscheduled day.
  - Authoring order reproduces dev exactly.
  - All 63 in version order match dev on signature, return type, language,
    SECURITY INVOKER, no `search_path`, volatility, parallel safety, ACL and
    body hash, and refuse with `REHAB_NOT_SCHEDULED_TODAY`.
  - Dev's history plus the fix is unchanged, so the fix is a no-op on dev.
- **Development application.** The migration was applied (founder-approved)
  to the registered development project, after the dry run listed exactly
  this file. The ledger went from 62 to 63. The function and the whole schema
  catalog were identical before and after.
- **Production impact before the fix:** none functional. The function is
  reached only through the legacy development route, and its client EXECUTE
  was revoked in M3.1.

## Build and configuration proofs

- **Build without runtime configuration.** `next build` succeeds with every
  secret and runtime setting blank, so the build needs no runtime secrets.
- **No secret frozen into the build.** A build with a unique sentinel in every
  secret was scanned with `verifyM33ConfigBoundary.test.mjs --build
  --sentinels`; no sentinel appears in `.next/server` or `.next/static`.
- **Configuration refusals.**
  `web/lib/__tests__/m34aDeploymentConfig.test.ts` uses placeholders only.
  - **Production:** a correct Vercel Production configuration validates. Each
    of these is refused:
    - loopback, http and path-bearing origins;
    - the development project;
    - a missing or mismatched identity pin;
    - another project's service key;
    - fake, disabled or unset email;
    - a missing Resend key;
    - reserved and development sender domains;
    - development email recipients;
    - fake-provider controls;
    - FastAPI or bridge configuration;
    - Anthropic;
    - the retired `NEXT_PUBLIC_*` names, `RESEND_FROM`,
      `SAFETY_EMAIL_PROVIDER` and `RESEND_BASE_URL`;
    - a short or missing dispatch secret;
    - the legacy runtime;
    - production mode on a Preview deployment;
    - the `.test` profile on Vercel.
  - **Preview:** the Preview model validates, and its unsafe variants are
    refused.
- **The production "approval" at runtime is the identity pin.** S3's runtime
  configuration does not consult `productionSupabaseProjects` (the registry
  is not runtime authority). Production requires `TENOTRAINER_SUPABASE_PROJECT_REF`
  to equal the URL's ref and refuses the registered development project. The
  D1 operator workflow is what requires registry approval.

## Vercel configuration

**No `vercel.json` is added in M3.4a.** Nothing that belongs in it is both
needed and already known to be correct:

- **Framework, build and install commands:** detected (Next.js, `next build`,
  `npm ci` from the lockfile).
- **Node version:** from `package.json` `engines` (`22.x`).
- **Root directory (`web`):** a dashboard project setting; `vercel.json`
  cannot express it.
- **Function region:** must follow the production Supabase region, which is
  not chosen yet. Pinning a region now would be a guess; decide it in M3.4c.
- **Cron:** not used (the recommended scheduler is `pg_cron` + `pg_net`, in
  M3.4f).
- **Headers and route limits:** already in `next.config.ts`, the proxy, and
  route exports (`runtime`, `maxDuration`).
- **Deployment Protection, toolbar, domains, environment variables and
  production auto-assignment:** all dashboard settings.

## What M3.4b Preview requires

Proven against a real server configured as Preview
(`web/scripts/verifyM34aPreviewProfile.mjs`): `VERCEL=1`,
`VERCEL_ENV=preview`, `NODE_ENV=production`. With this configuration the
patient, clinician and invitation flows work with **zero FastAPI contact**,
email stays disabled, and links stay on the alias.

**Preview environment (Vercel "Preview" scope only):**

- `TENOTRAINER_MODE=development`
- `TENOTRAINER_APP_ORIGIN=https://<stable preview alias>` (one dedicated
  branch alias; generated links use it)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and
  `TENOTRAINER_SUPABASE_PROJECT_REF` from the **development** project
- `C5_PATIENT_RUNTIME_ENABLED=true` (**required**: unset selects the legacy
  runtime, which needs FastAPI; the contrast case proves it)
- `TENOTRAINER_EMAIL_PROVIDER=disabled`
- optionally a Preview-only `SAFETY_DISPATCH_SECRET`, distinct from
  production's

**Must not be set in Preview:**

- `FASTAPI_URL`, `BRIDGE_SECRET`;
- any production credential, production Resend key or production project;
- the retired names.

**External settings:**

- Vercel Deployment Protection on, because development mode exposes
  development-only surfaces;
- the Vercel toolbar off.

No code-level blocker was found.

## Deferred

- **M3.4b:** the Vercel project, Preview environment, protection and toolbar.
- **M3.4c:** the production Supabase project, its region (and the Vercel
  function region), and real-platform verification of everything the
  stand-ins can't reproduce:
  - `pg_cron`;
  - Auth;
  - platform grants and defaults;
  - extensions;
  - the security advisor;
  - `rls_auto_enable` / `ensure_rls` behaviour and provenance on a new
    project.
- **M3.4c and onward:** signup disabled, Site URL and redirect list.
- **M3.4d:** Resend.
- **M3.4e:** the first protected Production deployment, the probe, and the
  manual link check.
- **M3.4f:** the scheduler.
- **M3.4g:** CSP enforcement (and the global-error page).
- **Outside M3.4:** S4 and login rate limiting.

## Verification

| Suite | Proves |
|---|---|
| `web/scripts/verifyM33Readiness.mjs` | readiness semantics incl. the narrow deployment-host exception |
| `web/scripts/verifyM34aDeploymentTools.mjs` | gate verdicts, probe classification (modelled platforms), live probe/gate, CLIs |
| `web/scripts/verifyM34aCspProduction.mjs` | zero CSP violations as served and under enforcement, resources work |
| `web/scripts/verifyM34aFreshDatabase.mjs` | fresh reconstruction from every migration (64), fresh state, zero application drift at dev's ledger position |
| `web/scripts/verifyM34cSecurityHardening.mjs` | migration 64's exact change set, privilege matrix, linter-equivalent counts, trigger / RLS / reconcile / schedule-gate behaviour |
| `web/scripts/verifyM34aPreviewProfile.mjs` | the Preview model works without FastAPI, email disabled |
| `web/lib/__tests__/m34aDeploymentConfig.test.ts` | Production / Preview configuration acceptance and refusals |
