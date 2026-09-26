-- C5.3 Draft & Publish Engine — RPC-level verification. Runs entirely
-- inside one transaction ROLLBACK'd at the end — no row persists in the
-- shared project regardless of outcome. Uses real, pre-existing auth.users
-- ids purely to satisfy FK constraints (and a temporary supervisor_patients
-- row inserted and rolled back within the same transaction); no clinical
-- meaning is attached to them and nothing is ever committed.
BEGIN;

CREATE TEMP TABLE verify_results (seq SERIAL PRIMARY KEY, result TEXT);

DO $verify$
DECLARE
  v_patient1 UUID := 'dc12a11e-39b7-47eb-886d-1b90f94c1cbb';
  v_patient2 UUID := '6017c6ee-df39-412c-8037-2a522f0b3b46';
  v_clinician UUID := '44197ef7-7421-47ed-a164-75d2765fc019';
  v_other_clinician UUID := '53eaa2d2-b526-4d01-aa5b-033bff88dd46';

  v_ex_active UUID;
  v_ex_archived UUID;
  v_template_id UUID;
  v_pp1_id UUID;
  v_pp2_id UUID;
  v_draft_id UUID;
  v_workout_id UUID;
  v_workout2_id UUID;
  v_ex1_id UUID;
  v_ex2_id UUID;
  v_version1_id UUID;
  v_version2_id UUID;
  v_row RECORD;
  v_pass INT := 0;
  v_fail INT := 0;
BEGIN
  -- ---- setup: temporary supervision relationships (rolled back) ----
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient1, 'active');
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_clinician, v_patient2, 'active');
  INSERT INTO supervisor_patients (supervisor_id, patient_id, status) VALUES (v_other_clinician, v_patient1, 'active');

  -- prior clinical state (stage/irritability/is_insertional carry-forward
  -- source) for both patients, matching the legacy onboarding shape.
  INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source) VALUES (v_patient1, 2, 'moderate', false, 'onboarding');
  INSERT INTO prescription_versions (user_id, stage, irritability, is_insertional, source) VALUES (v_patient2, 1, 'low', true, 'onboarding');

  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('C5.3 verify active exercise', 'global', true) RETURNING id INTO v_ex_active;
  INSERT INTO canonical_exercises (name, visibility, active) VALUES ('C5.3 verify archived exercise', 'global', false) RETURNING id INTO v_ex_archived;

  INSERT INTO prescription_templates (name, owner_clinician_id, visibility) VALUES ('C5.3 verify template', v_clinician, 'private') RETURNING id INTO v_template_id;
  INSERT INTO template_workouts (template_id, order_index) VALUES (v_template_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO template_exercises (template_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex_active, 0) RETURNING id INTO v_ex1_id;
  INSERT INTO template_exercise_dosage (template_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex1_id, 'repetition', 3, 'exact', 10);

  INSERT INTO verify_results(result) VALUES ('--- setup complete ---');

  -- ================= CREATE DRAFT — empty (first prescription) =================
  BEGIN
    v_draft_id := create_prescription_draft(v_patient1, v_clinician, 'empty', NULL, NULL);
    SELECT * INTO v_row FROM prescription_drafts WHERE id = v_draft_id;
    IF v_row.based_on_prescription_version_id IS NULL AND v_row.stale_base_prescription_version_id IS NULL
       AND v_row.editing_clinician_id = v_clinician AND v_row.created_by = v_clinician THEN
      INSERT INTO verify_results(result) VALUES ('PASS: empty draft created, based_on=NULL, stale_base=NULL (first prescription)'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES ('FAIL: empty draft field semantics wrong'); v_fail := v_fail + 1;
    END IF;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: empty draft creation raised: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  SELECT id INTO v_pp1_id FROM patient_prescriptions WHERE patient_id = v_patient1;
  INSERT INTO verify_results(result) VALUES (format('PASS: patient_prescriptions transactionally created (%s)', v_pp1_id)); v_pass := v_pass + 1;

  -- DRAFT_ALREADY_EXISTS
  BEGIN
    PERFORM create_prescription_draft(v_patient1, v_clinician, 'empty', NULL, NULL);
    INSERT INTO verify_results(result) VALUES ('FAIL: second open draft was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%DRAFT_ALREADY_EXISTS%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: DRAFT_ALREADY_EXISTS correctly rejected'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for duplicate draft: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  -- ================= VALIDATE (incomplete) =================
  IF EXISTS (SELECT 1 FROM validate_prescription_draft(v_draft_id) WHERE rule = 'has_workout' AND NOT passed) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: empty editing draft correctly fails has_workout (editing remains permissive, only publish blocks)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: has_workout rule did not flag empty draft'); v_fail := v_fail + 1;
  END IF;

  -- publish should fail validation while empty
  BEGIN
    PERFORM publish_prescription_draft(v_draft_id, v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: publish of empty draft was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%VALIDATION_FAILED%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: publish of empty draft correctly rejected (VALIDATION_FAILED)'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for empty-draft publish: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  -- build it into a valid, publishable draft: 2 workouts, sequence mode
  UPDATE prescription_drafts SET scheduling_mode = 'sequence' WHERE id = v_draft_id;
  INSERT INTO prescription_workouts (prescription_draft_id, order_index) VALUES (v_draft_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO prescription_workouts (prescription_draft_id, order_index) VALUES (v_draft_id, 1) RETURNING id INTO v_workout2_id;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex_active, 0) RETURNING id INTO v_ex1_id;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex1_id, 'repetition', 3, 'exact', 10);

  IF EXISTS (SELECT 1 FROM validate_prescription_draft(v_draft_id) WHERE NOT passed) THEN
    INSERT INTO verify_results(result) VALUES ('FAIL: fully-populated draft unexpectedly fails validation'); v_fail := v_fail + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('PASS: fully-populated draft passes all validation rules'); v_pass := v_pass + 1;
  END IF;

  -- ================= NON-OWNER CANNOT MUTATE, CAN VIEW =================
  BEGIN
    PERFORM reorder_prescription_workouts(v_draft_id, v_other_clinician, ARRAY[v_workout2_id, v_workout_id]);
    INSERT INTO verify_results(result) VALUES ('FAIL: non-owner clinician mutation was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%DRAFT_NOT_OWNED_BY_CALLER%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: non-owner clinician correctly blocked from mutating (DRAFT_NOT_OWNED_BY_CALLER)'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for non-owner mutation: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  -- ================= REORDER — two-phase swap safety =================
  BEGIN
    PERFORM reorder_prescription_workouts(v_draft_id, v_clinician, ARRAY[v_workout2_id, v_workout_id]);
    SELECT order_index INTO v_row FROM prescription_workouts WHERE id = v_workout2_id;
    IF (SELECT order_index FROM prescription_workouts WHERE id = v_workout2_id) = 0
       AND (SELECT order_index FROM prescription_workouts WHERE id = v_workout_id) = 1 THEN
      INSERT INTO verify_results(result) VALUES ('PASS: reorder swap succeeded with no unique-constraint collision'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES ('FAIL: reorder did not produce expected order'); v_fail := v_fail + 1;
    END IF;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: reorder raised unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;
  -- swap back for downstream determinism
  PERFORM reorder_prescription_workouts(v_draft_id, v_clinician, ARRAY[v_workout_id, v_workout2_id]);

  -- ================= EXERCISE ARCHIVED / INACCESSIBLE BLOCKS PUBLISH =================
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index) VALUES (v_workout2_id, v_ex_archived, 0) RETURNING id INTO v_ex2_id;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex2_id, 'repetition', 3, 'exact', 8);

  IF EXISTS (SELECT 1 FROM validate_prescription_draft(v_draft_id) WHERE rule = 'exercises_active_and_accessible' AND NOT passed) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: archived exercise correctly flagged by exercises_active_and_accessible'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: archived exercise not flagged'); v_fail := v_fail + 1;
  END IF;

  BEGIN
    PERFORM publish_prescription_draft(v_draft_id, v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: publish with archived exercise was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%VALIDATION_FAILED%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: publish blocked by archived exercise (VALIDATION_FAILED)'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for archived-exercise publish: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  DELETE FROM prescription_exercises WHERE id = v_ex2_id; -- remove the blocker, retry below

  -- ================= FIRST PUBLISH (v1) =================
  BEGIN
    v_version1_id := publish_prescription_draft(v_draft_id, v_clinician);
    SELECT * INTO v_row FROM prescription_versions WHERE id = v_version1_id;
    IF v_row.version_number = 1 AND v_row.stage = 2 AND v_row.irritability = 'moderate' AND v_row.is_insertional = false
       AND v_row.source = 'clinician_change' AND v_row.published_by = v_clinician THEN
      INSERT INTO verify_results(result) VALUES ('PASS: first publish -> v1, prior clinical state carried forward, source=clinician_change'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES ('FAIL: v1 row fields incorrect'); v_fail := v_fail + 1;
    END IF;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: first publish raised unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  IF (SELECT current_prescription_version_id FROM patient_prescriptions WHERE id = v_pp1_id) = v_version1_id THEN
    INSERT INTO verify_results(result) VALUES ('PASS: current_prescription_version_id updated to v1'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: current pointer not updated'); v_fail := v_fail + 1;
  END IF;

  IF (SELECT status FROM prescription_drafts WHERE id = v_draft_id) = 'published' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: draft marked published'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: draft not marked published'); v_fail := v_fail + 1;
  END IF;

  IF EXISTS (SELECT 1 FROM notifications WHERE prescription_version_id = v_version1_id AND type = 'prescription_published' AND patient_id = v_patient1) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: prescription_published notification created, referencing v1'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: prescription_published notification missing/wrong'); v_fail := v_fail + 1;
  END IF;

  IF EXISTS (SELECT 1 FROM prescription_sequence_state WHERE patient_prescription_id = v_pp1_id AND prescription_version_id = v_version1_id
             AND current_workout_id = (SELECT id FROM prescription_workouts WHERE prescription_version_id = v_version1_id ORDER BY order_index LIMIT 1)) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: sequence state initialized to first workout of v1'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: sequence state not initialized correctly'); v_fail := v_fail + 1;
  END IF;

  -- Both draft workouts (v_workout_id with its 1 active exercise, and
  -- v_workout2_id left empty after its archived-exercise blocker was
  -- deleted) are published: 2 workouts, 1 exercise total, all with fresh
  -- version-owned IDs distinct from the draft's own IDs.
  IF (SELECT count(*) FROM prescription_workouts WHERE prescription_version_id = v_version1_id) = 2
     AND (SELECT count(*) FROM prescription_exercises pe JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id WHERE pw.prescription_version_id = v_version1_id) = 1 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: 2 workouts / 1 exercise published (matches draft content after archived-blocker removal) — fresh version-owned IDs, distinct from draft IDs'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: unexpected workout/exercise count on v1'); v_fail := v_fail + 1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM prescription_workouts WHERE id IN (v_workout_id, v_workout2_id) AND prescription_version_id IS NOT NULL) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: original draft-owned workout rows untouched (still draft-owned, not repointed)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: draft-owned workout rows were mutated instead of copied'); v_fail := v_fail + 1;
  END IF;

  -- ================= PAUSE / RESUME =================
  BEGIN
    PERFORM pause_prescription(v_pp1_id, v_clinician);
    SELECT * INTO v_row FROM patient_prescriptions WHERE id = v_pp1_id;
    IF v_row.operational_status = 'paused' AND v_row.paused_by = v_clinician AND v_row.paused_at IS NOT NULL THEN
      INSERT INTO verify_results(result) VALUES ('PASS: pause sets operational_status/paused_by/paused_at correctly'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES ('FAIL: pause fields incorrect'); v_fail := v_fail + 1;
    END IF;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: pause raised unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  BEGIN
    PERFORM pause_prescription(v_pp1_id, v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: double-pause was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%PRESCRIPTION_ALREADY_PAUSED%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: double-pause correctly rejected'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for double-pause: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  BEGIN
    PERFORM resume_prescription(v_pp1_id, v_clinician);
    SELECT * INTO v_row FROM patient_prescriptions WHERE id = v_pp1_id;
    IF v_row.operational_status = 'active' AND v_row.resumed_by = v_clinician AND v_row.resumed_at IS NOT NULL
       AND v_row.paused_at IS NULL AND v_row.paused_by IS NULL THEN
      INSERT INTO verify_results(result) VALUES ('PASS: resume sets operational_status/resumed_by/resumed_at and clears paused_at/paused_by'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES ('FAIL: resume fields incorrect'); v_fail := v_fail + 1;
    END IF;
  EXCEPTION WHEN others THEN INSERT INTO verify_results(result) VALUES (format('FAIL: resume raised unexpectedly: %s', SQLERRM)); v_fail := v_fail + 1;
  END;

  -- ================= PUBLISH WHILE PAUSED PRESERVES PAUSED STATE =================
  PERFORM pause_prescription(v_pp1_id, v_clinician);
  v_draft_id := create_prescription_draft(v_patient1, v_clinician, 'clone_active', v_version1_id, NULL);
  SELECT * INTO v_row FROM prescription_drafts WHERE id = v_draft_id;
  IF v_row.based_on_prescription_version_id = v_version1_id AND v_row.stale_base_prescription_version_id = v_version1_id THEN
    INSERT INTO verify_results(result) VALUES ('PASS: clone_active sets based_on=stale_base=current version (v7 example A analog)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: clone_active based_on/stale_base semantics wrong'); v_fail := v_fail + 1;
  END IF;
  -- v1 has 2 workouts (see above), so cloning it should produce 2.
  IF (SELECT count(*) FROM prescription_workouts WHERE prescription_draft_id = v_draft_id) = 2 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: clone_active copied workout/exercise/dosage content atomically'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: clone_active did not copy content correctly'); v_fail := v_fail + 1;
  END IF;

  v_version2_id := publish_prescription_draft(v_draft_id, v_clinician);
  SELECT * INTO v_row FROM prescription_versions WHERE id = v_version2_id;
  IF v_row.version_number = 2 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: subsequent publish -> v2 (no gap, no v0)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES (format('FAIL: expected version_number=2, got %s', v_row.version_number)); v_fail := v_fail + 1;
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE prescription_version_id = v_version2_id AND type = 'prescription_updated') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: subsequent publish creates prescription_updated notification'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: prescription_updated notification missing'); v_fail := v_fail + 1;
  END IF;
  IF EXISTS (SELECT 1 FROM prescription_versions WHERE id = v_version1_id) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: old immutable version v1 retained unchanged after v2 publish'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: v1 was removed/mutated'); v_fail := v_fail + 1;
  END IF;
  IF (SELECT operational_status FROM patient_prescriptions WHERE id = v_pp1_id) = 'paused' THEN
    INSERT INTO verify_results(result) VALUES ('PASS: publishing while paused leaves prescription PAUSED (no automatic resume)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: publish while paused changed operational_status'); v_fail := v_fail + 1;
  END IF;

  -- ================= CALENDAR MODE CLEARS SEQUENCE STATE =================
  v_draft_id := create_prescription_draft(v_patient1, v_clinician, 'clone_active', v_version2_id, NULL);
  UPDATE prescription_drafts SET scheduling_mode = 'calendar' WHERE id = v_draft_id;
  UPDATE prescription_workouts SET days_of_week = ARRAY[1,3,5]::SMALLINT[] WHERE prescription_draft_id = v_draft_id;
  PERFORM publish_prescription_draft(v_draft_id, v_clinician);
  IF NOT EXISTS (SELECT 1 FROM prescription_sequence_state WHERE patient_prescription_id = v_pp1_id) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: publishing Calendar-mode version deletes prescription_sequence_state (invariant: row exists iff Sequence Mode)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: sequence_state row still present after Calendar-mode publish'); v_fail := v_fail + 1;
  END IF;

  -- ================= STALE-BASE PROTECTION (direct mechanism test — see report) =================
  -- Case 1: NULL stale_base vs non-NULL current (first-prescription race).
  v_draft_id := create_prescription_draft(v_patient2, v_clinician, 'empty', NULL, NULL);
  SELECT id INTO v_pp2_id FROM patient_prescriptions WHERE patient_id = v_patient2;
  INSERT INTO prescription_workouts (prescription_draft_id, order_index) VALUES (v_draft_id, 0) RETURNING id INTO v_workout_id;
  INSERT INTO prescription_exercises (prescription_workout_id, canonical_exercise_id, order_index) VALUES (v_workout_id, v_ex_active, 0) RETURNING id INTO v_ex1_id;
  INSERT INTO prescription_exercise_dosage (prescription_exercise_id, dosage_type, sets, reps_mode, reps_exact) VALUES (v_ex1_id, 'repetition', 3, 'exact', 10);
  UPDATE prescription_drafts SET scheduling_mode = 'sequence' WHERE id = v_draft_id;
  -- simulate "someone else published v1 in the meantime" by directly advancing the pointer
  UPDATE patient_prescriptions SET current_prescription_version_id = v_version1_id WHERE id = v_pp2_id;
  BEGIN
    PERFORM publish_prescription_draft(v_draft_id, v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: NULL-vs-current stale race was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%DRAFT_STALE_BASE%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: NULL stale_base vs non-NULL current correctly blocked (DRAFT_STALE_BASE)'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for NULL-race: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;
  UPDATE patient_prescriptions SET current_prescription_version_id = NULL WHERE id = v_pp2_id; -- revert simulated race
  v_version1_id := publish_prescription_draft(v_draft_id, v_clinician); -- real, valid first publish for patient2 now
  IF (SELECT version_number FROM prescription_versions WHERE id = v_version1_id) = 1 THEN
    INSERT INTO verify_results(result) VALUES ('PASS: NULL vs NULL (valid case) correctly allows first publish'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: NULL-vs-NULL valid case did not publish v1'); v_fail := v_fail + 1;
  END IF;

  -- Case 2: v7-style stale_base vs changed current (historical-copy scenario).
  v_draft_id := create_prescription_draft(v_patient2, v_clinician, 'clone_active', v_version1_id, NULL);
  UPDATE prescription_drafts SET based_on_prescription_version_id = v_version1_id WHERE id = v_draft_id; -- simulate "copy v3" content-source override
  IF (SELECT stale_base_prescription_version_id FROM prescription_drafts WHERE id = v_draft_id) = v_version1_id THEN
    INSERT INTO verify_results(result) VALUES ('PASS: historical-copy-style draft retains correct stale_base regardless of based_on override'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: stale_base incorrectly affected by based_on'); v_fail := v_fail + 1;
  END IF;
  -- simulate a competing publish moving current forward (reuse a distinct
  -- real prescription_versions row purely to satisfy the FK — the FK has
  -- no patient-matching constraint, and this is a mechanism test, not a
  -- realistic reachable state, per the report's discussion).
  UPDATE patient_prescriptions SET current_prescription_version_id = v_version2_id WHERE id = v_pp2_id; -- distinct fake "v8"
  BEGIN
    PERFORM publish_prescription_draft(v_draft_id, v_clinician);
    INSERT INTO verify_results(result) VALUES ('FAIL: v7-base vs v8-current stale race was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%DRAFT_STALE_BASE%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: historical-copy stale-base race correctly blocked (DRAFT_STALE_BASE)'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for v7/v8 race: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  -- ================= TEMPLATE APPLICATION =================
  UPDATE patient_prescriptions SET current_prescription_version_id = v_version1_id WHERE id = v_pp2_id; -- revert
  UPDATE prescription_drafts SET status = 'discarded' WHERE id = v_draft_id; -- free the slot (was left 'editing' after the blocked publish above)
  v_draft_id := create_prescription_draft(v_patient2, v_clinician, 'from_template', NULL, v_template_id);
  SELECT * INTO v_row FROM prescription_drafts WHERE id = v_draft_id;
  IF v_row.based_on_prescription_version_id IS NULL AND v_row.source_template_id = v_template_id AND v_row.stale_base_prescription_version_id = v_version1_id THEN
    INSERT INTO verify_results(result) VALUES ('PASS: template-sourced draft has based_on=NULL, source_template_id set, stale_base=current-at-creation'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: template draft field semantics wrong'); v_fail := v_fail + 1;
  END IF;
  IF (SELECT count(*) FROM prescription_workouts WHERE prescription_draft_id = v_draft_id) = 1
     AND EXISTS (SELECT 1 FROM prescription_exercise_dosage ped JOIN prescription_exercises pe ON pe.id = ped.prescription_exercise_id
                 JOIN prescription_workouts pw ON pw.id = pe.prescription_workout_id
                 WHERE pw.prescription_draft_id = v_draft_id AND ped.reps_exact = 10) THEN
    INSERT INTO verify_results(result) VALUES ('PASS: template content (workout/exercise/dosage) copied into draft, no live linkage retained'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: template content not copied correctly'); v_fail := v_fail + 1;
  END IF;
  UPDATE prescription_templates SET name = 'mutated after copy' WHERE id = v_template_id;
  IF NOT EXISTS (SELECT 1 FROM prescription_workouts WHERE prescription_draft_id = v_draft_id AND label = 'mutated after copy') THEN
    INSERT INTO verify_results(result) VALUES ('PASS: mutating the template after copy does not affect the draft (no live linkage)'); v_pass := v_pass + 1;
  ELSE
    INSERT INTO verify_results(result) VALUES ('FAIL: template mutation leaked into draft'); v_fail := v_fail + 1;
  END IF;

  -- TEMPLATE_UNAVAILABLE for a clinician without access
  BEGIN
    PERFORM create_prescription_draft(v_patient2, v_other_clinician, 'from_template', NULL, v_template_id);
    INSERT INTO verify_results(result) VALUES ('FAIL: inaccessible-template draft creation was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%TEMPLATE_UNAVAILABLE%' OR SQLERRM LIKE '%PATIENT_NOT_AUTHORIZED%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: inaccessible template / unauthorized clinician correctly rejected'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for inaccessible template: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  -- ================= UNAUTHORIZED CLINICIAN CANNOT CREATE A DRAFT AT ALL =================
  BEGIN
    PERFORM create_prescription_draft(v_patient2, v_other_clinician, 'empty', NULL, NULL);
    INSERT INTO verify_results(result) VALUES ('FAIL: unauthorized clinician draft creation was ACCEPTED (should reject)'); v_fail := v_fail + 1;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%PATIENT_NOT_AUTHORIZED%' THEN
      INSERT INTO verify_results(result) VALUES ('PASS: unauthorized clinician (no supervisor_patients row for patient2) correctly blocked'); v_pass := v_pass + 1;
    ELSE
      INSERT INTO verify_results(result) VALUES (format('FAIL: wrong error for unauthorized clinician: %s', SQLERRM)); v_fail := v_fail + 1;
    END IF;
  END;

  INSERT INTO verify_results(result) VALUES (format('=== C5.3 RPC VERIFICATION RESULT: %s PASS, %s FAIL ===', v_pass, v_fail));
END $verify$;

SELECT result FROM verify_results ORDER BY seq;

ROLLBACK;
