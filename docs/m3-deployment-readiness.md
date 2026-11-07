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
- [M3.4e — protected Production (closed)](#m34e--protected-production-closed)
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
| 10 | An unauthenticated redirect lands on the canonical `/login` (with `next`): `Location` is resolved against the canonical origin, so an absolute canonical URL or a path-absolute relative one passes; a protocol-relative or foreign target fails |
| 10b | **MANUAL:** generated links (invitation, safety email) use the canonical origin. Deferred at M3.4e (see [M3.4e — protected Production](#m34e--protected-production-closed)). |

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
- **The production "approval" at runtime is the identity pin plus the
  registry.** Production requires `TENOTRAINER_SUPABASE_PROJECT_REF` to equal
  the URL's ref, refuses the registered development project and, since M3.4e
  (N1), refuses any project not registered in `productionSupabaseProjects`.
  The D1 operator workflow applies the same registry approval.

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

## M3.4e — protected Production (closed)

The first protected Production deployment, verified end to end without
introducing any patient, clinical or operational data.

### Release

| Item | Value |
|---|---|
| Production application SHA | `20c06b11dfc80343e0f0245bd403fba7d5964446` (exact-SHA fast-forward of `main`, no force, no merge) |
| Vercel deployment | `9x1YanDFkZPwjZUMDwrLnzpdHhmG`, Production / Current, from `main` |
| Canonical origin | `https://tenotrainer.vercel.app` |
| Verified per-deployment host | `https://tenotrainer-q70ila1g3-teno-trainer.vercel.app` |
| Protection | Vercel Authentication on every deployment; never weakened or bypassed for browsers |
| Production Supabase | `wfaalpfobpmojohetjlr`, the only registered production project (N1); ledger 64 |
| Prescription publishing | `C5_PRESCRIPTION_PUBLISH_ENABLED=false` |

### Final live verification

Run by the founder from a temporary checkout of the corrected operator probe
(below) against the unchanged Production deployment, with the Deployment
Protection bypass entered through a hidden prompt and unset afterwards.

| Check | Result |
|---|---|
| J3 readiness gate, per-deployment host and canonical, GET + HEAD | PASS |
| J5 deployment probe | `PASS 13, FAIL 0, OBSERVATION 0, MANUAL 1` (10b) |
| J5 check 10 | PASS: `307 /login?next=%2Fpatient%2Fdashboard` |
| J6 canonical `GET /login` | HTTP/2 200; `Content-Security-Policy-Report-Only` present (no enforced CSP); HSTS `max-age=31536000; includeSubDomains` (the application's value); `x-vercel-id` shows `iad1` |
| Runtime logs | `TenoTrainer operating mode: production`; no configuration refusal or runtime error |
| Email and dispatch | none sent or started |

### Probe correction (check 10)

The first live run reported check 10 as FAIL: Production answered
`307 Location: /login?next=%2Fpatient%2Fdashboard`. The proxy builds an
absolute canonical URL, but Next.js 16 relativizes a proxy redirect whose
target is the request's own origin (`next/dist/server/web/adapter.js`), and
on the real HTTPS canonical host that origin is identical. A browser resolves
the relative `Location` against the canonical URL, so it stays on the
canonical host, which is the approved intent (the M3.3 real-TLS browser check
asserts the landing URL). Local runs had kept the absolute form only because
plain-HTTP requests made the `https` target cross-origin.

Check 10 now verifies the browser-resolved destination (commit
`949cb94e7634c55bc80bb36a26efd46ab8d414be`, operator tooling only). The
application's redirect behaviour was not changed, and Production / `main`
stayed at `20c06b1`.

### D1 founder provisioning

- Run with `web/scripts/provisionStaff.mjs` from the production-ops worktree
  at the deployed SHA: dry run, then apply (3 writes: the initial
  organization `tenotrainer`, the founder account, its `super_user`
  membership), then an idempotent rerun (`no_change`, 0 writes).
- The dedicated D1 operator key was revoked afterwards; the temporary
  password file was deleted. `tenotrainer_vercel_production` (the runtime
  service key) is retained.
- Local audit artifacts, outside the repository and retained:
  `~/.tenotrainer-d1/plan.json` (no secret) and
  `~/.tenotrainer-d1/post-d1-verify.sql` (read-only verification, SHA-256
  `5124ca8e48de97d8a286e75bef02a30b698d1373935e5e70ffbf1f7171c5d836`).

### Auth and service-role verification

- The founder signed in (Vercel login, then TenoTrainer), reached
  `/super/dashboard`, and observed the founder account listed with role
  **Super User**. That list is read with the service role
  (`organization_members` and `auth.admin.listUsers`), so this proves the
  Production service key; a failing key renders "No clinicians yet".
- The founder logged out. During the first sign-in, Auth sessions and refresh
  tokens were 1 (from 0); after each of the two logouts both were 0.
- Final read-only verification: `read_only` on; ledger 64 (latest
  `20261104000001`); one founder user, one email identity, one profile; the
  organization and `super_user` membership unchanged; `never_signed_in`
  false; sessions 0; refresh tokens 0; 76 public tables, nonzero only for
  the reference data (`canonical_exercises` 47, `exercise_reference_dosage`
  46, `m6_heuristics` 16), the two safety heartbeats and the three D1 rows;
  sweep healthy, dispatch never started; the safety sweep is the only cron
  job; Vault 0, Storage 0, `pg_net` absent.

### Operating lessons

- **Read-only production checks use the Management API
  `POST /v1/projects/<ref>/database/query/read-only`.** `supabase db query
  --linked` first creates or refreshes a temporary `cli_login_postgres`
  role (and can remove network bans after failed connections) and then runs
  the SQL through the full-privilege query endpoint.
- **The Deployment Protection bypass for automation is retained.** The
  readiness gate and probe need it for every protected release, and the
  M3.4f scheduler's database-side dispatch caller needs it to reach the
  protected dispatch route.

### Deferred, not failed: generated-link check (10b)

- **Invitation links:** verified at the first real clinician onboarding,
  not with a manufactured invitation or email.
- **Safety-email links:** verified in M3.4f with the first real dispatch.

The code path is covered locally by `verifyM33CanonicalOrigin.mjs`.

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
- **M3.4e:** closed (see
  [M3.4e — protected Production](#m34e--protected-production-closed)); its
  generated-link check (10b) is deferred as described there.
- **M3.4f:** the scheduler: `pg_net`, the protected dispatch caller (Vault
  and Deployment Protection bypass handling), the first real dispatch, the
  dispatch heartbeat, and the safety-email link check.
- **M3.4g:** CSP enforcement (and the global-error page).
- **S4:** the Auth Site URL and redirect list, password recovery, and the
  related Auth hardening (including login rate limiting).
- **Later:** mobile/PWA work, Jason Alpha readiness and onboarding, and any
  compliance / BAA gate required before clinical use.

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
