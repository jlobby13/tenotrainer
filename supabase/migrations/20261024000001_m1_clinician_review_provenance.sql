-- =============================================================================
-- M1 — C5 integrity, clinician visibility and safety review: provenance and
-- safety primitives. Forward-only; no applied migration is edited.
--
-- 1. set_outcome_edits — append-only OLD -> NEW history for a C5 patient's
--    correction of a performed set while the session is open
--    (c5_edit_performance). The set_outcomes row keeps the current,
--    authoritative value. Patient correction is NOT a void: a set can still
--    never be removed or turned from completed into skipped.
--
-- 2. Professional-review safety release (founder-locked, M1 D1/D2):
--      effective level < 4 and not professionally held
--        -> the existing patient-resolution rules (unchanged);
--      effective level >= 4, or a professional-review hold
--        -> patient reassessment is recorded but can NEVER release;
--           an explicit, authorized clinician release is required.
--    Applies to every episode, regardless of the runtime that raised it.
--
--    acute_episode_review_state() is the SINGLE authoritative derivation of
--    effective level / professional-review status. get_patient_acute_brake_
--    status() (re-defined here with an unchanged signature and grants), the
--    release guard trigger, the clinician release function and the
--    patient reassessment path all read it, so no layer derives it alone.
--
--    acute_safety_releases gains the 'clinician_release' path (clinician id
--    + required note, database time) and is made immutable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Set-edit provenance
-- -----------------------------------------------------------------------------
CREATE TABLE set_outcome_edits (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_outcome_id             UUID NOT NULL REFERENCES set_outcomes(id) ON DELETE CASCADE,
  rehab_session_id           UUID NOT NULL REFERENCES rehab_sessions(id) ON DELETE CASCADE,
  user_id                    UUID NOT NULL REFERENCES auth.users(id),
  edited_at                  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  previous_outcome           TEXT NOT NULL,
  previous_actual_reps       NUMERIC NULL,
  previous_actual_load       NUMERIC NULL,
  previous_actual_load_unit  TEXT NULL,
  previous_actual_duration_seconds NUMERIC NULL,
  previous_actual_distance_m NUMERIC NULL,
  new_outcome                TEXT NOT NULL,
  new_actual_reps            NUMERIC NULL,
  new_actual_load            NUMERIC NULL,
  new_actual_load_unit       TEXT NULL,
  new_actual_duration_seconds NUMERIC NULL,
  new_actual_distance_m      NUMERIC NULL
);

CREATE INDEX idx_set_outcome_edits_session ON set_outcome_edits (rehab_session_id, edited_at);

COMMENT ON TABLE set_outcome_edits IS
  'M1 append-only history of a patient correcting a performed C5 set while the session was open: the values replaced (previous_*) and the values recorded (new_*). set_outcomes holds the current value. A correction is not a void and carries no judgment.';

ALTER TABLE set_outcome_edits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON set_outcome_edits FROM anon, authenticated;
GRANT SELECT ON set_outcome_edits TO authenticated;

CREATE POLICY "set_outcome_edits: own read"
  ON set_outcome_edits FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "set_outcome_edits: clinician read assigned patient"
  ON set_outcome_edits FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = set_outcome_edits.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

-- Append-only (same convention as c5_recovery_decisions: UPDATE refused;
-- rows leave only with their session).
CREATE OR REPLACE FUNCTION trg_set_outcome_edits_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SET_OUTCOME_EDIT_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER trg_set_outcome_edits_immutable
  BEFORE UPDATE ON set_outcome_edits
  FOR EACH ROW EXECUTE FUNCTION trg_set_outcome_edits_immutable();

-- c5_edit_performance: identical contract and result codes; the replaced
-- values are now preserved before the row is updated, in the same
-- transaction. An edit that changes nothing (e.g. a retry) writes no
-- history and leaves the row untouched.
CREATE OR REPLACE FUNCTION c5_edit_performance(p_patient_id UUID, p_session_id UUID, p_performance JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lock RECORD;
  v_err TEXT;
  v_row set_outcomes;
  v_outcome TEXT := p_performance->>'outcome';
  v_reps NUMERIC := (p_performance->>'actual_reps')::numeric;
  v_load NUMERIC := (p_performance->>'actual_load')::numeric;
  v_unit TEXT := p_performance->>'actual_load_unit';
  v_duration NUMERIC := (p_performance->>'actual_duration_seconds')::numeric;
  v_distance NUMERIC := (p_performance->>'actual_distance_m')::numeric;
BEGIN
  SELECT * INTO v_lock FROM c5_lock_started_session(p_patient_id, p_session_id);
  IF v_lock.o_code IS NOT NULL THEN RETURN jsonb_build_object('result', v_lock.o_code); END IF;

  v_err := c5_performance_error(v_lock.o_snapshot, p_performance);
  IF v_err IS NOT NULL THEN RETURN jsonb_build_object('result', 'invalid_performance', 'detail', v_err); END IF;

  SELECT * INTO v_row FROM set_outcomes
  WHERE rehab_session_id = p_session_id AND exercise_id = p_performance->>'exercise_id'
    AND set_index = (p_performance->>'unit_index')::smallint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'performance_not_recorded'); END IF;
  IF v_row.outcome = 'completed' AND v_outcome = 'skipped' THEN
    RETURN jsonb_build_object('result', 'invalid_performance', 'detail', 'completed_cannot_become_skipped');
  END IF;

  IF v_row.outcome IS NOT DISTINCT FROM v_outcome
     AND v_row.actual_reps IS NOT DISTINCT FROM v_reps
     AND v_row.actual_load IS NOT DISTINCT FROM v_load
     AND v_row.actual_load_unit IS NOT DISTINCT FROM v_unit
     AND v_row.actual_duration_seconds IS NOT DISTINCT FROM v_duration
     AND v_row.actual_distance_m IS NOT DISTINCT FROM v_distance THEN
    RETURN jsonb_build_object('result', 'edited');
  END IF;

  INSERT INTO set_outcome_edits (
    set_outcome_id, rehab_session_id, user_id,
    previous_outcome, previous_actual_reps, previous_actual_load, previous_actual_load_unit,
    previous_actual_duration_seconds, previous_actual_distance_m,
    new_outcome, new_actual_reps, new_actual_load, new_actual_load_unit, new_actual_duration_seconds, new_actual_distance_m
  ) VALUES (
    v_row.id, p_session_id, p_patient_id,
    v_row.outcome, v_row.actual_reps, v_row.actual_load, v_row.actual_load_unit,
    v_row.actual_duration_seconds, v_row.actual_distance_m,
    v_outcome, v_reps, v_load, v_unit, v_duration, v_distance
  );

  UPDATE set_outcomes SET
    outcome = v_outcome,
    actual_reps = v_reps,
    actual_load = v_load,
    actual_load_unit = v_unit,
    actual_duration_seconds = v_duration,
    actual_distance_m = v_distance,
    was_edited = true
  WHERE id = v_row.id;
  RETURN jsonb_build_object('result', 'edited');
END;
$$;
REVOKE ALL ON FUNCTION c5_edit_performance(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_edit_performance(UUID, UUID, JSONB) TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Authoritative effective level / professional-review state of ONE episode
-- -----------------------------------------------------------------------------
-- Effective level (unchanged M5 rules, previously inline in
-- get_patient_acute_brake_status): initial Level 5 -> 5; otherwise 3,
-- raised to 4 by recurrence, > 48 h unresolved, or >= 3 blocked loading
-- opportunities. professionally_held: any reassessment reported
-- evaluated = true AND cleared = false (the M5 professional hold).
-- requires_clinician_release = effective_level >= 4 OR professionally_held.
-- Evaluated at the database clock (now()).
CREATE OR REPLACE FUNCTION acute_episode_review_state(p_episode_id UUID)
RETURNS TABLE (
  episode_id UUID,
  user_id UUID,
  initial_level SMALLINT,
  confirmed_at TIMESTAMPTZ,
  effective_level SMALLINT,
  level4_reasons TEXT[],
  blocked_opportunity_count BIGINT,
  professionally_held BOOLEAN,
  requires_clinician_release BOOLEAN,
  released BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_episode acute_safety_episodes;
  v_blocked BIGINT;
  v_reasons TEXT[] := '{}';
  v_level SMALLINT;
  v_held BOOLEAN;
BEGIN
  SELECT e.* INTO v_episode FROM acute_safety_episodes e WHERE e.id = p_episode_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*) INTO v_blocked FROM blocked_loading_opportunities b WHERE b.acute_safety_episode_id = v_episode.id;

  IF v_episode.initial_level = 5 THEN
    v_level := 5;
  ELSE
    v_level := 3;
    IF v_episode.level4_recurrent THEN
      v_level := 4;
      v_reasons := array_append(v_reasons, 'recurrent_level_3_episodes');
    END IF;
    IF now() - v_episode.confirmed_at > INTERVAL '48 hours' THEN
      v_level := 4;
      v_reasons := array_append(v_reasons, 'unresolved_over_48_hours');
    END IF;
    IF v_blocked >= 3 THEN
      v_level := 4;
      v_reasons := array_append(v_reasons, 'three_blocked_opportunities');
    END IF;
  END IF;

  v_held := EXISTS (
    SELECT 1 FROM acute_safety_reassessments r
    WHERE r.acute_safety_episode_id = v_episode.id
      AND r.evaluated_by_professional = true AND r.cleared_by_professional = false
  );

  RETURN QUERY SELECT v_episode.id, v_episode.user_id, v_episode.initial_level, v_episode.confirmed_at, v_level, v_reasons, v_blocked,
    v_held, (v_level >= 4 OR v_held),
    EXISTS (SELECT 1 FROM acute_safety_releases r WHERE r.acute_safety_episode_id = v_episode.id);
END;
$$;
REVOKE ALL ON FUNCTION acute_episode_review_state(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION acute_episode_review_state(UUID) TO authenticated, service_role;

-- Same signature, columns, ordering and grants as before; the level now
-- comes from acute_episode_review_state (one derivation).
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
  v_episode_id UUID;
BEGIN
  SELECT e.id INTO v_episode_id
    FROM acute_safety_episodes e
    WHERE e.user_id = p_user_id
      AND NOT EXISTS (SELECT 1 FROM acute_safety_releases r WHERE r.acute_safety_episode_id = e.id)
    ORDER BY e.confirmed_at DESC
    LIMIT 1;

  IF v_episode_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT s.episode_id, s.initial_level, s.confirmed_at, s.effective_level, s.level4_reasons, s.blocked_opportunity_count
    FROM acute_episode_review_state(v_episode_id) s;
END;
$$;
GRANT EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) FROM anon;

-- The C5 Start gate reports a professional-review hold from the same
-- derivation: any open episode requiring clinician release (effective
-- level >= 4, or professionally held) is
-- acute_safety_professional_review_required; otherwise the existing codes.
-- Signature, result codes and grants unchanged (C5.6C).
CREATE OR REPLACE FUNCTION c5_acute_gate(p_user_id UUID, OUT o_code TEXT, OUT o_episode_id UUID, OUT o_level SMALLINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_brake RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM escalation_evaluations ee
    JOIN rehab_sessions rs ON rs.id = ee.rehab_session_id
    WHERE rs.user_id = p_user_id AND ee.escalation_level IN (3, 5)
      AND NOT EXISTS (SELECT 1 FROM acute_safety_episodes ase WHERE ase.source_escalation_evaluation_id = ee.id)
  ) THEN
    o_code := 'acute_safety_reconciliation_required';
    RETURN;
  END IF;
  SELECT * INTO v_brake FROM get_patient_acute_brake_status(p_user_id);
  IF FOUND THEN
    o_episode_id := v_brake.episode_id;
    o_level := v_brake.effective_level;
    o_code := CASE
      WHEN EXISTS (
        SELECT 1 FROM acute_safety_episodes e, LATERAL acute_episode_review_state(e.id) s
        WHERE e.user_id = p_user_id AND NOT s.released AND s.requires_clinician_release
      ) THEN 'acute_safety_professional_review_required'
      ELSE 'acute_safety_review_required' END;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION c5_acute_gate(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Clinician release provenance on acute_safety_releases
-- -----------------------------------------------------------------------------
ALTER TABLE acute_safety_releases
  ADD COLUMN released_by_clinician_id UUID NULL REFERENCES auth.users(id),
  ADD COLUMN release_note TEXT NULL;

ALTER TABLE acute_safety_releases DROP CONSTRAINT acute_safety_releases_release_path_check;
ALTER TABLE acute_safety_releases
  ADD CONSTRAINT acute_safety_releases_release_path_check CHECK (release_path IN (
    'self_resolved_no_evaluation', 'professional_clearance', 'professional_clearance_with_prescription', 'clinician_release'
  )),
  -- A clinician release names its clinician and a 1–1000 character note and
  -- never cites a patient reassessment; every other path carries neither.
  ADD CONSTRAINT acute_safety_releases_clinician_release_provenance CHECK (
    (release_path = 'clinician_release'
      AND released_by_clinician_id IS NOT NULL
      AND release_note IS NOT NULL AND char_length(btrim(release_note)) BETWEEN 1 AND 1000
      AND source_reassessment_id IS NULL)
    OR (release_path <> 'clinician_release' AND released_by_clinician_id IS NULL AND release_note IS NULL)
  );

COMMENT ON COLUMN acute_safety_releases.released_by_clinician_id IS
  'M1: the clinician who explicitly released a professional-review hold (release_path = clinician_release). released_at is the database time of that release.';
COMMENT ON COLUMN acute_safety_releases.release_note IS
  'M1: the clinician''s required release note (1–1000 characters). Provenance only.';

-- Guard: a professional-review hold (effective level >= 4, or professionally
-- held) can only be released by the clinician path — enforced for every
-- writer, including service-role code. Also pins the release to the
-- episode's own patient.
CREATE OR REPLACE FUNCTION trg_acute_safety_releases_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_state RECORD;
BEGIN
  SELECT * INTO v_state FROM acute_episode_review_state(NEW.acute_safety_episode_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACUTE_RELEASE_EPISODE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.user_id IS DISTINCT FROM v_state.user_id THEN
    RAISE EXCEPTION 'ACUTE_RELEASE_PATIENT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF v_state.requires_clinician_release AND NEW.release_path <> 'clinician_release' THEN
    RAISE EXCEPTION 'ACUTE_RELEASE_REQUIRES_CLINICIAN' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_acute_safety_releases_guard
  BEFORE INSERT ON acute_safety_releases
  FOR EACH ROW EXECUTE FUNCTION trg_acute_safety_releases_guard();

CREATE OR REPLACE FUNCTION trg_acute_safety_releases_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ACUTE_RELEASE_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER trg_acute_safety_releases_immutable
  BEFORE UPDATE ON acute_safety_releases
  FOR EACH ROW EXECUTE FUNCTION trg_acute_safety_releases_immutable();

-- -----------------------------------------------------------------------------
-- 4. clinician_release_acute_episode — the explicit clinician release.
--    Server-only (service_role). The caller has already authenticated the
--    clinician and run the high-consequence authorization; this function
--    re-checks the active Postgres assignment as defense in depth.
--    Result codes: released | already_released | episode_not_found |
--    not_authorized | invalid_note | clinician_release_not_required.
--    Idempotent: an episode already released returns its existing release.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinician_release_acute_episode(p_episode_id UUID, p_clinician_id UUID, p_note TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_episode acute_safety_episodes;
  v_existing acute_safety_releases;
  v_state RECORD;
  v_note TEXT := btrim(coalesce(p_note, ''));
  v_release acute_safety_releases;
BEGIN
  SELECT * INTO v_episode FROM acute_safety_episodes WHERE id = p_episode_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'episode_not_found'); END IF;

  IF NOT EXISTS (
    SELECT 1 FROM supervisor_patients sp
    WHERE sp.supervisor_id = p_clinician_id AND sp.patient_id = v_episode.user_id AND sp.status = 'active'
  ) THEN
    RETURN jsonb_build_object('result', 'not_authorized');
  END IF;

  SELECT * INTO v_existing FROM acute_safety_releases WHERE acute_safety_episode_id = p_episode_id;
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'already_released', 'release', to_jsonb(v_existing));
  END IF;

  IF char_length(v_note) NOT BETWEEN 1 AND 1000 THEN
    RETURN jsonb_build_object('result', 'invalid_note');
  END IF;

  SELECT * INTO v_state FROM acute_episode_review_state(p_episode_id);
  IF NOT v_state.requires_clinician_release THEN
    RETURN jsonb_build_object('result', 'clinician_release_not_required');
  END IF;

  INSERT INTO acute_safety_releases (acute_safety_episode_id, user_id, release_path, released_by_clinician_id, release_note)
  VALUES (p_episode_id, v_episode.user_id, 'clinician_release', p_clinician_id, v_note)
  RETURNING * INTO v_release;
  RETURN jsonb_build_object('result', 'released', 'release', to_jsonb(v_release));
END;
$$;
REVOKE ALL ON FUNCTION clinician_release_acute_episode(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION clinician_release_acute_episode(UUID, UUID, TEXT) TO service_role;
