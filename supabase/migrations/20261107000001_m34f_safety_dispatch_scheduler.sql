-- =============================================================================
-- M3.4f — production scheduler for safety email dispatch (pg_cron + pg_net)
-- =============================================================================
-- The M3.2 migration schedules only the SQL sweep and deliberately encodes no
-- HTTP dispatch schedule, URL or secret. This migration adds the database-side
-- caller for POST /api/internal/safety-notifications/dispatch, built so that
-- applying it is inert everywhere:
--
--   - pg_net is enabled; no request is made by this migration. Its objects
--     are owned by the platform (supabase_admin) with Supabase's default
--     PUBLIC grants, which this migration's owner cannot revoke; `net` is not
--     exposed through the Data API (see section 1).
--   - private.safety_dispatch_tick() (schema `private`, not API-exposed;
--     SECURITY DEFINER, empty search_path, EXECUTE for nobody but its owner)
--     reads three operator-supplied Vault entries. With none present it does
--     nothing (`not_configured`): development and fresh databases never
--     receive them. Partial, duplicated or malformed configuration fails
--     closed with a value-free error.
--   - The target URL is pinned to the canonical production dispatch endpoint
--     below: the wrapper is not a generic HTTP client. A different canonical
--     origin (e.g. a custom domain) is a reviewed forward migration, made
--     together with TENOTRAINER_APP_ORIGIN and the Vault URL entry.
--   - The cron job `tenotrainer_m34f_safety_dispatch` (every minute) is
--     created INACTIVE; an operator activates it after the empty-queue proof.
--     Its command is the bare wrapper call: no URL or credential.
--
-- Secrets never appear in this file, the cron command, return values or
-- errors. Vault values are entered by the operator (Supabase dashboard).
-- Delivery semantics (claim, lease, idempotent provider send, heartbeat)
-- stay in the application route. pg_net does not retry; it does follow
-- redirects (libcurl FOLLOWLOCATION, no option to disable), so the pinned
-- endpoint must never redirect.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. pg_net (Supabase's supported pattern; its objects live in schema `net`).
--    On Supabase the extension's objects are owned by supabase_admin, with
--    USAGE / EXECUTE / table privileges granted to PUBLIC and the API roles
--    (measured on development, pg_net 0.20.4). A REVOKE issued by this
--    migration's owner is a no-op there, so none is attempted; the access
--    boundary is that `net` is not a Data API schema and anon /
--    authenticated are NOLOGIN. The scheduler's own entry point (section 3)
--    is owner-only.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- 2. The private schema (never exposed through the Data API).
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. The scheduler wrapper.
--
-- Vault contract (each name exactly once; values never logged or returned):
--   tenotrainer_production_dispatch_url           the canonical dispatch URL
--   tenotrainer_production_dispatch_secret        SAFETY_DISPATCH_SECRET
--   tenotrainer_production_dispatch_vercel_bypass the scheduler's Vercel
--                                                 Deployment Protection bypass
--
-- Returns only {status, request_id}. Failures raise
-- SAFETY_DISPATCH_TICK_<CODE> (P0001) with no configured value in the
-- message or detail, so pg_cron records a failed run with a safe message.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.safety_dispatch_tick()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_dispatch_url CONSTANT TEXT := 'https://tenotrainer.vercel.app/api/internal/safety-notifications/dispatch';
  c_names CONSTANT TEXT[] := ARRAY[
    'tenotrainer_production_dispatch_url',
    'tenotrainer_production_dispatch_secret',
    'tenotrainer_production_dispatch_vercel_bypass'
  ];
  v_name TEXT;
  v_count BIGINT;
  v_missing INT := 0;
  v_url TEXT;
  v_secret TEXT;
  v_bypass TEXT;
  v_request_id BIGINT;
BEGIN
  BEGIN
    IF pg_catalog.to_regclass('vault.decrypted_secrets') IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_configured');
    END IF;

    FOREACH v_name IN ARRAY c_names LOOP
      SELECT pg_catalog.count(*) INTO v_count FROM vault.decrypted_secrets s WHERE s.name = v_name;
      IF v_count > 1 THEN
        RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_DUPLICATE_CONFIGURATION' USING ERRCODE = 'P0001';
      END IF;
      IF v_count = 0 THEN
        v_missing := v_missing + 1;
      END IF;
    END LOOP;
    IF v_missing = pg_catalog.array_length(c_names, 1) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_configured');
    END IF;
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_PARTIAL_CONFIGURATION' USING ERRCODE = 'P0001';
    END IF;

    SELECT s.decrypted_secret INTO v_url FROM vault.decrypted_secrets s WHERE s.name = c_names[1];
    SELECT s.decrypted_secret INTO v_secret FROM vault.decrypted_secrets s WHERE s.name = c_names[2];
    SELECT s.decrypted_secret INTO v_bypass FROM vault.decrypted_secrets s WHERE s.name = c_names[3];

    -- Exact canonical endpoint only (no other host, scheme, port, path,
    -- query, fragment or trailing slash).
    IF v_url IS DISTINCT FROM c_dispatch_url THEN
      RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_URL_NOT_ALLOWED' USING ERRCODE = 'P0001';
    END IF;
    -- Printable ASCII without spaces or control characters: no header
    -- injection. The dispatch secret matches the application's 32-character
    -- minimum.
    IF v_secret IS NULL OR pg_catalog.char_length(v_secret) NOT BETWEEN 32 AND 512 OR v_secret !~ '^[!-~]+$' THEN
      RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_DISPATCH_SECRET_MALFORMED' USING ERRCODE = 'P0001';
    END IF;
    IF v_bypass IS NULL OR pg_catalog.char_length(v_bypass) NOT BETWEEN 16 AND 512 OR v_bypass !~ '^[!-~]+$' THEN
      RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_BYPASS_MALFORMED' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      v_request_id := net.http_post(
        url := c_dispatch_url,
        body := '{}'::JSONB,
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_secret,
          'x-vercel-protection-bypass', v_bypass
        ),
        timeout_milliseconds := 30000
      );
    EXCEPTION WHEN OTHERS THEN
      -- pg_net's own error text could echo the request; never propagate it.
      RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_ENQUEUE_FAILED' USING ERRCODE = 'P0001', DETAIL = 'sqlstate=' || SQLSTATE;
    END;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SAFETY_DISPATCH_TICK_%' THEN
      RAISE;
    END IF;
    RAISE EXCEPTION 'SAFETY_DISPATCH_TICK_INTERNAL_ERROR' USING ERRCODE = 'P0001', DETAIL = 'sqlstate=' || SQLSTATE;
  END;

  RETURN pg_catalog.jsonb_build_object('status', 'enqueued', 'request_id', v_request_id);
END;
$$;

REVOKE ALL ON FUNCTION private.safety_dispatch_tick() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.safety_dispatch_tick() IS
  'M3.4f: the scheduler''s caller of the protected safety dispatch route. Reads three operator-supplied Vault entries (not_configured when none exist); pinned to the canonical dispatch URL; returns {status, request_id} only; failures raise value-free SAFETY_DISPATCH_TICK_* errors.';

-- -----------------------------------------------------------------------------
-- 4. The dispatch job: every minute, created INACTIVE (operator activation:
--    SELECT cron.alter_job(<jobid>, active := true)).
-- -----------------------------------------------------------------------------
SELECT cron.schedule('tenotrainer_m34f_safety_dispatch', '* * * * *', 'SELECT private.safety_dispatch_tick()');
SELECT cron.alter_job(j.jobid, active := false) FROM cron.job j WHERE j.jobname = 'tenotrainer_m34f_safety_dispatch';
