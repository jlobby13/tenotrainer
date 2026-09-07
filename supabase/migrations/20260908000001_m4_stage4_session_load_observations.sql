-- =============================================================================
-- Milestone 4, Stage 4 founder-acceptance patch: session-level external-load
-- observation model.
--
-- Replaces morning_responses.external_load_categories/external_load_timing
-- (Stage 4's original implementation) with a normalized, provenance-tagged
-- table keyed to rehab_session_id. That original design conflated an
-- "observation about the session's loading context" with "the morning
-- response record" and had no way to distinguish an M3-captured observation
-- from an M4-captured one. Neither old column is dropped — this migration
-- is purely additive. See the deprecation note at the bottom.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- session_load_observations
--
-- One row per reported activity (category + timing), or exactly one
-- category='none'/timing=NULL row per capture point when the patient
-- explicitly confirms nothing relevant happened. Rows are never updated in
-- place — a changed answer before finalize is a delete-and-reinsert of that
-- capture point's rows (see the M3/M4 route handlers), so this table stays
-- append/replace-only, matching escalation_evaluations' and
-- tolerance_evaluations' existing "server-derived, patient never writes
-- directly" trust tier.
-- ---------------------------------------------------------------------------
CREATE TABLE session_load_observations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id   UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES auth.users(id),

  -- 'none' is a real, explicit answer (patient was asked and confirmed
  -- nothing relevant happened) — distinct from the absence of any row at
  -- all for this (rehab_session_id, captured_during), which means "never
  -- asked / not yet answered." Never conflated.
  category           TEXT NOT NULL CHECK (category IN (
    'running', 'sport', 'prolonged_walking_standing', 'other_lower_body_training',
    'unusually_high_activity', 'other', 'none'
  )),

  -- NULL only for category='none' — an explicit "nothing happened" answer
  -- has no timing to report. Every real category must carry a timing.
  timing             TEXT CHECK (timing IN (
    'previous_day', 'same_day_before_rehab', 'same_day_after_rehab'
  )),

  -- Which workflow captured this observation — the load-bearing provenance
  -- distinction this migration exists to add. Always set by the server
  -- route itself, never accepted from client-supplied request bodies.
  captured_during    TEXT NOT NULL CHECK (captured_during IN (
    'm3_session_response', 'm4_morning_response'
  )),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT session_load_observations_none_has_no_timing
    CHECK ((category = 'none') = (timing IS NULL)),

  -- Clinical timing invariant, enforced at the data layer (not just in the
  -- UI): M3 captures only what could plausibly be known before/around the
  -- rehab session; M4 captures only what happened after it. This mirrors
  -- the same "the deterministic layer must not rely solely on UI/API
  -- validation" principle applied to the tolerance evaluator itself.
  CONSTRAINT session_load_observations_timing_matches_provenance
    CHECK (
      category = 'none'
      OR (captured_during = 'm3_session_response' AND timing IN ('previous_day', 'same_day_before_rehab'))
      OR (captured_during = 'm4_morning_response' AND timing = 'same_day_after_rehab')
    )
);

CREATE INDEX idx_session_load_observations_session
  ON session_load_observations (rehab_session_id, captured_during);

ALTER TABLE session_load_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "session_load_observations: own read"
  ON session_load_observations FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "session_load_observations: clinician read assigned patient"
  ON session_load_observations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = session_load_observations.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- No permissive INSERT/UPDATE/DELETE policy — RLS default-denies every write
-- from `authenticated`. Both the M3 response route and the M4
-- morning-response route write these rows via the service-role client only,
-- exactly like escalation_evaluations/tolerance_evaluations, so
-- captured_during can never be spoofed from a request body.
REVOKE INSERT, UPDATE, DELETE ON session_load_observations FROM authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: migrate any existing morning_responses external-load data into
-- the new table before the app stops writing the old columns. Every row
-- that could possibly exist so far was written exclusively by the M4
-- finalize route, so all backfilled rows are tagged 'm4_morning_response'.
-- The old schema stored categories and timings as two independent arrays
-- with no pairing between them — an inherent ambiguity in the design being
-- replaced here, not something this backfill can recover precisely. Each
-- non-'none' category is conservatively backfilled with the first recorded
-- timing value (falling back to 'same_day_after_rehab', the only timing M4
-- itself could validly mean) rather than fabricating a per-category
-- pairing that was never actually captured. A category value of 'none'
-- always backfills to a single {category:'none', timing:NULL} row per the
-- table's own CHECK constraint.
-- ---------------------------------------------------------------------------
INSERT INTO session_load_observations (rehab_session_id, user_id, category, timing, captured_during, created_at)
SELECT
  mr.rehab_session_id,
  mr.user_id,
  cat,
  CASE WHEN cat = 'none' THEN NULL ELSE COALESCE(mr.external_load_timing[1], 'same_day_after_rehab') END,
  'm4_morning_response',
  mr.updated_at
FROM morning_responses mr, unnest(mr.external_load_categories) AS cat
WHERE mr.external_load_categories IS NOT NULL
  AND array_length(mr.external_load_categories, 1) > 0;

-- ---------------------------------------------------------------------------
-- Deprecation: morning_responses.external_load_categories/external_load_timing
-- are NOT dropped (no destructive change to already-applied Stage 4 columns)
-- but are no longer written or read by the application as of this patch —
-- session_load_observations is now the single source of truth for external
-- loading. Any data in these two columns has been backfilled above. They
-- are retained only as an inert historical artifact and may be dropped in a
-- future migration once the founder confirms no external consumer depends
-- on them.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN morning_responses.external_load_categories IS
  'DEPRECATED (M4 Stage 4 founder-acceptance patch): superseded by session_load_observations. No longer written or read by the app. Retained, not dropped, pending founder confirmation.';
COMMENT ON COLUMN morning_responses.external_load_timing IS
  'DEPRECATED (M4 Stage 4 founder-acceptance patch): superseded by session_load_observations. No longer written or read by the app. Retained, not dropped, pending founder confirmation.';

REVOKE UPDATE (external_load_categories, external_load_timing) ON morning_responses FROM authenticated;
