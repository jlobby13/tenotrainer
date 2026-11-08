-- =============================================================================
-- M3.5 D3 — authentication rate limiting (login and password recovery)
-- =============================================================================
-- Counter storage for the application's rate limiter (web/lib/authRateLimit.ts).
-- The application derives every bucket key as an HMAC-SHA256 (server-only
-- key) over "<scope>|<normalized identifier>": no email address, IP address
-- or user id is ever stored — only 64-hex keys.
--
--   private.auth_rate_limit_buckets      one row per active bucket
--   private.auth_rate_limit_maintenance  last bounded cleanup (one row)
--   public.auth_rate_limit_reserve(keys, limits, windows) -> {allowed, retry_after_s}
--   public.auth_rate_limit_clear(keys)
--
-- Reservation semantics (atomic, one transaction, rows locked in a fixed
-- order so concurrent callers cannot deadlock or exceed a limit):
--   - a bucket whose fixed window has elapsed starts a new window;
--   - if ANY bucket is already at its limit, nothing is incremented and the
--     call is refused with the longest remaining wait — a refused request
--     never extends a lockout or grows a counter;
--   - otherwise every bucket is incremented and the call is allowed.
-- At most once every 10 minutes a call also deletes up to 200 buckets idle
-- for more than a day (bounded cleanup; no cron job).
--
-- service_role only (the server's limiter); API roles have no access.
-- Touches no clinical, safety, authorization or cron object.
-- =============================================================================

CREATE TABLE private.auth_rate_limit_buckets (
  bucket_key   TEXT PRIMARY KEY CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER NOT NULL CHECK (hits >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_rate_limit_buckets_updated_at ON private.auth_rate_limit_buckets (updated_at);

CREATE TABLE private.auth_rate_limit_maintenance (
  id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  last_cleanup_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity'
);
INSERT INTO private.auth_rate_limit_maintenance (id) VALUES (true);

ALTER TABLE private.auth_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.auth_rate_limit_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.auth_rate_limit_buckets, private.auth_rate_limit_maintenance
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.auth_rate_limit_reserve(p_keys TEXT[], p_limits INTEGER[], p_window_seconds INTEGER[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now     TIMESTAMPTZ := pg_catalog.clock_timestamp();
  v_n       INTEGER := pg_catalog.cardinality(p_keys);
  v_blocked BOOLEAN := false;
  v_wait    DOUBLE PRECISION := 0;
  r         RECORD;
BEGIN
  IF v_n IS NULL OR v_n < 1 OR v_n > 8
     OR pg_catalog.cardinality(p_limits) IS DISTINCT FROM v_n
     OR pg_catalog.cardinality(p_window_seconds) IS DISTINCT FROM v_n
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_keys) k WHERE k IS NULL OR k !~ '^[0-9a-f]{64}$')
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_limits) l WHERE l IS NULL OR l < 1 OR l > 10000)
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_window_seconds) w WHERE w IS NULL OR w < 1 OR w > 86400)
     OR (SELECT pg_catalog.count(DISTINCT k) FROM pg_catalog.unnest(p_keys) k) <> v_n THEN
    RAISE EXCEPTION 'AUTH_RATE_LIMIT_INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;

  -- Make sure every bucket row exists, then lock all of them in key order.
  INSERT INTO private.auth_rate_limit_buckets (bucket_key, window_start, hits, updated_at)
  SELECT k, v_now, 0, v_now FROM pg_catalog.unnest(p_keys) k ORDER BY k
  ON CONFLICT (bucket_key) DO NOTHING;

  FOR r IN
    SELECT b.bucket_key, b.window_start, b.hits, a.lim, a.win
    FROM private.auth_rate_limit_buckets b
    JOIN ROWS FROM (pg_catalog.unnest(p_keys), pg_catalog.unnest(p_limits), pg_catalog.unnest(p_window_seconds)) AS a(k, lim, win) ON a.k = b.bucket_key
    ORDER BY b.bucket_key
    FOR UPDATE OF b
  LOOP
    IF r.window_start + pg_catalog.make_interval(secs => r.win) <= v_now THEN
      -- The window has elapsed: a fresh one starts with this request.
      UPDATE private.auth_rate_limit_buckets SET window_start = v_now, hits = 0, updated_at = v_now
      WHERE bucket_key = r.bucket_key;
    ELSIF r.hits >= r.lim THEN
      v_blocked := true;
      v_wait := GREATEST(v_wait, EXTRACT(EPOCH FROM (r.window_start + pg_catalog.make_interval(secs => r.win)) - v_now));
    END IF;
  END LOOP;

  IF NOT v_blocked THEN
    UPDATE private.auth_rate_limit_buckets b SET hits = b.hits + 1, updated_at = v_now
    WHERE b.bucket_key = ANY (p_keys);
  END IF;

  -- Bounded cleanup: at most every 10 minutes, at most 200 idle buckets.
  -- SKIP LOCKED: a concurrent caller never waits for it.
  PERFORM 1 FROM private.auth_rate_limit_maintenance m
  WHERE m.id AND m.last_cleanup_at < v_now - INTERVAL '10 minutes'
  FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE private.auth_rate_limit_maintenance SET last_cleanup_at = v_now WHERE id;
    DELETE FROM private.auth_rate_limit_buckets b
    WHERE b.ctid IN (SELECT o.ctid FROM private.auth_rate_limit_buckets o
                     WHERE o.updated_at < v_now - INTERVAL '1 day' AND o.bucket_key <> ALL (p_keys)
                     LIMIT 200);
  END IF;

  RETURN pg_catalog.jsonb_build_object('allowed', NOT v_blocked, 'retry_after_s', pg_catalog.ceil(v_wait)::INTEGER);
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_rate_limit_clear(p_keys TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_keys IS NULL OR pg_catalog.cardinality(p_keys) < 1 OR pg_catalog.cardinality(p_keys) > 8
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_keys) k WHERE k IS NULL OR k !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'AUTH_RATE_LIMIT_INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM private.auth_rate_limit_buckets b WHERE b.bucket_key = ANY (p_keys);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_rate_limit_reserve(TEXT[], INTEGER[], INTEGER[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_rate_limit_clear(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_rate_limit_reserve(TEXT[], INTEGER[], INTEGER[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_rate_limit_clear(TEXT[]) TO service_role;

COMMENT ON FUNCTION public.auth_rate_limit_reserve(TEXT[], INTEGER[], INTEGER[]) IS
  'M3.5 D3: atomically reserve one attempt in every given rate-limit bucket (HMAC keys only); refuses without incrementing when any bucket is at its limit.';
