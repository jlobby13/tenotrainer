-- Fix invitation foreign keys so deleting a Supabase auth user doesn't get
-- blocked by the invitations table. invited_by and accepted_by are audit
-- columns — SET NULL on delete is safer than CASCADE (keeps the invitation record).

ALTER TABLE invitations
  DROP CONSTRAINT IF EXISTS invitations_invited_by_fkey,
  DROP CONSTRAINT IF EXISTS invitations_accepted_by_fkey;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_invited_by_fkey
    FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT invitations_accepted_by_fkey
    FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- invited_by is NOT NULL in the original schema; relax that so SET NULL can work.
ALTER TABLE invitations ALTER COLUMN invited_by DROP NOT NULL;
