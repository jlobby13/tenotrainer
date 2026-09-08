-- =============================================================================
-- Acute Safety Gate + Resolution Lifecycle (pre-M5-Stage-4 blocking safety
-- milestone).
--
-- Keeps these systems distinct (see the spec's Section 1 — do not collapse
-- into one mutable status object):
--   Acute Event              -> raw patient report (session_events / rehab_sessions
--                                sudden_or_sharp_pain/new_functional_difficulty/
--                                pop_felt_or_heard columns — REUSED, not duplicated)
--   Acute Safety Evaluation  -> escalation_evaluations (REUSED, unchanged)
--   Acute Episode            -> acute_safety_episodes (NEW, append-only)
--   Safety Brake             -> DERIVED (no mutable "active" flag) from the
--                                existence of an episode with no matching release
--   Acute Reassessment       -> acute_safety_reassessments (NEW, append-only)
--   Safety Release           -> acute_safety_releases (NEW, append-only, immutable)
--   Cautious Return Context  -> cautious_return_contexts (NEW, append-only,
--                                one row per first-session-after-release)
--   Blocked Loading Opportunity -> blocked_loading_opportunities (NEW, append-only)
--   Tolerance Evaluation     -> tolerance_evaluations (REUSED, unchanged, unrelated)
--
-- No mutable fields anywhere in this migration: no acute_override=false, no
-- resolved=true, no brake_acknowledged. "Is the brake currently active" is
-- always DERIVED from whether an unreleased episode exists — never stored.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Widen session_events' type vocabulary (additive — existing values
-- unchanged) to add the ONE new exercise-report reason the spec requires:
-- sudden/sharp/pulling pain, reported DURING an exercise, which — unlike the
-- four ordinary options — must eventually require the acute questionnaire
-- (deferred to End Session if the patient continues; see Section 3 Path B).
-- The existing ordinary options and pop_reported's Level 5 immediate-action
-- behavior are unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE session_events DROP CONSTRAINT session_events_type_check;
ALTER TABLE session_events ADD CONSTRAINT session_events_type_check CHECK (type IN (
  'equipment', 'too_difficult', 'pain_limiting', 'other', 'pop_reported', 'sudden_sharp_pain'
));

-- ---------------------------------------------------------------------------
-- 1. acute_safety_episodes — one row per CONFIRMED Level 3 or Level 5
-- finding. "Confirmed" means escalation_evaluations already computed level
-- 3 or 5 for a session (via the EXISTING, unchanged evaluateEscalation()).
-- This table does not re-derive or duplicate that classification — it
-- captures the longitudinal EPISODE grouping and recurrence-window facts
-- escalation_evaluations was never meant to carry.
--
-- confirmed_at is FROZEN forever once set (Section 4: "preserve the
-- original confirmation timestamp") — nothing here ever updates it.
--
-- Reassessments/blocked-opportunities/newer-symptom-reports for the SAME
-- unresolved issue all reference this ONE episode row (via their own FK) —
-- they never create a second episode for the same unresolved concern
-- (Section 4). A genuinely NEW qualifying event, after this episode is
-- released (see acute_safety_releases), gets its OWN new episode row.
-- ---------------------------------------------------------------------------
CREATE TABLE acute_safety_episodes (
  id                                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                            UUID NOT NULL REFERENCES auth.users(id),

  -- Provenance — which session/evaluation confirmed this episode. Both
  -- REUSE existing M3 tables; nothing here duplicates their data beyond
  -- the minimum snapshot needed for reassessment question relevance below.
  source_rehab_session_id            UUID NOT NULL REFERENCES rehab_sessions(id),
  source_escalation_evaluation_id    UUID NOT NULL REFERENCES escalation_evaluations(id),

  -- The escalation level that created this episode. Level 5 (pop) and
  -- Level 3 (sudden/sharp pain and/or new functional difficulty) share this
  -- table because their release requirements converge structurally
  -- (professional clearance + refreshed prescription) once Level 3 reaches
  -- a professional-hold or Level 4 state — see acute_safety_releases.
  initial_level                      SMALLINT NOT NULL CHECK (initial_level IN (3, 5)),

  -- Snapshot of which specific findings were present at confirmation —
  -- reused verbatim from the SAME rehab_sessions columns the escalation
  -- evaluator itself reads (never re-asked or re-derived). This is what
  -- lets the reassessment questionnaire honestly ask "not applicable" for
  -- a finding that was never part of THIS episode (Section 5) — a patient
  -- is never asked to say a symptom "resolved" if they never reported it.
  initial_sudden_or_sharp_pain       BOOLEAN NOT NULL,
  initial_new_functional_difficulty  BOOLEAN NOT NULL,
  initial_pop_felt_or_heard          BOOLEAN NOT NULL,

  -- Anchored 14-day recurrence-window bookkeeping (Section 10), computed
  -- ONCE at confirmation time and frozen — see web/lib/acuteSafety.ts's
  -- computeRecurrenceWindow() for the exact greedy-anchor algorithm this
  -- mirrors (a plain "4 events in the last 14 days" sliding-window query is
  -- explicitly NOT what this implements). recurrence_window_anchor_id
  -- points at the episode that anchors the currently-active window this
  -- episode falls into (NULL means this episode IS the anchor — either the
  -- very first one, or the first one after a prior window expired).
  recurrence_window_anchor_id        UUID REFERENCES acute_safety_episodes(id),
  recurrence_sequence_in_window      SMALLINT NOT NULL CHECK (recurrence_sequence_in_window >= 1),
  -- Frozen at confirmation: true iff this episode is the 4th-or-later in
  -- its anchored window. TenoTrainer v1 clinician-designed threshold (see
  -- Section 32) — not a validated biological/pathology boundary.
  level4_recurrent                   BOOLEAN NOT NULL DEFAULT false,

  confirmed_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_acute_safety_episodes_user_confirmed ON acute_safety_episodes (user_id, confirmed_at DESC);
CREATE INDEX idx_acute_safety_episodes_source_session ON acute_safety_episodes (source_rehab_session_id);

-- ---------------------------------------------------------------------------
-- 2. acute_safety_reassessments — one row per patient-submitted structured
-- reassessment. Multiple rows may exist for the SAME episode (a patient may
-- reassess more than once while still unresolved) — this does NOT create
-- additional episodes (Section 4), it just adds more reassessment evidence
-- for the same one.
--
-- The "critical conditional UI rule" (Section 5) is enforced HERE, at the
-- data layer, not merely in the UI: cleared_by_professional can only be
-- non-NULL when evaluated_by_professional is true. UNKNOWN != NO — an
-- un-asked clearance question is NULL, never coerced to false.
-- ---------------------------------------------------------------------------
CREATE TABLE acute_safety_reassessments (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acute_safety_episode_id         UUID NOT NULL REFERENCES acute_safety_episodes(id),
  user_id                         UUID NOT NULL REFERENCES auth.users(id),

  -- NULL means "not applicable — not an original finding for this episode"
  -- (Section 5). Never asked, never answered, never coerced to a value.
  sudden_or_sharp_pain_resolved   BOOLEAN,
  new_functional_difficulty_resolved BOOLEAN,

  evaluated_by_professional       BOOLEAN NOT NULL,
  -- Only meaningful (and only ever persisted) when evaluated_by_professional
  -- is true — see the CHECK constraint below.
  cleared_by_professional         BOOLEAN,

  submitted_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT acute_safety_reassessments_clearance_requires_evaluation CHECK (
    (evaluated_by_professional = false AND cleared_by_professional IS NULL)
    OR (evaluated_by_professional = true)
  )
);

CREATE INDEX idx_acute_safety_reassessments_episode ON acute_safety_reassessments (acute_safety_episode_id, submitted_at DESC);

-- ---------------------------------------------------------------------------
-- 3. acute_safety_releases — the immutable fact that permits ordinary
-- loading to resume. At most ONE per episode (UNIQUE below) — release is a
-- terminal event; an episode is either released or it isn't, forever.
--
-- release_path names WHICH locked release rule applied (Section 6/11/13):
--   self_resolved_no_evaluation        — 6A: evaluated=No, all present
--                                         findings resolved. No prescription
--                                         required.
--   professional_clearance             — 6B: evaluated=Yes, cleared=Yes,
--                                         ordinary Level 3. No prescription
--                                         required (explicitly locked).
--   professional_clearance_with_prescription — 6C/11/13: Level 3
--                                         professional-hold, Level 4, or
--                                         Level 5 — requires BOTH clearance
--                                         AND a prescription_versions row
--                                         created after this episode's
--                                         confirmed_at. Neither alone
--                                         releases (Section 6C/11: chronology
--                                         is not intent, matching the
--                                         Stage 1 founder-acceptance lock).
-- ---------------------------------------------------------------------------
CREATE TABLE acute_safety_releases (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acute_safety_episode_id         UUID NOT NULL UNIQUE REFERENCES acute_safety_episodes(id),
  user_id                         UUID NOT NULL REFERENCES auth.users(id),

  release_path                    TEXT NOT NULL CHECK (release_path IN (
    'self_resolved_no_evaluation', 'professional_clearance', 'professional_clearance_with_prescription'
  )),

  -- The patient-submitted reassessment whose answers satisfied the release
  -- rule. Nullable — reserved for a FUTURE authenticated clinician-direct-
  -- release event (Section 6C/22), which this migration does not build the
  -- UI for, but the schema already accommodates: a clinician-release path
  -- would simply insert a row here with source_reassessment_id NULL and a
  -- (not-yet-added) source_clinician_id column in a later, additive
  -- migration, once that workflow is actually designed.
  source_reassessment_id          UUID REFERENCES acute_safety_reassessments(id),

  -- The refreshed prescription version required for the
  -- ...with_prescription path — NULL for the two paths that don't require
  -- one. Never inferred as "the clinician reviewed this because a newer
  -- version exists" — it is required to be created AFTER the episode
  -- (enforced by the write path, not by a CHECK against a mutable "now"),
  -- and its mere existence is combined with, never substituted for, actual
  -- professional clearance.
  source_prescription_version_id  UUID REFERENCES prescription_versions(id),

  released_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT acute_safety_releases_prescription_required_iff_hold_path CHECK (
    (release_path = 'professional_clearance_with_prescription' AND source_prescription_version_id IS NOT NULL)
    OR (release_path <> 'professional_clearance_with_prescription' AND source_prescription_version_id IS NULL)
  )
);

CREATE INDEX idx_acute_safety_releases_user ON acute_safety_releases (user_id, released_at DESC);

-- ---------------------------------------------------------------------------
-- 4. blocked_loading_opportunities — a structured fact recorded when an
-- active brake prevents a scheduled rehab_sessions row from ever being
-- created. Never a fake rehab_sessions row (Section 16).
--
-- Deduplication identity: (acute_safety_episode_id, prescription_instance_id)
-- — repeated clicks/retries for the SAME scheduled opportunity, while the
-- SAME episode's brake is active, collapse to one row via the UNIQUE
-- constraint + ON CONFLICT DO NOTHING in the writing function.
-- ---------------------------------------------------------------------------
CREATE TABLE blocked_loading_opportunities (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES auth.users(id),
  acute_safety_episode_id   UUID NOT NULL REFERENCES acute_safety_episodes(id),
  prescription_instance_id  TEXT NOT NULL,
  brake_level               SMALLINT NOT NULL CHECK (brake_level IN (3, 4, 5)),
  blocked_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT blocked_loading_opportunities_dedup UNIQUE (acute_safety_episode_id, prescription_instance_id)
);

CREATE INDEX idx_blocked_loading_opportunities_episode ON blocked_loading_opportunities (acute_safety_episode_id);

-- ---------------------------------------------------------------------------
-- 5. cautious_return_contexts — captured ONCE, for the first successfully
-- started rehab session after a release (Section 7). Mirrors
-- session_guidance_contexts' pattern exactly: an immutable handoff snapshot,
-- one row max per session, never recomputed once captured. After that
-- session produces its own newer clinical response, ordinary Stage 2
-- feedback takes precedence again (unchanged, no special-casing needed
-- there — see the completion report).
-- ---------------------------------------------------------------------------
CREATE TABLE cautious_return_contexts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rehab_session_id          UUID NOT NULL UNIQUE REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  acute_safety_release_id   UUID NOT NULL UNIQUE REFERENCES acute_safety_releases(id),
  acute_safety_episode_id   UUID NOT NULL REFERENCES acute_safety_episodes(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- RLS — same trust tier as escalation_evaluations/tolerance_evaluations/
-- session_guidance_contexts throughout: own-read, clinician-read-assigned,
-- no permissive write policy for authenticated, explicit REVOKE as
-- defense in depth. All writes go through SECURITY DEFINER functions or the
-- existing service-role Route Handler pattern (see the completion report
-- for which write path each table uses).
-- ---------------------------------------------------------------------------
ALTER TABLE acute_safety_episodes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE acute_safety_reassessments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE acute_safety_releases         ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_loading_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cautious_return_contexts      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "acute_safety_episodes: own read" ON acute_safety_episodes FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "acute_safety_episodes: clinician read assigned patient" ON acute_safety_episodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = acute_safety_episodes.user_id AND sp.supervisor_id = auth.uid())
);
REVOKE INSERT, UPDATE, DELETE ON acute_safety_episodes FROM authenticated;

CREATE POLICY "acute_safety_reassessments: own read" ON acute_safety_reassessments FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "acute_safety_reassessments: clinician read assigned patient" ON acute_safety_reassessments FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = acute_safety_reassessments.user_id AND sp.supervisor_id = auth.uid())
);
REVOKE INSERT, UPDATE, DELETE ON acute_safety_reassessments FROM authenticated;

CREATE POLICY "acute_safety_releases: own read" ON acute_safety_releases FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "acute_safety_releases: clinician read assigned patient" ON acute_safety_releases FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = acute_safety_releases.user_id AND sp.supervisor_id = auth.uid())
);
REVOKE INSERT, UPDATE, DELETE ON acute_safety_releases FROM authenticated;

CREATE POLICY "blocked_loading_opportunities: own read" ON blocked_loading_opportunities FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "blocked_loading_opportunities: clinician read assigned patient" ON blocked_loading_opportunities FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = blocked_loading_opportunities.user_id AND sp.supervisor_id = auth.uid())
);
REVOKE INSERT, UPDATE, DELETE ON blocked_loading_opportunities FROM authenticated;

CREATE POLICY "cautious_return_contexts: own read" ON cautious_return_contexts FOR SELECT USING (
  EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = cautious_return_contexts.rehab_session_id AND rs.user_id = auth.uid())
);
CREATE POLICY "cautious_return_contexts: clinician read assigned patient" ON cautious_return_contexts FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM rehab_sessions rs JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
    WHERE rs.id = cautious_return_contexts.rehab_session_id AND sp.supervisor_id = auth.uid()
  )
);
REVOKE INSERT, UPDATE, DELETE ON cautious_return_contexts FROM authenticated;

-- acute_safety_reassessments: unlike morning_responses/rehab_sessions'
-- progressively-checkpointed raw inputs, a reassessment submission must be
-- evaluated for release-eligibility (evaluateReleaseEligibility() in
-- web/lib/acuteSafety.ts) and, if eligible, immediately produce an
-- acute_safety_releases row — a single atomic server-side operation.
-- Minimum-privilege (Section 29): rather than grant `authenticated` a
-- direct INSERT here (which would still need to be paired with a separate
-- trusted write for the release decision, and would let a raw PostgREST
-- insert record a reassessment the server-side eligibility check never
-- actually saw), the entire reassessment-then-maybe-release flow is
-- server-controlled via the service-role client from
-- /api/patient/acute-safety/reassessment — see web/lib/acuteSafetyServer.ts.
-- REVOKE below is defense in depth; no permissive INSERT policy exists.
REVOKE INSERT, UPDATE, DELETE ON acute_safety_reassessments FROM authenticated;

-- ---------------------------------------------------------------------------
-- get_patient_acute_brake_status(p_user_id): the ONE canonical derivation of
-- "is there an active acute safety brake for this patient, and at what
-- effective level" — reused by BOTH create_rehab_session_if_allowed (the
-- gate) and a future read-helper for patient-facing display, so the
-- threshold logic never has to be kept in sync across two places.
--
-- SECURITY INVOKER (default) — purely a read/derivation over tables whose
-- RLS policies already correctly scope "own row" or "assigned clinician"
-- access; no elevated privilege is needed or granted here.
--
-- "Active" = the most recent acute_safety_episodes row for this patient
-- that has NO row in acute_safety_releases. effective_level:
--   5              — initial_level = 5 (Level 5 never downgrades)
--   4              — level4_recurrent already frozen true at confirmation,
--                     OR confirmed_at is more than 48 hours in the past,
--                     OR >=3 blocked_loading_opportunities exist for it
--                     (TenoTrainer v1 thresholds — see Section 32; NOT
--                     validated biological/pathology boundaries)
--   3              — otherwise
-- level4_reasons is a text[] naming which trigger(s) fired (never shown
-- to the patient verbatim — see web/lib/acuteSafety.ts's patient-facing
-- copy layer).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_patient_acute_brake_status(p_user_id UUID)
RETURNS TABLE (
  episode_id UUID,
  initial_level SMALLINT,
  confirmed_at TIMESTAMPTZ,
  effective_level SMALLINT,
  level4_reasons TEXT[],
  blocked_opportunity_count BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_episode acute_safety_episodes;
  v_blocked_count BIGINT;
  v_reasons TEXT[] := '{}';
  v_level SMALLINT;
BEGIN
  SELECT e.* INTO v_episode
    FROM acute_safety_episodes e
    WHERE e.user_id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM acute_safety_releases r WHERE r.acute_safety_episode_id = e.id)
    ORDER BY e.confirmed_at DESC
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN; -- no active brake — empty result set, not a fabricated "level 0" row
  END IF;

  SELECT count(*) INTO v_blocked_count FROM blocked_loading_opportunities b WHERE b.acute_safety_episode_id = v_episode.id;

  IF v_episode.initial_level = 5 THEN
    v_level := 5;
  ELSE
    v_level := 3;
    IF v_episode.level4_recurrent THEN
      v_level := 4;
      v_reasons := v_reasons || 'recurrent_level_3_episodes';
    END IF;
    IF now() - v_episode.confirmed_at > INTERVAL '48 hours' THEN
      v_level := 4;
      v_reasons := v_reasons || 'unresolved_over_48_hours';
    END IF;
    IF v_blocked_count >= 3 THEN
      v_level := 4;
      v_reasons := v_reasons || 'three_blocked_opportunities';
    END IF;
  END IF;

  RETURN QUERY SELECT v_episode.id, v_episode.initial_level, v_episode.confirmed_at, v_level, v_reasons, v_blocked_count;
END;
$$;

GRANT EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) FROM anon;

-- ---------------------------------------------------------------------------
-- record_blocked_loading_opportunity(...): the ONE write path for
-- blocked_loading_opportunities. SECURITY DEFINER for the same reason as
-- Stage 3's capture_session_guidance_context() — avoids a raw table grant
-- plus a complex RLS WITH CHECK for an insert whose caller (the gate RPC)
-- is already SECURITY INVOKER. Ownership-checked; idempotent via the
-- dedup UNIQUE constraint + ON CONFLICT DO NOTHING.
--
-- Hardened from the start (per the Stage 3 hardening patch precedent):
-- EXECUTE is explicitly revoked from PUBLIC/anon, granted only to
-- `authenticated` — the sole role create_rehab_session_if_allowed() ever
-- runs as.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_blocked_loading_opportunity(
  p_acute_safety_episode_id UUID,
  p_prescription_instance_id TEXT,
  p_brake_level SMALLINT
)
RETURNS blocked_loading_opportunities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_episode acute_safety_episodes;
  v_result blocked_loading_opportunities;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_episode FROM acute_safety_episodes WHERE id = p_acute_safety_episode_id AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACUTE_EPISODE_NOT_FOUND' USING ERRCODE = 'P0004';
  END IF;

  INSERT INTO blocked_loading_opportunities (user_id, acute_safety_episode_id, prescription_instance_id, brake_level)
  VALUES (v_user_id, p_acute_safety_episode_id, p_prescription_instance_id, p_brake_level)
  ON CONFLICT (acute_safety_episode_id, prescription_instance_id) DO NOTHING
  RETURNING * INTO v_result;

  IF v_result IS NULL THEN
    SELECT * INTO v_result FROM blocked_loading_opportunities
      WHERE acute_safety_episode_id = p_acute_safety_episode_id AND prescription_instance_id = p_prescription_instance_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_blocked_loading_opportunity(UUID, TEXT, SMALLINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_blocked_loading_opportunity(UUID, TEXT, SMALLINT) FROM anon;
GRANT EXECUTE ON FUNCTION record_blocked_loading_opportunity(UUID, TEXT, SMALLINT) TO authenticated;

-- ---------------------------------------------------------------------------
-- capture_cautious_return_context(p_rehab_session_id): mirrors
-- capture_session_guidance_context() exactly. Called from within
-- create_rehab_session_if_allowed() immediately after a genuinely new
-- session is inserted. A no-op (returns NULL) unless there is a release for
-- this patient whose released_at precedes this session's started_at AND
-- which has no cautious_return_contexts row yet for ANY session (so only
-- the first qualifying session captures it, per Section 7) — the most
-- RECENT such release is used, matching "the first session after [the most
-- recent] release."
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION capture_cautious_return_context(p_rehab_session_id UUID)
RETURNS cautious_return_contexts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_session rehab_sessions;
  v_release RECORD;
  v_result cautious_return_contexts;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_session FROM rehab_sessions WHERE id = p_rehab_session_id AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REHAB_SESSION_NOT_FOUND' USING ERRCODE = 'P0003';
  END IF;

  SELECT * INTO v_result FROM cautious_return_contexts WHERE rehab_session_id = p_rehab_session_id;
  IF FOUND THEN
    RETURN v_result;
  END IF;

  -- Most recent release for this patient, released strictly before this
  -- session started, that has not yet had its first-subsequent-session
  -- captured.
  SELECT r.id AS release_id, r.acute_safety_episode_id AS episode_id
    INTO v_release
    FROM acute_safety_releases r
    WHERE r.user_id = v_user_id
      AND r.released_at < v_session.started_at
      AND NOT EXISTS (SELECT 1 FROM cautious_return_contexts c WHERE c.acute_safety_release_id = r.id)
    ORDER BY r.released_at DESC
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL; -- no unclaimed release — nothing to capture, not fabricated
  END IF;

  INSERT INTO cautious_return_contexts (rehab_session_id, acute_safety_release_id, acute_safety_episode_id)
  VALUES (p_rehab_session_id, v_release.release_id, v_release.episode_id)
  ON CONFLICT (rehab_session_id) DO NOTHING
  RETURNING * INTO v_result;

  IF v_result IS NULL THEN
    SELECT * INTO v_result FROM cautious_return_contexts WHERE rehab_session_id = p_rehab_session_id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION capture_cautious_return_context(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION capture_cautious_return_context(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION capture_cautious_return_context(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- create_rehab_session_if_allowed(): enforce the acute safety brake
-- server-side, ahead of the M4 morning-response gate (Section 14
-- precedence: acute Level 4/5 > acute Level 3 > M4 gate > prescription
-- resolution). Recovery (step 1) is UNCHANGED and still wins first — a
-- resumed/retried session is never newly blocked by a brake that appeared
-- after it already legitimately started. Ordering otherwise LOCKED, do not
-- reorder further — see this function's own prior migrations' ordering notes.
-- ---------------------------------------------------------------------------
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
  v_brake RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('create_rehab_session_if_allowed'), hashtext(v_user_id::text));

  -- 1. Existing legitimate session recovery wins first.
  SELECT * INTO v_existing
    FROM rehab_sessions
    WHERE (id = p_session_id OR prescription_instance_id = p_prescription_instance_id)
      AND user_id = v_user_id
    LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- 2. Acute safety brake (NEW) — checked before the M4 gate, per the
  -- locked precedence order. Never trusts browser-supplied safety state;
  -- entirely derived from get_patient_acute_brake_status(), which reads
  -- only immutable, already-persisted acute_safety_* facts.
  SELECT * INTO v_brake FROM get_patient_acute_brake_status(v_user_id);
  IF FOUND THEN
    PERFORM record_blocked_loading_opportunity(v_brake.episode_id, p_prescription_instance_id, v_brake.effective_level);
    IF v_brake.effective_level >= 4 THEN
      RAISE EXCEPTION 'ACUTE_SAFETY_PROFESSIONAL_REVIEW_REQUIRED' USING ERRCODE = 'P0005';
    ELSE
      RAISE EXCEPTION 'ACUTE_SAFETY_REVIEW_REQUIRED' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  -- 3. Unresolved PRIOR morning-response obligation blocks a genuinely NEW session.
  SELECT id INTO v_outstanding_session_id
    FROM rehab_sessions
    WHERE user_id = v_user_id
      AND status = 'awaiting_morning_response'
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'MORNING_RESPONSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 4. Resolve the patient's CURRENT prescription version (M5 Stage 1).
  SELECT id INTO v_prescription_version_id
    FROM prescription_versions
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESCRIPTION_VERSION_REQUIRED' USING ERRCODE = 'P0002';
  END IF;

  -- 5. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at,
    prescription_snapshot, prescription_version_id
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at,
    p_prescription_snapshot, v_prescription_version_id
  )
  RETURNING * INTO v_new;

  -- 6. Guidance handoff capture (M5 Stage 3) — unchanged.
  PERFORM capture_session_guidance_context(v_new.id);

  -- 7. Cautious-return context capture (NEW) — a no-op unless a release
  -- exists that hasn't yet had its first subsequent session captured.
  PERFORM capture_cautious_return_context(v_new.id);

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
