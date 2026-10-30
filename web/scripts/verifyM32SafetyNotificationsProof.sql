-- M3.2 — ROLLBACK-ONLY pre-application proof of the safety-notification
-- migration. Nothing persists: the migration file is included VERBATIM
-- (runSqlSuite.mjs expands the @@include line and prints its sha256) inside
-- this transaction, exercised through the REAL C5 lifecycle / response /
-- reconciliation / release functions and in-transaction fixtures, then
-- rolled back.
--
-- now() is constant inside one transaction, so the passage of time is
-- simulated by back-dating fixture timestamps (confirmed_at, evaluated_at,
-- outbox times) — never by changing any function.
--
-- Run (guarded): TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyM32SafetyNotificationsProof.sql
BEGIN;

-- @@include web/scripts/verifyM32SafetyNotificationsHelpers.sql

-- ============================================================ before
DO $pre$
BEGIN
  PERFORM pg_temp.chk('pre: no M3.2 object exists before the migration',
    to_regclass('public.safety_notification_events') IS NULL AND to_regclass('public.safety_email_outbox') IS NULL
    AND to_regprocedure('public.safety_notifications_sweep()') IS NULL);
END
$pre$;

-- ============================================================ the migration, verbatim
-- @@include supabase/migrations/20261028000001_m3_2_safety_notifications.sql

-- @@include web/scripts/verifyM32SafetyNotificationsBody.sql

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
