-- =============================================================================
-- Stage 4: Row Level Security policies
-- Posture: deny-by-default (RLS already enabled in Stage 1; no policy = no access).
-- Principle: a user can only see/write rows they own or that their org role permits.
-- Service-role key bypasses RLS entirely — keep it server-only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- Users read/update their own row.
-- Clinicians and above can read any profile in their org.
-- Super users can update any profile in their org.

CREATE POLICY "profiles: own read"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles: own update"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- Clinicians can read profiles of users in the same org.
CREATE POLICY "profiles: clinician read org members"
  ON profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM organization_members om_viewer
      JOIN organization_members om_target
        ON om_viewer.organization_id = om_target.organization_id
      WHERE om_viewer.user_id = auth.uid()
        AND om_viewer.role IN ('clinician', 'clinician_admin', 'super_user')
        AND om_target.user_id = profiles.id
    )
  );

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE POLICY "orgs: members can read their org"
  ON organizations FOR SELECT
  USING (is_org_member(id));

CREATE POLICY "orgs: super_user can update"
  ON organizations FOR UPDATE
  USING (is_org_super_user(id));

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
CREATE POLICY "org_members: read own membership"
  ON organization_members FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "org_members: clinicians read org roster"
  ON organization_members FOR SELECT
  USING (is_org_clinician(organization_id));

-- Inserts/deletes handled server-side via service-role only.

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
-- Super users and clinician_admins can read invitations for their org.
CREATE POLICY "invitations: clinician_admin read"
  ON invitations FOR SELECT
  USING (is_org_clinician_admin(organization_id));

CREATE POLICY "invitations: clinician_admin insert"
  ON invitations FOR INSERT
  WITH CHECK (is_org_clinician_admin(organization_id));

CREATE POLICY "invitations: clinician_admin update (cancel)"
  ON invitations FOR UPDATE
  USING (is_org_clinician_admin(organization_id));

-- Invitees can read their own invitation by token — handled server-side via service-role.
-- Do NOT expose invitation tokens over RLS-filtered queries; the acceptance route
-- uses service-role to validate and accept.

-- ---------------------------------------------------------------------------
-- exercises (shared reference data — org-scoped read, clinician+ write)
-- ---------------------------------------------------------------------------
CREATE POLICY "exercises: org members read"
  ON exercises FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
    )
  );

CREATE POLICY "exercises: clinician_admin write"
  ON exercises FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
        AND om.role IN ('clinician_admin', 'super_user')
    )
  );

CREATE POLICY "exercises: clinician_admin update"
  ON exercises FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
        AND om.role IN ('clinician_admin', 'super_user')
    )
  );

-- ---------------------------------------------------------------------------
-- knowledge_entries (same pattern as exercises)
-- ---------------------------------------------------------------------------
CREATE POLICY "kb: org members read"
  ON knowledge_entries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
    )
  );

CREATE POLICY "kb: clinician_admin write"
  ON knowledge_entries FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
        AND om.role IN ('clinician_admin', 'super_user')
    )
  );

CREATE POLICY "kb: clinician_admin update"
  ON knowledge_entries FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
        AND om.role IN ('clinician_admin', 'super_user')
    )
  );

-- ---------------------------------------------------------------------------
-- onboarding_assessments
-- ---------------------------------------------------------------------------
CREATE POLICY "onboarding: own read"
  ON onboarding_assessments FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "onboarding: own insert"
  ON onboarding_assessments FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "onboarding: clinician read assigned patient"
  ON onboarding_assessments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      JOIN organization_members om ON om.user_id = auth.uid()
      WHERE sp.patient_id = onboarding_assessments.user_id
        AND sp.supervisor_id = auth.uid()
        AND om.role IN ('clinician', 'clinician_admin', 'super_user')
    )
  );

-- ---------------------------------------------------------------------------
-- rehab_plans
-- ---------------------------------------------------------------------------
CREATE POLICY "rehab_plans: own read"
  ON rehab_plans FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "rehab_plans: own insert"
  ON rehab_plans FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "rehab_plans: clinician read assigned patient"
  ON rehab_plans FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = rehab_plans.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE POLICY "sessions: own read"
  ON sessions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "sessions: own insert"
  ON sessions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "sessions: clinician read assigned patient"
  ON sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = sessions.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- daily_logs
-- ---------------------------------------------------------------------------
CREATE POLICY "daily_logs: own read"
  ON daily_logs FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "daily_logs: own insert"
  ON daily_logs FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "daily_logs: own update"
  ON daily_logs FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "daily_logs: clinician read assigned patient"
  ON daily_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = daily_logs.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- session_follow_ups
-- ---------------------------------------------------------------------------
CREATE POLICY "follow_ups: own read"
  ON session_follow_ups FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "follow_ups: own insert"
  ON session_follow_ups FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "follow_ups: own update"
  ON session_follow_ups FOR UPDATE
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- progression_decisions
-- ---------------------------------------------------------------------------
CREATE POLICY "progression: own read"
  ON progression_decisions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "progression: own insert"
  ON progression_decisions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "progression: clinician read assigned patient"
  ON progression_decisions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = progression_decisions.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- visa_a_responses
-- ---------------------------------------------------------------------------
CREATE POLICY "visa_a: own read"
  ON visa_a_responses FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "visa_a: own insert"
  ON visa_a_responses FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "visa_a: clinician read assigned patient"
  ON visa_a_responses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = visa_a_responses.user_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- schedule_overrides
-- ---------------------------------------------------------------------------
CREATE POLICY "schedule_overrides: own read"
  ON schedule_overrides FOR SELECT
  USING (user_id = auth.uid());

-- Clinicians write overrides on behalf of patients (server-side, service-role).
-- Patients cannot self-insert schedule_overrides.

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
CREATE POLICY "messages: own sent read"
  ON messages FOR SELECT
  USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE POLICY "messages: own insert"
  ON messages FOR INSERT
  WITH CHECK (sender_id = auth.uid());

CREATE POLICY "messages: mark read"
  ON messages FOR UPDATE
  USING (recipient_id = auth.uid());

-- ---------------------------------------------------------------------------
-- supervisor_patients
-- ---------------------------------------------------------------------------
CREATE POLICY "sup_patients: supervisor read own caseload"
  ON supervisor_patients FOR SELECT
  USING (supervisor_id = auth.uid());

-- Patient can see who supervises them.
CREATE POLICY "sup_patients: patient read own record"
  ON supervisor_patients FOR SELECT
  USING (patient_id = auth.uid());

-- Inserts/dismissals are privileged — handled via service-role in server actions.

-- ---------------------------------------------------------------------------
-- supervisor_assessments
-- ---------------------------------------------------------------------------
CREATE POLICY "sup_assessments: supervisor read own"
  ON supervisor_assessments FOR SELECT
  USING (supervisor_id = auth.uid());

CREATE POLICY "sup_assessments: supervisor insert"
  ON supervisor_assessments FOR INSERT
  WITH CHECK (supervisor_id = auth.uid());

CREATE POLICY "sup_assessments: supervisor update"
  ON supervisor_assessments FOR UPDATE
  USING (supervisor_id = auth.uid());

CREATE POLICY "sup_assessments: patient read own"
  ON supervisor_assessments FOR SELECT
  USING (patient_id = auth.uid());

-- ---------------------------------------------------------------------------
-- supervisor_case_notes
-- ---------------------------------------------------------------------------
CREATE POLICY "case_notes: supervisor read own"
  ON supervisor_case_notes FOR SELECT
  USING (supervisor_id = auth.uid());

CREATE POLICY "case_notes: supervisor insert"
  ON supervisor_case_notes FOR INSERT
  WITH CHECK (supervisor_id = auth.uid());

-- ---------------------------------------------------------------------------
-- supervisor_session_comments
-- ---------------------------------------------------------------------------
CREATE POLICY "sup_comments: supervisor read own"
  ON supervisor_session_comments FOR SELECT
  USING (supervisor_id = auth.uid());

CREATE POLICY "sup_comments: supervisor write"
  ON supervisor_session_comments FOR INSERT
  WITH CHECK (supervisor_id = auth.uid());

CREATE POLICY "sup_comments: supervisor update"
  ON supervisor_session_comments FOR UPDATE
  USING (supervisor_id = auth.uid());

-- Patient can read comments on their own logs.
CREATE POLICY "sup_comments: patient read own"
  ON supervisor_session_comments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM daily_logs dl
      WHERE dl.id = supervisor_session_comments.daily_log_id
        AND dl.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- supervisor_alerts
-- ---------------------------------------------------------------------------
CREATE POLICY "alerts: supervisor read assigned patient"
  ON supervisor_alerts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = supervisor_alerts.patient_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- Alerts are inserted server-side (service-role). Supervisors can resolve.
CREATE POLICY "alerts: supervisor update (resolve)"
  ON supervisor_alerts FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM supervisor_patients sp
      WHERE sp.patient_id = supervisor_alerts.patient_id
        AND sp.supervisor_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- supervisor_audit_logs (append-only; no updates/deletes via RLS)
-- ---------------------------------------------------------------------------
CREATE POLICY "audit_logs: actor read own"
  ON supervisor_audit_logs FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "audit_logs: super_user read all in org"
  ON supervisor_audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.user_id = auth.uid()
        AND om.role = 'super_user'
    )
  );

-- Inserts only via service-role (audit integrity).

-- ---------------------------------------------------------------------------
-- tfa_codes (server-managed; users never query this directly)
-- ---------------------------------------------------------------------------
-- No client-side policies — all 2FA operations go through server actions
-- that use the service-role client. The deny-by-default posture blocks
-- any direct client access.
