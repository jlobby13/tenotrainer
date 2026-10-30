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
in maintenance (the D1 exception). Recurring production invocation is M3.4.
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
dispatch, open alerts (kind, opaque subject, code). No PHI. External paging
is M3.3; the production alert destination is M3.4.

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
