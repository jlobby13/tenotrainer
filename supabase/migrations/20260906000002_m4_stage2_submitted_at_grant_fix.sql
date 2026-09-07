-- Fix a gap in the M4 Stage 1 migration: the original UPDATE grant on
-- morning_responses included submitted_at as browser-writable, which
-- directly contradicts the trust boundary Stage 2 requires (the browser may
-- submit raw observations only; finalization/submitted_at is trusted
-- server-side state, set only via the service-role client in the finalize
-- route). Same class of self-caught gap as M3's insert_grant_fix.

REVOKE UPDATE ON morning_responses FROM authenticated;
GRANT UPDATE (
  next_morning_pain, next_morning_stiffness, patient_note, updated_at
) ON morning_responses TO authenticated;
