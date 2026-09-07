-- =============================================================================
-- Milestone 5, Stage 1: immutable prescription-version identity.
--
-- Core distinction this table exists to preserve (see specs/roadmap.md and
-- the M5 Stage 1 architecture inspection):
--
--   Prescription Version   = the immutable CLINICAL PLAN STATE (stage,
--                             irritability, insertional status) that was in
--                             effect when a session began. Append-only —
--                             a plan change is a NEW row, never an UPDATE.
--
--   rehab_sessions.prescription_snapshot (existing, M3) = the exact exercise
--                             selection/dosage/instructions actually
--                             prescribed for ONE session. That remains the
--                             sole source of truth for exact session
--                             exposure — this table does NOT replace it and
--                             does NOT claim to fully determine it. The
--                             operative exercise list is still generated
--                             dynamically by the legacy FastAPI rule engine
--                             / exercise library at session-plan-build time
--                             (app/main.py:_build_session_plan); Stage 1
--                             does not move that into Postgres.
--
-- "Current prescription version" for a patient is always DERIVED as the
-- latest row by created_at — there is no is_current flag and no
-- superseded_at column. Supersession is implicit: a version is current
-- until a newer version row exists for the same patient.
-- =============================================================================

CREATE TABLE prescription_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id),

  -- Clinical plan-state fields. Reuses the existing rehab_irritability enum
  -- (supabase/migrations/20260831000001_stage1_schema.sql) so the vocabulary
  -- stays identical to the legacy FastAPI Irritability class values
  -- ('low' | 'moderate' | 'high' — app/engine/rules.py) it is bootstrapped
  -- and synchronized from.
  stage           INTEGER NOT NULL,
  irritability    rehab_irritability NOT NULL,
  is_insertional  BOOLEAN NOT NULL,

  -- Smallest vocabulary that supports current + clearly planned creation
  -- paths only (see the M5 Stage 1 architecture inspection). Do not add
  -- other sources speculatively.
  --   onboarding       — the live FastAPI /onboarding flow's initial plan.
  --   legacy_bootstrap — one-time capture of a pre-Stage-1 patient's
  --                      currently-known plan state (see the bootstrap
  --                      script). Never represents a historical version.
  --   clinician_change — reserved for the not-yet-built clinician
  --                      prescription editor. Nothing writes this yet.
  --   system_progression — reserved for a future approved automatic
  --                      stage/irritability progression path. Nothing
  --                      writes this yet (the legacy progression code that
  --                      once mutated rehab_plans in place is dead, per the
  --                      M4 Stage 3 /daily-log retirement).
  source          TEXT NOT NULL CHECK (source IN (
    'onboarding', 'legacy_bootstrap', 'clinician_change', 'system_progression'
  )),

  -- Cross-system traceability only — the legacy FastAPI rehab_plans.id this
  -- version was created from/alongside. Never FK'd (different database
  -- engine entirely: SQLite), same convention as rehab_sessions.plan_id.
  -- Nullable: a future clinician_change/system_progression version created
  -- natively in Postgres may have no legacy counterpart at all.
  legacy_plan_id  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT prescription_versions_stage_positive CHECK (stage >= 1)
);

CREATE INDEX idx_prescription_versions_user_created
  ON prescription_versions (user_id, created_at DESC);

-- Idempotency guarantee for the legacy bootstrap script: at most one
-- legacy_bootstrap row per patient, ever, even if the script is re-run
-- concurrently or repeatedly. The script itself also checks "does this
-- patient already have ANY version row" before inserting (so a patient
-- whose onboarding-sync already succeeded is never given a redundant
-- bootstrap row) — this index is the DB-level backstop for the
-- same-source race, not the only idempotency mechanism.
CREATE UNIQUE INDEX prescription_versions_one_bootstrap_per_user
  ON prescription_versions (user_id)
  WHERE source = 'legacy_bootstrap';

ALTER TABLE prescription_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "prescription_versions: own read"
  ON prescription_versions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "prescription_versions: clinician read assigned patient"
  ON prescription_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = prescription_versions.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- Append-only, server-derived-only — identical trust tier to
-- escalation_evaluations/tolerance_evaluations. No permissive INSERT/UPDATE/
-- DELETE policy exists at all, so RLS default-denies every write from
-- `authenticated`; the REVOKE below is defense in depth. Every write path
-- (onboarding sync, legacy bootstrap, and any future clinician-change/
-- system-progression path) goes through the service-role client only — see
-- web/lib/prescriptionVersionsServer.ts.
REVOKE INSERT, UPDATE, DELETE ON prescription_versions FROM authenticated;
