# M3.2 — Clinician safety notifications

Notifications **report** authoritative safety state; they never create or
decide it. `acute_episode_review_state()` (M1) is the only derivation of
effective level, Level-4 reasons, professional hold, requires-clinician-release
and released. The notification code maps its output; it re-derives nothing.

Migration: `supabase/migrations/20261028000001_m3_2_safety_notifications.sql`.
Proof (rollback-only, includes the migration verbatim):
`web/scripts/verifyM32SafetyNotificationsProof.sql`.

## Subjects

| Subject | Identity | Channels | Created by |
|---|---|---|---|
| `safety_review` event | (episode, tier) | in-app | episode insert (ordinary Level 3) |
| `clinician_review` event | (episode, tier) | in-app + email | first time `requires_clinician_release` (effective ≥ 4 by recurrence / > 48 h / ≥ 3 blocked opportunities, or professional hold) |
| `urgent_clinician_review` event | (episode, tier) | in-app + email | effective Level 5 |
| acute-stop notice (D6) | the immediate-response row | in-app only | an acute Stop recorded a TRUE safety fact and the check-in is outstanding |

Tiers only move upward; the highest **current** tier is created on first
detection (an episode first seen already at clinician review gets no
`safety_review` event). A lower event stays as history with
`superseded_by_event_id`. Effective Level 5 exists only for an initial Level-5
episode, so "L4 → L5" is always a new L5 episode with its own event.

The acute-stop notice classifies nothing: no level, no episode, no release
requirement, no email; patient blocking is unchanged. Note that a plain Stop
under an active brake is also `stopped_acute` but records no fact — it gets
no notice. Resolution: `check_in_submitted` when the check-in is submitted
(same transaction); `superseded_by_event_id` links the classified episode
event of the same session once reconciled.

## Transitions → notification behaviour

| # | Transition | Result |
|---|---|---|
| 1 | new ordinary L3 | new `safety_review` event |
| 2 | new L5 | new `urgent_clinician_review` event |
| 3 | L3 > 48 h unresolved | sweep: new `clinician_review` (no write exists to hook) |
| 4 | L3 recurrence (4th in window) | episode born effective 4: one `clinician_review` only |
| 5 | 3rd blocked opportunity | same transaction: new `clinician_review` |
| 6 | "L4 → L5" | a new L5 episode → new urgent event |
| 7 | reconcile after the fact (orphan) | sweep reconciles via the existing function; highest current tier only |
| 8 | duplicate reconcile | nothing (no insert, no trigger; unique (episode, tier)) |
| 9 | reassessment while review required | nothing; a reassessment that creates a hold escalates L3 → `clinician_review` |
| 10 | release (patient or clinician) | no notification; events resolved; unsent email suppressed |
| 11 | several open episodes | independent events per episode |
| 12 | pause / resume | no notification (a paused prescription records no blocked opportunity) |

## Atomicity and repair

AFTER-row triggers on `acute_safety_episodes`, `blocked_loading_opportunities`,
`acute_safety_reassessments`, `acute_safety_releases`,
`session_immediate_responses` and `supervisor_patients` call one
exception-isolated hook. A failure becomes a `notification_hook_failed`
alert and a WARNING log line; the safety write commits and reconciliation is
never stuck. `safety_notifications_sweep()` (pg_cron, every minute, SQL only)
repairs: orphan L3/L5 facts older than 2 minutes (existing
`reconcile_missing_acute_episodes`), time-based escalation, missing events
and notices, late recipients, stalled urgent email. The C5.6E fact and
reconcile transactions stay separate.

## Recipients

Primary: every active assignment whose clinician holds a clinician /
clinician_admin role in the assignment's organization (the
`clinician_patient_access()` predicate). Fallback: clinician_admins of the
patient's single patient-role organization; zero or several patient
organizations fail closed (recorded, alerted, nobody notified). Rows are
immutable history (`assigned_clinician`, `fallback_clinician_admin`,
`late_assignment`); eligibility is re-checked at every inbox read and
delivery attempt; an ended assignment hides the row and suppresses email.
A fallback admin's row carries no episode reference and routes to
assignment ("No clinician is assigned — assign one to review"); receiving it
grants no clinical access.

## Email outbox

One intent per email-required recipient: `pending → claimed →
provider_accepted | retry_scheduled | failed_permanent`, or
`suppressed_episode_released` / `suppressed_recipient_ineligible`.
`provider_accepted` is only provider acceptance. Stable idempotency key per
generation (`tenotrainer-safety-email/<outbox>/g<n>`); leases recover crashed
workers (attempt closed `abandoned_lease_expired`, same key); a late
acceptance is always recorded. Retry: immediate, +1m, +5m, +15m, +1h, +3h,
+6h, +8h, then `failed_permanent` + alert. Super-user requeue is audited and
starts a new generation. Error fields hold codes only.

## Maintenance (founder D1)

Narrow operational exception: the sweep, event/notice/outbox creation and
dispatch bookkeeping continue (the database is mode-unaware by design). No
clinical, prescription, assignment or release mutation is allowed, and the
UI does not record `read_at` (`safety_notification_open(..., p_mark_read =>
false)`).

## Access

All tables: RLS on, no policy, no anon/authenticated privilege; service_role
read-only. Every write is a SECURITY DEFINER function; only the eight server
RPCs are executable by service_role.

## Phase B — delivery, inbox, operations

### Scoped claim

`safety_email_claim(p_limit, p_lease_seconds, p_only_outbox_ids uuid[] DEFAULT NULL)`
— the only signature. `NULL` = every eligible due intent (production
dispatch); an array is an additional filter that never bypasses due time,
status, lease, attempt limit, episode resolution or recipient eligibility
(lease recovery is scoped too). Empty / unknown ids claim nothing; duplicate
ids claim once. The HTTP route never accepts a scope; exact fixture scopes
are used only by the test harness (dispatcher core called in-process).

### Provider and dispatcher

`web/lib/safetyEmail/`: `provider.ts` (interface; results `accepted` /
`permanent` / `transient` / `ambiguous`, codes only), `resendProvider.ts`
(Resend with the outbox idempotency key as `Idempotency-Key`; timeout →
ambiguous), `fakeProvider.ts` (development only; idempotent like the real
provider; scriptable; never networked), `template.ts` (PHI-free subjects and
body), `dispatcher.ts` (claim → send → record; no runtime imports, so the
authoritative worker suite runs this exact code), `index.ts` (provider
selection from validated config; production run with scope `NULL`;
heartbeat; structured JSON logs with codes, counts and opaque ids only).

`POST /api/internal/safety-notifications/dispatch`: Node runtime;
`Authorization: Bearer <SAFETY_DISPATCH_SECRET>` compared in constant time;
no session authority, no body, no scope; replay / concurrency safe (leases +
idempotency keys); 503 `SAFETY_EMAIL_DISABLED` when no provider is
configured (development default — nothing is ever sent implicitly). Allowed
in maintenance (the D1 exception). Recurring production invocation: the
M3.4f scheduler ([Production scheduler](#production-scheduler-m34f)).
`after()` acceleration is NOT implemented in M3.2 (durability never depended
on it).

### Inbox

`/clinician/notifications` (grouped by patient; process language first,
level as secondary detail; open / resolved / replaced history),
`/clinician/notifications/<recipient id>` (opaque link used in-app and in
email: ownership + current eligibility, `read_at` once, never in
maintenance; 303 to the Safety episode anchor / session / copy-only state),
`/clinician/notifications/<id>/assignment-required` (fallback clinician_admin:
patient name and the assignment-required copy only). Notification items are
plain anchors (never prefetched — prefetching would record `read_at`). The
badge counts unread **open** items. Reading is never clinical review or
release.

### Health (super_user only)

`/super/safety-notifications`: in-flight > 5 min, urgent without provider
acceptance after 15 min, failed_permanent by tier, outbox by status,
failed recipient resolution, hook failures repaired by the sweep, events
detected by the sweep, orphan reconciliations, last successful sweep /
dispatch, open alerts (kind, opaque subject, code). No PHI. Dispatch
heartbeat freshness is defined in
[Production scheduler](#production-scheduler-m34f); automatic external
alerts are [Automated monitoring](#automated-monitoring-m34f-mon).

### Production scheduler (M3.4f)

Migration `20261107000001_m34f_safety_dispatch_scheduler.sql`. pg_cron runs
`private.safety_dispatch_tick()` every minute; pg_net POSTs to the canonical
dispatch route. Delivery semantics (claim, lease, idempotent send, record,
heartbeat) stay in the application. pg_net (0.20.4 on Supabase) does not
retry; it **does follow redirects** (libcurl `FOLLOWLOCATION`, no option to
disable). The pinned endpoint never redirects; a redirect seen in practice
means the bypass or the domain configuration is wrong (see Operator
response).

- **The wrapper** (schema `private`, not API-exposed): `SECURITY DEFINER`,
  `search_path = ''`, EXECUTE for its owner only; the API roles cannot call
  it. It returns only `{status, request_id}`;
  failures raise value-free `SAFETY_DISPATCH_TICK_<CODE>` errors, so a
  failed cron run records a safe message.
- **Configuration**: three Vault entries, entered by the operator in the
  Supabase dashboard (never a migration, CLI argument, repository file or
  cron command):

  | Vault name | Value |
  |---|---|
  | `tenotrainer_production_dispatch_url` | the canonical dispatch URL |
  | `tenotrainer_production_dispatch_secret` | `SAFETY_DISPATCH_SECRET` |
  | `tenotrainer_production_dispatch_vercel_bypass` | a dedicated, independently revocable Vercel Protection Bypass for Automation, labeled for the Production database safety-dispatch scheduler (never the operator / probe bypass) |

  Vault names are unique (a partial unique index on `vault.secrets.name`),
  so the duplicate check is defense in depth. Before entering values,
  confirm with a read-only query that none of the three names exists: a
  failing statement is written to the Postgres log with its text
  (`log_min_error_statement = error`), and a duplicate name is the one
  foreseeable failure. Enter the values through the dashboard's Vault UI,
  never the SQL editor (which keeps query history), and never in a command,
  repository file, migration or report.

  None present → `not_configured`, no request (development and fresh
  databases). Partial, duplicated, malformed (non-printable or space
  characters; dispatch secret < 32, bypass < 16 characters) or any URL
  other than the pinned endpoint → error, no request.
- **The URL is pinned** to
  `https://tenotrainer.vercel.app/api/internal/safety-notifications/dispatch`;
  the wrapper is not a generic HTTP client. A different canonical origin
  (e.g. a custom domain) is a reviewed forward migration together with
  `TENOTRAINER_APP_ORIGIN` and the Vault URL.
- **The request**: `POST`, body `{}`, headers `Content-Type`,
  `Authorization: Bearer <dispatch secret>` and
  `x-vercel-protection-bypass` only (no `Origin`, `Sec-Fetch-Site` or bypass
  cookie), 30 s timeout.
- **pg_net access**: see the accepted trust boundary below.
- **The job** `tenotrainer_m34f_safety_dispatch` is created **inactive**.
  Activation is an explicit operator step after the empty-queue proof:
  `SELECT cron.alter_job(<jobid>, active := true)`.

**pg_net trust boundary (accepted residual exposure).** Measured on
development (pg_net 0.20.4, M3.4f Stage B) and accepted by the founder:

- pg_net's objects (schema `net`, its functions, `net.http_request_queue`,
  `net._http_response`) are owned by `supabase_admin`.
- Supabase's platform defaults grant access to them: `USAGE` on `net` to
  PUBLIC and the API roles, `EXECUTE` on its functions and all privileges
  on its tables and sequence to PUBLIC. **At the SQL privilege level the
  API roles (`anon`, `authenticated`, `service_role`) can use pg_net.**
- Our migrations run as `postgres`, which cannot revoke grants made by
  `supabase_admin`, so migration 65 attempts no REVOKE or ownership change
  on pg_net's objects.
- `net` is not exposed through the Data API (exposed schemas: `public`,
  `graphql_public`), so ordinary `anon` / `authenticated` application
  clients have no SQL path to pg_net.
- Roles with direct SQL capability (the operator, Supabase platform
  services) may use pg_net, read its queue and read its responses, as
  Supabase's grants allow.
- While a request waits in `net.http_request_queue`, its row holds the
  outbound request headers. For the safety dispatcher these are the
  dispatch credential (`Authorization: Bearer …`) and the Vercel bypass.
  The worker deletes the row before sending, so the exposure is transient,
  but it is real.
- `net._http_response` holds response data (status, response headers and
  body, kept for `pg_net.ttl`, 6 hours), never the original request headers.
- This residual exposure is accepted as part of trusting the Supabase
  database / platform boundary. Only the scheduler's own entry point
  (`private.safety_dispatch_tick()`) is restricted to its owner.

**Redirects.** pg_net 0.20.4 follows HTTP redirects (libcurl
`FOLLOWLOCATION`; no option to disable it). The exact URL pin stays
required: the wrapper rejects every configured URL other than the canonical
endpoint. The wrapper only enqueues the request and does not inspect the
asynchronous response, so judging the response belongs to the operator
verification step (Operator response, below).

**Verification strategy.** With no clinical data the outbox is empty, so a
dispatch claims nothing, sends nothing and records a successful dispatch
heartbeat. M3.4f proves the path with a manual empty-queue call, then
scheduled empty-queue calls, then a read-only baseline check. No Production
safety event is created for testing (safety history is immutable). The first
real safety email and its generated-link (canonical origin) observation are
deferred to the first genuine safety event.

**Heartbeat freshness** (`safety_notification_health`, shown on
`/super/safety-notifications`), while the job is active:

| Dispatch heartbeat | State |
|---|---|
| `dispatch_last_succeeded_at` within 5 minutes | healthy |
| more than 5 and up to 15 minutes old, or `dispatch_last_failed_at` newer than the last success | degraded: investigate |
| more than 15 minutes old (the urgent-delivery stall threshold) | stale: incident |

**Operator response.** Read `cron.job_run_details` for the job (status and
the value-free `SAFETY_DISPATCH_TICK_*` message) and `net._http_response`
(about 6 hours of responses; redirects are already followed, so read the
final response). **HTTP 200 alone is not proof of a dispatch.** A successful
dispatch is a 200 with `content_type` `application/json` and a body matching
the route's contract: `{"result":"dispatched","claimed":…,"accepted":…,
"retry_scheduled":…,"failed_permanent":…,"stale":…,"record_failed":…,
"batches":…,"duration_ms":…}`, together with an advancing
`dispatch_last_succeeded_at`. A 200 HTML page or any other body is a
**failed** verification: pg_net may have followed a redirect to a login /
protection page or elsewhere (bypass or domain misconfigured). A JSON `UNAUTHORIZED` 401 is a dispatch-secret mismatch; a
Vercel 401 page is the bypass; 403
`NONCANONICAL_HOST_REFUSED` is the URL; 503 `SAFETY_EMAIL_DISABLED` or 500
`DISPATCH_FAILED` point at the application logs. **Stop**:
`SELECT cron.alter_job(<jobid>, active := false)` (immediate; the outbox and
its leases are unaffected). Automatic alerting:
[Automated monitoring](#automated-monitoring-m34f-mon).

### Automated monitoring (M3.4f-MON)

Migration `20261108000001_m34f_mon_safety_monitor.sql`. Founder decision:
automatic operational alerts exist **before** the recurring dispatcher is
activated.

**Architecture.** A Supabase-side evaluator checks the safety notification
machinery every five minutes and checks in with an **external dead-man's
switch** (Healthchecks.io): a success ping when healthy, a `/fail` ping
carrying failure codes when not. Healthchecks.io alerts the founder on a
`/fail` ping **and** when check-ins stop (period 5 min, grace 10 min), so a
dead database, a paused project, a stopped pg_cron or pg_net, or a crashed
evaluator is detected outside Supabase. Alert delivery is Healthchecks.io's
own (email plus an optional second channel), independent of Resend, Vercel
and the dispatch path being monitored.

- `private.safety_monitor_evaluate()`: returns
  `{v, status: ok | pre_activation | fail, codes, m}`; owner-only,
  `SECURITY DEFINER`, empty `search_path`.
- `private.safety_monitor_tick()` (the cron command): evaluates (an
  evaluator failure becomes a `fail` check-in with `monitor_evaluator_error`
  and the SQLSTATE only), records the result in
  `private.safety_monitor_state`, then POSTs the payload to the check-in URL
  (or `<url>/fail`) with only `Content-Type`, 10 s timeout. Its pg_net request
  ids go to `private.safety_monitor_requests` (kept 2 days) so check-in
  responses are never classified as dispatch responses.
- `private.safety_monitor_set_dispatch_expected(boolean)`: declares
  recurring dispatch expected (records `dispatch_expected_since`).
- The job `tenotrainer_m34f_mon_safety_monitor` (`*/5 * * * *`) is created
  **inactive**.

**Pre-activation vs active.** Until an operator declares dispatch expected,
the intentionally inactive dispatcher is not an alert (status
`pre_activation`; only the always-on checks apply). The Stage F activation
runs, in one transaction, `cron.alter_job(<dispatch jobid>, active := true)`
and `private.safety_monitor_set_dispatch_expected(true)`. The dispatch rules
other than "job inactive" then wait a 10-minute grace (no runs or heartbeat
are expected yet).

**Detection rules** (codes; windows are the last 10 minutes):

| Code | Applies | Fires when |
|---|---|---|
| `sweep_job_inactive` | always | the M3.2 sweep job is missing or inactive |
| `sweep_heartbeat_stale` | always | the sweep never succeeded, or last success > 5 min ago |
| `pg_net_worker_down` | always | no pg_net worker backend |
| `pg_net_queue_backlog` | always | > 3 requests waiting in `net.http_request_queue` |
| `notification_backlog` | always | > 20 emails in flight, or the oldest in flight > 15 min |
| `open_alert_<kind>` | always | an open `safety_notification_alerts` row (every kind but the informational `orphan_fact_reconciled`), e.g. `open_alert_delivery_failed_permanent`, `open_alert_urgent_delivery_stalled` |
| `dispatch_scheduler_unexpectedly_active` | pre-activation | the dispatch job is active although not declared expected |
| `dispatch_scheduler_inactive` | active | the dispatch job is missing or inactive |
| `dispatch_runs_missing` | active, after grace | < 8 runs in 10 min, or none in the last 3 min |
| `dispatch_runs_failing` | active, after grace | the last 3 runs all failed |
| `dispatch_heartbeat_degraded` / `_stale` | active, after grace | last successful dispatch > 10 / > 15 min ago |
| `dispatch_failed_after_success` | active, after grace | `last_failed_at` newer than `last_succeeded_at` |
| `dispatch_auth_failures` | active, after grace | ≥ 2 JSON 401 `UNAUTHORIZED` (dispatch secret mismatch) |
| `dispatch_protection_redirects` | active, after grace | ≥ 2 HTML responses (a followed Vercel login / protection redirect, or a Vercel 401 page) |
| `dispatch_http_errors` | active, after grace | ≥ 3 other non-contract responses (503, 500, 403, 5xx, a 200 without the exact contract) |
| `dispatch_timeouts` | active, after grace | ≥ 3 pg_net timeouts or transport errors |
| (no check-in) | always | detected by Healthchecks.io after period + grace |

Single bad ticks never alert (window thresholds). Healthchecks.io alerts
once per state change (down / up) and sends a recovery notice; repeated
`/fail` check-ins with the same codes do not re-alert. The payload's codes are
sorted and distinct.

**Payload (no PHI).** `{v: 1, status, codes, m}` where `codes` are the fixed
words above and `m` holds integer / boolean metrics only (ages in seconds,
counts, flags). No patient, clinician, recipient, event or alert identifiers,
addresses, alert subject keys or detail codes, and no free text (the
evaluator's error text is replaced by its SQLSTATE).

**Healthchecks.io configuration** (founder; not in the repository):

- one check, *Simple* schedule, **period 5 minutes, grace 10 minutes**;
- integrations: the founder's email, plus one second channel (push,
  Telegram or SMS) so a missed email is not the only signal;
- account two-factor authentication on.

**Vault contract.** `tenotrainer_production_monitor_ping_url` = the check's
UUID check-in URL, exactly
`https://hc-ping.com/<lowercase uuid>` (no other host, scheme, port, path,
slug form, query, fragment or trailing slash). Entered by the founder
through the dashboard's Vault UI after confirming the name is absent. No
entry → the tick evaluates and records state but sends nothing
(`not_configured`): with the external check configured, the silence alerts
(fail closed). A duplicated or malformed entry or a pg_net failure raises a
value-free `SAFETY_MONITOR_TICK_*` error (the cron run fails; nothing is
sent; the silence alerts).

**Trust and security.** Push-only: nothing new is reachable from outside; no
health endpoint, database credential, Management API token or Vercel bypass
leaves Supabase. The check-in URL can only report to its own check; a leaked
URL allows false "up" or "down" check-ins but reads nothing. Rotate by
regenerating the check's URL in Healthchecks.io and replacing the Vault
entry; revoke by deleting the check. The URL sits briefly in
`net.http_request_queue` like the dispatch credentials (the accepted pg_net
trust boundary). It is separate from the dispatch secret and both bypasses.

**Detected / not detected.**

| Failure | Detected |
|---|---|
| Supabase down or paused, pg_cron or pg_net stopped, evaluator crash | yes (check-ins stop, or `monitor_evaluator_error`) |
| Vercel down or misconfigured while dispatch is active | yes (dispatch responses / heartbeat) |
| Vercel down **before** activation | no (no traffic; a later external `/api/ready` probe) |
| Healthchecks.io itself down | no (rare; its status page) |
| The founder's alert email not arriving | mitigated by the second channel |
| An evaluator bug reporting `ok` | no at runtime; mitigated by `verifyM34fMonSafetyMonitor.mjs` |

**Operational checks.** `~/.tenotrainer-m34f/f-monitor.sql` (v2; operator
copy, outside the repository) reports the monitor job, its runs and
check-ins, the last evaluation and settings, and excludes the check-ins from
dispatch classification.

**Production provisioning sequence** (each step separately authorized):

1. Apply migration 66 to development (inert), then Production.
2. The founder creates the Healthchecks.io check (period 5, grace 10) and
   the integrations; enters the check-in URL in Production Vault (Vault UI,
   name verified absent first).
3. Boolean-only verification that the entry exists once and matches the
   pinned pattern.
4. Activate the **monitor** job:
   `SELECT cron.alter_job(<monitor jobid>, active := true)`; observe
   `pre_activation` check-ins arriving (Healthchecks.io shows "up").
5. Alert tests that never touch dispatch or clinical data:
   (a) deactivate the monitor job for ~20 minutes → "down" alert → reactivate
   → recovery notice; (b) `private.safety_monitor_set_dispatch_expected(true)`
   while the dispatcher stays inactive → `dispatch_scheduler_inactive`
   `/fail` alert → `set_dispatch_expected(false)` → recovery notice.
6. Only then Stage F: activate the dispatcher and declare it expected in
   one transaction.

**Rollback.** Deactivate the monitor job
(`cron.alter_job(<monitor jobid>, active := false)`) and pause the check in
Healthchecks.io (so the silence does not alert); optionally delete the Vault
entry. The migration's objects are inert without the job and the entry.

### Audit history and account deletion

Recipient, event, notice, outbox, attempt and requeue rows reference
`auth.users` without cascade: an account with safety-notification
responsibility history cannot be deleted. This is intentional audit-history
preservation (founder-accepted); deletion / anonymization policy is future
work.

### Development fixture purge (test tooling only)

`web/scripts/lib/m32FixturePurge.sql` (a session-temporary
`pg_temp.m32_fixture_purge`) + `web/scripts/lib/safetyFixturePurge.mjs`.
Not a migration, RPC, route, action or UI; no persistent function or grant.
Runs only after the M3.1 guard (`TENOTRAINER_MODE=development`, the `.env`
project and the linked CLI project both allow-listed and identical) with the
current run's exact fixture ids; each user must be synthetic
(`@example.invalid`, necessary not sufficient) and created in the run
window; organizations / exercises only when passed and proven disposable;
`REAL_ORG` never. Any coupling of a fixture actor to non-fixture data, or
any history older than the run, aborts. One transaction; the six history
guards are disabled only inside it and verified re-enabled; a catalog-driven
check proves zero residue in every column referencing `auth.users`. Any
error rolls everything back. Suites fail if teardown fails.
