-- ============================================================================
-- 007 — Real user accounts: email + password, Google and Apple sign-in
-- ============================================================================
--
-- users.password_hash already exists (unused until now). It stores a scrypt
-- hash like "scrypt$16384$8$1$<salt>$<hash>" — never the password itself.
-- It stays NULL for people who only ever sign in with Google/Apple.
--
-- user_identities links a user to an outside sign-in provider. `subject` is
-- the provider's permanent, unique id for that person (Google's "sub",
-- Apple's "sub") — emails can change, so we match on this instead.
-- One user can have several identities (e.g. password + Google + Apple).
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;

-- Emails are compared case-insensitively ("Bob@x.com" = "bob@x.com").
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'apple')),
  subject VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
