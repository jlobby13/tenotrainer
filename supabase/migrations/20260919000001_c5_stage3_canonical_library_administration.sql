-- =============================================================================
-- C5, Stage 3D — Canonical Library Administration Foundation (founder-
-- approved). Global-tier exercise administration ONLY — private/org-shared
-- clinician-management authorization is explicitly out of scope and
-- untouched here.
--
-- Grant/RLS layering note: canonical_exercises and exercise_reference_dosage
-- currently have INSERT/UPDATE/DELETE REVOKEd from `authenticated`
-- (20260916000001) — a table-level GRANT is a prerequisite for RLS to have
-- any effect at all (RLS only restricts within an already-granted
-- privilege, it cannot itself grant one). This migration re-GRANTs exactly
-- the verbs each table needs for the C5.3D lifecycle (canonical_exercises:
-- INSERT/UPDATE only, explicitly NOT DELETE; exercise_reference_dosage:
-- INSERT/UPDATE/DELETE, since founder-approved lifecycle deletes only the
-- optional reference-dosage row, never the exercise itself) and relies
-- entirely on RLS USING/WITH CHECK predicates to restrict who can actually
-- exercise that grant and what shape the resulting row must have.
--
-- Provenance architecture: direct authenticated RLS writes (no RPC/server
-- boundary) are used deliberately, matching the existing
-- clinician_admin/super_user precedent in
-- 20260911000006_m6_stage3a_heuristics_evidence_catalog.sql. WITH CHECK
-- enforces created_by/updated_by = auth.uid() literally — a client cannot
-- spoof another actor's id (the write is rejected, not silently
-- corrected), and cannot omit it either (WITH CHECK requires equality with
-- auth.uid(), so NULL never satisfies it for an authenticated insert). An
-- RPC/server boundary would add no additional safety here since Postgres
-- itself verifies auth.uid() from the caller's validated JWT, independent
-- of anything in the request body — see the C5.3D report for the full
-- comparison against the alternative.
-- =============================================================================

ALTER TABLE canonical_exercises
  ADD COLUMN created_by UUID NULL REFERENCES auth.users(id);

COMMENT ON COLUMN canonical_exercises.created_by IS
  'NULL = system/bootstrap/legacy-migration origin (the 47-exercise seed always inserts via service-role with this NULL — never fabricated). Non-NULL = the authenticated super_user who created this row, enforced equal to auth.uid() by RLS WITH CHECK, never client-trusted.';

CREATE OR REPLACE FUNCTION is_platform_super_user()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.user_id = auth.uid() AND om.role = 'super_user'
  );
$$;
REVOKE ALL ON FUNCTION is_platform_super_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_platform_super_user() TO authenticated;

-- -----------------------------------------------------------------------------
-- canonical_exercises: global-tier super_user write access.
-- -----------------------------------------------------------------------------
GRANT INSERT, UPDATE ON canonical_exercises TO authenticated;

CREATE POLICY "canonical_exercises: super_user create global" ON canonical_exercises FOR INSERT
  WITH CHECK (
    is_platform_super_user()
    AND visibility = 'global'
    AND owner_clinician_id IS NULL
    AND organization_id IS NULL
    AND created_by = auth.uid()
  );

-- USING restricts which EXISTING rows a super_user may target (must already
-- be global — this policy grants no access to private/org_shared rows at
-- all). WITH CHECK restricts what the row may become AFTER the update —
-- still global-shaped, so this permission can never be used to smuggle a
-- global exercise into private/org_shared ownership, and updated_by is
-- pinned to the caller, never client-spoofable.
CREATE POLICY "canonical_exercises: super_user update global" ON canonical_exercises FOR UPDATE
  USING (is_platform_super_user() AND visibility = 'global')
  WITH CHECK (
    is_platform_super_user()
    AND visibility = 'global'
    AND owner_clinician_id IS NULL
    AND organization_id IS NULL
    AND updated_by = auth.uid()
  );

-- DELETE remains deliberately unavailable: no policy is added, and DELETE
-- is NOT re-granted to authenticated above (still revoked from
-- 20260916000001). Archive (active=false) / reactivate (active=true) is
-- the supported lifecycle for global exercises in C5.3D — covered by the
-- UPDATE policy above (active is an ordinary column, no separate policy
-- needed). Existing FK protections (prescription_exercises/
-- template_exercises reference canonical_exercises with NO ACTION,
-- confirmed in the C5.3C audit) are completely unchanged by this migration.

-- -----------------------------------------------------------------------------
-- exercise_reference_dosage: super_user write access, resolved through the
-- parent exercise's visibility. This is authorization to manage the
-- OPTIONAL reference-dosage row only — never the canonical exercise itself.
-- -----------------------------------------------------------------------------
GRANT INSERT, UPDATE, DELETE ON exercise_reference_dosage TO authenticated;

CREATE POLICY "exercise_reference_dosage: super_user write for global exercise" ON exercise_reference_dosage FOR INSERT
  WITH CHECK (
    is_platform_super_user()
    AND EXISTS (SELECT 1 FROM canonical_exercises ce WHERE ce.id = exercise_reference_dosage.exercise_id AND ce.visibility = 'global')
  );

CREATE POLICY "exercise_reference_dosage: super_user update for global exercise" ON exercise_reference_dosage FOR UPDATE
  USING (
    is_platform_super_user()
    AND EXISTS (SELECT 1 FROM canonical_exercises ce WHERE ce.id = exercise_reference_dosage.exercise_id AND ce.visibility = 'global')
  )
  WITH CHECK (
    is_platform_super_user()
    AND EXISTS (SELECT 1 FROM canonical_exercises ce WHERE ce.id = exercise_reference_dosage.exercise_id AND ce.visibility = 'global')
  );

-- Deletes only this reference-dosage row (an exercise's optional reference
-- values) — never the canonical_exercises row itself, which has no DELETE
-- grant/policy at all per the section above.
CREATE POLICY "exercise_reference_dosage: super_user delete for global exercise" ON exercise_reference_dosage FOR DELETE
  USING (
    is_platform_super_user()
    AND EXISTS (SELECT 1 FROM canonical_exercises ce WHERE ce.id = exercise_reference_dosage.exercise_id AND ce.visibility = 'global')
  );
