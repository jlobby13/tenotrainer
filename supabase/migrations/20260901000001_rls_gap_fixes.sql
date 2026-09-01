-- =============================================================================
-- RLS gap fixes identified in audit (2026-09-01)
--
-- Gaps fixed:
--   1. session_follow_ups — clinicians could read daily_logs for their patients
--      but not the follow-up tasks attached to those logs.
--   2. schedule_overrides — clinicians write overrides via service-role but had
--      no client-side read policy for their patients' schedules.
--
-- Not changed:
--   exercises / knowledge_entries — no organization_id column; these are shared
--   reference data. Scoping to org requires a schema change, tracked as tech debt.
-- =============================================================================

CREATE POLICY "follow_ups: clinician read assigned patient"
  ON session_follow_ups FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = session_follow_ups.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

CREATE POLICY "schedule_overrides: clinician read assigned patient"
  ON schedule_overrides FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = schedule_overrides.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );
