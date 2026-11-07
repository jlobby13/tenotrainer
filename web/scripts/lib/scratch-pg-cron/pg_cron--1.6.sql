-- M3.4a — scratch TEST DOUBLE of pg_cron's catalog surface used by the
-- migrations: cron.job and cron.schedule/unschedule. Jobs are recorded so
-- the fresh-database proof can compare job definitions; nothing executes.
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid    BIGSERIAL PRIMARY KEY,
  schedule TEXT NOT NULL,
  command  TEXT NOT NULL,
  nodename TEXT NOT NULL DEFAULT 'localhost',
  nodeport INT  NOT NULL DEFAULT 5432,
  database TEXT NOT NULL DEFAULT current_database(),
  username TEXT NOT NULL DEFAULT current_user,
  active   BOOLEAN NOT NULL DEFAULT true,
  jobname  TEXT UNIQUE
);
CREATE TABLE cron.job_run_details (
  jobid BIGINT, runid BIGSERIAL PRIMARY KEY, job_pid INT, database TEXT, username TEXT, command TEXT,
  status TEXT, return_message TEXT, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ
);
CREATE FUNCTION cron.schedule(job_name TEXT, schedule TEXT, command TEXT) RETURNS BIGINT
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$$;
CREATE FUNCTION cron.schedule(schedule TEXT, command TEXT) RETURNS BIGINT
LANGUAGE sql AS $$ INSERT INTO cron.job (schedule, command) VALUES (schedule, command) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(job_name TEXT) RETURNS BOOLEAN
LANGUAGE sql AS $$ WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT count(*) > 0 FROM d $$;
CREATE FUNCTION cron.unschedule(job_id BIGINT) RETURNS BOOLEAN
LANGUAGE sql AS $$ WITH d AS (DELETE FROM cron.job WHERE jobid = job_id RETURNING 1) SELECT count(*) > 0 FROM d $$;
-- M3.4f — cron.alter_job (pg_cron's signature): the dispatch job is created
-- inactive.
CREATE FUNCTION cron.alter_job(job_id BIGINT, schedule TEXT DEFAULT NULL, command TEXT DEFAULT NULL, database TEXT DEFAULT NULL,
                               username TEXT DEFAULT NULL, active BOOLEAN DEFAULT NULL) RETURNS VOID
LANGUAGE sql AS $$
  UPDATE cron.job j SET schedule = coalesce(alter_job.schedule, j.schedule), command = coalesce(alter_job.command, j.command),
         database = coalesce(alter_job.database, j.database), username = coalesce(alter_job.username, j.username),
         active = coalesce(alter_job.active, j.active)
  WHERE j.jobid = alter_job.job_id
$$;
