-- M3.2 — POST-application safety-notification suite (rollback-only). The
-- same checks as the pre-application proof, against the applied schema.
-- Nothing persists.
--
-- Run (guarded): TENOTRAINER_MODE=development node scripts/runSqlSuite.mjs scripts/verifyM32SafetyNotifications.sql
BEGIN;

-- @@include web/scripts/verifyM32SafetyNotificationsHelpers.sql

-- @@include web/scripts/verifyM32SafetyNotificationsBody.sql

SELECT result FROM verify_results ORDER BY seq;
ROLLBACK;
