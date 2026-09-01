-- ---------------------------------------------------------------------------
-- Track email delivery status on invitations.
-- email_sent_at: NULL means email not yet sent or delivery failed.
-- ---------------------------------------------------------------------------

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
