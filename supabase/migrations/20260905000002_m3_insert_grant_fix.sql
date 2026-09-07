-- Fix a gap in 20260905000001: column-level UPDATE was restricted on
-- rehab_sessions so `authenticated` cannot set current_escalation_level via
-- UPDATE, but the blanket table-level INSERT grant meant a patient could
-- still supply that value (or status, or any response field) at row-creation
-- time. INSERT is now restricted to exactly the columns a session-creation
-- request needs; every derived/response field is reachable only via the
-- already-restricted UPDATE grant (or, for current_escalation_level, not at
-- all from `authenticated`).

REVOKE INSERT ON rehab_sessions FROM authenticated;
GRANT INSERT (
  id, user_id, plan_id, prescription_instance_id, patient_local_date,
  started_at, prescription_snapshot
) ON rehab_sessions TO authenticated;
