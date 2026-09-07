-- =============================================================================
-- Milestone 3: durable session response, escalation, and pattern-engine
-- foundation.
--
-- Named `rehab_sessions` (not `sessions`) to avoid colliding with the
-- existing, vestigial `sessions` table from the stage-1 schema (unwired,
-- never populated by the live FastAPI app — see specs/roadmap.md).
--
-- Follows the existing RLS convention from 20260831000003_rls_policies.sql:
-- patient-own via `user_id = auth.uid()`, clinician access via
-- `supervisor_patients`. No organization_id — clinical tables in this schema
-- are not org-scoped; this is documented as the CURRENT access model, not a
-- permanent multi-tenancy decision.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- rehab_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE rehab_sessions (
  id                        UUID PRIMARY KEY,               -- client-generated sessionInstanceId
  user_id                   UUID NOT NULL REFERENCES auth.users(id),
  plan_id                   TEXT,                            -- legacy FastAPI rehab_plans.id (cross-system reference, not FK'd)

  -- Prescription-instance identity. Deliberately a single OPAQUE column, not
  -- a compound (plan_id, date) uniqueness rule — see the UNIQUE constraint
  -- below. v1 computes this value client-side as "{plan_id}:{patient_local_date}",
  -- which in practice still yields one instance per day today (the legacy
  -- backend only ever produces one session_plan per day). A future system
  -- that supports multiple prescribed sessions per day, split sessions, or
  -- clinician-programmed AM/PM loading only needs to change how this VALUE is
  -- computed upstream — no schema change, because uniqueness is keyed on this
  -- single column, not on date.
  prescription_instance_id  TEXT NOT NULL,
  patient_local_date        DATE NOT NULL,                   -- timing/query convenience only — NOT the uniqueness boundary

  status                    TEXT NOT NULL DEFAULT 'in_progress',
  exercise_outcome          TEXT,                             -- null until EXERCISES_COMPLETE reached
  early_end_reason          TEXT,

  started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  exercises_ended_at        TIMESTAMPTZ,

  prescription_snapshot     JSONB NOT NULL,

  -- Raw patient-reported facts. No column here has a DEFAULT — NULL always
  -- means unknown/unanswered, never coerced to 0/false. Explicit zero/false is
  -- valid clinical data and stored as such.
  peak_session_pain         SMALLINT,                         -- 0-10
  difficulty                TEXT,                             -- 'easy' | 'moderate' | 'hard' | 'too_hard'
  contributor_reason        TEXT,
  contributor_exercise_id   TEXT,
  contributor_other_text    TEXT,
  sudden_or_sharp_pain      BOOLEAN,                          -- tri-state via nullability
  pop_felt_or_heard         BOOLEAN,
  new_functional_difficulty BOOLEAN,

  -- Derived, server-trusted only (see grants below) — denormalized mirror of
  -- the latest escalation_evaluations row, for cheap dashboard/query reads.
  -- The authoritative, versioned history lives in escalation_evaluations.
  current_escalation_level  SMALLINT,

  response_recorded_at      TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT rehab_sessions_status_check CHECK (status IN (
    'in_progress', 'exercises_complete', 'response_in_progress',
    'awaiting_morning_response', 'response_complete'
  )),
  CONSTRAINT rehab_sessions_exercise_outcome_check CHECK (exercise_outcome IS NULL OR exercise_outcome IN (
    'completed', 'ended_early', 'acute_terminated'
  )),
  CONSTRAINT rehab_sessions_peak_pain_range CHECK (peak_session_pain IS NULL OR peak_session_pain BETWEEN 0 AND 10),
  CONSTRAINT rehab_sessions_difficulty_check CHECK (difficulty IS NULL OR difficulty IN (
    'easy', 'moderate', 'hard', 'too_hard'
  )),
  CONSTRAINT rehab_sessions_contributor_check CHECK (contributor_reason IS NULL OR contributor_reason IN (
    'specific_exercise', 'overall_session_too_much', 'symptoms_higher_before_start',
    'other_physical_activity', 'fatigue_poor_recovery', 'unsure', 'other'
  )),
  CONSTRAINT rehab_sessions_escalation_range CHECK (current_escalation_level IS NULL OR current_escalation_level BETWEEN 0 AND 5),

  -- ONE SESSION INSTANCE PER PRESCRIPTION INSTANCE — not "one per plan per day".
  CONSTRAINT rehab_sessions_one_per_prescription_instance UNIQUE (prescription_instance_id)
);

CREATE INDEX idx_rehab_sessions_user_started ON rehab_sessions (user_id, started_at DESC);
CREATE INDEX idx_rehab_sessions_user_status  ON rehab_sessions (user_id, status);

-- ---------------------------------------------------------------------------
-- set_outcomes — normalized, one row per set. Never zero-fills or null-fills
-- a skipped set's actual performance; outcome itself carries that meaning.
-- ---------------------------------------------------------------------------
CREATE TABLE set_outcomes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id      UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  exercise_id           TEXT NOT NULL,          -- matches prescription_snapshot[].ex_id
  exercise_order_index  SMALLINT NOT NULL,
  set_index             SMALLINT NOT NULL,
  outcome               TEXT NOT NULL,          -- 'completed' | 'skipped'
  prescribed_reps       NUMERIC,
  prescribed_load       NUMERIC,
  actual_reps           NUMERIC,                -- NULL for a skipped set — never fabricated
  actual_load           NUMERIC,
  was_edited            BOOLEAN NOT NULL DEFAULT false,
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT set_outcomes_outcome_check CHECK (outcome IN ('completed', 'skipped')),
  CONSTRAINT set_outcomes_unique_set UNIQUE (rehab_session_id, exercise_id, set_index)
);

CREATE INDEX idx_set_outcomes_session ON set_outcomes (rehab_session_id);

-- ---------------------------------------------------------------------------
-- session_events — structured problem/event reports (Report a Problem, M2)
-- ---------------------------------------------------------------------------
CREATE TABLE session_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id  UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  exercise_id       TEXT,
  set_index         SMALLINT,
  type              TEXT NOT NULL,
  note              TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT session_events_type_check CHECK (type IN (
    'equipment', 'too_difficult', 'pain_limiting', 'other', 'pop_reported'
  ))
);

CREATE INDEX idx_session_events_session ON session_events (rehab_session_id);
CREATE INDEX idx_session_events_type    ON session_events (type);

-- ---------------------------------------------------------------------------
-- escalation_evaluations — append-only, server-written only (see grants).
-- Raw facts (above) are never overwritten by a re-evaluation; a new rule
-- version produces a NEW row, preserving "what we believed at the time".
-- ---------------------------------------------------------------------------
CREATE TABLE escalation_evaluations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id  UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  escalation_level  SMALLINT NOT NULL,
  escalation_reason TEXT NOT NULL,
  rule_version      TEXT NOT NULL,
  inputs_snapshot   JSONB NOT NULL,
  evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT escalation_evaluations_level_range CHECK (escalation_level BETWEEN 0 AND 5)
);

CREATE INDEX idx_escalation_evaluations_session ON escalation_evaluations (rehab_session_id, evaluated_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE rehab_sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE set_outcomes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_evaluations ENABLE ROW LEVEL SECURITY;

-- rehab_sessions: patient owns their raw data; clinician reads via the
-- existing supervisor_patients assignment (same pattern as rehab_plans/
-- sessions/daily_logs above).
CREATE POLICY "rehab_sessions: own read"
  ON rehab_sessions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "rehab_sessions: own insert"
  ON rehab_sessions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "rehab_sessions: own update"
  ON rehab_sessions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "rehab_sessions: clinician read assigned patient"
  ON rehab_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = rehab_sessions.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- Column-level defense in depth: even though the row-level UPDATE policy
-- above would otherwise permit it, the `authenticated` role is explicitly
-- denied UPDATE on current_escalation_level (and every column that isn't a
-- patient-owned raw input). Only service_role (which bypasses RLS and column
-- grants) can set it — i.e. only the trusted server code path in the
-- escalation evaluator. Supabase grants broad default privileges to
-- `authenticated` at the schema level, so the REVOKE is necessary, not
-- redundant with RLS.
REVOKE UPDATE ON rehab_sessions FROM authenticated;
GRANT UPDATE (
  status, exercise_outcome, early_end_reason, exercises_ended_at,
  peak_session_pain, difficulty,
  contributor_reason, contributor_exercise_id, contributor_other_text,
  sudden_or_sharp_pain, pop_felt_or_heard, new_functional_difficulty,
  response_recorded_at, updated_at
) ON rehab_sessions TO authenticated;

-- set_outcomes: patient owns rows on their own sessions; clinician reads via
-- the same supervisor_patients join, through rehab_sessions.
CREATE POLICY "set_outcomes: own read"
  ON set_outcomes FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid())
  );

CREATE POLICY "set_outcomes: own insert"
  ON set_outcomes FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid())
  );

CREATE POLICY "set_outcomes: clinician read assigned patient"
  ON set_outcomes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = set_outcomes.rehab_session_id AND sp.supervisor_id = auth.uid()
    )
  );

-- session_events: same pattern as set_outcomes.
CREATE POLICY "session_events: own read"
  ON session_events FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = session_events.rehab_session_id AND rs.user_id = auth.uid())
  );

CREATE POLICY "session_events: own insert"
  ON session_events FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = session_events.rehab_session_id AND rs.user_id = auth.uid())
  );

CREATE POLICY "session_events: clinician read assigned patient"
  ON session_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = session_events.rehab_session_id AND sp.supervisor_id = auth.uid()
    )
  );

-- escalation_evaluations: READ-ONLY for both patient and clinician. No
-- authenticated INSERT/UPDATE/DELETE policy exists at all — Postgres RLS
-- default-denies any operation with no permissive policy, so this is
-- correctly locked down even before the explicit REVOKE below. Only
-- service_role (used exclusively by the escalation evaluator's server-side
-- code path) can write here.
CREATE POLICY "escalation_evaluations: own read"
  ON escalation_evaluations FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = escalation_evaluations.rehab_session_id AND rs.user_id = auth.uid())
  );

CREATE POLICY "escalation_evaluations: clinician read assigned patient"
  ON escalation_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = escalation_evaluations.rehab_session_id AND sp.supervisor_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE ON escalation_evaluations FROM authenticated;
