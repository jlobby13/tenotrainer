-- =============================================================================
-- Milestone 5, Stage 3: guidance -> session handoff.
--
-- Persists, once per genuinely-new rehab session, the objective clinical
-- facts that existed at the moment that session began:
--   - the most recent finalized tolerance evaluation for this patient
--     (by evaluated_at — real chronological clinical availability, never
--     rule_version text or rehab_session_id ordering),
--   - the prescription version that evaluation's own session ran under,
--   - the prescription version THIS new session resolved to,
--   - whether those two versions are the same, different, or unknown.
--
-- This table records FACTS, never interpretation. It does NOT mean and
-- MUST NEVER be read as: noncompliance, ignoring advice, overriding a
-- warning, clinician approval, clinician review, guidance acknowledgment,
-- guidance resolution, or escalation. A future guidance_actions-style model
-- (not built here) is where any of those concepts would eventually live,
-- once real evidence of them exists.
--
-- Append-only, immutable, at most one row per rehab_sessions row (enforced
-- by the UNIQUE constraint below) — matches the escalation_evaluations/
-- tolerance_evaluations/prescription_versions trust tier: RLS enabled, no
-- permissive UPDATE/DELETE policy for anyone, and no direct INSERT/UPDATE/
-- DELETE table grant for `authenticated` either (see the SECURITY DEFINER
-- function below for why writes still work).
-- =============================================================================

CREATE TABLE session_guidance_contexts (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The new session this handoff context describes. One row maximum per
  -- session (UNIQUE below) — this is a fact about "what existed when THIS
  -- session began," not a running log.
  rehab_session_id                  UUID NOT NULL UNIQUE REFERENCES rehab_sessions(id) ON DELETE CASCADE,

  -- The source evaluation this context is a snapshot of. source_rehab_session_id
  -- is a deliberate denormalization (redundant with
  -- tolerance_evaluations.rehab_session_id) so a future clinician view can
  -- read "what session produced this evaluation" without an extra join —
  -- same justification already used for rehab_sessions.current_escalation_level
  -- denormalizing escalation_evaluations.
  source_tolerance_evaluation_id    UUID NOT NULL REFERENCES tolerance_evaluations(id),
  source_rehab_session_id           UUID NOT NULL REFERENCES rehab_sessions(id),

  -- Echoed from the source evaluation at capture time — reuses the EXACT
  -- same locked vocabularies as tolerance_evaluations (see
  -- 20260907000002_m4_stage4_tolerance_interpretation.sql), never a parallel
  -- vocabulary invented here.
  source_tolerance_classification   TEXT NOT NULL CHECK (source_tolerance_classification IN (
    'well_tolerated', 'caution', 'poorly_tolerated', 'acute_override', 'insufficient_data'
  )),
  source_immediate_guidance         TEXT NOT NULL CHECK (source_immediate_guidance IN (
    'maintain', 'maintain_cautiously', 'reduce_modify', 'clinical_review'
  )),

  -- The prescription version the SOURCE session (the one that produced the
  -- evaluation above) ran under — nullable: that session may be a
  -- pre-Stage-1 legacy row with no resolved identity (honest unknown, never
  -- guessed — see 20260909000002_m5_stage1_session_prescription_version_link.sql).
  source_prescription_version_id    UUID REFERENCES prescription_versions(id),

  -- The prescription version THIS new session resolved to. In practice
  -- always non-null for a session created through
  -- create_rehab_session_if_allowed() (Stage 1's PRESCRIPTION_VERSION_REQUIRED
  -- invariant already guarantees this before a session can even be
  -- inserted) — kept NULLABLE at the schema level only because
  -- capture_session_guidance_context() below is a general-purpose,
  -- honestly-derived function, not hard-restricted to sessions created in
  -- the last few seconds; a legacy/unresolved target is still a real,
  -- non-fabricated "unknown", never forced to a fake value here.
  session_prescription_version_id   UUID REFERENCES prescription_versions(id),

  -- Never computed loosely — see the CHECK constraint below, which makes an
  -- inconsistent value structurally impossible regardless of write path.
  prescription_version_comparison   TEXT NOT NULL CHECK (prescription_version_comparison IN (
    'same', 'different', 'unknown'
  )),

  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Locked derivation rule (Section 8 of the Stage 3 brief): NULL+NULL must
  -- NOT become "same" — both sides must be known and equal for "same",
  -- both known and unequal for "different", anything else is "unknown".
  -- Enforced here so it can never be violated by ANY writer, not just the
  -- one function that currently exists.
  CONSTRAINT session_guidance_contexts_comparison_consistent CHECK (
    (prescription_version_comparison = 'unknown'
      AND (source_prescription_version_id IS NULL OR session_prescription_version_id IS NULL))
    OR (prescription_version_comparison = 'same'
      AND source_prescription_version_id IS NOT NULL AND session_prescription_version_id IS NOT NULL
      AND source_prescription_version_id = session_prescription_version_id)
    OR (prescription_version_comparison = 'different'
      AND source_prescription_version_id IS NOT NULL AND session_prescription_version_id IS NOT NULL
      AND source_prescription_version_id <> session_prescription_version_id)
  )
);

CREATE INDEX idx_session_guidance_contexts_source_evaluation
  ON session_guidance_contexts (source_tolerance_evaluation_id);

ALTER TABLE session_guidance_contexts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "session_guidance_contexts: own read"
  ON session_guidance_contexts FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = session_guidance_contexts.rehab_session_id AND rs.user_id = auth.uid())
  );

CREATE POLICY "session_guidance_contexts: clinician read assigned patient"
  ON session_guidance_contexts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = session_guidance_contexts.rehab_session_id AND sp.supervisor_id = auth.uid()
    )
  );

-- No permissive INSERT/UPDATE/DELETE policy for anyone — RLS default-denies
-- every write from `authenticated`. The REVOKE below is defense in depth.
-- All writes go through capture_session_guidance_context() (SECURITY
-- DEFINER, below), never a raw table grant.
REVOKE INSERT, UPDATE, DELETE ON session_guidance_contexts FROM authenticated;

-- ---------------------------------------------------------------------------
-- capture_session_guidance_context(p_rehab_session_id)
--
-- Why a SEPARATE SECURITY DEFINER function rather than a raw INSERT grant +
-- RLS WITH CHECK on session_guidance_contexts, or inlining this logic
-- directly into create_rehab_session_if_allowed() (which is deliberately
-- SECURITY INVOKER): a WITH CHECK expression capable of verifying "every
-- source_* column genuinely matches the real evaluation/session it claims
-- to" would need to re-derive the entire selection query (most-recent-
-- evaluation-before-this-session's-started_at) as a boolean predicate —
-- correct in principle, but risks either a subtle bug that quietly reopens
-- a fabrication hole, or a bug that blocks legitimate session creation for
-- every patient. A single, readable, testable PL/pgSQL function is safer
-- to reason about and to fix. SECURITY DEFINER means `authenticated` needs
-- no table-level grant on session_guidance_contexts at all (unlike
-- rehab_sessions, which stays column-grant-based because
-- create_rehab_session_if_allowed's own trust model is unchanged) — this
-- function is the ONLY write path, and it accepts nothing from the caller
-- except a session id: every other field (evaluation id, classification,
-- guidance, both version ids, the comparison) is DERIVED here from
-- persisted rows, never accepted as an argument, per Section 5 of the
-- Stage 3 brief ("the browser must not supply ... derive all of these
-- server-side").
--
-- Idempotent: if a context already exists for this session, returns it
-- unchanged rather than recomputing — a retried/duplicate call (or the
-- ON CONFLICT DO NOTHING race-loser path below) never mutates an already-
-- captured historical snapshot. Returns NULL (not an error) when there is
-- no prior evaluation to capture — no guidance context is ever fabricated
-- for a patient with no evaluable history yet.
--
-- Callable by any authenticated patient for any session they own — this is
-- safe (not merely "trusted by convention") because the function never
-- accepts client-supplied clinical data; every write is honestly re-derived
-- from real, already-persisted, immutable rows regardless of who or when it
-- is called. It is intended to be invoked exactly once per session, from
-- inside create_rehab_session_if_allowed() immediately after that session's
-- own INSERT, within the same transaction.
-- =============================================================================

CREATE OR REPLACE FUNCTION capture_session_guidance_context(p_rehab_session_id UUID)
RETURNS session_guidance_contexts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_session rehab_sessions;
  v_source RECORD;
  v_comparison TEXT;
  v_result session_guidance_contexts;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  -- Ownership check — SECURITY DEFINER bypasses RLS entirely for this
  -- function's own body, so this is the ONLY thing standing between one
  -- patient and another patient's session/evaluation data. Session not
  -- found (wrong id, or belongs to someone else) is treated identically.
  SELECT * INTO v_session FROM rehab_sessions WHERE id = p_rehab_session_id AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REHAB_SESSION_NOT_FOUND' USING ERRCODE = 'P0003';
  END IF;

  -- Idempotent short-circuit — never recompute or replace an existing
  -- historical snapshot.
  SELECT * INTO v_result FROM session_guidance_contexts WHERE rehab_session_id = p_rehab_session_id;
  IF FOUND THEN
    RETURN v_result;
  END IF;

  -- Most recent finalized evaluation for this patient (any of their
  -- sessions, any rule version), by evaluated_at, STRICTLY BEFORE this
  -- session's own started_at. Anchoring to started_at (fixed at that
  -- session's insert, not to "now") is what makes this correct regardless
  -- of exactly when this function executes relative to the session's
  -- INSERT, and is what prevents a LATER evaluation or LATER prescription
  -- version from ever retroactively mutating an already-captured context
  -- (this query and the comparison below only ever run once, at capture
  -- time — see the idempotent short-circuit above).
  SELECT te.id AS evaluation_id, te.tolerance_classification, te.immediate_guidance,
         te.rehab_session_id AS source_session_id, src.prescription_version_id AS source_prescription_version_id
    INTO v_source
    FROM tolerance_evaluations te
    JOIN rehab_sessions src ON src.id = te.rehab_session_id
    WHERE src.user_id = v_user_id
      AND te.evaluated_at < v_session.started_at
    ORDER BY te.evaluated_at DESC
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL; -- no prior evaluation — no context fabricated (absence != favorable)
  END IF;

  IF v_source.source_prescription_version_id IS NULL OR v_session.prescription_version_id IS NULL THEN
    v_comparison := 'unknown';
  ELSIF v_source.source_prescription_version_id = v_session.prescription_version_id THEN
    v_comparison := 'same';
  ELSE
    v_comparison := 'different';
  END IF;

  INSERT INTO session_guidance_contexts (
    rehab_session_id, source_tolerance_evaluation_id, source_rehab_session_id,
    source_tolerance_classification, source_immediate_guidance,
    source_prescription_version_id, session_prescription_version_id,
    prescription_version_comparison
  ) VALUES (
    p_rehab_session_id, v_source.evaluation_id, v_source.source_session_id,
    v_source.tolerance_classification, v_source.immediate_guidance,
    v_source.source_prescription_version_id, v_session.prescription_version_id,
    v_comparison
  )
  ON CONFLICT (rehab_session_id) DO NOTHING
  RETURNING * INTO v_result;

  IF v_result IS NULL THEN
    -- Lost a race to a concurrent call for the same session (defense in
    -- depth — in practice create_rehab_session_if_allowed's own per-patient
    -- advisory lock already prevents this) — fetch the winner's row rather
    -- than erroring or leaving the caller with nothing.
    SELECT * INTO v_result FROM session_guidance_contexts WHERE rehab_session_id = p_rehab_session_id;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION capture_session_guidance_context(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- create_rehab_session_if_allowed(): capture the handoff context for a
-- genuinely NEW session, in the same transaction, immediately after that
-- session's own INSERT. Recovery (step 1) and the morning-response gate
-- (step 2) are UNCHANGED and UNREACHED-BEYOND exactly as before — a
-- recovered/resumed session never re-enters this function body far enough
-- to call capture_session_guidance_context again, so recovery can never
-- recompute or replace an existing context. Ordering otherwise locked, do
-- not reorder — see 20260909000002's own ordering note.
-- =============================================================================

CREATE OR REPLACE FUNCTION create_rehab_session_if_allowed(
  p_session_id UUID,
  p_plan_id TEXT,
  p_prescription_instance_id TEXT,
  p_patient_local_date DATE,
  p_started_at TIMESTAMPTZ,
  p_prescription_snapshot JSONB
)
RETURNS rehab_sessions
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing rehab_sessions;
  v_outstanding_session_id UUID;
  v_prescription_version_id UUID;
  v_new rehab_sessions;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('create_rehab_session_if_allowed'), hashtext(v_user_id::text));

  -- 1. Existing legitimate session recovery wins first — see ordering note above.
  SELECT * INTO v_existing
    FROM rehab_sessions
    WHERE (id = p_session_id OR prescription_instance_id = p_prescription_instance_id)
      AND user_id = v_user_id
    LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- 2. Unresolved PRIOR morning-response obligation blocks a genuinely NEW session.
  SELECT id INTO v_outstanding_session_id
    FROM rehab_sessions
    WHERE user_id = v_user_id
      AND status = 'awaiting_morning_response'
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'MORNING_RESPONSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Resolve the patient's CURRENT prescription version (M5 Stage 1).
  -- Never created here — see the locked-invariant note in
  -- 20260909000002_m5_stage1_session_prescription_version_link.sql.
  SELECT id INTO v_prescription_version_id
    FROM prescription_versions
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESCRIPTION_VERSION_REQUIRED' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at,
    prescription_snapshot, prescription_version_id
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at,
    p_prescription_snapshot, v_prescription_version_id
  )
  RETURNING * INTO v_new;

  -- 5. Guidance handoff capture (M5 Stage 3) — only for a genuinely new
  -- session, never on recovery. See capture_session_guidance_context()
  -- above for why this is safe to call unconditionally here: it derives
  -- everything itself from v_new.id and persisted facts, accepting no
  -- clinical data from this caller either.
  PERFORM capture_session_guidance_context(v_new.id);

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
