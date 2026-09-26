-- C5.3 final correction — template_performance_focus verification. Runs
-- entirely inside one transaction ROLLBACK'd at the end.
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

DO $verify$
DECLARE
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_ex_active UUID;
  v_template0_id UUID; -- zero focuses
  v_template1_id UUID; -- one focus
  v_templateN_id UUID; -- multiple focuses
  v_workout_id UUID;
  v_ex_id UUID;
  v_pp_id UUID;
  v_draft_id UUID;
  v_pass INT := 0;
  v_fail INT := 0;
BEGIN
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, 'dc12a11e-39b7-47eb-886d-1b90f94c1cbb'::uuid, 'active');
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('TPF verify exercise', 'global', true) RETURNING id INTO v_ex_active;

  -- --- template with ZERO performance focuses ---
  INSERT INTO prescription_templates (name, owner_clinician_id, visibility) VALUES ('TPF verify template 0', v_clinician, 'private') RETURNING id INTO v_template0_id;
  INSERT INTO template_workouts (template_id, order_index) VALUES (v_template0_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO template_exercises (template_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex_active, 0) RETURNING id INTO v_ex_id;
  INSERT INTO template_exercise_dosage (template_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex_id, 'repetition', 3, 'exact', 10);

  -- --- template with ONE performance focus ---
  INSERT INTO prescription_templates (name, owner_clinician_id, visibility) VALUES ('TPF verify template 1', v_clinician, 'private') RETURNING id INTO v_template1_id;
  INSERT INTO template_performance_focus (template_id, focus) VALUES (v_template1_id, 'strength_development');
  INSERT INTO template_workouts (template_id, order_index) VALUES (v_template1_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO template_exercises (template_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex_active, 0) RETURNING id INTO v_ex_id;
  INSERT INTO template_exercise_dosage (template_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex_id, 'repetition', 3, 'exact', 10);

  -- --- template with MULTIPLE performance focuses ---
  INSERT INTO prescription_templates (name, owner_clinician_id, visibility) VALUES ('TPF verify template N', v_clinician, 'private') RETURNING id INTO v_templateN_id;
  INSERT INTO template_performance_focus (template_id, focus) VALUES (v_templateN_id, 'strength_development'), (v_templateN_id, 'energy_storage'), (v_templateN_id, 'maintenance');
  INSERT INTO template_workouts (template_id, order_index) VALUES (v_templateN_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO template_exercises (template_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex_active, 0) RETURNING id INTO v_ex_id;
  INSERT INTO template_exercise_dosage (template_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex_id, 'repetition', 3, 'exact', 10);

  -- --- invalid focus rejected ---
  BEGIN
    INSERT INTO template_performance_focus (template_id, focus) VALUES (v_template0_id, 'not_a_real_focus');
    INSERT INTO verify_results(result) VALUES ('FAIL: invalid focus was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN
    INSERT INTO verify_results(result) VALUES ('PASS: invalid focus value rejected'); v_pass := v_pass + 1;
  END;

  -- --- duplicate (template_id, focus) rejected ---
  BEGIN
    INSERT INTO template_performance_focus (template_id, focus) VALUES (v_template1_id, 'strength_development');
    INSERT INTO verify_results(result) VALUES ('FAIL: duplicate (template_id, focus) was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO verify_results(result) VALUES ('PASS: duplicate (template_id, focus) rejected'); v_pass := v_pass + 1;
  END;

  -- --- copy: zero focuses ---
  v_draft_id := create_prescription_draft('dc12a11e-39b7-47eb-886d-1b90f94c1cbb'::uuid, v_clinician, 'from_template', NULL, v_template0_id);
  IF NOT EXISTS (SELECT 1 FROM prescription_draft_performance_focus WHERE prescription_draft_id = v_draft_id) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: template with zero focuses copies zero draft focus rows'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: unexpected focus rows copied from zero-focus template'); v_fail := v_fail + 1;
  END IF;
  UPDATE prescription_drafts SET status = 'discarded' WHERE id = v_draft_id;

  -- --- copy: one focus ---
  v_draft_id := create_prescription_draft('dc12a11e-39b7-47eb-886d-1b90f94c1cbb'::uuid, v_clinician, 'from_template', NULL, v_template1_id);
  IF (SELECT array_agg(focus ORDER BY focus) FROM prescription_draft_performance_focus WHERE prescription_draft_id = v_draft_id) = ARRAY['strength_development'] THEN
    INSERT INTO verify_results(result) VALUES ('PASS: template with one focus copies exactly that one focus'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: one-focus template copy incorrect'); v_fail := v_fail + 1;
  END IF;
  UPDATE prescription_drafts SET status = 'discarded' WHERE id = v_draft_id;

  -- --- copy: multiple focuses ---
  v_draft_id := create_prescription_draft('dc12a11e-39b7-47eb-886d-1b90f94c1cbb'::uuid, v_clinician, 'from_template', NULL, v_templateN_id);
  IF (SELECT array_agg(focus ORDER BY focus) FROM prescription_draft_performance_focus WHERE prescription_draft_id = v_draft_id)
     = ARRAY['energy_storage','maintenance','strength_development'] THEN
    INSERT INTO verify_results(result) VALUES ('PASS: template with multiple focuses copies all of them correctly'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: multi-focus template copy incorrect'); v_fail := v_fail + 1;
  END IF;

  -- --- disconnection: mutating the template afterward does not affect the draft ---
  INSERT INTO template_performance_focus (template_id, focus) VALUES (v_templateN_id, 'return_to_sport_prep');
  IF NOT EXISTS (SELECT 1 FROM prescription_draft_performance_focus WHERE prescription_draft_id = v_draft_id AND focus = 'return_to_sport_prep') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: adding a focus to the template after copy does not retroactively affect the already-created draft (no live linkage)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: template mutation leaked into already-copied draft'); v_fail := v_fail + 1;
  END IF;
  DELETE FROM template_performance_focus WHERE template_id = v_templateN_id AND focus = 'maintenance';
  IF EXISTS (SELECT 1 FROM prescription_draft_performance_focus WHERE prescription_draft_id = v_draft_id AND focus = 'maintenance') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: removing a focus from the template after copy does not retroactively remove it from the draft'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: template removal leaked into already-copied draft'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== TEMPLATE PERFORMANCE FOCUS VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
