-- =============================================================================
-- M3.1 — retire legacy patient database write authority and tighten client
-- grants (development and production alike; one deterministic, unconditional
-- forward migration).
--
-- The C5 runtime, M1 clinician review/release, M2 assignment/invitation
-- authority and PEC all write through server-only SECURITY DEFINER RPCs or
-- the service role; none of the authority removed here is used by them.
-- Proven before application by web/scripts/verifyM3RevocationProof.sql
-- (rollback-only, runs THIS file verbatim) and after application by
-- web/scripts/verifyM3AdversarialSurface.mjs --expect-revoked.
--
-- PRESERVED deliberately:
--   * profiles own UPDATE (timezone / morning reminder), notifications
--     UPDATE(read_at), reconcile_missing_acute_episodes;
--   * canonical_exercises / exercise_reference_dosage platform-admin
--     (super_user) policies, including exercise_reference_dosage DELETE
--     (C5.3D canonical-library authority);
--   * the M6 Heuristics / Evidence catalog authoring model (Stage 3A):
--     authenticated INSERT/UPDATE + its six clinician_admin/super_user
--     policies on m6_heuristics, m6_evidence_sources, m6_heuristic_evidence;
--   * clinician_exercise_favorites own INSERT/SELECT (the product path is
--     service-role setExerciseFavorite());
--   * every service_role privilege.
-- RLS is not disabled or weakened anywhere; no policy is created.
-- =============================================================================

-- 1. Legacy patient-own write policies (FastAPI-era legacy runtime rows).
DROP POLICY IF EXISTS "rehab_sessions: own insert" ON rehab_sessions;
DROP POLICY IF EXISTS "rehab_sessions: own update" ON rehab_sessions;
DROP POLICY IF EXISTS "set_outcomes: own insert" ON set_outcomes;
DROP POLICY IF EXISTS "set_outcomes: own update" ON set_outcomes;
DROP POLICY IF EXISTS "morning_responses: own insert" ON morning_responses;
DROP POLICY IF EXISTS "morning_responses: own update" ON morning_responses;
DROP POLICY IF EXISTS "session_events: own insert" ON session_events;
DROP POLICY IF EXISTS "daily_logs: own insert" ON daily_logs;
DROP POLICY IF EXISTS "daily_logs: own update" ON daily_logs;
DROP POLICY IF EXISTS "onboarding: own insert" ON onboarding_assessments;
DROP POLICY IF EXISTS "progression: own insert" ON progression_decisions;
DROP POLICY IF EXISTS "rehab_plans: own insert" ON rehab_plans;
DROP POLICY IF EXISTS "sessions: own insert" ON sessions;
DROP POLICY IF EXISTS "follow_ups: own insert" ON session_follow_ups;
DROP POLICY IF EXISTS "follow_ups: own update" ON session_follow_ups;
DROP POLICY IF EXISTS "visa_a: own insert" ON visa_a_responses;
DROP POLICY IF EXISTS "messages: own insert" ON messages;
DROP POLICY IF EXISTS "messages: mark read" ON messages;

-- 2. Retired legacy staff / Stage-1 library direct-write policies (the
--    FastAPI-era supervisor dashboard's Supabase tables, and the Stage-1
--    exercises / knowledge_entries tables superseded by canonical_exercises).
DROP POLICY IF EXISTS "alerts: supervisor update (resolve)" ON supervisor_alerts;
DROP POLICY IF EXISTS "sup_assessments: supervisor insert" ON supervisor_assessments;
DROP POLICY IF EXISTS "sup_assessments: supervisor update" ON supervisor_assessments;
DROP POLICY IF EXISTS "case_notes: supervisor insert" ON supervisor_case_notes;
DROP POLICY IF EXISTS "sup_comments: supervisor write" ON supervisor_session_comments;
DROP POLICY IF EXISTS "sup_comments: supervisor update" ON supervisor_session_comments;
DROP POLICY IF EXISTS "exercises: clinician_admin write" ON exercises;
DROP POLICY IF EXISTS "exercises: clinician_admin update" ON exercises;
DROP POLICY IF EXISTS "kb: clinician_admin write" ON knowledge_entries;
DROP POLICY IF EXISTS "kb: clinician_admin update" ON knowledge_entries;

-- 3. Client write grants on the retired legacy tables (a table-level REVOKE
--    also revokes the corresponding column-level grants).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  rehab_sessions, set_outcomes, morning_responses, session_events,
  daily_logs, onboarding_assessments, progression_decisions, rehab_plans, sessions,
  session_follow_ups, visa_a_responses, messages, schedule_overrides, tfa_codes,
  supervisor_alerts, supervisor_assessments, supervisor_case_notes, supervisor_session_comments, supervisor_audit_logs,
  exercises, knowledge_entries
FROM anon, authenticated;

-- 4. Direct authenticated DELETE that no current product flow uses (none of
--    these tables has a policy a current flow deletes through; favorites
--    are removed by the service-role setExerciseFavorite()). The M6 catalog
--    keeps INSERT/UPDATE authoring but never needed DELETE.
--    exercise_reference_dosage DELETE is intentionally NOT revoked.
REVOKE DELETE ON organizations, profiles, clinician_exercise_favorites,
  m6_heuristics, m6_evidence_sources, m6_heuristic_evidence
FROM authenticated;

-- 5. Legacy client-executable mutation functions.
REVOKE EXECUTE ON FUNCTION create_rehab_session_if_allowed(uuid, text, text, date, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION capture_session_guidance_context(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION capture_cautious_return_context(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_blocked_loading_opportunity(uuid, text, smallint) FROM PUBLIC, anon, authenticated;

-- 6. Grant hygiene across every public table: anon never writes; neither
--    client role truncates. (Catalog loop over the public tables that exist —
--    identical in every environment, since every environment is built from
--    the same migrations.)
DO $m31_revoke$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon', t.relname);
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM authenticated', t.relname);
  END LOOP;
END $m31_revoke$;

-- 7. Future tables created by migrations (role postgres) do not regain anon
--    writes, client TRUNCATE, or authenticated DELETE. A future table that
--    genuinely needs client DELETE must GRANT it explicitly with its policy.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE DELETE, TRUNCATE ON TABLES FROM authenticated;
