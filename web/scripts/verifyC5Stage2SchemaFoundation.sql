-- C5.2 schema verification. Runs entirely inside one transaction that is
-- ROLLBACK'd at the end — no row persists in the shared project regardless
-- of outcome. Uses two real, pre-existing auth.users ids purely to satisfy
-- FK constraints; no clinical meaning is attached to them and nothing is
-- ever committed. Results are captured into a temp table (also rolled back)
-- and printed via a final SELECT, since RAISE NOTICE output is not
-- surfaced by `supabase db query`.
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

DO $verify$
DECLARE
  v_patient UUID := 'dc12a11e-39b7-47eb-886d-1b90f94c1cbb';
  v_clinician UUID := '6017c6ee-df39-412c-8037-2a522f0b3b46';
  v_pp_id UUID;
  v_pv_id UUID;
  v_draft_id UUID;
  v_ex_id UUID;
  v_workout_id UUID;
  v_pe_ids UUID[];
  v_pass INT := 0;
  v_fail INT := 0;
  v_kg NUMERIC;
BEGIN
  INSERT INTO canonical_exercises (name, visibility) VALUES ('Verification Calf Raise', 'global') RETURNING id INTO v_ex_id;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp_id;
  INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source, patient_prescription_id, version_number, published_at, published_by)
    VALUES (v_patient, 1, 'low', false, 'clinician_change', v_pp_id, 1, now(), v_clinician) RETURNING id INTO v_pv_id;
  UPDATE patient_prescriptions SET current_prescription_version_id = v_pv_id WHERE id = v_pp_id;
  INSERT INTO prescription_workouts (prescription_version_id, order_index) VALUES (v_pv_id, 0) RETURNING id INTO v_workout_id;

  WITH inserted AS (
    INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index)
    SELECT v_workout_id, v_ex_id, gs FROM generate_series(0, 29) gs
    RETURNING id, order_index
  )
  SELECT array_agg(id ORDER BY order_index) INTO v_pe_ids FROM inserted;

  INSERT INTO verify_results(result) VALUES (format('setup complete: patient_prescription=%s, version=%s, workout=%s', v_pp_id, v_pv_id, v_workout_id));

  -- ================= EXAMPLES A-I: expected ACCEPT =================

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
      VALUES (v_pe_ids[1], 'repetition', 3, 'exact', 10, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('PASS: Example A (3x10 exact) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example A rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_min, reps_max, load_type)
      VALUES (v_pe_ids[2], 'repetition', 3, 'range', 8, 12, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('PASS: Example B (3x8-12 range) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example B rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, hold_duration_mode, hold_duration_exact_seconds)
      VALUES (v_pe_ids[3], 'hold', 5, 'exact', 45);
    INSERT INTO verify_results(result) VALUES ('PASS: Example C (5x45s hold) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example C rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, concentric_duration_seconds, rep_hold_duration_seconds, eccentric_duration_seconds, load_type)
      VALUES (v_pe_ids[4], 'repetition', 3, 'exact', 10, 2, 1, 3, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('PASS: Example D (3x10, 2/1/3 rep timing) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example D rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, time_duration_mode, time_duration_exact_seconds, interval_work_seconds, interval_recovery_seconds)
      VALUES (v_pe_ids[5], 'time', 'exact', 1200, 60, 120);
    INSERT INTO verify_results(result) VALUES ('PASS: Example E (20min total + 1/2min interval) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example E rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, contacts_mode, contacts_exact, load_type)
      VALUES (v_pe_ids[6], 'contact', 3, 'exact', 20, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('PASS: Example F (3x20 contacts) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example F rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_value_exact, load_unit)
      VALUES (v_pe_ids[7], 'repetition', 3, 'exact', 8, 'external', 30, 'lb');
    INSERT INTO verify_results(result) VALUES ('PASS: Example G (3x8 @ 30lb) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example G rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_min, reps_max, load_type)
      VALUES (v_pe_ids[8], 'repetition', 3, 'range', 8, 10, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('PASS: Example H (3x8-10 @ bodyweight) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example H rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
      VALUES (v_pe_ids[9], 'repetition', 3, 'exact', 10, 'assisted');
    INSERT INTO verify_results(result) VALUES ('PASS: Example I (assisted, no numeric load) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: Example I rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  SELECT load_value_kg_derived INTO v_kg FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pe_ids[7];
  IF v_kg BETWEEN 13.60 AND 13.61 THEN
    INSERT INTO verify_results(result) VALUES (format('PASS: load_value_kg_derived computed correctly (%s kg for 30lb)', v_kg)); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: load_value_kg_derived wrong: %s', v_kg)); v_fail := v_fail + 1;
  END IF;

  -- ================= INVALID CASES: expected REJECT =================

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, reps_min, reps_max, load_type)
      VALUES (v_pe_ids[10], 'repetition', 3, 'exact', 10, 8, 12, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('FAIL: reps exact+range simultaneously was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: reps exact+range simultaneously rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_min, reps_max, load_type)
      VALUES (v_pe_ids[11], 'repetition', 3, 'range', 12, 8, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('FAIL: range max < min was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: range max < min rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_value_exact)
      VALUES (v_pe_ids[12], 'repetition', 3, 'exact', 8, 'external', 30);
    INSERT INTO verify_results(result) VALUES ('FAIL: external load without unit was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: external load without unit rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_value_exact, load_unit)
      VALUES (v_pe_ids[13], 'repetition', 3, 'exact', 8, 'bodyweight', 20, 'kg');
    INSERT INTO verify_results(result) VALUES ('FAIL: bodyweight with fabricated numeric load was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: bodyweight with numeric load rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, hold_duration_mode, hold_duration_exact_seconds, reps_mode, reps_exact)
      VALUES (v_pe_ids[14], 'hold', 5, 'exact', 45, 'exact', 10);
    INSERT INTO verify_results(result) VALUES ('FAIL: hold dosage using rep fields was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: hold dosage using rep fields rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, hold_duration_mode, hold_duration_exact_seconds, load_type)
      VALUES (v_pe_ids[15], 'repetition', 3, 'exact', 10, 'exact', 45, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('FAIL: repetition dosage using hold fields was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: repetition dosage using hold fields rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type)
      VALUES (v_pe_ids[16], 'time');
    INSERT INTO verify_results(result) VALUES ('FAIL: malformed empty time dosage was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: malformed empty time dosage rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
      VALUES (v_pe_ids[17], 'repetition', 0, 'exact', 10, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('FAIL: zero sets was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: zero sets rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type)
      VALUES (v_pe_ids[18], 'repetition', 3, 'exact', -5, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('FAIL: negative reps was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: negative reps rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, reps_mode, reps_exact, load_type)
      VALUES (v_pe_ids[19], 'repetition', 'exact', 10, 'bodyweight');
    INSERT INTO verify_results(result) VALUES ('FAIL: repetition dosage with NULL sets was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: repetition dosage with NULL sets rejected'); v_pass := v_pass + 1;
  END;

  -- ================= STRUCTURAL / IDENTITY CONSTRAINTS =================

  BEGIN
    INSERT INTO prescription_workouts (prescription_version_id, prescription_draft_id, order_index) VALUES (v_pv_id, v_pv_id, 99);
    INSERT INTO verify_results(result) VALUES ('FAIL: workout with BOTH parents set was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: workout with both parents set rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_workouts (order_index) VALUES (99);
    INSERT INTO verify_results(result) VALUES ('FAIL: workout with NEITHER parent set was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: workout with neither parent set rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient);
    INSERT INTO verify_results(result) VALUES ('FAIL: second patient_prescriptions row for same patient was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN unique_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: second patient_prescriptions row for same patient rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source, patient_prescription_id, version_number, published_at, published_by)
      VALUES (v_patient, 1, 'low', false, 'clinician_change', v_pp_id, 1, now(), v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: duplicate version_number for same patient_prescription was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN unique_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: duplicate version_number rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source, version_number)
      VALUES (v_patient, 1, 'low', false, 'onboarding', 1);
    INSERT INTO verify_results(result) VALUES ('FAIL: version_number without patient_prescription_id/published_at/published_by was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: partial C5-native fields rejected (togetherness constraint)'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source)
      VALUES (v_patient, 2, 'low', false, 'onboarding');
    INSERT INTO verify_results(result) VALUES ('PASS: legacy-shaped row (all C5 fields NULL) still accepted, historical compatibility preserved'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: legacy-shaped row rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  INSERT INTO prescription_drafts (patient_prescription_id, source, created_by, editing_clinician_id, updated_by)
    VALUES (v_pp_id, 'empty', v_clinician, v_clinician, v_clinician) RETURNING id INTO v_draft_id;
  INSERT INTO verify_results(result) VALUES ('PASS: first open draft created');
  v_pass := v_pass + 1;

  BEGIN
    INSERT INTO prescription_drafts (patient_prescription_id, source, created_by, editing_clinician_id, updated_by)
      VALUES (v_pp_id, 'empty', v_clinician, v_clinician, v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: second OPEN draft for same patient_prescription was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN unique_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: second open draft rejected (one-open-draft constraint)'); v_pass := v_pass + 1;
  END;

  BEGIN
    UPDATE prescription_drafts SET status = 'discarded' WHERE id = v_draft_id;
    INSERT INTO prescription_drafts (patient_prescription_id, source, created_by, editing_clinician_id, updated_by)
      VALUES (v_pp_id, 'empty', v_clinician, v_clinician, v_clinician);
    INSERT INTO verify_results(result) VALUES ('PASS: new open draft allowed after prior one discarded'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: new draft after discard rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO notifications (patient_id, type) VALUES (v_patient, 'prescription_published');
    INSERT INTO verify_results(result) VALUES ('FAIL: prescription_published notification without prescription_version_id was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: prescription_published notification without ref rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO notifications (patient_id, type, prescription_version_id) VALUES (v_patient, 'prescription_published', v_pv_id);
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_published notification with ref accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: notification with ref rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO canonical_exercises (name, visibility, owner_clinician_id) VALUES ('Bad Global', 'global', v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: global exercise WITH owner was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: global exercise with owner rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO canonical_exercises (name, visibility) VALUES ('Bad Private', 'private');
    INSERT INTO verify_results(result) VALUES ('FAIL: private exercise WITHOUT owner was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: private exercise without owner rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, side)
      VALUES (v_pe_ids[20], 'repetition', 3, 'exact', 10, 'bodyweight', 'alternating');
    INSERT INTO verify_results(result) VALUES ('FAIL: side=alternating was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN check_violation THEN INSERT INTO verify_results(result) VALUES ('PASS: side=alternating rejected (not in approved vocabulary)'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, side)
      VALUES (v_pe_ids[21], 'repetition', 3, 'exact', 10, 'bodyweight', 'both_sides_separately');
    INSERT INTO verify_results(result) VALUES ('PASS: side=both_sides_separately accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: side=both_sides_separately rejected unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  INSERT INTO verify_results(result) VALUES (format('=== C5.2 SCHEMA VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
