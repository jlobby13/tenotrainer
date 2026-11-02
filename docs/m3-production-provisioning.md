# D1 — production provisioning (operator workflow)

Production organizations and staff accounts are created by an explicit,
operator-run script that talks to Supabase directly with the service
credential. The public application has no provisioning surface in
production or maintenance.

## Contents

- [What changed](#what-changed)
- [Before any externally reachable production deployment](#before-any-externally-reachable-production-deployment)
- [The operator workflow](#the-operator-workflow)
- [Safety properties](#safety-properties)
- [Procedure](#procedure)
- [Partial failure](#partial-failure)
- [Out of scope](#out-of-scope)
- [Verification](#verification)

## What changed

- **`/setup` is development-only.** Outside development:
  - the proxy answers `404` for `/setup` and every subpath (it is in
    `DEVELOPMENT_ONLY_PAGES`, ahead of authentication and the maintenance
    rules);
  - the page itself calls `notFound()` before reading any session or
    bootstrap state;
  - the server action `createOrgAction` refuses first
    (`refuseActionOutsideDevelopment`), before any Supabase client exists,
    so invoking it directly cannot provision anything.
- **Its check-then-insert guard is not a security boundary.** It remains
  only as development tooling on the shared development project.
- **Production staff provisioning is the operator workflow**
  (`web/scripts/provisionStaff.mjs`). There is intentionally no production
  staff-invitation or staff-management UI; staff invitations
  (`/admin/invitations`) stay development-only.
- Clinicians still invite **patients** in production through the existing
  M2 flow.

## Before any externally reachable production deployment

**Supabase public signup must be disabled** (Supabase dashboard → Auth) on
the production project before that project is attached to an externally
reachable deployment. The application has no signup path, but the Supabase
Auth signup endpoint is enabled by default on a new project, and the
publishable / anon key is public by design.

The development project's Auth settings are not changed by D1.

## The operator workflow

```
node --env-file=<owner-only env file> web/scripts/provisionStaff.mjs \
  --plan <plan.json> --target-ref <project-ref> \
  [--passwords-file <passwords.json>] [--apply] [--json]
```

Run from `web/`. Without `--apply` it is a dry run.

### Inputs

| Input | Where | Secret? |
|---|---|---|
| `SUPABASE_URL` | process environment (e.g. `node --env-file`) | no |
| `SUPABASE_SERVICE_ROLE_KEY` | process environment | **yes** |
| plan (JSON) | a file **outside the repository** | no, but names real people |
| `--target-ref` | argument: the expected project ref, typed by the operator | no |
| passwords (JSON) | an owner-only (`chmod 600`) file **outside the repository** | **yes** |

- No `.env` file is read implicitly, and no secret is ever accepted as an
  argument (unknown arguments are refused).
- Keep the env file and the passwords file owner-only, outside the
  repository, and delete the passwords file after the run.

### Plan

```json
{
  "target": { "intent": "production", "projectRef": "<project-ref>" },
  "organization": { "name": "<organization name>", "slug": "<slug>" },
  "superUser": { "email": "<founder address>", "name": "<name>" },
  "clinicians": [
    { "email": "<address>", "name": "<name>", "role": "clinician" }
  ]
}
```

- `intent` is `production` or `development`. `developmentNamespace` is
  required for `development` (it separates test runs on the shared
  development project) and refused for `production`.
- `clinicians` is optional; `role` is `clinician` or `clinician_admin`.
- Unknown fields (including any password) are refused. Emails are
  lower-cased and must be distinct.

### Passwords

```json
{ "<address>": "<initial password>" }
```

- Needed only for accounts that will be **created**; an existing account's
  password is never read or changed.
- 12–72 bytes, must not contain the address's local part, and only plan
  addresses are accepted.
- The current Supabase Auth API needs a password to create a usable account
  with no email. Without password recovery (S4) there is no safer path yet;
  once S4 exists, accounts could be created without a password and claimed
  by a recovery link instead.

### Output and exit codes

The report is structural: target ref and intent, credential *format*, each
planned step and its status (`create`, `exists`, `recover`, refused with a
reason), the number of writes and the outcome. No credential, password or
token is printed; output passes through a redactor that also strips JWTs
and `sb_` / `re_` keys.

| Exit | Meaning |
|---|---|
| 0 | applied, no change, or a dry run that would apply |
| 1 | unexpected error |
| 2 | refused before any write (usage, validation, identity, conflict, a missing password) |
| 3 | stopped after a partial write — see [Partial failure](#partial-failure) |

## Safety properties

### Target identity (fail closed)

All of these must hold, or the run is refused before any network call:

1. `--target-ref` is given and equals `plan.target.projectRef`;
2. `SUPABASE_URL` is exactly `https://<ref>.supabase.co` for that ref
   (S3 `parseSupabaseUrl`; a local stack cannot be positively identified);
3. the credential is a service credential (`sb_secret_…`, or a legacy
   `service_role` JWT whose embedded `ref` equals the target; publishable,
   anon and unknown keys are refused);
4. the S3 registry (`web/config/resourceIdentity.json`) classifies the ref
   for the intent:
   - `production` refuses a registered development project, and requires
     the ref in `productionSupabaseProjects` (added by reviewed change in
     M3.4; until then every production run is refused);
   - `development` refuses a registered production project and requires a
     registered development project.

Then a read with the credential must succeed against that URL.

The Supabase CLI link is never consulted.

### Dry run

Validates everything above, reads the target, and reports the intended
operations. It writes nothing.

### Idempotency

A rerun of the same plan reports `no change`, or completes a recoverable
state. It never:

- duplicates an organization or membership;
- changes a role;
- adopts an existing account it did not create;
- touches another organization.

Ambiguous state is refused for operator review:

- an organization at the claim id with a different name or slug;
- a slug used by another organization;
- an account in another organization;
- an account with a different role;
- a super user that this workflow did not create;
- in production, any organization or super user that this workflow did not
  create.

### Concurrency (database level)

- The initial organization and the initial super-user membership use
  **deterministic primary keys** derived from the target (production: the
  project ref; development: ref + namespace).
- Two concurrent writers both reach the same `INSERT`; Postgres primary-key
  uniqueness lets exactly one succeed.
- The other re-reads: if it finds exactly its intended row it continues,
  otherwise it stops.
- `organizations.slug`, `organization_members(organization_id, user_id)`
  and Auth email uniqueness cover the rest.
- No process-local lock is relied on, and no migration was needed.

### Privilege

- Privilege comes only from the `organization_members` row, written
  **last**.
- The profile row comes from the existing `auth.users` trigger
  (`handle_new_auth_user`, name from `user_metadata.name`).
- Accounts created by the workflow are email-confirmed and carry an inert
  `app_metadata.tenotrainer_operator` marker (`{v, organization_id, role}`);
  the application never reads it.
- `admin.createUser` sends no email.

## Procedure

1. **(M3.4)** Production project provisioned from migrations. Public signup
   disabled. Its ref added to `productionSupabaseProjects` by reviewed
   change.
2. Write the plan and passwords files outside the repository; `chmod 600`
   the passwords file and the env file.
3. Dry run. Review every step and the outcome `would_apply`.
4. `--apply`. Expect `applied`.
5. Rerun the dry run: expect `no change`.
6. Delete the passwords file. Each person signs in and keeps their initial
   password private (changing it waits for S4).
7. Later clinicians: the same plan (organization and super user unchanged,
   reported `exists`) with the new clinicians added.

## Partial failure

Supabase Auth and Postgres cannot be written atomically together. The
order (organization → account → membership) means every interrupted state
is unprivileged:

- an organization with no super user;
- an account with a marker but no membership (it can sign in but holds no
  role; it sees the patient "No active program" state).

The report and exit code 3 say what was written. Rerunning the same plan
detects the marker and completes the membership (`recover`); no password is
needed for an existing account. A state the workflow cannot attribute to
itself is refused for review instead.

## Out of scope

- A production staff UI.
- Multiple organizations: D1 provisions the installation's initial
  organization.
- Password recovery (S4).
- Login rate limiting.
- Any M3.4 infrastructure.

## Verification

| Suite | Proves |
|---|---|
| `web/scripts/verifyD1OperatorProvisioning.test.mjs` | plan rules, target identity and registry classification (injected registries), dry-run purity, idempotency, conflicts, partial recovery, claim-id concurrency semantics, password-file rules, redaction, CLI refusals with no secret printed |
| `web/scripts/verifyD1OperatorProvisioningLive.mjs` | the same on the real development project (development intent): dry run writes nothing, apply, rerun, conflict refusals, crash + recovery, database-level races (rival super users released together; the same plan in two processes) |
| `web/scripts/verifyD1SetupRetirement.mjs` | `/setup` 404 in production and maintenance (signed out and signed in), real action posts refused, the action's in-process refusal before any Supabase client, development unchanged, nothing provisioned |
