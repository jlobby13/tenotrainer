-- M3.2 — POST-application rollback-only check of the guarded development
-- fixture purge (same checks as the pre-application proof). Nothing persists.
--
-- Run (guarded): TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyM32FixturePurgeCheck.sql
BEGIN;

-- @@include web/scripts/verifyM32SafetyNotificationsHelpers.sql

-- @@include web/scripts/lib/m32FixturePurge.sql

-- @@include web/scripts/verifyM32FixturePurgeBody.sql

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
