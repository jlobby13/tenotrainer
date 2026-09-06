-- Fix a gap found during M3 live re-verification: session_events was written
-- via a plain INSERT (not an upsert like set_outcomes), so the "resubmitting
-- exercises-complete is idempotent" design this schema documents elsewhere
-- was actually false for session_events specifically — a genuine refresh
-- mid-flow after a problem report (pop or otherwise) would duplicate that
-- report's row every time exercises-complete gets resubmitted on remount.
--
-- occurred_at is the client-recorded timestamp of the original report and
-- stays fixed across resubmissions of the same local ActiveSessionState, so
-- (rehab_session_id, exercise_id, set_index, type, occurred_at) is a safe
-- natural key for "this exact report" — two genuinely distinct reports of
-- the same type on the same exercise/set at the identical millisecond are
-- not a realistic collision for this app.
--
-- set_index is NOT optional here despite appearances: no current call site
-- ever passes a setNumber into reportProblem(), so set_index is NULL on
-- every real row today, and a plain UNIQUE index treats every NULL as
-- distinct from every other NULL — it would have deduplicated nothing at
-- all. Stored generated columns coalesce the nullable fields to a
-- comparable value; PostgREST's upsert(onConflict:) needs a plain column
-- name to target (it does not reliably support expression indexes), which
-- these provide.
ALTER TABLE session_events
  ADD COLUMN exercise_id_key TEXT GENERATED ALWAYS AS (COALESCE(exercise_id, '')) STORED,
  ADD COLUMN set_index_key   SMALLINT GENERATED ALWAYS AS (COALESCE(set_index, -1)) STORED;

CREATE UNIQUE INDEX session_events_natural_key
  ON session_events (rehab_session_id, exercise_id_key, set_index_key, type, occurred_at);
