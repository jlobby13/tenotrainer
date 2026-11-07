-- M3.4f — scratch TEST DOUBLE of pg_net's surface used by the migrations:
-- schema net, net.http_post (pg_net's signature) and the request queue.
-- Requests are recorded in net.http_request_queue; nothing is ever sent.
CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (
  id                   BIGSERIAL PRIMARY KEY,
  method               TEXT NOT NULL,
  url                  TEXT NOT NULL,
  headers              JSONB NOT NULL,
  body                 BYTEA NULL,
  timeout_milliseconds INT NOT NULL
);
CREATE TABLE net._http_response (
  id BIGINT, status_code INT, content_type TEXT, headers JSONB, content TEXT, timed_out BOOLEAN, error_msg TEXT,
  created TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION net.http_post(url TEXT, body JSONB DEFAULT '{}'::JSONB, params JSONB DEFAULT '{}'::JSONB,
                              headers JSONB DEFAULT '{"Content-Type": "application/json"}'::JSONB,
                              timeout_milliseconds INT DEFAULT 5000) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT;
BEGIN
  -- Test seam: a failure whose text echoes the request (as a real client
  -- error might), so the suite proves the wrapper never propagates it.
  IF current_setting('tenotrainer_test.pg_net_fail', true) = 'on' THEN
    RAISE EXCEPTION 'pg_net double failure: % %', url, headers;
  END IF;
  INSERT INTO net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', url, headers, convert_to(body::TEXT, 'UTF8'), timeout_milliseconds)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
-- Mirrors the access measured on Supabase development (pg_net 0.20.4, M3.4f
-- Stage B): schema USAGE for PUBLIC and the API roles (its
-- grant_pg_net_access event trigger), EXECUTE for PUBLIC, and all table /
-- sequence privileges for PUBLIC. There the objects belong to supabase_admin,
-- so the migration owner cannot revoke any of this.
GRANT USAGE ON SCHEMA net TO PUBLIC, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA net TO PUBLIC;
GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO PUBLIC;
