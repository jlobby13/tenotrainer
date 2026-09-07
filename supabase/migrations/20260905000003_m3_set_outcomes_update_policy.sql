-- Fix a gap found during M3 live verification: set_outcomes had INSERT and
-- SELECT policies but no UPDATE policy. exercises-complete/route.ts submits
-- set_outcomes via .upsert(..., {onConflict: "rehab_session_id,exercise_id,set_index"}),
-- which is INSERT ... ON CONFLICT DO UPDATE — the UPDATE arm has no permissive
-- RLS policy to satisfy, so Postgres default-denies it. This broke every
-- resubmission of exercises-complete past the first one (in particular,
-- resuming the response flow after a page refresh, which always resubmits
-- exercises-complete as part of its idempotent bootstrap).

CREATE POLICY "set_outcomes: own update"
  ON set_outcomes FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM rehab_sessions rs WHERE rs.id = set_outcomes.rehab_session_id AND rs.user_id = auth.uid())
  );
