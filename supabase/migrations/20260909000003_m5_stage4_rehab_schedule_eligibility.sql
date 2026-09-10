-- =============================================================================
-- Milestone 5, Stage 4 — founder-review closure patch: rehab-day scheduling
-- eligibility primitive.
--
-- Stage 4 verification exposed a genuine architectural gap: the app has no
-- authoritative concept of whether prescribed rehab is actually scheduled
-- for a given patient-local calendar date. This conflicts with the
-- founder-locked principle "Schedule remains authoritative — response
-- interpretation does not manufacture a rehab day."
--
-- Pre-patch inspection findings (see the founder report for the full
-- writeup):
--   - prescription_versions (20260909000001) has NO cadence/frequency field
--     of any kind — only stage/irritability/is_insertional/source.
--   - The legacy FastAPI rehab_plans/onboarding_assessments tables have no
--     cadence field either.
--   - The legacy exercise_library.json's per-exercise dosage_defaults.
--     weekly_frequency varies WILDLY within a single session_plan (daily,
--     3x/week, twice daily, every other day, 2x/week, 2-3x daily, 1-2x
--     daily, observed across 47 exercises) — this is per-exercise dosing
--     guidance, not a coherent whole-plan schedule, and reconciling
--     conflicting per-exercise frequencies into one day-level verdict would
--     require inventing a rule with no founder approval.
--   - The only whole-plan "weekly schedule" concept (_compute_adaptive_schedule,
--     app/main.py) is a non-persisted, non-versioned, ADVISORY display
--     computed fresh on every legacy-dashboard page load from mutable
--     "current" state — it never gates session creation anywhere, and is
--     not reachable from the canonical Next.js /api/patient/summary bridge
--     at all. Not authoritative; not reused here.
--   - The only literal day-of-week schedule table (schedule_overrides, a
--     per-week patient self-override) belonged exclusively to the now-
--     RETIRED /daily-log route (which unconditionally redirects before any
--     of its own guard logic runs — see 20260908000001 and the M4 Stage 3
--     retirement note). Not revived; not reused.
--
-- Conclusion: there is currently NO founder-approved cadence for ANY
-- patient's prescription, including the founder's own active/test account.
-- Per explicit instruction, this migration does NOT choose one (no
-- "daily," no "3x/week"). It adds the versioned, immutable PRIMITIVE only —
-- every prescription_versions row (historical and newly-created) gets
-- rehab_days_of_week = NULL, which derives to 'unknown' eligibility
-- everywhere. 'unknown' is integrated to behave exactly like today's
-- pre-patch behavior (never blocks, never hides the CTA) — see
-- derive_rehab_day_eligibility() below and its TypeScript mirror
-- (web/lib/rehabSchedule.ts). This is a zero-behavior-change deployment
-- until a real, founder-approved cadence source populates this column.
-- =============================================================================

-- NULL (the default, and the value every existing row already has) means
-- "no explicit schedule identity" — honestly unknown, never coerced to a
-- guessed cadence. When populated by a future authoritative write path
-- (e.g. a clinician prescription editor — not built here), each element is
-- a day-of-week integer matching both JS Date.getDay() and Postgres
-- EXTRACT(DOW ...): 0=Sunday .. 6=Saturday. An empty array ('{}') is a
-- structurally distinct, legitimate "explicitly zero rehab days" value,
-- never conflated with NULL/unknown.
ALTER TABLE prescription_versions
  ADD COLUMN rehab_days_of_week SMALLINT[] NULL;

-- CHECK constraints cannot contain subqueries (Postgres rejects EXISTS/
-- unnest here with "cannot use subquery in check constraint"), so validity
-- is expressed via array containment instead: every element of
-- rehab_days_of_week must appear in {0..6}.
ALTER TABLE prescription_versions
  ADD CONSTRAINT prescription_versions_rehab_days_of_week_valid CHECK (
    rehab_days_of_week IS NULL
    OR rehab_days_of_week <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::SMALLINT[]
  );

COMMENT ON COLUMN prescription_versions.rehab_days_of_week IS
  'Versioned, immutable rehab-day schedule for this prescription version. '
  'NULL = unknown (no schedule identity on file — never treated as daily or '
  'any other guessed cadence). Elements are 0=Sunday..6=Saturday. Nothing '
  'currently writes a non-NULL value; this column exists so a future '
  'founder-approved authoritative source (e.g. a clinician prescription '
  'editor) can populate it without another migration.';

-- ---------------------------------------------------------------------------
-- derive_rehab_day_eligibility(rehab_days_of_week, patient_local_date):
-- the ONE canonical derivation of "is prescribed rehab scheduled on this
-- patient-local calendar date" — pure, deterministic, no DB access. Mirrors
-- web/lib/rehabSchedule.ts's deriveRehabDayEligibility() exactly (same
-- pattern as computeRecurrenceWindow's TS/SQL mirror pair) so the gate RPC
-- and the read-only dashboard/server helpers can never disagree.
--
-- Returns exactly one of: 'unknown' | 'scheduled' | 'not_scheduled'.
-- UNKNOWN is a first-class, never-collapsed result — it is NOT treated as
-- either "scheduled" or "not_scheduled" by this function; callers decide
-- how to behave for 'unknown' (today: identically to 'scheduled', i.e.
-- never blocking — see create_rehab_session_if_allowed below and the
-- dashboard integration).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION derive_rehab_day_eligibility(
  p_rehab_days_of_week SMALLINT[],
  p_patient_local_date DATE
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_dow SMALLINT;
BEGIN
  IF p_rehab_days_of_week IS NULL THEN
    RETURN 'unknown';
  END IF;

  v_dow := EXTRACT(DOW FROM p_patient_local_date)::SMALLINT; -- 0=Sunday..6=Saturday

  IF v_dow = ANY(p_rehab_days_of_week) THEN
    RETURN 'scheduled';
  END IF;

  RETURN 'not_scheduled';
END;
$$;

REVOKE EXECUTE ON FUNCTION derive_rehab_day_eligibility(SMALLINT[], DATE) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION derive_rehab_day_eligibility(SMALLINT[], DATE) FROM anon;
GRANT EXECUTE ON FUNCTION derive_rehab_day_eligibility(SMALLINT[], DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- create_rehab_session_if_allowed(): integrate the schedule-eligibility
-- primitive as the founder-specified FIRST substantive gate (Section 3 of
-- the closure-patch brief) — "Prescription schedule -> is there a loading
-- opportunity today? If NO: no prescribed session today. If YES: evaluate
-- higher-priority gates. Then: Acute safety -> Morning-response ->
-- Start prescribed rehab."
--
-- Ordering notes:
--   - Existing-session recovery (step 1) still wins first, unconditionally
--     — a patient resuming an already-legitimately-started session is never
--     blocked by a schedule check computed against "now."
--   - Prescription-version resolution is moved earlier (was step 4) because
--     the schedule check needs to read THIS version's rehab_days_of_week —
--     a patient with no prescription version at all still gets
--     PRESCRIPTION_VERSION_REQUIRED first (a more fundamental problem than
--     scheduling), matching prior behavior exactly for that case.
--   - Only 'not_scheduled' raises. 'unknown' (the value for every row
--     today, per this migration's header note) and 'scheduled' both fall
--     through unchanged — this is a zero-behavior-change deployment until
--     real schedule data exists.
--   - Acute safety and the M4 morning-response gate are UNCHANGED and
--     UNAFFECTED by this check: they are enforced by entirely separate
--     endpoints (the acute reassessment route, the morning-response
--     finalize route) that never call this function at all, so a required
--     safety reassessment or an outstanding morning check-in remains fully
--     actionable regardless of today's schedule eligibility, satisfying
--     the brief's explicit "separate whether a clinical follow-up is due
--     from whether loading is scheduled."
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_rehab_session_if_allowed(
  p_session_id UUID,
  p_plan_id TEXT,
  p_prescription_instance_id TEXT,
  p_patient_local_date DATE,
  p_started_at TIMESTAMPTZ,
  p_prescription_snapshot JSONB
)
RETURNS rehab_sessions
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_existing rehab_sessions;
  v_outstanding_session_id UUID;
  v_prescription_version_id UUID;
  v_rehab_days_of_week SMALLINT[];
  v_eligibility TEXT;
  v_new rehab_sessions;
  v_brake RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('create_rehab_session_if_allowed'), hashtext(v_user_id::text));

  -- 1. Existing legitimate session recovery wins first.
  SELECT * INTO v_existing
    FROM rehab_sessions
    WHERE (id = p_session_id OR prescription_instance_id = p_prescription_instance_id)
      AND user_id = v_user_id
    LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- 2. Resolve the patient's CURRENT prescription version (M5 Stage 1) —
  -- moved ahead of the acute/M4 gates (from its prior position as step 4)
  -- so its rehab_days_of_week is available for the schedule check below.
  SELECT id, rehab_days_of_week INTO v_prescription_version_id, v_rehab_days_of_week
    FROM prescription_versions
    WHERE user_id = v_user_id
    ORDER BY created_at DESC
    LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRESCRIPTION_VERSION_REQUIRED' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Prescription schedule eligibility (Stage 4 closure patch). Only an
  -- explicit 'not_scheduled' blocks — 'unknown' and 'scheduled' both
  -- proceed to the higher-priority safety/obligation gates below.
  v_eligibility := derive_rehab_day_eligibility(v_rehab_days_of_week, p_patient_local_date);
  IF v_eligibility = 'not_scheduled' THEN
    RAISE EXCEPTION 'REHAB_NOT_SCHEDULED_TODAY' USING ERRCODE = 'P0008';
  END IF;

  -- 4. Acute safety brake (read-only). Correct by construction: the caller
  -- (web/app/api/patient/rehab-session/route.ts) always calls
  -- reconcile_missing_acute_episodes() as a separate, already-committed
  -- transaction immediately before invoking this function.
  SELECT * INTO v_brake FROM get_patient_acute_brake_status(v_user_id);
  IF FOUND THEN
    IF v_brake.effective_level >= 4 THEN
      RAISE EXCEPTION 'ACUTE_SAFETY_PROFESSIONAL_REVIEW_REQUIRED' USING ERRCODE = 'P0005';
    ELSE
      RAISE EXCEPTION 'ACUTE_SAFETY_REVIEW_REQUIRED' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  -- 5. Unresolved PRIOR morning-response obligation blocks a genuinely NEW session.
  SELECT id INTO v_outstanding_session_id
    FROM rehab_sessions
    WHERE user_id = v_user_id
      AND status = 'awaiting_morning_response'
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'MORNING_RESPONSE_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 6. Create.
  INSERT INTO rehab_sessions (
    id, user_id, plan_id, prescription_instance_id, patient_local_date, started_at,
    prescription_snapshot, prescription_version_id
  ) VALUES (
    p_session_id, v_user_id, p_plan_id, p_prescription_instance_id, p_patient_local_date, p_started_at,
    p_prescription_snapshot, v_prescription_version_id
  )
  RETURNING * INTO v_new;

  -- 7. Guidance handoff capture (M5 Stage 3) — unchanged.
  PERFORM capture_session_guidance_context(v_new.id);

  -- 8. Cautious-return context capture — unchanged.
  PERFORM capture_cautious_return_context(v_new.id);

  RETURN v_new;
END;
$$;

GRANT EXECUTE ON FUNCTION create_rehab_session_if_allowed(UUID, TEXT, TEXT, DATE, TIMESTAMPTZ, JSONB) TO authenticated;
