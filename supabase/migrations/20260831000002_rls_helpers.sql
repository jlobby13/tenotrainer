-- =============================================================================
-- Stage 3: RLS helper functions
-- All functions are SECURITY DEFINER so they run as the DB owner and can query
-- organization_members without triggering the member table's own RLS policies
-- during evaluation (avoiding recursion).
-- =============================================================================

-- Returns true if the authenticated user belongs to the given org.
CREATE OR REPLACE FUNCTION is_org_member(org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
  );
$$;

-- Returns true if the authenticated user has exactly the given role in the org.
CREATE OR REPLACE FUNCTION has_org_role(org_id UUID, check_role org_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
      AND role = check_role
  );
$$;

-- Returns true if the user is a super_user in the given org.
CREATE OR REPLACE FUNCTION is_org_super_user(org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
      AND role = 'super_user'
  );
$$;

-- Returns true if the user is clinician_admin or super_user in the given org.
CREATE OR REPLACE FUNCTION is_org_clinician_admin(org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
      AND role IN ('clinician_admin', 'super_user')
  );
$$;

-- Returns true if the user is clinician, clinician_admin, or super_user in the given org.
CREATE OR REPLACE FUNCTION is_org_clinician(org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = org_id
      AND user_id = auth.uid()
      AND role IN ('clinician', 'clinician_admin', 'super_user')
  );
$$;

-- Returns true if the authenticated user owns the given profile row.
-- Convenience alias — avoids repeating auth.uid() = user_id in every policy.
CREATE OR REPLACE FUNCTION is_own_profile(profile_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT auth.uid() = profile_user_id;
$$;

-- Returns the org_role of the current user in the given org, or NULL if not a member.
CREATE OR REPLACE FUNCTION get_org_role(org_id UUID)
RETURNS org_role LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM public.organization_members
  WHERE organization_id = org_id
    AND user_id = auth.uid()
  LIMIT 1;
$$;
