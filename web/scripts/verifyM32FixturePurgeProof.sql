-- M3.2 — ROLLBACK-ONLY pre-application proof of the guarded development
-- fixture purge: the migration and the purge tool are included VERBATIM;
-- refusal, induced-failure rollback, zero residue, untouched pre-existing
-- data and post-purge immutability are proven; nothing persists.
--
-- Run (guarded): TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyM32FixturePurgeProof.sql
BEGIN;

-- @@include web/scripts/verifyM32SafetyNotificationsHelpers.sql

-- @@include supabase/migrations/20261028000001_m3_2_safety_notifications.sql

-- @@include web/scripts/lib/m32FixturePurge.sql

-- @@include web/scripts/verifyM32FixturePurgeBody.sql

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
