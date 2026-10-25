-- C5.4 Authoring Revision A — Dosage Model & Compatibility verification.
-- Read-only assertions for existing-data/capability checks + one
-- rolled-back transaction for constraint-shape and copy-path checks,
-- matching the established verifyC5Stage3DraftPublishEngine.sql /
-- verifyC5Stage4cWorkoutScheduling.sql convention.
--
-- Run from the repo root:
--   supabase db query --linked --file web/scripts/verifyC5Stage4RevisionADosageModel.sql

CREATE TEMP TABLE IF NOT EXISTS verify_results (seq SERIAL PRIMARY KEY, result TEXT);
TRUNCATE verify_results;

-- ================= READ-ONLY: EXISTING DATA / CAPABILITIES =================
DO $ro$
DECLARE
  v_pass INT := 0;
  v_fail INT := 0;
  v_count INT;
BEGIN
  -- ---- existing compatibility: every currently-live row of every type ----
  IF NOT EXISTS (SELECT 1 FROM prescription_exercise_dosage WHERE dosage_type NOT IN ('repetition','hold','contact','time','distance')) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: dosage_type unchanged/untouched, no unexpected values on prescription_exercise_dosage'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: unexpected dosage_type value present'); v_fail := v_fail + 1;
  END IF;

  SELECT count(*) INTO v_count FROM exercise_reference_dosage;
  IF v_count = 46 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: exercise_reference_dosage still has exactly 46 rows (ex_040 remains the only exercise without one)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: exercise_reference_dosage row count changed (%s, expected 46)', v_count)); v_fail := v_fail + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM canonical_exercises ce
    JOIN exercise_reference_dosage erd ON erd.exercise_id = ce.id
    WHERE ce.legacy_ex_id IN ('ex_001','ex_002','ex_003','ex_004') AND (erd.dosage_type != 'hold' OR erd.reps_mode IS NOT NULL)
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ex_001-004 reference dosage untouched (still hold-only, no reps added)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ex_001-004 reference dosage content was altered'); v_fail := v_fail + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM exercise_reference_dosage WHERE exercise_id = (SELECT id FROM canonical_exercises WHERE legacy_ex_id = 'ex_040')) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: ex_040 still has zero reference dosage rows'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ex_040 unexpectedly gained a reference dosage row'); v_fail := v_fail + 1;
  END IF;

  -- ---- capability metadata ----
  SELECT count(*) INTO v_count FROM canonical_exercises WHERE visibility = 'global';
  IF v_count = 47 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: 47 global canonical exercises present'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: expected 47 global exercises, found %s', v_count)); v_fail := v_fail + 1;
  END IF;

  -- NOTE (C5.4 Revision B focused correction, 20261001000001):
  -- dosage_capabilities was REPURPOSED to mean ALLOWED (a superset); the
  -- narrow/conservative-default checks below were always about the
  -- auto-shown DEFAULT set, so they now read default_dosage_capabilities
  -- instead — this preserves their original intent exactly, it does not
  -- weaken them. See that migration's header for the full rationale.
  IF NOT EXISTS (SELECT 1 FROM canonical_exercises WHERE visibility = 'global' AND (cardinality(dosage_capabilities) = 0 OR cardinality(default_dosage_capabilities) = 0)) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: all 47 canonical exercises have non-empty default AND allowed dosage capabilities'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: at least one canonical exercise has no capability metadata'); v_fail := v_fail + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM canonical_exercises, unnest(dosage_capabilities || default_dosage_capabilities) cap
    WHERE cap NOT IN ('reps','hold','contacts','distance','interval_time')
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: no invalid capability values present anywhere (default or allowed)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: an invalid capability value exists'); v_fail := v_fail + 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM canonical_exercises WHERE legacy_ex_id IN ('ex_001','ex_002','ex_003','ex_004')
    AND NOT (default_dosage_capabilities @> ARRAY['reps','hold'])
  ) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: motivating isometric calf exercises (ex_001-004) support BOTH reps and hold by default'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: ex_001-004 do not carry both reps and hold capabilities by default'); v_fail := v_fail + 1;
  END IF;

  SELECT count(*) INTO v_count FROM canonical_exercises WHERE 'distance' = ANY(default_dosage_capabilities);
  IF v_count = 1 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: distance capability narrowly assigned by DEFAULT (exactly 1 exercise)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: distance DEFAULT capability assigned to %s exercises, expected 1', v_count)); v_fail := v_fail + 1;
  END IF;

  SELECT count(*) INTO v_count FROM canonical_exercises WHERE 'contacts' = ANY(default_dosage_capabilities);
  IF v_count = 6 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: contacts capability narrowly assigned by DEFAULT (exactly 6 exercises)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: contacts DEFAULT capability assigned to %s exercises, expected 6', v_count)); v_fail := v_fail + 1;
  END IF;

  SELECT count(*) INTO v_count FROM canonical_exercises WHERE 'interval_time' = ANY(default_dosage_capabilities);
  IF v_count = 4 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: interval_time capability narrowly assigned by DEFAULT (exactly 4 exercises)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: interval_time DEFAULT capability assigned to %s exercises, expected 4', v_count)); v_fail := v_fail + 1;
  END IF;

  -- New (this correction): allowed superset is verified separately —
  -- distance's ALLOWED set legitimately grows to 3 (ex_034, ex_035, ex_036
  -- curated-widened), while contacts/interval_time's ALLOWED exercise
  -- COUNTS are unchanged (only reps was added alongside them, not new
  -- exercises gaining contacts/interval_time itself).
  SELECT count(*) INTO v_count FROM canonical_exercises WHERE 'distance' = ANY(dosage_capabilities);
  IF v_count = 3 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: distance ALLOWED set correctly widened to 3 exercises (ex_034/035/036)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: distance ALLOWED capability assigned to %s exercises, expected 3', v_count)); v_fail := v_fail + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM canonical_exercises WHERE NOT (default_dosage_capabilities <@ dosage_capabilities)) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: default is a subset of allowed for all 47 exercises (structural invariant)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: default ⊆ allowed invariant violated for at least one exercise'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('--- read-only section: %s PASS, %s FAIL ---', v_pass, v_fail));
END;
$ro$;

-- ================= TRANSACTIONAL: SHAPE / COMBINED / LOAD / COPY-PATH =================
BEGIN;

DO $verify$
DECLARE
  -- Real, pre-existing auth.users ids (same fixture ids used by
  -- verifyC5Stage3DraftPublishEngine.sql) purely to satisfy FK constraints —
  -- everything here is rolled back, no clinical meaning is attached to them.
  v_patient UUID;
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_ex UUID;
  v_pp_id UUID;
  v_draft_id UUID;
  v_workout_id UUID;
  v_pex_id UUID;
  v_version_id UUID;
  v_template_id UUID;
  v_tw_id UUID;
  v_te_id UUID;
  v_row RECORD;
  v_pass INT := 0;
  v_fail INT := 0;
BEGIN
  -- M2: throwaway in-transaction user(s) (rolled back). An assignment's patient
  -- must never be a staff account, and an assignment's clinician must hold a
  -- clinician role in its organization; the shared project has no spare real
  -- non-staff account to borrow.
  v_patient := gen_random_uuid();
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_patient, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'verify-' || v_patient || '@example.invalid', '', now(), now(), now(), '{}', '{}');
  -- M2: an assignment requires the clinician's clinician-role membership in its organization.
  INSERT INTO organization_members (organization_id, user_id, role) VALUES ('07f342fd-075c-42b5-a885-30ca64953d46', v_clinician, 'clinician') ON CONFLICT (organization_id, user_id) DO NOTHING;
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient, 'active');
  -- prior clinical state (stage/irritability/is_insertional carry-forward
  -- source), matching the legacy onboarding shape — required by publish's
  -- has_prior_clinical_state rule (unrelated to Revision A, unchanged).
  INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source) VALUES (v_patient, 2, 'moderate', false, 'onboarding');
  INSERT INTO canonical_exercises (name, visibility) VALUES ('Revision A verify exercise', 'global') RETURNING id INTO v_ex;
  INSERT INTO patient_prescriptions (patient_id) VALUES (v_patient) RETURNING id INTO v_pp_id;
  INSERT INTO prescription_drafts (patient_prescription_id, status, source, created_by, editing_clinician_id, updated_by, scheduling_mode, target_sessions_per_week)
    VALUES (v_pp_id, 'editing', 'empty', v_clinician, v_clinician, v_clinician, 'sequence', 3) RETURNING id INTO v_draft_id;
  INSERT INTO prescription_workouts (prescription_draft_id, order_index) VALUES (v_draft_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex, 0) RETURNING id INTO v_pex_id;

  -- ---- existing single-type shapes still valid (unchanged CHECK behavior) ----
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_pex_id, 'repetition', 3, 'exact', 10);
    INSERT INTO verify_results(result) VALUES ('PASS: old-shape repetition-only row still accepted'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: repetition-only row rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, hold_duration_mode, hold_duration_exact_seconds) VALUES (v_pex_id, 'hold', 5, 'exact', 45);
    INSERT INTO verify_results(result) VALUES ('PASS: old-shape hold-only row still accepted'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: hold-only row rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, contacts_mode, contacts_exact) VALUES (v_pex_id, 'contact', 3, 'exact', 20);
    INSERT INTO verify_results(result) VALUES ('PASS: old-shape contact-only row still accepted'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: contact-only row rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, time_duration_mode, time_duration_exact_seconds) VALUES (v_pex_id, 'time', 'exact', 1200);
    INSERT INTO verify_results(result) VALUES ('PASS: old-shape time-only row still accepted (no sets required)'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: time-only row rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, distance_mode, distance_exact_value, distance_unit) VALUES (v_pex_id, 'distance', 4, 'exact', 60, 'm');
    INSERT INTO verify_results(result) VALUES ('PASS: old-shape distance-only row still accepted'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: distance-only row rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  -- ---- combined dimensions: the actual point of Revision A ----
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, hold_duration_mode, hold_duration_exact_seconds)
      VALUES (v_pex_id, 'hold', 4, 'exact', 5, 'exact', 30);
    INSERT INTO verify_results(result) VALUES ('PASS: reps + hold combined in one row (4 sets x 5 reps x 30s hold) — the founder motivating example'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: reps+hold combination rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    UPDATE prescription_exercise_dosage SET load_type = 'external', load_mode = 'exact', load_value_exact = 25, load_unit = 'lb' WHERE prescription_exercise_id = v_pex_id;
    INSERT INTO verify_results(result) VALUES ('PASS: reps + hold + load combined (adding load to the existing combined row)'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: reps+hold+load combination rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    UPDATE prescription_exercise_dosage SET tempo_description = '2-1-2' WHERE prescription_exercise_id = v_pex_id;
    INSERT INTO verify_results(result) VALUES ('PASS: reps + tempo combined (tempo was already universal, confirmed still unaffected)'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: reps+tempo combination rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  SELECT * INTO v_row FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  IF v_row.reps_exact = 5 AND v_row.hold_duration_exact_seconds = 30 AND v_row.load_value_exact = 25 AND v_row.tempo_description = '2-1-2' AND v_row.dosage_type = 'hold' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: dosage_type (hold) does NOT suppress the independently-validated reps/load/tempo dimensions actually stored'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: combined row values did not persist as expected'); v_fail := v_fail + 1;
  END IF;
  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_min, reps_max, hold_duration_mode, hold_duration_min_seconds, hold_duration_max_seconds)
      VALUES (v_pex_id, 'hold', 3, 'range', 8, 10, 'range', 20, 30);
    INSERT INTO verify_results(result) VALUES ('PASS: reps range + hold range combined and independently valid'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: combined ranges rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  -- ---- malformed secondary dimension still rejected (structural correctness preserved) ----
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, hold_duration_mode, hold_duration_min_seconds)
      VALUES (v_pex_id, 'hold', 3, 'exact', 5, 'range', 30);
    INSERT INTO verify_results(result) VALUES ('FAIL: malformed hold range (min without max) was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: malformed secondary dimension (hold range missing max) correctly rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, reps_mode, reps_min, reps_max) VALUES (v_pex_id, 'repetition', 'range', 10, 5);
    INSERT INTO verify_results(result) VALUES ('FAIL: reps range with min > max was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: reps range min > max correctly rejected'); v_pass := v_pass + 1;
  END;

  -- ---- at-least-one-meaningful-dimension ----
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type) VALUES (v_pex_id, 'repetition');
    INSERT INTO verify_results(result) VALUES ('FAIL: completely empty dosage object (dosage_type only, nothing else) was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: meaningless dosage object (no dimension at all) correctly rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets) VALUES (v_pex_id, 'repetition', 3);
    INSERT INTO verify_results(result) VALUES ('PASS: sets alone satisfies at-least-one-dimension (matches founder-approved rule exactly)'); v_pass := v_pass + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: sets-only row unexpectedly rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  -- ---- load: exact preserved, range valid, malformed rejected, derived values ----
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_value_exact, load_unit)
    VALUES (v_pex_id, 'repetition', 3, 'exact', 8, 'external', 25, 'lb');
  SELECT * INTO v_row FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  IF v_row.load_value_exact = 25 AND v_row.load_mode IS NULL AND round(v_row.load_value_kg_derived, 4) = round(25 * 0.45359237, 4) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: exact load preserved verbatim, NULL load_mode treated as exact, derived kg unchanged/correct'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: exact load behavior changed'); v_fail := v_fail + 1;
  END IF;
  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_mode, load_value_min, load_value_max, load_unit)
      VALUES (v_pex_id, 'repetition', 3, 'exact', 8, 'external', 'range', 20, 30, 'lb');
    INSERT INTO verify_results(result) VALUES ('PASS: load range (20-30 lb) accepted'); v_pass := v_pass + 1;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: load range rejected: %s', SQLERRM)); v_fail := v_fail + 1;
  END;
  SELECT * INTO v_row FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  IF round(v_row.load_value_min_kg_derived, 4) = round(20 * 0.45359237, 4) AND round(v_row.load_value_max_kg_derived, 4) = round(30 * 0.45359237, 4) AND v_row.load_value_kg_derived IS NULL THEN
    INSERT INTO verify_results(result) VALUES ('PASS: derived min/max kg correct for lb, load_value_kg_derived correctly NULL for a range (never overloaded)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: derived load range values incorrect'); v_fail := v_fail + 1;
  END IF;
  UPDATE prescription_exercise_dosage SET load_unit = 'kg', load_value_min = 9, load_value_max = 13.6 WHERE prescription_exercise_id = v_pex_id;
  SELECT * INTO v_row FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  IF v_row.load_value_min_kg_derived = 9 AND v_row.load_value_max_kg_derived = 13.6 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: kg unit derived values pass through unchanged (identity)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: kg identity derivation incorrect'); v_fail := v_fail + 1;
  END IF;
  DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_mode, load_value_min, load_unit)
      VALUES (v_pex_id, 'repetition', 3, 'exact', 8, 'external', 'range', 20, 'lb');
    INSERT INTO verify_results(result) VALUES ('FAIL: load range missing max was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: load range missing max correctly rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_mode, load_value_min, load_value_max, load_unit)
      VALUES (v_pex_id, 'repetition', 3, 'exact', 8, 'external', 'range', 30, 20, 'lb');
    INSERT INTO verify_results(result) VALUES ('FAIL: load range min > max was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: load range min > max correctly rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, load_type, load_mode, load_value_min, load_value_max)
      VALUES (v_pex_id, 'repetition', 3, 'exact', 8, 'external', 'range', 20, 30);
    INSERT INTO verify_results(result) VALUES ('FAIL: load range without a unit was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: load range without a unit correctly rejected'); v_pass := v_pass + 1;
  END;

  -- ---- malformed distance / interval still rejected ----
  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, distance_mode, distance_exact_value) VALUES (v_pex_id, 'distance', 'exact', 60);
    INSERT INTO verify_results(result) VALUES ('FAIL: distance without a unit was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: malformed distance (no unit) correctly rejected'); v_pass := v_pass + 1;
  END;

  BEGIN
    INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, interval_work_seconds) VALUES (v_pex_id, 'time', 3, -5);
    INSERT INTO verify_results(result) VALUES ('FAIL: negative interval_work_seconds was ACCEPTED'); v_fail := v_fail + 1;
    DELETE FROM prescription_exercise_dosage WHERE prescription_exercise_id = v_pex_id;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES ('PASS: malformed interval (negative work seconds) correctly rejected'); v_pass := v_pass + 1;
  END;

  -- ---- copy paths: clone_active / template->draft / draft->publish preserve new fields ----
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact, hold_duration_mode, hold_duration_exact_seconds, load_type, load_mode, load_value_min, load_value_max, load_unit)
    VALUES (v_pex_id, 'hold', 4, 'exact', 5, 'exact', 30, 'external', 'range', 20, 30, 'lb');

  UPDATE prescription_drafts SET scheduling_mode = 'sequence', target_sessions_per_week = 3 WHERE id = v_draft_id;
  v_version_id := publish_prescription_draft(v_draft_id, v_clinician);

  SELECT ped.* INTO v_row FROM prescription_exercise_dosage ped
    JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    WHERE pw.prescription_version_id = v_version_id;
  IF v_row.reps_exact = 5 AND v_row.hold_duration_exact_seconds = 30 AND v_row.load_mode = 'range' AND v_row.load_value_min = 20 AND v_row.load_value_max = 30 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: draft -> publish preserves combined reps+hold+load-range dosage exactly (no silent field loss)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: publish copy path lost a Revision A field'); v_fail := v_fail + 1;
  END IF;

  -- clone_active: copy_prescription_version_content_into_draft
  v_draft_id := create_prescription_draft(v_patient, v_clinician, 'clone_active', v_version_id, NULL);
  SELECT ped.* INTO v_row FROM prescription_exercise_dosage ped
    JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    WHERE pw.prescription_draft_id = v_draft_id;
  IF v_row.reps_exact = 5 AND v_row.hold_duration_exact_seconds = 30 AND v_row.load_mode = 'range' AND v_row.load_value_min = 20 AND v_row.load_value_max = 30 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: clone_active (copy_prescription_version_content_into_draft) preserves combined dosage + load range'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: clone_active copy path lost a Revision A field'); v_fail := v_fail + 1;
  END IF;

  -- clone_historical uses the SAME copy_prescription_version_content_into_draft function as clone_active
  -- (verified directly in the implementation report from create_prescription_draft's source) — not re-tested
  -- separately here since it is structurally the identical code path.

  UPDATE prescription_drafts SET status = 'discarded' WHERE id = v_draft_id;

  -- template -> draft: copy_template_content_into_draft
  INSERT INTO prescription_templates (name, owner_clinician_id, visibility) VALUES ('Revision A verify template', v_clinician, 'private') RETURNING id INTO v_template_id;
  INSERT INTO template_workouts (template_id, order_index) VALUES (v_template_id, 0) RETURNING id INTO v_tw_id;
  INSERT INTO template_exercises (template_workout_id, canonical_exercise_id, order_index) VALUES (v_tw_id, v_ex, 0) RETURNING id INTO v_te_id;
  INSERT INTO template_exercise_dosage (template_exercise_id, dosage_type, sets, reps_mode, reps_exact, hold_duration_mode, hold_duration_exact_seconds, load_type, load_mode, load_value_min, load_value_max, load_unit)
    VALUES (v_te_id, 'hold', 4, 'exact', 5, 'exact', 30, 'external', 'range', 20, 30, 'lb');

  v_draft_id := create_prescription_draft(v_patient, v_clinician, 'from_template', NULL, v_template_id);
  SELECT ped.* INTO v_row FROM prescription_exercise_dosage ped
    JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
    JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
    WHERE pw.prescription_draft_id = v_draft_id;
  IF v_row.reps_exact = 5 AND v_row.hold_duration_exact_seconds = 30 AND v_row.load_mode = 'range' AND v_row.load_value_min = 20 AND v_row.load_value_max = 30 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: from_template (copy_template_content_into_draft) preserves combined dosage + load range'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: from_template copy path lost a Revision A field'); v_fail := v_fail + 1;
  END IF;

  INSERT INTO verify_results(result) VALUES (format('=== C5.4 REVISION A VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END;
$verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
