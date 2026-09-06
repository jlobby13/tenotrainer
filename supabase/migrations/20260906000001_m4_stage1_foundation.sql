-- =============================================================================
-- Milestone 4, Stage 1: durable foundation for the Morning Response step.
--
-- Scope is deliberately narrow — persistence, timing utilities, and RLS only.
-- No questionnaire, no session-start gating, no tolerance engine, no
-- clinician UI. See specs/roadmap.md for the full Stage 1/2/3 breakdown.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- morning_responses
--
-- Temporally distinct from rehab_sessions (its own table, its own lifecycle),
-- per the locked M4 architecture. One row per rehab_sessions row, at most.
--
-- scheduled_eligible_at is NULLABLE — this is a deliberate departure from the
-- earlier "NOT NULL" sketch. UNKNOWN TIMEZONE != UTC TIMEZONE: if the
-- patient's IANA timezone isn't known yet when this row is created, the
-- scheduled eligibility instant genuinely cannot be computed without
-- fabricating it, so it stays NULL until a real timezone becomes available
-- (see web/lib/morningResponseServer.ts's reconciliation step). Once set, it
-- is frozen — never recomputed from a later-changed reminder/timezone
-- preference.
-- ---------------------------------------------------------------------------
CREATE TABLE morning_responses (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id       UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES auth.users(id),

  scheduled_eligible_at  TIMESTAMPTZ,  -- NULL until timezone is known; frozen once set

  -- Raw patient-reported facts. No DEFAULT on either — NULL means unknown/
  -- unanswered, never coerced to 0. Explicit 0 is valid, distinct data.
  next_morning_pain       SMALLINT,
  next_morning_stiffness  SMALLINT,
  patient_note             TEXT,

  submitted_at           TIMESTAMPTZ,  -- NULL means still outstanding

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT morning_responses_rehab_session_unique UNIQUE (rehab_session_id),
  CONSTRAINT morning_responses_pain_range
    CHECK (next_morning_pain IS NULL OR next_morning_pain BETWEEN 0 AND 10),
  CONSTRAINT morning_responses_stiffness_range
    CHECK (next_morning_stiffness IS NULL OR next_morning_stiffness BETWEEN 0 AND 10)
);

CREATE INDEX idx_morning_responses_user           ON morning_responses (user_id);
CREATE INDEX idx_morning_responses_outstanding
  ON morning_responses (user_id, scheduled_eligible_at)
  WHERE submitted_at IS NULL;

DO $$ BEGIN
  CREATE TRIGGER trg_morning_responses_updated_at
    BEFORE UPDATE ON morning_responses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE morning_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "morning_responses: own read"
  ON morning_responses FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "morning_responses: own insert"
  ON morning_responses FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "morning_responses: own update"
  ON morning_responses FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "morning_responses: clinician read assigned patient"
  ON morning_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = morning_responses.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- Column-level defense in depth, same shape as rehab_sessions: the row-level
-- UPDATE policy above would otherwise permit updating any column on a row
-- the patient owns. Only the raw, patient-answerable fields are writable;
-- scheduled_eligible_at (and rehab_session_id/user_id) are reachable only
-- via the service-role reconciliation path.
REVOKE UPDATE ON morning_responses FROM authenticated;
GRANT UPDATE (
  next_morning_pain, next_morning_stiffness, patient_note, submitted_at, updated_at
) ON morning_responses TO authenticated;

-- Same reasoning as rehab_sessions' insert-grant fix: the row-level INSERT
-- policy would otherwise permit inserting into every column at row-creation
-- time, including scheduled_eligible_at. Session/obligation creation always
-- goes through the service-role ensureMorningResponseExists() path in
-- practice, but this column grant makes the browser's actual capability
-- match that intent exactly, not just by convention.
REVOKE INSERT ON morning_responses FROM authenticated;
GRANT INSERT (
  id, rehab_session_id, user_id, scheduled_eligible_at, created_at
) ON morning_responses TO authenticated;

-- ---------------------------------------------------------------------------
-- tolerance_evaluations
--
-- Persistence only in Stage 1 — no evaluator exists yet, nothing writes here
-- until a later stage. Modeled directly on escalation_evaluations: append-
-- only, server-derived, read-only for authenticated.
-- ---------------------------------------------------------------------------
CREATE TABLE tolerance_evaluations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id          UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  morning_response_id       UUID NOT NULL REFERENCES morning_responses(id) ON DELETE CASCADE,

  -- Free TEXT, not a CHECK-constrained enum — the vocabulary direction
  -- (well_tolerated / maintain / adjust / insufficient_data) is approved as
  -- a DIRECTION, not a locked, implemented mapping. Constraining the column
  -- now would be choosing the mapping under the guise of a schema detail.
  tolerance_classification  TEXT NOT NULL,
  patient_facing_label      TEXT NOT NULL,
  reason                    TEXT NOT NULL,
  rule_version              TEXT NOT NULL,
  inputs_snapshot           JSONB NOT NULL,
  evaluated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tolerance_evaluations_session
  ON tolerance_evaluations (rehab_session_id, evaluated_at DESC);

ALTER TABLE tolerance_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tolerance_evaluations: own read"
  ON tolerance_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      WHERE rs.id = tolerance_evaluations.rehab_session_id AND rs.user_id = auth.uid()
    )
  );

CREATE POLICY "tolerance_evaluations: clinician read assigned patient"
  ON tolerance_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = tolerance_evaluations.rehab_session_id AND sp.supervisor_id = auth.uid()
    )
  );

-- No permissive INSERT/UPDATE/DELETE policy exists at all, so RLS
-- default-denies every write from `authenticated` — the explicit REVOKE
-- below is defense in depth, matching escalation_evaluations exactly.
REVOKE INSERT, UPDATE, DELETE ON tolerance_evaluations FROM authenticated;

-- ---------------------------------------------------------------------------
-- profiles: reminder preference + timezone
--
-- morning_reminder_time is a local WALL-CLOCK TIME, never converted to or
-- stored as a fixed UTC time — the same instant-in-UTC would be wrong twice
-- a year across a DST boundary if it were.
--
-- timezone is nullable with NO default. Absence is a real, meaningful state
-- (not yet captured) — see web/lib/morningResponseServer.ts. It is
-- deliberately never defaulted to 'UTC' here or anywhere else.
-- ---------------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN morning_reminder_time TIME NOT NULL DEFAULT '05:00:00',
  ADD COLUMN timezone TEXT;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_morning_reminder_time_15min
  CHECK (
    EXTRACT(MINUTE FROM morning_reminder_time)::int % 15 = 0
    AND EXTRACT(SECOND FROM morning_reminder_time) = 0
  );

-- profiles' own UPDATE grant is already unrestricted at the column level for
-- `authenticated` (no prior REVOKE on this table) and its RLS policy already
-- scopes UPDATE to the owning row (is_own_profile-style predicate from
-- 20260831000003) — timezone/morning_reminder_time inherit that unchanged.
-- The "only write timezone when currently NULL" rule is an application-layer
-- invariant (see the timezone-initialization route), not an RLS rule: RLS
-- controls WHO can write a row, not "only if the current value is NULL",
-- which Postgres RLS cannot express as a WITH CHECK against the pre-update
-- value without a trigger. A trigger was judged unnecessary complexity for
-- Stage 1 — the one server-side write path enforces this directly.
