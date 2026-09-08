-- =============================================================================
-- Bug fix, additive: get_patient_acute_brake_status()'s `v_reasons ||
-- '<literal>'` expressions were being resolved by PL/pgSQL as an
-- array-vs-array concatenation attempt (trying to parse the plain string
-- literal AS a text[] literal) rather than array-append, raising
-- "malformed array literal" the moment any Level 4 reason fired. Fixed by
-- using array_append() explicitly, which is unambiguous.
--
-- New additive migration rather than editing 20260911000001 in place, which
-- is already applied to the linked development database — see the M5
-- Stage 3 hardening patch's identical precedent and reasoning.
-- =============================================================================

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
    RETURN;
  END IF;

  SELECT count(*) INTO v_blocked_count FROM blocked_loading_opportunities b WHERE b.acute_safety_episode_id = v_episode.id;

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
    IF v_blocked_count >= 3 THEN
      v_level := 4;
      v_reasons := array_append(v_reasons, 'three_blocked_opportunities');
    END IF;
  END IF;

  RETURN QUERY SELECT v_episode.id, v_episode.initial_level, v_episode.confirmed_at, v_level, v_reasons, v_blocked_count;
END;
$$;

GRANT EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_patient_acute_brake_status(UUID) FROM anon;
