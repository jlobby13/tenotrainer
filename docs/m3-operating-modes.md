# M3.1 — operating modes and the production authority boundary

`TENOTRAINER_MODE` is the **sole** operating-mode authority. The database
answers *who* may act; the mode answers *whether operations are permitted*.
There is no database maintenance flag.

## Modes

| Mode | Purpose |
|---|---|
| `development` | Local development and verification. The only mode in which the legacy (FastAPI-era) runtime, bridge routes and tester/admin invitation workflow exist. |
| `production` | Live service. C5 is always the patient runtime. |
| `maintenance` | Planned unavailability. Patients see the unavailable page; clinicians and super users are read-only. |

`TENOTRAINER_MODE` is **required** and has **no default**: not from
`NODE_ENV`, not from `next dev`. Every server, test run and isolated
verification server sets it explicitly. `.env.local` does not set it.

## Startup validation (fail closed)

`web/lib/envValidation.ts` is the one validation boundary (pure; used by
`instrumentation.ts`, the proxy and unit tests). `web/instrumentation.ts`
runs it once before the server handles any request; an invalid
configuration logs the problems (variable names only, never values) and
**exits the process**. The proxy re-validates per request and answers 503
if configuration is invalid.

| Rule | development | production / maintenance |
|---|---|---|
| `TENOTRAINER_MODE` present and exactly one of the three values | required | required |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | — | required |
| `NEXT_PUBLIC_APP_URL` | — | required; non-local `https` origin |
| `FASTAPI_URL`, `BRIDGE_SECRET` (legacy bridge) | allowed | **forbidden** |
| `C5_PATIENT_RUNTIME_ENABLED` | `true` selects C5, otherwise legacy | unset or `"true"` only; `"false"` is rejected (it can never select legacy) |
| `C5_PRESCRIPTION_PUBLISH_ENABLED` | `true` enables publish | `"true"` / `"false"` / unset; `false` or unset = publication freeze |

Interpretation lives in `web/lib/operatingMode.ts`:

- `isC5RuntimeAuthoritative()` — `mode !== "development" || runtimeGate`.
- `isLegacyAllowed()` — development only.
- `isPublishAllowedByMode()` — never in maintenance; otherwise the publish gate.
- `isMutationAllowed()` / `assertMutationAllowed()` — false / throws
  `MaintenanceError` in maintenance.

## Production legacy isolation

Outside development:

- Legacy patient APIs (`/api/patient/rehab-session/**`,
  `/api/patient/morning-response/**`) and bridge / internal routes
  (`/api/auth/launch-dashboard`, `/api/auth/validate-bridge`,
  `/api/internal/prescription-versions`,
  `/api/internal/supervisor-patients-sync`) answer **410 `LEGACY_RETIRED`** —
  in the proxy *and* inside each handler.
- Legacy page branches (`/patient/dashboard`, `/patient/session`,
  `/patient/progress` for a patient who is not on C5) render 404; C5
  patients always get the C5 branch.
- F9: `/admin/invitations`, the super-dashboard Invitations tab and the
  tester/admin invitation server actions are unavailable (404 / refused).
- `/api/auth/debug` is development-only (decided by the mode, not `NODE_ENV`).
- FastAPI is neither configured nor reachable; no C5 path depends on it.

## Maintenance enforcement (defense in depth)

Authorization logic is never duplicated: each layer only asks the mode.

1. **Proxy** (`web/proxy.ts`): `/api/patient/**` → 503 for every method
   (reads included); every non-GET/HEAD request and every server-action POST
   (`next-action` header) → 503, except `/login`, `/logout`, `/auth/*`;
   `/patient/*`, `/invite/*`, `/setup` are rewritten to `/maintenance`.
2. **HTTP / auth boundary**: `requireClinicianForRoute({ mutation: true })`
   (all 19 clinician mutation handlers), `requireC5Patient()` /
   `withC5Patient`, `maintenanceResponse()` in the patient settings and
   reassessment routes.
3. **Server actions**: `refuseActionInMaintenance()` (assignments, patient
   invitations, prescription create/pause/resume, invite accept, notice
   dismiss, org setup). `loginAction` is exempt.
4. **Clinical libraries**: `assertMutationAllowed()` is the first statement
   of every mutating library function (prescription drafts/publish/pause/
   resume, clinician release, patient reassessment, patient invitations,
   assignments, notices, favorites, the C5 runtime and response writers).
   `getC5TrainingState()` performs no reconciliation write in maintenance.

UI: patient layouts render the approved copy — *"TenoTrainer is temporarily
unavailable. Your progress is saved."* Staff layouts show a read-only banner
and wrap content in a disabled `<fieldset>` (presentation only; every
mutation is refused server-side regardless). Professional-review release is
**not** available in maintenance, with no exceptions.

A Started session is never auto-finished or stopped by maintenance; it
resumes normally when the mode returns to production.

## Mode-reading pages are request-time only

Layouts and pages that read the mode call `await connection()` first, so the
mode is never evaluated during prerendering (the build itself runs without
`TENOTRAINER_MODE`; a page that read it at build time would fail the build).

## Test-harness guard

Every write-capable harness (all `scripts/*.mjs` that hold the service-role
key or run SQL, `scripts/lib/m6EngineHarness.mjs`,
`scripts/bootstrapPrescriptionVersions.ts`) calls
`assertDevTestTarget()` from `scripts/lib/devProjectGuard.mjs`. It refuses
unless **both** `TENOTRAINER_MODE === "development"` **and** the target
project ref (from `NEXT_PUBLIC_SUPABASE_URL`, and the linked CLI project) is
in the non-empty `scripts/lib/allowedTestProjects.json`. Missing mode,
production/maintenance, missing/empty allow-list or an unknown project all
refuse. A production project ref must never be added to the allow-list.

SQL suites run through the guarded runner:

```
TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/<suite>.sql
```

## Running isolated servers

```
npx next build
TENOTRAINER_MODE=production FASTAPI_URL= BRIDGE_SECRET= \
  NEXT_PUBLIC_APP_URL=https://app.tenotrainer.test RESEND_API_KEY= \
  npx next start -p <port>
```

`.env.local` is still loaded by Next, so in production / maintenance the
bridge variables must be overridden to empty. Development verification
servers set `TENOTRAINER_MODE=development` explicitly.

## Suites

| Suite | What it proves |
|---|---|
| `scripts/verifyM3EnvAndGuard.test.mjs` | environment validation + harness guard (unit) |
| `scripts/verifyM3OperatingModes.mjs` | startup refusal, production / maintenance / production / development matrices on real isolated servers; Started session preserved and resumed; rows byte-identical across maintenance |
| `scripts/lib/m3MaintenanceLibraryProbe.mjs` | every guarded library mutation refuses in-process (with a production negative control) |
| `scripts/verifyM3AdversarialSurface.mjs` | PostgREST attacks with real JWTs, legacy-authority baseline (`--expect-revoked` after Phase B), HTTP attacks on a production-mode server |
| `scripts/verifyM3RevocationProof.sql` | rollback-only proof of the proposed revocation migration (Phase B) |

## Legacy database authority (Phase B — applied)

Migration `supabase/migrations/20261026000002_m3_1_revoke_legacy_patient_authority.sql`
(applied to development 2026-10-26; the D1 cutover — gate-off legacy patient
clinical writes are intentionally unsupported in development too):

- drops the 18 legacy patient-own write policies and the 10 retired legacy
  staff / Stage-1 library policies (supervisor dashboard tables,
  `exercises`, `knowledge_entries`);
- revokes INSERT/UPDATE/DELETE/TRUNCATE from anon + authenticated on the 21
  retired legacy tables (column grants included);
- revokes authenticated DELETE on `organizations`, `profiles`,
  `clinician_exercise_favorites` and the three M6 catalog tables;
- revokes client EXECUTE on `create_rehab_session_if_allowed`,
  `capture_session_guidance_context`, `capture_cautious_return_context`,
  `record_blocked_loading_opportunity`;
- revokes anon writes and all client TRUNCATE on every public table, and
  the same plus authenticated DELETE in default privileges for future
  `postgres`-owned tables (a future table that needs client DELETE must
  GRANT it explicitly alongside its policy).

Preserved: profile timezone/reminder UPDATE, `notifications.read_at`,
reconciliation, every C5/M1/M2/PEC server path, canonical-library
super_user authority including **`exercise_reference_dosage` DELETE (the
only remaining authenticated DELETE)**, favorites via the service role, and
the **M6 catalog authoring model** (authenticated INSERT/UPDATE + its six
clinician_admin/super_user policies — CURRENT AUTHORITY, not legacy).

Proof: `verifyM3RevocationProof.sql` (pre-application, includes the
migration verbatim via `-- @@include`), `verifyM3AdversarialSurface.mjs
--expect-revoked` (post-application).

### Retired legacy suites

| Suite | Classification | Replacement / note |
|---|---|---|
| verifyStage4Loop | SUPERSEDED BY CURRENT C5 COVERAGE | PEC journey, C5.6C lifecycle + races, C5.6D runtime, C5.6E check-ins |
| verifyStage4ScheduleAuthority | SUPERSEDED BY CURRENT C5 COVERAGE | C5.4c scheduling SQL, C5.6F frequency/recovery, C5.6D not_scheduled_today |
| verifyReconciliation | SUPERSEDED BY CURRENT C5 COVERAGE | verifyM31ReconciliationAnchor (confirmed_at == evaluated_at), C5.6C/E SQL, M1 SQL |
| verifyPrescribedDosageFix | SUPERSEDED BY CURRENT C5 COVERAGE | C5.6D hold + rep units, PEC dosage wording |
| verifyM6Stage4GeneratorWiring | LEGACY-ONLY FEATURE WITH NO C5 WIRING | M6 generators were wired only into the legacy morning finalize route |
| verifyM6Stage4ProgressUI | LEGACY-ONLY FEATURE WITH NO C5 WIRING | legacy /patient/progress interpretation sections; C5 patients get C5ProgressHistory |

Retiring the two M6 Stage 4 *patient-flow* suites does **not** retire M6:
the M6 engines (verifyM6Stage3b / 3c), the schema suite (verifyM6Stage3aSchema)
and the M6 catalog authoring authority remain current. The files are kept,
marked RETIRED in their headers.
