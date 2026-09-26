-- C5.3G Canonical Exercise Library Bootstrap — verification against the
-- REAL seeded production data (read-only SELECT assertions only — this
-- script never writes anything, so no transaction/rollback is needed).
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage3gCanonicalExerciseBootstrap.sql

CREATE TEMP TABLE IF NOT EXISTS verify_results (seq SERIAL PRIMARY KEY, result TEXT);
TRUNCATE verify_results;

DO $verify$
DECLARE
  v_exercise_count INT;
  v_dosage_count INT;
  v_ex040_dosage_count INT;
  v_distinct_legacy_ids INT;
  v_pass INT := 0;
  v_fail INT := 0;
  r RECORD;
BEGIN
  -- ================= COUNTS =================
  SELECT count(*) INTO v_exercise_count FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL;
  IF v_exercise_count = 47 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: exactly 47 migrated canonical global exercises with non-null legacy_ex_id'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: expected 47 exercises, found %s', v_exercise_count)); v_fail := v_fail + 1;
  END IF;

  SELECT count(*) INTO v_dosage_count FROM exercise_reference_dosage erd
    JOIN canonical_exercises ce ON ce.id = erd.exercise_id WHERE ce.legacy_ex_id IS NOT NULL;
  IF v_dosage_count = 46 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: exactly 46 seeded reference-dosage rows'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: expected 46 reference-dosage rows, found %s', v_dosage_count)); v_fail := v_fail + 1;
  END IF;

  SELECT count(*) INTO v_ex040_dosage_count FROM exercise_reference_dosage erd
    JOIN canonical_exercises ce ON ce.id = erd.exercise_id WHERE ce.legacy_ex_id = 'ex_040';
  IF v_ex040_dosage_count = 0 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ex_040 has zero reference-dosage rows (approved omission)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: ex_040 unexpectedly has %s reference-dosage row(s)', v_ex040_dosage_count)); v_fail := v_fail + 1;
  END IF;

  -- ================= IDENTITY =================
  SELECT count(DISTINCT legacy_ex_id) INTO v_distinct_legacy_ids FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL;
  IF v_distinct_legacy_ids = 47 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: no duplicate legacy_ex_id (47 distinct)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: expected 47 distinct legacy_ex_id, found %s', v_distinct_legacy_ids)); v_fail := v_fail + 1;
  END IF;

  IF (SELECT count(DISTINCT id) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL) = 47 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: all 47 canonical UUIDs unique'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: canonical UUID collision detected'); v_fail := v_fail + 1;
  END IF;

  IF NOT EXISTS (
    SELECT gs FROM generate_series(1, 47) gs
    WHERE NOT EXISTS (SELECT 1 FROM canonical_exercises WHERE legacy_ex_id = 'ex_' || lpad(gs::text, 3, '0'))
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: every ex_001..ex_047 appears exactly once'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: at least one of ex_001..ex_047 is missing'); v_fail := v_fail + 1;
  END IF;

  -- ================= OWNERSHIP/LIFECYCLE =================
  IF NOT EXISTS (
    SELECT 1 FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL
      AND (visibility != 'global' OR owner_clinician_id IS NOT NULL OR organization_id IS NOT NULL
           OR created_by IS NOT NULL OR active != true)
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: all 47 are global / owner NULL / org NULL / created_by NULL / active true'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: at least one migrated exercise has incorrect ownership/lifecycle fields'); v_fail := v_fail + 1;
  END IF;

  -- ================= LOADING PROFILES =================
  FOR r IN
    SELECT loading_profile, count(*) AS c FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL GROUP BY loading_profile
  LOOP
    INSERT INTO verify_results(result) VALUES (format('loading_profile %s = %s exercises', r.loading_profile, r.c));
  END LOOP;
  IF (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'concentric_eccentric') = 12
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'stretching') = 7
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'isometric') = 5
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'eccentric_biased') = 5
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'heavy_dynamic') = 5
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'reactive_strength') = 5
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'fast_dynamic') = 4
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'return_to_run') = 4
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND loading_profile = 'explosive_strength') = 0
  THEN
    INSERT INTO verify_results(result) VALUES ('PASS: exact expected loading-profile counts after mapping (12/7/5/5/5/5/4/4, 0 explosive_strength)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: loading-profile counts do not match expected distribution'); v_fail := v_fail + 1;
  END IF;

  -- ================= LATERALITY =================
  IF (SELECT unilateral_bilateral FROM canonical_exercises WHERE legacy_ex_id = 'ex_017') = 'both'
     AND (SELECT unilateral_bilateral FROM canonical_exercises WHERE legacy_ex_id = 'ex_038') = 'both'
  THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ex_017 and ex_038 are both (the ACTUAL both-exercises — see migration header re: the ex_027/ex_045 correction)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ex_017/ex_038 laterality incorrect'); v_fail := v_fail + 1;
  END IF;
  IF (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND unilateral_bilateral = 'bilateral') = 27
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND unilateral_bilateral = 'unilateral') = 18
     AND (SELECT count(*) FROM canonical_exercises WHERE legacy_ex_id IS NOT NULL AND unilateral_bilateral = 'both') = 2
  THEN
    INSERT INTO verify_results(result) VALUES ('PASS: laterality counts exact (bilateral=27, unilateral=18, both=2)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: laterality counts do not match'); v_fail := v_fail + 1;
  END IF;

  -- ================= REFERENCE DOSAGE TYPE COVERAGE =================
  IF (SELECT count(*) FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id=erd.exercise_id WHERE ce.legacy_ex_id IS NOT NULL AND erd.dosage_type='repetition') = 23
     AND (SELECT count(*) FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id=erd.exercise_id WHERE ce.legacy_ex_id IS NOT NULL AND erd.dosage_type='hold') = 12
     AND (SELECT count(*) FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id=erd.exercise_id WHERE ce.legacy_ex_id IS NOT NULL AND erd.dosage_type='contact') = 6
     AND (SELECT count(*) FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id=erd.exercise_id WHERE ce.legacy_ex_id IS NOT NULL AND erd.dosage_type='time') = 4
     AND (SELECT count(*) FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id=erd.exercise_id WHERE ce.legacy_ex_id IS NOT NULL AND erd.dosage_type='distance') = 1
  THEN
    INSERT INTO verify_results(result) VALUES ('PASS: representative dosage-type distribution correct (23 repetition, 12 hold, 6 contact, 4 time, 1 distance = 46)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: dosage-type distribution incorrect'); v_fail := v_fail + 1;
  END IF;

  -- ex_033 exact structure
  IF EXISTS (
    SELECT 1 FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id = erd.exercise_id
    WHERE ce.legacy_ex_id = 'ex_033' AND erd.dosage_type='time' AND erd.time_duration_mode='exact'
      AND erd.time_duration_exact_seconds=1200 AND erd.interval_work_seconds=60 AND erd.interval_recovery_seconds=120
      AND erd.interval_rounds IS NULL
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ex_033 exact approved interval structure (1200s/60s/120s, rounds NULL)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ex_033 structure incorrect'); v_fail := v_fail + 1;
  END IF;

  -- ex_035 exact structure + derived meters
  IF EXISTS (
    SELECT 1 FROM exercise_reference_dosage erd JOIN canonical_exercises ce ON ce.id = erd.exercise_id
    WHERE ce.legacy_ex_id = 'ex_035' AND erd.dosage_type='distance' AND erd.sets=4 AND erd.distance_mode='exact'
      AND erd.distance_exact_value=60 AND erd.distance_unit='m' AND erd.tempo_description='75-80% effort'
      AND erd.distance_value_m_derived = 60
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ex_035 exact approved distance structure (sets=4, 60m, derived=60)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ex_035 structure incorrect'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== C5.3G BOOTSTRAP VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;
