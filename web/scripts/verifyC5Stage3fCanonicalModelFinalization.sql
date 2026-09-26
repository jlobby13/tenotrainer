-- C5.3F Canonical Exercise Model Finalization — verification. Runs entirely
-- inside one transaction ROLLBACK'd at the end.
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_patient UUID := 'dc12a11e-39b7-47eb-886d-1b90f94c1cbb';
  v_ex_id UUID;
  v_ex2_id UUID;
  v_template_id UUID;
  v_tw_id UUID;
  v_te_id UUID;
  v_draft_id UUID;
  v_draft2_id UUID;
  v_pp_id UUID;
  v_version1_id UUID;
  v_version2_id UUID;
  v_workout_id UUID;
  v_pex_id UUID;
  v_row RECORD;
  v_pass INT := 0;
  v_fail INT := 0;
  lp TEXT;
BEGIN
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');
  INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source) VALUES (v_patient, 1, 'low', false, 'onboarding');

  -- ================= LOADING PROFILE =================
  FOREACH lp IN ARRAY ARRAY['isometric','concentric_eccentric','eccentric_biased','heavy_dynamic','fast_dynamic','reactive_strength','explosive_strength','stretching','return_to_run'] LOOP
    BEGIN
      INSERT INTO canonical_exercises (name, visibility, loading_profile) VALUES ('lp test', 'global', lp);
      INSERT INTO verify_results(result) VALUES (format('PASS: loading_profile %s accepted', lp)); v_pass := v_pass + 1;
      DELETE FROM canonical_exercises WHERE name = 'lp test';
    EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: loading_profile %s rejected: %s', lp, SQLERRM)); v_fail := v_fail + 1;
    END;
  END LOOP;

  BEGIN
    INSERT INTO canonical_exercises (name, visibility, loading_profile) VALUES ('bad lp', 'global', 'not_a_real_profile');
    INSERT INTO verify_results(result) VALUES ('FAIL: invalid loading_profile was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: invalid loading_profile rejected'); v_pass := v_pass + 1;
  END;

  -- ================= LATERALITY =================
  BEGIN
    INSERT INTO canonical_exercises (name, visibility, unilateral_bilateral) VALUES ('both test', 'global', 'both');
    INSERT INTO verify_results(result) VALUES ('PASS: laterality both accepted'); v_pass := v_pass + 1;
    DELETE FROM canonical_exercises WHERE name = 'both test';
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: laterality both rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO canonical_exercises (name, visibility, unilateral_bilateral) VALUES ('bad lat', 'global', 'sideways');
    INSERT INTO verify_results(result) VALUES ('FAIL: invalid laterality was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: invalid laterality rejected'); v_pass := v_pass + 1;
  END;

  -- ================= EXECUTION CUES + METADATA SHAPES =================
  INSERT INTO canonical_exercises (
    name, visibility, execution_cues, difficulty_level, target_tissues, region_bias,
    impact_level, stretch_shortening_cycle, rate_of_loading, requires_full_rom,
    requires_dorsiflexion_depth, max_load_potential, common_compensations,
    contraindications_or_cautions, clinician_notes
  ) VALUES (
    'metadata test', 'global', ARRAY['Rise onto toes', 'Hold at 70% effort', 'Breathe normally'], 1,
    ARRAY['Achilles tendon', 'gastrocnemius', 'soleus'], ARRAY['midportion', 'insertional'],
    'none', false, 'slow', false, 'none', 'moderate', ARRAY['Gripping toes', 'Shifting weight'],
    'Reduce hold duration if pain exceeds 3/10.', 'First-line exercise for high irritability.'
  ) RETURNING id INTO v_ex_id;

  SELECT execution_cues INTO v_row FROM canonical_exercises WHERE id = v_ex_id;
  IF (SELECT execution_cues FROM canonical_exercises WHERE id = v_ex_id) = ARRAY['Rise onto toes', 'Hold at 70% effort', 'Breathe normally'] THEN
    INSERT INTO verify_results(result) VALUES ('PASS: execution_cues preserved as ordered array'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: execution_cues order/shape not preserved'); v_fail := v_fail + 1;
  END IF;

  IF EXISTS (
    SELECT 1 FROM canonical_exercises WHERE id = v_ex_id
      AND target_tissues = ARRAY['Achilles tendon','gastrocnemius','soleus']
      AND region_bias = ARRAY['midportion','insertional']
      AND common_compensations = ARRAY['Gripping toes','Shifting weight']
      AND difficulty_level = 1 AND impact_level = 'none' AND stretch_shortening_cycle = false
      AND rate_of_loading = 'slow' AND requires_full_rom = false AND requires_dorsiflexion_depth = 'none'
      AND max_load_potential = 'moderate'
      AND contraindications_or_cautions = 'Reduce hold duration if pain exceeds 3/10.'
      AND clinician_notes = 'First-line exercise for high irritability.'
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: all 13 new metadata fields accept and preserve intended source-compatible shapes'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: one or more metadata fields did not round-trip correctly'); v_fail := v_fail + 1;
  END IF;

  -- ================= DISTANCE DOSAGE =================
  INSERT INTO canonical_exercises (name, visibility) VALUES ('distance test exercise', 'global') RETURNING id INTO v_ex2_id;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp_id;
  INSERT INTO prescription_drafts (patient_prescription_id, status, source, created_by, editing_clinician_id, updated_by, scheduling_mode)
    VALUES (v_pp_id, 'editing', 'empty', v_clinician, v_clinician, v_clinician, 'sequence') RETURNING id INTO v_draft_id;
  INSERT INTO prescription_workouts (prescription_draft_id, order_index) VALUES (v_draft_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex2_id, 0) RETURNING id INTO v_pex_id;

  -- exact 60m
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit, tempo_description, rest_seconds)
      VALUES (v_pex_id, 'distance', 4, 'exact', 60, 'm', '75-80% effort', 120);
    INSERT INTO verify_results(result) VALUES ('PASS: exact 60m distance dosage (ex_035 shape) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: exact 60m distance rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  IF (SELECT distance_value_m_derived FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id) = 60 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: derived meters correct for m (60 -> 60)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: derived meters incorrect for m'); v_fail := v_fail + 1;
  END IF;

  -- valid range
  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_min_value, distance_max_value, distance_unit)
      VALUES (v_pex_id, 'distance', 3, 'range', 50, 80, 'm');
    INSERT INTO verify_results(result) VALUES ('PASS: valid distance range accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: valid distance range rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  -- km / ft / mi
  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit)
    VALUES (v_pex_id, 'distance', 1, 'exact', 1, 'km');
  IF (SELECT distance_value_m_derived FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id) = 1000 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: km accepted, derived meters correct (1km -> 1000m)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: km derived meters incorrect'); v_fail := v_fail + 1;
  END IF;

  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit)
    VALUES (v_pex_id, 'distance', 1, 'exact', 10, 'ft');
  IF (SELECT round(distance_value_m_derived, 4) FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id) = 3.0480 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ft accepted, derived meters correct (10ft -> 3.048m)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ft derived meters incorrect'); v_fail := v_fail + 1;
  END IF;

  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit)
    VALUES (v_pex_id, 'distance', 1, 'exact', 1, 'mi');
  IF (SELECT round(distance_value_m_derived, 3) FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id) = 1609.344 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: mi accepted, derived meters correct (1mi -> 1609.344m)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: mi derived meters incorrect'); v_fail := v_fail + 1;
  END IF;

  -- invalid unit
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit)
      VALUES (v_pex_id, 'distance', 1, 'exact', 10, 'yards');
    INSERT INTO verify_results(result) VALUES ('FAIL: invalid distance unit was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: invalid distance unit rejected'); v_pass := v_pass + 1;
  END;

  -- zero/negative
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit)
      VALUES (v_pex_id, 'distance', 1, 'exact', 0, 'm');
    INSERT INTO verify_results(result) VALUES ('FAIL: zero distance was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: zero distance rejected'); v_pass := v_pass + 1;
  END;
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit)
      VALUES (v_pex_id, 'distance', 1, 'exact', -5, 'm');
    INSERT INTO verify_results(result) VALUES ('FAIL: negative distance was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: negative distance rejected'); v_pass := v_pass + 1;
  END;

  -- malformed exact/range combos
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_min_value, distance_unit)
      VALUES (v_pex_id, 'distance', 1, 'exact', 60, 50, 'm');
    INSERT INTO verify_results(result) VALUES ('FAIL: exact+min simultaneously was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: exact+range simultaneously rejected'); v_pass := v_pass + 1;
  END;
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_min_value, distance_max_value, distance_unit)
      VALUES (v_pex_id, 'distance', 1, 'range', 80, 50, 'm');
    INSERT INTO verify_results(result) VALUES ('FAIL: range max < min was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: range max < min rejected'); v_pass := v_pass + 1;
  END;
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value)
      VALUES (v_pex_id, 'distance', 1, 'exact', 60);
    INSERT INTO verify_results(result) VALUES ('FAIL: distance without unit was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: distance without unit rejected'); v_pass := v_pass + 1;
  END;

  -- cannot coexist with other quantity fields
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit, reps_mode, reps_exact)
      VALUES (v_pex_id, 'distance', 1, 'exact', 60, 'm', 'exact', 10);
    INSERT INTO verify_results(result) VALUES ('FAIL: distance dosage with reps fields populated was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: distance dosage cannot simultaneously populate reps fields'); v_pass := v_pass + 1;
  END;
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, distance_mode, distance_exact_value, distance_unit)
      VALUES (v_pex_id, 'repetition', 1, 'exact', 10, 'exact', 60, 'm');
    INSERT INTO verify_results(result) VALUES ('FAIL: repetition dosage with distance fields populated was ACCEPTED'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: repetition dosage cannot simultaneously populate distance fields'); v_pass := v_pass + 1;
  END;

  -- ================= COPY/PUBLISH INTEGRITY: template -> draft -> published -> new draft =================
  INSERT INTO prescription_templates (name, owner_clinician_id, visibility) VALUES ('distance copy test template', v_clinician, 'private') RETURNING id INTO v_template_id;
  INSERT INTO template_workouts (template_id, order_index) VALUES (v_template_id, 0) RETURNING id INTO v_tw_id;
  INSERT INTO template_exercises (template_workout_id, canonical_exercise_id, order_index) VALUES (v_tw_id, v_ex2_id, 0) RETURNING id INTO v_te_id;
  INSERT INTO template_exercise_dosage (template_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit, tempo_description, rest_seconds)
    VALUES (v_te_id, 'distance', 4, 'exact', 60, 'm', '75-80% effort', 120);

  -- discard the earlier ad hoc draft, start clean from template
  UPDATE prescription_drafts SET status = 'discarded' WHERE id = v_draft_id;
  v_draft_id := create_prescription_draft(v_patient, v_clinician, 'from_template', NULL, v_template_id);

  SELECT ped.* INTO v_row FROM prescription_exercise_dosage ped
    JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    WHERE pw.prescription_draft_id = v_draft_id;
  IF v_row.dosage_type = 'distance' AND v_row.distance_exact_value = 60 AND v_row.distance_unit = 'm' AND v_row.sets = 4 AND v_row.tempo_description = '75-80% effort' AND v_row.rest_seconds = 120 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: template -> draft copy preserves distance dosage exactly (60m, sets=4)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: template -> draft copy lost/altered distance dosage'); v_fail := v_fail + 1;
  END IF;

  UPDATE prescription_drafts SET scheduling_mode = 'sequence' WHERE id = v_draft_id;
  v_version1_id := publish_prescription_draft(v_draft_id, v_clinician);

  SELECT ped.* INTO v_row FROM prescription_exercise_dosage ped
    JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    WHERE pw.prescription_version_id = v_version1_id;
  IF v_row.dosage_type = 'distance' AND v_row.distance_exact_value = 60 AND v_row.distance_unit = 'm' AND v_row.distance_value_m_derived = 60 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: draft -> published version preserves distance dosage exactly'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: draft -> published version lost/altered distance dosage'); v_fail := v_fail + 1;
  END IF;

  v_draft2_id := create_prescription_draft(v_patient, v_clinician, 'clone_active', v_version1_id, NULL);
  SELECT ped.* INTO v_row FROM prescription_exercise_dosage ped
    JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    WHERE pw.prescription_draft_id = v_draft2_id;
  IF v_row.dosage_type = 'distance' AND v_row.distance_exact_value = 60 AND v_row.distance_unit = 'm' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: published version -> new draft (clone_active) preserves distance dosage exactly'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: published version -> new draft lost/altered distance dosage'); v_fail := v_fail + 1;
  END IF;

  -- ================= ex_040-style: exercise migrated, no structured reference dosage =================
  INSERT INTO canonical_exercises (name, visibility) VALUES ('ex_040-style exercise', 'global') RETURNING id INTO v_ex_id;
  IF NOT EXISTS (SELECT 1 FROM exercise_reference_dosage WHERE exercise_id = v_ex_id) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: exercise can exist with zero exercise_reference_dosage rows (ex_040 pattern)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: unexpected reference dosage row present'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== C5.3F VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
