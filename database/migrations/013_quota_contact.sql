-- ============================================================================
-- 013 — Contact email for cloud quota requests (optional)
-- ============================================================================
-- Google's quota-increase command needs a contact email. The app fills it
-- into the ready-to-paste commands (Regions page, Config guides) so they run
-- as-is. NULL = use the account's sign-in email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_email VARCHAR(255);
