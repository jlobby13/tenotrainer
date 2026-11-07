-- =============================================================================
-- M3.4f-MON — automated monitoring of the safety dispatch infrastructure
-- =============================================================================
-- A Supabase-side evaluator checks the safety notification machinery every
-- five minutes and checks in with an EXTERNAL dead-man's switch
-- (Healthchecks.io): a success ping when healthy, a /fail ping carrying
-- failure codes when not. The external service alerts the founder on a /fail
-- ping AND when check-ins stop arriving (period 5 min, grace 10 min), so a
-- dead database, pg_cron, pg_net or evaluator is detected outside Supabase.
--
-- Applying this migration is inert everywhere:
--   - no request is made; the monitor job is created INACTIVE;
--   - the check-in URL is an operator-supplied Vault entry; with none present
--     the tick evaluates but sends nothing (`not_configured`), so a
--     production check whose pings stop alerts (fail closed);
--   - the dispatch rules apply only after an operator declares recurring
--     dispatch expected (private.safety_monitor_set_dispatch_expected(true),
--     in the same transaction as the Stage F activation): before that the
--     intentionally inactive dispatch scheduler is not an alert.
--
-- Payloads carry fixed failure codes and integer / boolean metrics only:
-- never patient, clinician, recipient or event identifiers, addresses or
-- free text. Nothing here reads the outbox's recipients or the inbox.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. State (schema `private`, created by M3.4f; never API-exposed).
-- -----------------------------------------------------------------------------
CREATE TABLE private.safety_monitor_settings (
  id                       BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  dispatch_expected_active BOOLEAN NOT NULL DEFAULT false,
  dispatch_expected_since  TIMESTAMPTZ NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT dispatch_expected_active OR dispatch_expected_since IS NOT NULL)
);
INSERT INTO private.safety_monitor_settings (id) VALUES (true);

-- The last evaluation and status transitions (local visibility; the external
-- service owns alert deduplication and recovery notices).
CREATE TABLE private.safety_monitor_state (
  id                 BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_status        TEXT NULL CHECK (last_status IS NULL OR last_status IN ('ok', 'pre_activation', 'fail')),
  last_codes         TEXT[] NOT NULL DEFAULT '{}',
  last_evaluated_at  TIMESTAMPTZ NULL,
  last_transition_at TIMESTAMPTZ NULL,
  transitions        INTEGER NOT NULL DEFAULT 0,
  last_request_id    BIGINT NULL
);
INSERT INTO private.safety_monitor_state (id) VALUES (true);

-- The monitor's own pg_net request ids, so its check-in responses are never
-- classified as dispatch responses (net._http_response has no URL column).
CREATE TABLE private.safety_monitor_requests (
  request_id BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE private.safety_monitor_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.safety_monitor_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.safety_monitor_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.safety_monitor_settings, private.safety_monitor_state, private.safety_monitor_requests
  FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Is the pg_net background worker running? (A separate function so the
--    scratch proofs can substitute it; pg_net's worker is not a test double.)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.safety_monitor_pg_net_worker_up()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.backend_type ILIKE 'pg_net%worker%');
$$;

-- -----------------------------------------------------------------------------
-- 3. The evaluator. Returns {v, status, codes, m}: status 'ok' (dispatch
--    expected and healthy), 'pre_activation' (dispatch not yet expected and
--    everything else healthy) or 'fail'; codes sorted; m = integer / boolean
--    metrics. Thresholds (documented in docs/m3-safety-notifications.md):
--
--    always
--      sweep_job_inactive              the M3.2 sweep job missing or inactive
--      sweep_heartbeat_stale           sweep never succeeded or > 5 min ago
--      pg_net_worker_down              no pg_net worker backend
--      pg_net_queue_backlog            > 3 rows waiting in net.http_request_queue
--      notification_backlog            > 20 emails in flight, or the oldest > 15 min
--      open_alert_<kind>               an open safety_notification_alerts row
--                                      (every kind but orphan_fact_reconciled)
--    pre-activation (dispatch not expected)
--      dispatch_scheduler_unexpectedly_active
--    dispatch expected
--      dispatch_scheduler_inactive     the job missing or inactive
--      -- the rest after a 10-minute grace from dispatch_expected_since --
--      dispatch_runs_missing           < 8 runs in 10 min, or none in 3 min
--      dispatch_runs_failing           the last 3 runs all failed
--      dispatch_heartbeat_degraded     last success > 10 min ago
--      dispatch_heartbeat_stale        last success > 15 min ago (replaces degraded)
--      dispatch_failed_after_success   last_failed_at newer than last_succeeded_at
--      dispatch_auth_failures          >= 2 JSON 401 UNAUTHORIZED in 10 min
--      dispatch_protection_redirects   >= 2 HTML responses (followed login /
--                                      protection redirect) in 10 min
--      dispatch_http_errors            >= 3 other non-contract responses in 10 min
--      dispatch_timeouts               >= 3 pg_net timeouts / transport errors in 10 min
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.safety_monitor_evaluate()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_dispatch_job CONSTANT TEXT := 'tenotrainer_m34f_safety_dispatch';
  c_sweep_job    CONSTANT TEXT := 'tenotrainer_m32_safety_notification_sweep';
  v_now          TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_codes        TEXT[] := '{}';
  v_expected     BOOLEAN;
  v_since        TIMESTAMPTZ;
  v_in_grace     BOOLEAN := false;
  v_window_start TIMESTAMPTZ;
  v_sweep_active BOOLEAN;
  v_sweep_ok     TIMESTAMPTZ;
  v_disp_active  BOOLEAN;
  v_disp_jobid   BIGINT;
  v_hb_ok        TIMESTAMPTZ;
  v_hb_failed    TIMESTAMPTZ;
  v_worker_up    BOOLEAN;
  v_queue        BIGINT;
  v_in_flight    BIGINT;
  v_oldest       TIMESTAMPTZ;
  v_alert_kinds  TEXT[];
  v_open_alerts  BIGINT;
  v_runs_10m     BIGINT := 0;
  v_runs_3m      BIGINT := 0;
  v_failed_10m   BIGINT := 0;
  v_last3_failed BIGINT := 0;
  v_last3        BIGINT := 0;
  v_ok           BIGINT := 0;
  v_unauth       BIGINT := 0;
  v_html         BIGINT := 0;
  v_errors       BIGINT := 0;
  v_timeouts     BIGINT := 0;
  v_hb_age       BIGINT;
  v_sweep_age    BIGINT;
  v_status       TEXT;
BEGIN
  SELECT s.dispatch_expected_active, s.dispatch_expected_since INTO v_expected, v_since
  FROM private.safety_monitor_settings s WHERE s.id;

  -- Always-on checks -----------------------------------------------------------
  SELECT j.active INTO v_sweep_active FROM cron.job j WHERE j.jobname = c_sweep_job;
  IF v_sweep_active IS DISTINCT FROM true THEN v_codes := pg_catalog.array_append(v_codes, 'sweep_job_inactive'); END IF;

  SELECT h.last_succeeded_at INTO v_sweep_ok FROM public.safety_notification_heartbeats h WHERE h.component = 'sweep';
  v_sweep_age := pg_catalog.floor(EXTRACT(EPOCH FROM v_now - v_sweep_ok))::BIGINT;
  IF v_sweep_ok IS NULL OR v_now - v_sweep_ok > INTERVAL '5 minutes' THEN v_codes := pg_catalog.array_append(v_codes, 'sweep_heartbeat_stale'); END IF;

  v_worker_up := private.safety_monitor_pg_net_worker_up();
  IF NOT v_worker_up THEN v_codes := pg_catalog.array_append(v_codes, 'pg_net_worker_down'); END IF;

  SELECT pg_catalog.count(*) INTO v_queue FROM net.http_request_queue;
  IF v_queue > 3 THEN v_codes := pg_catalog.array_append(v_codes, 'pg_net_queue_backlog'); END IF;

  SELECT h.outbox_in_flight, h.oldest_in_flight_created_at INTO v_in_flight, v_oldest FROM public.safety_notification_health h;
  IF coalesce(v_in_flight, 0) > 20 OR (v_oldest IS NOT NULL AND v_now - v_oldest > INTERVAL '15 minutes') THEN
    v_codes := pg_catalog.array_append(v_codes, 'notification_backlog');
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT 'open_alert_' || a.kind ORDER BY 'open_alert_' || a.kind), pg_catalog.count(*)
    INTO v_alert_kinds, v_open_alerts
  FROM public.safety_notification_alerts a WHERE a.cleared_at IS NULL AND a.kind <> 'orphan_fact_reconciled';
  IF v_alert_kinds IS NOT NULL THEN v_codes := pg_catalog.array_cat(v_codes, v_alert_kinds); END IF;

  -- Dispatch -------------------------------------------------------------------
  SELECT j.jobid, j.active INTO v_disp_jobid, v_disp_active FROM cron.job j WHERE j.jobname = c_dispatch_job;
  SELECT h.last_succeeded_at, h.last_failed_at INTO v_hb_ok, v_hb_failed
  FROM public.safety_notification_heartbeats h WHERE h.component = 'dispatch';
  v_hb_age := pg_catalog.floor(EXTRACT(EPOCH FROM v_now - v_hb_ok))::BIGINT;

  IF NOT v_expected THEN
    IF v_disp_active IS TRUE THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_scheduler_unexpectedly_active'); END IF;
  ELSE
    IF v_disp_active IS DISTINCT FROM true THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_scheduler_inactive'); END IF;
    v_in_grace := v_now - v_since < INTERVAL '10 minutes';
    v_window_start := GREATEST(v_now - INTERVAL '10 minutes', v_since);

    IF NOT v_in_grace THEN
      SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE d.start_time > v_now - INTERVAL '3 minutes'),
             pg_catalog.count(*) FILTER (WHERE d.status = 'failed')
        INTO v_runs_10m, v_runs_3m, v_failed_10m
      FROM cron.job_run_details d WHERE d.jobid = v_disp_jobid AND d.start_time > v_window_start;
      IF v_runs_10m < 8 OR v_runs_3m = 0 THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_runs_missing'); END IF;

      SELECT pg_catalog.count(*), pg_catalog.count(*) FILTER (WHERE l.status = 'failed') INTO v_last3, v_last3_failed
      FROM (SELECT d.status FROM cron.job_run_details d WHERE d.jobid = v_disp_jobid
            ORDER BY d.start_time DESC LIMIT 3) l;
      IF v_last3 = 3 AND v_last3_failed = 3 THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_runs_failing'); END IF;

      IF v_hb_ok IS NULL OR v_now - v_hb_ok > INTERVAL '15 minutes' THEN
        v_codes := pg_catalog.array_append(v_codes, 'dispatch_heartbeat_stale');
      ELSIF v_now - v_hb_ok > INTERVAL '10 minutes' THEN
        v_codes := pg_catalog.array_append(v_codes, 'dispatch_heartbeat_degraded');
      END IF;
      IF v_hb_failed IS NOT NULL AND (v_hb_ok IS NULL OR v_hb_failed > v_hb_ok) THEN
        v_codes := pg_catalog.array_append(v_codes, 'dispatch_failed_after_success');
      END IF;

      -- Dispatch responses (the monitor's own check-ins excluded).
      SELECT pg_catalog.count(*) FILTER (WHERE c.class = 'ok'),
             pg_catalog.count(*) FILTER (WHERE c.class = 'unauthorized'),
             pg_catalog.count(*) FILTER (WHERE c.class = 'html'),
             pg_catalog.count(*) FILTER (WHERE c.class = 'error'),
             pg_catalog.count(*) FILTER (WHERE c.class = 'timeout')
        INTO v_ok, v_unauth, v_html, v_errors, v_timeouts
      FROM (
        SELECT CASE
                 WHEN r.timed_out OR r.status_code IS NULL THEN 'timeout'
                 WHEN r.status_code = 200 AND b.body ->> 'result' = 'dispatched'
                      AND b.body ?& ARRAY['claimed','accepted','retry_scheduled','failed_permanent','stale','record_failed','batches','duration_ms']
                      AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(b.body)) = 9 THEN 'ok'
                 WHEN r.content_type ILIKE 'text/html%' THEN 'html'
                 WHEN r.status_code = 401 AND b.body ->> 'error' = 'UNAUTHORIZED' THEN 'unauthorized'
                 ELSE 'error'
               END AS class
        FROM net._http_response r
        CROSS JOIN LATERAL (SELECT CASE WHEN r.content_type ILIKE 'application/json%' AND pg_catalog.pg_input_is_valid(r.content, 'jsonb')
                                        THEN r.content::JSONB END AS body) b
        WHERE r.created > v_window_start
          AND NOT EXISTS (SELECT 1 FROM private.safety_monitor_requests m WHERE m.request_id = r.id)
      ) c;
      IF v_unauth >= 2 THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_auth_failures'); END IF;
      IF v_html >= 2 THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_protection_redirects'); END IF;
      IF v_errors >= 3 THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_http_errors'); END IF;
      IF v_timeouts >= 3 THEN v_codes := pg_catalog.array_append(v_codes, 'dispatch_timeouts'); END IF;
    END IF;
  END IF;

  SELECT coalesce(pg_catalog.array_agg(DISTINCT c ORDER BY c), '{}') INTO v_codes FROM pg_catalog.unnest(v_codes) c;
  v_status := CASE WHEN pg_catalog.cardinality(v_codes) > 0 THEN 'fail' WHEN v_expected THEN 'ok' ELSE 'pre_activation' END;

  RETURN pg_catalog.jsonb_build_object(
    'v', 1,
    'status', v_status,
    'codes', pg_catalog.to_jsonb(v_codes),
    'm', pg_catalog.jsonb_build_object(
      'dispatch_expected', v_expected,
      'dispatch_grace', v_in_grace,
      'dispatch_job_active', coalesce(v_disp_active, false),
      'sweep_age_s', v_sweep_age,
      'dispatch_heartbeat_age_s', v_hb_age,
      'dispatch_runs_10m', v_runs_10m,
      'dispatch_failed_runs_10m', v_failed_10m,
      'resp_ok_10m', v_ok,
      'resp_unauthorized_10m', v_unauth,
      'resp_html_10m', v_html,
      'resp_error_10m', v_errors,
      'resp_timeout_10m', v_timeouts,
      'pg_net_worker_up', v_worker_up,
      'pg_net_queue', v_queue,
      'outbox_in_flight', coalesce(v_in_flight, 0),
      'open_alerts', v_open_alerts));
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Declaring recurring dispatch expected (the Stage F activation runs this
--    in the same transaction as cron.alter_job(..., active := true)).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.safety_monitor_set_dispatch_expected(p_expected BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_expected IS NULL THEN
    RAISE EXCEPTION 'SAFETY_MONITOR_INVALID_ARGUMENT' USING ERRCODE = 'P0001';
  END IF;
  UPDATE private.safety_monitor_settings s
     SET dispatch_expected_active = p_expected,
         dispatch_expected_since = CASE WHEN p_expected AND NOT s.dispatch_expected_active THEN pg_catalog.clock_timestamp()
                                        WHEN p_expected THEN s.dispatch_expected_since END,
         updated_at = pg_catalog.clock_timestamp()
   WHERE s.id;
  RETURN (SELECT pg_catalog.jsonb_build_object('dispatch_expected_active', s.dispatch_expected_active,
                                               'dispatch_expected_since', s.dispatch_expected_since)
          FROM private.safety_monitor_settings s WHERE s.id);
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. The check-in tick (every five minutes once activated).
--
-- Vault contract (exactly once; never logged or returned):
--   tenotrainer_production_monitor_ping_url   https://hc-ping.com/<check uuid>
--
-- Evaluates (an evaluator failure becomes a `fail` check-in carrying
-- monitor_evaluator_error), records the result, then POSTs the payload to
-- <ping url> (ok / pre_activation) or <ping url>/fail. No entry → nothing is
-- sent (`not_configured`). A duplicated or malformed entry, or a pg_net
-- failure, raises a value-free SAFETY_MONITOR_TICK_* error: nothing is sent,
-- and the external grace period turns the silence into an alert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.safety_monitor_tick()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_name CONSTANT TEXT := 'tenotrainer_production_monitor_ping_url';
  v_eval       JSONB;
  v_status     TEXT;
  v_codes      TEXT[];
  v_prev       TEXT;
  v_count      BIGINT;
  v_url        TEXT;
  v_request_id BIGINT;
BEGIN
  BEGIN
    v_eval := private.safety_monitor_evaluate();
  EXCEPTION WHEN OTHERS THEN
    v_eval := pg_catalog.jsonb_build_object('v', 1, 'status', 'fail', 'codes', pg_catalog.jsonb_build_array('monitor_evaluator_error'),
                                            'm', pg_catalog.jsonb_build_object('evaluator_sqlstate', SQLSTATE));
  END;
  v_status := v_eval ->> 'status';
  SELECT coalesce(pg_catalog.array_agg(x), '{}') INTO v_codes FROM pg_catalog.jsonb_array_elements_text(v_eval -> 'codes') x;

  SELECT s.last_status INTO v_prev FROM private.safety_monitor_state s WHERE s.id FOR UPDATE;
  UPDATE private.safety_monitor_state s
     SET last_status = v_status, last_codes = v_codes, last_evaluated_at = pg_catalog.clock_timestamp(),
         last_transition_at = CASE WHEN v_prev IS DISTINCT FROM v_status THEN pg_catalog.clock_timestamp() ELSE s.last_transition_at END,
         transitions = s.transitions + CASE WHEN v_prev IS DISTINCT FROM v_status THEN 1 ELSE 0 END
   WHERE s.id;

  BEGIN
    IF pg_catalog.to_regclass('vault.decrypted_secrets') IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', v_status, 'codes', pg_catalog.to_jsonb(v_codes), 'ping', 'not_configured');
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM vault.decrypted_secrets s WHERE s.name = c_name;
    IF v_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('status', v_status, 'codes', pg_catalog.to_jsonb(v_codes), 'ping', 'not_configured');
    END IF;
    IF v_count > 1 THEN
      RAISE EXCEPTION 'SAFETY_MONITOR_TICK_DUPLICATE_CONFIGURATION' USING ERRCODE = 'P0001';
    END IF;
    SELECT s.decrypted_secret INTO v_url FROM vault.decrypted_secrets s WHERE s.name = c_name;
    -- Exactly a Healthchecks.io UUID check-in URL: no other host, scheme,
    -- port, path, query, fragment or trailing slash.
    IF v_url IS NULL OR v_url !~ '^https://hc-ping\.com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'SAFETY_MONITOR_TICK_URL_NOT_ALLOWED' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      v_request_id := net.http_post(
        url := CASE WHEN v_status = 'fail' THEN v_url || '/fail' ELSE v_url END,
        body := v_eval,
        headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 10000
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'SAFETY_MONITOR_TICK_ENQUEUE_FAILED' USING ERRCODE = 'P0001', DETAIL = 'sqlstate=' || SQLSTATE;
    END;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SAFETY_MONITOR_TICK_%' THEN
      RAISE;
    END IF;
    RAISE EXCEPTION 'SAFETY_MONITOR_TICK_INTERNAL_ERROR' USING ERRCODE = 'P0001', DETAIL = 'sqlstate=' || SQLSTATE;
  END;

  INSERT INTO private.safety_monitor_requests (request_id) VALUES (v_request_id);
  DELETE FROM private.safety_monitor_requests r WHERE r.created_at < pg_catalog.clock_timestamp() - INTERVAL '2 days';
  UPDATE private.safety_monitor_state s SET last_request_id = v_request_id WHERE s.id;

  RETURN pg_catalog.jsonb_build_object('status', v_status, 'codes', pg_catalog.to_jsonb(v_codes), 'ping', 'enqueued', 'request_id', v_request_id);
END;
$$;

REVOKE ALL ON FUNCTION private.safety_monitor_pg_net_worker_up() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.safety_monitor_evaluate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.safety_monitor_set_dispatch_expected(BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.safety_monitor_tick() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.safety_monitor_tick() IS
  'M3.4f-MON: evaluates the safety dispatch infrastructure and checks in with the external dead-man''s switch (Vault entry tenotrainer_production_monitor_ping_url; not_configured when absent). Payload: failure codes and integer / boolean metrics only.';

-- -----------------------------------------------------------------------------
-- 6. The monitor job: every five minutes, created INACTIVE (operator
--    activation after the check-in URL is in Vault:
--    SELECT cron.alter_job(<jobid>, active := true)).
-- -----------------------------------------------------------------------------
SELECT cron.schedule('tenotrainer_m34f_mon_safety_monitor', '*/5 * * * *', 'SELECT private.safety_monitor_tick()');
SELECT cron.alter_job(j.jobid, active := false) FROM cron.job j WHERE j.jobname = 'tenotrainer_m34f_mon_safety_monitor';
