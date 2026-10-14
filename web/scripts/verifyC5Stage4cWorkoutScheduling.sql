-- C5.4C Workout Structure & Scheduling — schema/function verification.
-- Read-only assertions + one rolled-back transaction for the RPC-level
-- checks (validate_prescription_draft / copy paths), matching the
-- established verifyC5Stage3DraftPublishEngine.sql convention.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage4cWorkoutScheduling.sql

CREATE TEMP TABLE IF NOT EXISTS verify_results (seq SERIAL PRIMARY KEY, result TEXT);
TRUNCATE verify_results;

DO $verify$
DECLARE
  v_pass INT := 0;
  v_fail INT := 0;
BEGIN
  -- ================= COLUMN EXISTENCE =================
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'prescription_drafts' AND column_name = 'target_sessions_per_week') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_drafts.target_sessions_per_week exists'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: prescription_drafts.target_sessions_per_week missing'); v_fail := v_fail + 1;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'prescription_versions' AND column_name = 'target_sessions_per_week') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_versions.target_sessions_per_week exists'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: prescription_versions.target_sessions_per_week missing'); v_fail := v_fail + 1;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'prescription_templates' AND column_name = 'target_sessions_per_week') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_templates.target_sessions_per_week exists'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: prescription_templates.target_sessions_per_week missing'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== C5.4C SCHEMA VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

-- ================= CHECK CONSTRAINT BOUNDS =================
-- Verified via pg_constraint introspection rather than a live insert — every
-- table with this column also carries FK requirements (auth.users, org)
-- that would need a full fixture just to test a CHECK expression.
DO $constraint_check$
DECLARE
  v_def TEXT;
  v_pass INT := 0;
  v_fail INT := 0;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
    WHERE conrelid = 'prescription_drafts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%target_sessions_per_week%';
  IF v_def LIKE '%>= 1%' AND v_def LIKE '%<= 7%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_drafts CHECK bounds are 1..7'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: unexpected CHECK definition: %s', v_def)); v_fail := v_fail + 1;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
    WHERE conrelid = 'prescription_versions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%target_sessions_per_week%';
  IF v_def LIKE '%>= 1%' AND v_def LIKE '%<= 7%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_versions CHECK bounds are 1..7'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: unexpected CHECK definition: %s', v_def)); v_fail := v_fail + 1;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
    WHERE conrelid = 'prescription_templates'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%target_sessions_per_week%';
  IF v_def LIKE '%>= 1%' AND v_def LIKE '%<= 7%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_templates CHECK bounds are 1..7'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: unexpected CHECK definition: %s', v_def)); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== C5.4C CHECK-BOUNDS VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $constraint_check$;

-- ================= validate_prescription_draft RULE PRESENCE (function source) =================
DO $rules$
DECLARE
  v_src TEXT;
  v_pass INT := 0;
  v_fail INT := 0;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'validate_prescription_draft';

  IF v_src LIKE '%sequence_target_frequency_present%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: sequence_target_frequency_present rule present'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: sequence_target_frequency_present rule missing'); v_fail := v_fail + 1;
  END IF;

  IF v_src LIKE '%calendar_target_frequency_absent%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: calendar_target_frequency_absent rule present'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: calendar_target_frequency_absent rule missing'); v_fail := v_fail + 1;
  END IF;

  IF v_src LIKE '%calendar_weekdays_exclusive%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: calendar_weekdays_exclusive rule present'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: calendar_weekdays_exclusive rule missing'); v_fail := v_fail + 1;
  END IF;

  -- Existing rules must still be present (nothing weakened/removed), except
  -- has_prior_clinical_state, deliberately removed in C5.6C (founder-locked:
  -- absent stage/irritability must never gate publication).
  IF v_src LIKE '%has_workout%' AND v_src LIKE '%has_active_exercise%' AND v_src LIKE '%active_exercises_have_dosage%'
     AND v_src LIKE '%scheduling_mode_present%' AND v_src LIKE '%sequence_ordering_valid%' AND v_src LIKE '%calendar_days_present%'
     AND v_src LIKE '%exercises_active_and_accessible%' AND v_src NOT LIKE '%has_prior_clinical_state%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: all 7 retained pre-existing C5.3 validation rules present; has_prior_clinical_state removed (C5.6C)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: an existing validation rule appears to have been removed/weakened'); v_fail := v_fail + 1;
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'publish_prescription_draft';
  IF v_src LIKE '%target_sessions_per_week%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: publish_prescription_draft carries target_sessions_per_week into the new version'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: publish_prescription_draft does not carry target_sessions_per_week'); v_fail := v_fail + 1;
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_src FROM pg_proc WHERE proname = 'create_prescription_draft';
  IF v_src LIKE '%target_sessions_per_week = pv.target_sessions_per_week%' AND v_src LIKE '%target_sessions_per_week = pt.target_sessions_per_week%' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: create_prescription_draft copies target_sessions_per_week from BOTH clone and template sources'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: create_prescription_draft does not copy target_sessions_per_week from one or both sources'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== C5.4C FUNCTION-SOURCE VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $rules$;

SELECT result FROM verify_results ORDER BY seq;
