# M3.4c — production database security posture

Supabase Security Advisor results for the TenoTrainer schema, what was
remediated, and which warnings are accepted (and why). Applies to every
environment built from the migrations.

## Contents

- [Advisor baseline](#advisor-baseline)
- [Migration 64: SECURITY DEFINER hardening](#migration-64-security-definer-hardening)
- [Accepted warnings after migration 64](#accepted-warnings-after-migration-64)
- [Deferred](#deferred)
- [Verification](#verification)

## Advisor baseline

After the first production migration (63 migrations), the Advisor reported
**0 errors and 52 warnings**:

| Warning | Count |
|---|---|
| Function search_path mutable | 31 (15 SECURITY DEFINER, 16 SECURITY INVOKER) |
| Extension in public (`pg_trgm`) | 1 |
| SECURITY DEFINER function executable by `anon` | 9 |
| SECURITY DEFINER function executable by `authenticated` | 11 |

**Root cause.** PostgreSQL grants EXECUTE on new functions to `PUBLIC`, and
Supabase's default privileges on schema `public` also grant it to `anon`,
`authenticated` and `service_role`. Functions whose migrations did not revoke
those defaults stayed callable through the Data API.

**Audit result.** There is no CRITICAL or HIGH finding, and no
privilege-escalation or unauthorized-data-access path:

- Every flagged role helper answers only about `auth.uid()`; anonymous
  callers always get false.
- The two trigger functions cannot run outside their triggers.
- `reconcile_missing_acute_episodes` refuses any user but the caller unless
  the verified JWT role is `service_role`.
- Mutable search paths are not exploitable through the API: PostgREST sets
  the search path itself, the API roles cannot run `SET` or DDL or create
  objects in `public`, and they cannot log in.

## Migration 64: SECURITY DEFINER hardening

`supabase/migrations/20261104000001_m34c_security_definer_hardening.sql`
changes privileges and configuration only. It changes no function body,
trigger binding, policy, table or data.

| Change | Functions |
|---|---|
| EXECUTE revoked from `PUBLIC`, `anon`, `authenticated`, `service_role` (trigger-only) | `handle_new_auth_user()`, `trg_acute_safety_releases_guard()` |
| EXECUTE revoked from `PUBLIC`, `anon`, `authenticated`; `service_role` keeps it (unused by policies, functions or the app) | `get_org_role(uuid)`, `has_org_role(uuid, org_role)`, `is_org_clinician_admin(uuid)` |
| `SET search_path = public` (the convention every other SECURITY DEFINER function already follows) | the 15 SECURITY DEFINER functions that had none: the eight org/role helpers, `handle_new_auth_user`, `clinician_can_access_exercise`, `copy_prescription_version_content_into_draft`, `copy_template_content_into_draft`, `create_prescription_draft`, `reorder_prescription_exercises`, `reorder_prescription_workouts` |

A trigger fires without the invoking role holding EXECUTE on its function,
so the profile trigger and the acute-release guard keep working. Every
reference in the 15 functions resolves exactly as before: `public` objects,
the schema-qualified `auth.uid()`, and `pg_catalog` built-ins. None of them
uses an extension-schema function.

## Accepted warnings after migration 64

The expected Advisor result is **27 warnings, 0 errors**, all intentional for
this phase:

- **16 × function search_path mutable — all SECURITY INVOKER.** They run with
  the caller's own privileges, so a mutable search path cannot elevate
  anything. They include `create_rehab_session_if_allowed`, whose accepted
  definition is deliberately left unchanged.
- **1 × `pg_trgm` in public.** It is installed there by the migrations,
  matching dev. Its functions grant nothing, and moving it would be a
  schema change in both environments for no security benefit.
- **4 × anon-executable SECURITY DEFINER:** `is_org_clinician`,
  `can_access_prescription_workout`, `is_org_member`, `is_org_super_user`.
  - Public-role RLS policies call them.
  - Revoking anon would break anonymous reads, including `/api/ready`'s
    `canonical_exercises` probe, which reaches `is_org_clinician` directly and
    `can_access_prescription_workout` through the prescription tables' RLS.
- **6 × authenticated-executable SECURITY DEFINER:** the same four, plus:
  - `is_platform_super_user` (RLS);
  - `reconcile_missing_acute_episodes` (own-user only; the legacy
    development session route uses it).

## Deferred

- **Secure-by-default function privileges**
  (`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS`): a separate
  convention change with its own tests. Until then, every migration that
  adds a function must state its EXECUTE grants explicitly.
- **Rewriting the public-role policies as `TO authenticated`**, so `anon` can
  lose EXECUTE on the four helpers. This needs its own RLS test pass.
- **`authenticated` EXECUTE on `reconcile_missing_acute_episodes`:** remove it
  with the M6 legacy retirement.
- **`pg_temp` in SECURITY DEFINER search paths:** an optional repository-wide
  follow-up; not exploitable today.

## Verification

- `web/scripts/verifyM34cSecurityHardening.mjs` runs on scratch PostgreSQL
  17.11 and 17.6. It proves:
  - migration 64's exact change set: the 15 configurations and 17 removed
    grants, with nothing added;
  - the privilege matrix;
  - the linter-equivalent counts (16 + 1 + 4 + 6);
  - in rolled-back transactions, as the API roles:
    - the profile trigger and the release guard still fire for roles
      without EXECUTE;
    - the anonymous readiness read and the RLS helper chain still work;
    - own-user reconcile is allowed and cross-user reconcile refused;
    - the revoked helpers are refused;
    - `create_rehab_session_if_allowed` is unchanged and still returns
      `REHAB_NOT_SCHEDULED_TODAY`.
- Production and dev are verified by the read-only post-migration proof and
  an Advisor re-run after each environment receives migration 64.
