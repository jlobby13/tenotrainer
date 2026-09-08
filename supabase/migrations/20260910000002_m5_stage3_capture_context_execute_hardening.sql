-- =============================================================================
-- Milestone 5, Stage 3 security-hardening patch: tighten
-- capture_session_guidance_context()'s EXECUTE privilege.
--
-- The original Stage 3 migration (20260910000001) explicitly granted
-- EXECUTE to `authenticated` but never revoked PostgreSQL's default
-- EXECUTE-to-PUBLIC grant a newly created function receives automatically
-- — leaving it callable by `anon` (and any other role) too. The function
-- is SECURITY DEFINER; although it never trusts client-supplied clinical
-- data and enforces its own ownership check internally (see its body),
-- minimum-privilege still applies: only the one role that actually needs
-- to call it should be able to. create_rehab_session_if_allowed() — the
-- only caller anywhere in this app — always runs as `authenticated` (the
-- Next.js route uses the anon-key client with the patient's own session;
-- nothing invokes it as `anon` or `service_role`), so `authenticated` is
-- the sole role granted here.
--
-- This is a NEW additive migration rather than an edit to
-- 20260910000001_m5_stage3_session_guidance_contexts.sql, which is already
-- applied to the linked development database — amending that file in
-- place now would leave its local content silently diverged from the
-- schema already running on the remote. See that migration for the
-- function's full definition and ownership/authentication checks, which
-- this patch does not touch or weaken.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION capture_session_guidance_context(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION capture_session_guidance_context(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION capture_session_guidance_context(UUID) TO authenticated;
