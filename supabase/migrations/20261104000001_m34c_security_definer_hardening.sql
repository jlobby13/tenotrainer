-- =============================================================================
-- M3.4c — SECURITY DEFINER hardening (founder-approved Security Advisor
-- remediation). Privilege and configuration changes only: no function body,
-- trigger binding, policy, table or data changes.
--
-- Background: PostgreSQL grants EXECUTE on new functions to PUBLIC, and the
-- Supabase default privileges on schema public also grant it to anon,
-- authenticated and service_role. Functions whose migrations did not revoke
-- that default stayed callable through the Data API. The M3.4c audit found
-- no exploitable path; this removes the execution that nothing needs and
-- pins search_path on the SECURITY DEFINER functions that lacked it.
--
-- Deliberately unchanged (documented in docs/m3-production-security.md):
--   - is_org_clinician, can_access_prescription_workout, is_org_member and
--     is_org_super_user keep anon / authenticated EXECUTE: public-role RLS
--     policies call them, including the anonymous readiness read of
--     canonical_exercises; each answers only about auth.uid();
--   - is_platform_super_user and reconcile_missing_acute_episodes keep
--     authenticated EXECUTE (RLS; the legacy development session route);
--   - the 16 SECURITY INVOKER functions without a fixed search_path,
--     including create_rehab_session_if_allowed, are not altered;
--   - pg_trgm stays in public; default privileges are not changed.
-- =============================================================================

-- 1. Trigger functions: never called directly. A trigger fires without the
--    invoking role holding EXECUTE on its function.
REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.trg_acute_safety_releases_guard() FROM PUBLIC, anon, authenticated, service_role;

-- 2. Unused role helpers (no policy, function or application caller):
--    server-side only.
REVOKE EXECUTE ON FUNCTION public.get_org_role(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.has_org_role(uuid, public.org_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_org_clinician_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_role(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.has_org_role(uuid, public.org_role) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_org_clinician_admin(uuid) TO service_role;

-- 3. Fixed search_path for the 15 SECURITY DEFINER functions that lacked one
--    (the convention the other SECURITY DEFINER functions already follow).
--    Every reference resolves exactly as before: public objects, the
--    schema-qualified auth.uid(), and pg_catalog built-ins.
ALTER FUNCTION public.can_access_prescription_workout(uuid) SET search_path = public;
ALTER FUNCTION public.clinician_can_access_exercise(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.copy_prescription_version_content_into_draft(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.copy_template_content_into_draft(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.create_prescription_draft(uuid, uuid, text, uuid, uuid) SET search_path = public;
ALTER FUNCTION public.get_org_role(uuid) SET search_path = public;
ALTER FUNCTION public.handle_new_auth_user() SET search_path = public;
ALTER FUNCTION public.has_org_role(uuid, public.org_role) SET search_path = public;
ALTER FUNCTION public.is_org_clinician(uuid) SET search_path = public;
ALTER FUNCTION public.is_org_clinician_admin(uuid) SET search_path = public;
ALTER FUNCTION public.is_org_member(uuid) SET search_path = public;
ALTER FUNCTION public.is_org_super_user(uuid) SET search_path = public;
ALTER FUNCTION public.is_platform_super_user() SET search_path = public;
ALTER FUNCTION public.reorder_prescription_exercises(uuid, uuid, uuid[]) SET search_path = public;
ALTER FUNCTION public.reorder_prescription_workouts(uuid, uuid, uuid[]) SET search_path = public;
