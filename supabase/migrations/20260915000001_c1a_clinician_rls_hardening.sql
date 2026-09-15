-- =============================================================================
-- C1A — Clinician Foundation: RLS hardening (founder-locked Decision 2).
--
-- Two changes, both additive (DROP+CREATE the same policy names — RLS
-- policies cannot be altered incrementally in Postgres):
--
-- 1. Every clinician-read policy on a clinical table that already goes
--    through `supervisor_patients` now ALSO requires `sp.status = 'active'`.
--    A dismissed supervisory relationship previously still granted full
--    read access forever (the dismissal fields exist on the table but
--    nothing checked them) — this closes that gap identically across every
--    affected table. No table's identity/join logic changes, only this one
--    added clause.
--
--    Scope: exactly the M3-M6 tables identified in the C1 Foundation audit,
--    plus session_events (same vintage/pattern as set_outcomes and
--    escalation_evaluations — a live M3 table sharing the identical
--    rehab_sessions-joined clinician-read shape, simply not spelled out by
--    name in the prior audit's table list). Older Stage-1-era tables that
--    share this same base pattern (onboarding_assessments, rehab_plans,
--    sessions, daily_logs, progression_decisions, visa_a_responses) are
--    deliberately NOT touched here — they were not part of the audited
--    M3-M6 table set and are believed superseded/dead (per this session's
--    own prior findings); tightening them is out of scope for this pass
--    and can be revisited separately if they turn out to still be live.
--
-- 2. `profiles` and `organization_members`'s clinician-read policies, which
--    previously granted access merely from shared organization membership
--    (no supervisor_patients check at all), are replaced with
--    supervision-scoped equivalents:
--      - profiles: clinician read now requires an ACTIVE supervisor_patients
--        row naming that specific patient — identical shape to every
--        clinical table above. The prior org-wide grant is removed
--        entirely; there is no legitimate "clinician reads a colleague's
--        own clinical-intake profile" need to preserve here.
--      - organization_members: split into two narrower policies rather
--        than one blanket tightening, using ONLY the existing `role`
--        column (no new schema): a clinician retains org-wide visibility
--        of STAFF rows only (role IN ('clinician','clinician_admin',
--        'super_user')) — the legitimate staff-directory need — and gains
--        visibility of a 'member'/'tester' row (a patient) ONLY when an
--        active supervisor_patients relationship exists for that specific
--        user. This closes the "any clinician can enumerate the org's
--        patient membership rows, and therefore discover patient
--        existence, merely from being in the same org" gap without
--        removing legitimate staff-roster visibility.
--
-- Patients retain their own unmodified `own read` policies throughout —
-- nothing here changes what a patient can see of their own data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1a. Direct-on-user_id pattern
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "prescription_versions: clinician read assigned patient" ON prescription_versions;
CREATE POLICY "prescription_versions: clinician read assigned patient"
  ON prescription_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = prescription_versions.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "rehab_sessions: clinician read assigned patient" ON rehab_sessions;
CREATE POLICY "rehab_sessions: clinician read assigned patient"
  ON rehab_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = rehab_sessions.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "morning_responses: clinician read assigned patient" ON morning_responses;
CREATE POLICY "morning_responses: clinician read assigned patient"
  ON morning_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = morning_responses.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "session_load_observations: clinician read assigned patient" ON session_load_observations;
CREATE POLICY "session_load_observations: clinician read assigned patient"
  ON session_load_observations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = session_load_observations.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "acute_safety_episodes: clinician read assigned patient" ON acute_safety_episodes;
CREATE POLICY "acute_safety_episodes: clinician read assigned patient" ON acute_safety_episodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = acute_safety_episodes.user_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active')
);

DROP POLICY IF EXISTS "acute_safety_reassessments: clinician read assigned patient" ON acute_safety_reassessments;
CREATE POLICY "acute_safety_reassessments: clinician read assigned patient" ON acute_safety_reassessments FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = acute_safety_reassessments.user_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active')
);

DROP POLICY IF EXISTS "acute_safety_releases: clinician read assigned patient" ON acute_safety_releases;
CREATE POLICY "acute_safety_releases: clinician read assigned patient" ON acute_safety_releases FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = acute_safety_releases.user_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active')
);

DROP POLICY IF EXISTS "blocked_loading_opportunities: clinician read assigned patient" ON blocked_loading_opportunities;
CREATE POLICY "blocked_loading_opportunities: clinician read assigned patient" ON blocked_loading_opportunities FOR SELECT USING (
  EXISTS (SELECT 1 FROM supervisor_patients sp WHERE sp.patient_id = blocked_loading_opportunities.user_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active')
);

DROP POLICY IF EXISTS "m6_longitudinal_interpretations: clinician read assigned patient" ON m6_longitudinal_interpretations;
CREATE POLICY "m6_longitudinal_interpretations: clinician read assigned patient"
  ON m6_longitudinal_interpretations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = m6_longitudinal_interpretations.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- 1b. Joined-via-rehab_sessions pattern
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "set_outcomes: clinician read assigned patient" ON set_outcomes;
CREATE POLICY "set_outcomes: clinician read assigned patient"
  ON set_outcomes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = set_outcomes.rehab_session_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "session_events: clinician read assigned patient" ON session_events;
CREATE POLICY "session_events: clinician read assigned patient"
  ON session_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = session_events.rehab_session_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "escalation_evaluations: clinician read assigned patient" ON escalation_evaluations;
CREATE POLICY "escalation_evaluations: clinician read assigned patient"
  ON escalation_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = escalation_evaluations.rehab_session_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "tolerance_evaluations: clinician read assigned patient" ON tolerance_evaluations;
CREATE POLICY "tolerance_evaluations: clinician read assigned patient"
  ON tolerance_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rehab_sessions rs
      JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
      WHERE rs.id = tolerance_evaluations.rehab_session_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "cautious_return_contexts: clinician read assigned patient" ON cautious_return_contexts;
CREATE POLICY "cautious_return_contexts: clinician read assigned patient" ON cautious_return_contexts FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM rehab_sessions rs JOIN supervisor_patients sp ON sp.patient_id = rs.user_id
    WHERE rs.id = cautious_return_contexts.rehab_session_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
  )
);

-- ---------------------------------------------------------------------------
-- 1c. Joined-via-m6_longitudinal_interpretations pattern
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "m6_interpretation_reason_codes: clinician read assigned patient" ON m6_interpretation_reason_codes;
CREATE POLICY "m6_interpretation_reason_codes: clinician read assigned patient"
  ON m6_interpretation_reason_codes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_reason_codes.interpretation_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "m6_interpretation_rehab_sessions: clinician read assigned patient" ON m6_interpretation_rehab_sessions;
CREATE POLICY "m6_interpretation_rehab_sessions: clinician read assigned patient"
  ON m6_interpretation_rehab_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_rehab_sessions.interpretation_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "m6_interpretation_morning_responses: clinician read assigned patient" ON m6_interpretation_morning_responses;
CREATE POLICY "m6_interpretation_morning_responses: clinician read assigned patient"
  ON m6_interpretation_morning_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_morning_responses.interpretation_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "m6_interpretation_tolerance_evaluations: clinician read assigned patient" ON m6_interpretation_tolerance_evaluations;
CREATE POLICY "m6_interpretation_tolerance_evaluations: clinician read assigned patient"
  ON m6_interpretation_tolerance_evaluations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_tolerance_evaluations.interpretation_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "m6_interpretation_prescription_versions: clinician read assigned patient" ON m6_interpretation_prescription_versions;
CREATE POLICY "m6_interpretation_prescription_versions: clinician read assigned patient"
  ON m6_interpretation_prescription_versions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_prescription_versions.interpretation_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

DROP POLICY IF EXISTS "m6_interpretation_heuristics: clinician read assigned patient" ON m6_interpretation_heuristics;
CREATE POLICY "m6_interpretation_heuristics: clinician read assigned patient"
  ON m6_interpretation_heuristics FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM m6_longitudinal_interpretations mi
      JOIN supervisor_patients sp ON sp.patient_id = mi.user_id
      WHERE mi.id = m6_interpretation_heuristics.interpretation_id AND sp.supervisor_id = auth.uid() AND sp.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- 2a. profiles — org-wide grant replaced entirely with supervision-scoped
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "profiles: clinician read org members" ON profiles;
CREATE POLICY "profiles: clinician read assigned patient"
  ON profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = profiles.id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );

-- ---------------------------------------------------------------------------
-- 2b. organization_members — split into staff-directory + supervised-patient
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "org_members: clinicians read org roster" ON organization_members;

-- Legitimate staff-directory visibility: unchanged for non-patient roles.
-- 'member' (the patient role in this schema) is deliberately excluded —
-- this is the entire fix for the patient-discovery-via-org-roster gap.
-- 'tester' is conservatively treated like a patient here (excluded from
-- the staff set) since its actual purpose is ambiguous in this schema;
-- flagged in the C1A report for the founder to revisit if 'tester' should
-- be treated as staff instead.
CREATE POLICY "org_members: clinicians read org staff directory"
  ON organization_members FOR SELECT
  USING (
    is_org_clinician(organization_id)
    AND role IN ('clinician', 'clinician_admin', 'super_user')
  );

-- A specific patient's (or tester's) own membership row is visible to a
-- clinician only through an active supervisory relationship — never merely
-- from shared organization membership.
CREATE POLICY "org_members: clinician read assigned patient membership"
  ON organization_members FOR SELECT
  USING (
    role NOT IN ('clinician', 'clinician_admin', 'super_user')
    AND EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = organization_members.user_id
        AND sp.supervisor_id = auth.uid()
        AND sp.status = 'active'
    )
  );
