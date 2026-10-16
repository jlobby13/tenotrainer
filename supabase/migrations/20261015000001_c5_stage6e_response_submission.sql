-- =============================================================================
-- C5.6E — patient response submission (immediate + next-morning).
--
-- Forward-only. Adds two service_role-only RPCs on top of the C5.6B response
-- records (session_immediate_responses / morning_responses) and the C5.6C
-- obligations. No table, constraint or closed function is changed.
--
--   c5_submit_immediate_response(patient, session, response)
--     Validates and RESOLVES the session's immediate-response obligation and,
--     in the SAME transaction, records the session's escalation evaluation
--     using the EXISTING v1 escalation rule (web/lib/escalation.ts — parity
--     tested): pop -> Level 5; sudden/sharp pain or new functional difficulty
--     -> Level 3; otherwise Level 0. Pain and Session RPE are NOT rule inputs
--     (no threshold exists or is invented). Level 1 is unreachable for C5:
--     its inputs (legacy pain-limiting events / "ended early for symptoms")
--     are not captured by the C5 runtime.
--     The acute EPISODE (brake) is created afterwards by the existing
--     reconcile_missing_acute_episodes(), which the API layer calls in its
--     OWN transaction once this one has committed — so a reconciliation
--     failure can never roll back a submitted safety fact, and the C5 gate
--     fails closed (acute_safety_reconciliation_required) until it succeeds.
--
--   c5_submit_morning_response(patient, session, response)
--     Resolves the next-morning obligation once due (answered |
--     unable_to_recall). The frozen due instant and reference_local_date are
--     never touched; submitted_at is the actual submission time, so a
--     retrospective submission keeps its reference morning.
--
-- Shared semantics:
--   * UNKNOWN != ZERO: unable-to-recall stores NULL + an explicit
--     flag/resolution; 0 is stored only when the patient chose 0.
--   * Idempotent: the response row is locked FOR UPDATE; a resolved row is
--     immutable (C5.6B guards), so a retry returns `submitted, replayed`
--     (identical payload) or `already_submitted` (different payload) and
--     changes nothing — no second escalation evaluation, so no second
--     episode.
--   * A safety fact already recorded as TRUE (reported in-session at Stop,
--     C5.6C) can never be downgraded by the form: a contradicting `false` is
--     refused with `recorded_safety_fact_conflict`.
--   * Safety items have no unable-to-recall path.
--   * Business rejections are RETURNED as { result: <code> }, never raised.
-- =============================================================================

-- Integer 0..10 from JSON, else NULL; p_ok reports whether the key held a
-- valid value (absent / null keys are reported separately by the caller).
CREATE OR REPLACE FUNCTION c5_json_score(p_obj JSONB, p_key TEXT)
RETURNS SMALLINT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v JSONB := p_obj -> p_key;
  n NUMERIC;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) <> 'number' THEN RAISE EXCEPTION 'C5_SCORE_INVALID'; END IF;
  n := v::text::numeric;
  IF n <> trunc(n) OR n < 0 OR n > 10 THEN RAISE EXCEPTION 'C5_SCORE_INVALID'; END IF;
  RETURN n::smallint;
END;
$$;
REVOKE ALL ON FUNCTION c5_json_score(JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- The existing v1 escalation rule (web/lib/escalation.ts), restricted to the
-- inputs the C5 runtime actually captures. Pure.
CREATE OR REPLACE FUNCTION c5_escalation_v1(p_sudden BOOLEAN, p_pop BOOLEAN, p_new_difficulty BOOLEAN, OUT o_level SMALLINT, OUT o_reason TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_pop IS TRUE THEN
    o_level := 5; o_reason := 'pop_felt_or_heard';
  ELSIF p_sudden IS TRUE AND p_new_difficulty IS TRUE THEN
    o_level := 3; o_reason := 'sudden_or_sharp_pain_and_new_functional_difficulty';
  ELSIF p_sudden IS TRUE THEN
    o_level := 3; o_reason := 'sudden_or_sharp_pain';
  ELSIF p_new_difficulty IS TRUE THEN
    o_level := 3; o_reason := 'new_functional_difficulty';
  ELSE
    o_level := 0; o_reason := 'routine_loading_exposure';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION c5_escalation_v1(BOOLEAN, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Immediate response.
--   p_response: { peak_session_pain: 0..10 | null, peak_pain_unable_to_recall: bool,
--                 overall_session_rpe: 0..10 | null, rpe_unable_to_recall: bool,
--                 sudden_or_sharp_pain: bool, pop_felt_or_heard: bool,
--                 new_functional_difficulty: bool }
--   A safety key may be omitted ONLY when that fact is already recorded TRUE.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION c5_submit_immediate_response(p_patient_id UUID, p_session_id UUID, p_response JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row session_immediate_responses;
  v_status TEXT;
  v_pain SMALLINT;
  v_rpe SMALLINT;
  v_pain_utr BOOLEAN;
  v_rpe_utr BOOLEAN;
  v_safety JSONB := '{}'::jsonb;
  v_key TEXT;
  v_existing BOOLEAN;
  v_given JSONB;
  v_esc RECORD;
  v_eval_id UUID;
BEGIN
  IF p_patient_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;

  SELECT sir.* INTO v_row
  FROM session_immediate_responses sir
  JOIN rehab_sessions rs ON rs.id = sir.rehab_session_id
  WHERE sir.rehab_session_id = p_session_id AND sir.user_id = p_patient_id AND rs.training_status IS NOT NULL
  FOR UPDATE OF sir;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'response_not_found'); END IF;

  IF jsonb_typeof(p_response) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'response_malformed');
  END IF;

  BEGIN
    v_pain := c5_json_score(p_response, 'peak_session_pain');
    v_rpe := c5_json_score(p_response, 'overall_session_rpe');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'score_must_be_integer_0_to_10');
  END;
  IF jsonb_typeof(p_response->'peak_pain_unable_to_recall') NOT IN ('boolean', 'null')
     OR jsonb_typeof(p_response->'rpe_unable_to_recall') NOT IN ('boolean', 'null') THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'unable_to_recall_must_be_boolean');
  END IF;
  v_pain_utr := COALESCE(p_response->'peak_pain_unable_to_recall' = 'true'::jsonb, false);
  v_rpe_utr := COALESCE(p_response->'rpe_unable_to_recall' = 'true'::jsonb, false);

  -- Each graded item: exactly one of a value or "unable to recall".
  IF (v_pain IS NULL) = (NOT v_pain_utr) THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'peak_pain_value_or_unable_to_recall_required');
  END IF;
  IF (v_rpe IS NULL) = (NOT v_rpe_utr) THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'rpe_value_or_unable_to_recall_required');
  END IF;

  -- Safety items: explicit booleans; a recorded TRUE is never downgraded.
  FOREACH v_key IN ARRAY ARRAY['sudden_or_sharp_pain', 'pop_felt_or_heard', 'new_functional_difficulty'] LOOP
    v_existing := (to_jsonb(v_row) ->> v_key)::boolean;
    v_given := p_response -> v_key;
    IF v_given IS NULL OR jsonb_typeof(v_given) = 'null' THEN
      IF v_existing IS TRUE THEN
        v_safety := v_safety || jsonb_build_object(v_key, true);
        CONTINUE;
      END IF;
      RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'safety_answer_required', 'item', v_key);
    END IF;
    IF jsonb_typeof(v_given) <> 'boolean' THEN
      RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'safety_answer_required', 'item', v_key);
    END IF;
    IF v_existing IS TRUE AND v_given = 'false'::jsonb THEN
      RETURN jsonb_build_object('result', 'recorded_safety_fact_conflict', 'item', v_key);
    END IF;
    v_safety := v_safety || jsonb_build_object(v_key, v_given);
  END LOOP;

  -- Already resolved: immutable. Report whether this retry matches.
  IF v_row.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'result', CASE WHEN v_row.peak_session_pain IS NOT DISTINCT FROM v_pain
                      AND v_row.peak_pain_unable_to_recall = v_pain_utr
                      AND v_row.overall_session_rpe IS NOT DISTINCT FROM v_rpe
                      AND v_row.rpe_unable_to_recall = v_rpe_utr
                      AND v_row.sudden_or_sharp_pain = (v_safety->>'sudden_or_sharp_pain')::boolean
                      AND v_row.pop_felt_or_heard = (v_safety->>'pop_felt_or_heard')::boolean
                      AND v_row.new_functional_difficulty = (v_safety->>'new_functional_difficulty')::boolean
                     THEN 'submitted' ELSE 'already_submitted' END,
      'replayed', true,
      'escalation_level', (SELECT escalation_level FROM escalation_evaluations WHERE rehab_session_id = p_session_id ORDER BY evaluated_at DESC LIMIT 1));
  END IF;

  UPDATE session_immediate_responses SET
    peak_session_pain = v_pain,
    peak_pain_unable_to_recall = v_pain_utr,
    overall_session_rpe = v_rpe,
    rpe_unable_to_recall = v_rpe_utr,
    sudden_or_sharp_pain = (v_safety->>'sudden_or_sharp_pain')::boolean,
    pop_felt_or_heard = (v_safety->>'pop_felt_or_heard')::boolean,
    new_functional_difficulty = (v_safety->>'new_functional_difficulty')::boolean,
    resolved_at = now()
  WHERE id = v_row.id;

  SELECT training_status INTO v_status FROM rehab_sessions WHERE id = p_session_id;
  SELECT * INTO v_esc FROM c5_escalation_v1(
    (v_safety->>'sudden_or_sharp_pain')::boolean, (v_safety->>'pop_felt_or_heard')::boolean, (v_safety->>'new_functional_difficulty')::boolean);
  INSERT INTO escalation_evaluations (rehab_session_id, escalation_level, escalation_reason, rule_version, inputs_snapshot)
  VALUES (p_session_id, v_esc.o_level, v_esc.o_reason, 'v1', jsonb_build_object(
    'source', 'c5_immediate_response',
    'suddenOrSharpPain', (v_safety->>'sudden_or_sharp_pain')::boolean,
    'popFeltOrHeard', (v_safety->>'pop_felt_or_heard')::boolean,
    'newFunctionalDifficulty', (v_safety->>'new_functional_difficulty')::boolean,
    'trainingStatus', v_status))
  RETURNING id INTO v_eval_id;

  RETURN jsonb_build_object('result', 'submitted', 'replayed', false,
    'escalation_level', v_esc.o_level, 'escalation_evaluation_id', v_eval_id);
END;
$$;
REVOKE ALL ON FUNCTION c5_submit_immediate_response(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_submit_immediate_response(UUID, UUID, JSONB) TO service_role;

-- -----------------------------------------------------------------------------
-- Next-morning response.
--   p_response: { resolution: 'answered' | 'unable_to_recall',
--                 next_morning_pain: 0..10, next_morning_stiffness: 0..10,
--                 stiffness_duration: 'lt_5_min'|'min_5_15'|'min_15_30'|'gt_30_min'
--                                     (required iff stiffness > 0, else absent),
--                 patient_note: text (optional, <= 500) }
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION c5_submit_morning_response(p_patient_id UUID, p_session_id UUID, p_response JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row morning_responses;
  v_resolution TEXT;
  v_pain SMALLINT;
  v_stiff SMALLINT;
  v_duration TEXT;
  v_note TEXT;
BEGIN
  IF p_patient_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS' USING ERRCODE = 'P0001';
  END IF;

  SELECT mr.* INTO v_row
  FROM morning_responses mr
  JOIN rehab_sessions rs ON rs.id = mr.rehab_session_id
  WHERE mr.rehab_session_id = p_session_id AND mr.user_id = p_patient_id AND rs.training_status IS NOT NULL
  FOR UPDATE OF mr;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'response_not_found'); END IF;

  IF jsonb_typeof(p_response) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'response_malformed');
  END IF;
  v_resolution := p_response->>'resolution';
  IF v_resolution IS NULL OR v_resolution NOT IN ('answered', 'unable_to_recall') THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'resolution_required');
  END IF;
  BEGIN
    v_pain := c5_json_score(p_response, 'next_morning_pain');
    v_stiff := c5_json_score(p_response, 'next_morning_stiffness');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'score_must_be_integer_0_to_10');
  END;
  v_duration := NULLIF(p_response->>'stiffness_duration', '');
  v_note := NULLIF(btrim(COALESCE(p_response->>'patient_note', '')), '');
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'note_too_long');
  END IF;

  IF v_resolution = 'unable_to_recall' THEN
    IF v_pain IS NOT NULL OR v_stiff IS NOT NULL OR v_duration IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'unable_to_recall_has_no_values');
    END IF;
  ELSE
    IF v_pain IS NULL OR v_stiff IS NULL THEN
      RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'pain_and_stiffness_required');
    END IF;
    IF v_stiff > 0 AND (v_duration IS NULL OR v_duration NOT IN ('lt_5_min', 'min_5_15', 'min_15_30', 'gt_30_min')) THEN
      RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'stiffness_duration_required');
    END IF;
    IF v_stiff = 0 AND v_duration IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'invalid_response', 'detail', 'stiffness_duration_without_stiffness');
    END IF;
  END IF;

  IF v_row.submitted_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'result', CASE WHEN v_row.resolution = v_resolution
                      AND v_row.next_morning_pain IS NOT DISTINCT FROM v_pain
                      AND v_row.next_morning_stiffness IS NOT DISTINCT FROM v_stiff
                      AND v_row.stiffness_duration IS NOT DISTINCT FROM v_duration
                      AND v_row.patient_note IS NOT DISTINCT FROM v_note
                     THEN 'submitted' ELSE 'already_submitted' END,
      'replayed', true, 'submitted_at', v_row.submitted_at, 'reference_local_date', v_row.reference_local_date);
  END IF;

  IF v_row.scheduled_eligible_at IS NULL OR v_row.scheduled_eligible_at > now() THEN
    RETURN jsonb_build_object('result', 'morning_not_yet_due', 'due_at', v_row.scheduled_eligible_at);
  END IF;

  UPDATE morning_responses SET
    resolution = v_resolution,
    next_morning_pain = v_pain,
    next_morning_stiffness = v_stiff,
    stiffness_duration = v_duration,
    patient_note = v_note,
    submitted_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('result', 'submitted', 'replayed', false,
    'submitted_at', v_row.submitted_at, 'reference_local_date', v_row.reference_local_date, 'due_at', v_row.scheduled_eligible_at);
END;
$$;
REVOKE ALL ON FUNCTION c5_submit_morning_response(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION c5_submit_morning_response(UUID, UUID, JSONB) TO service_role;
