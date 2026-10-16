-- One token per user for the Mac clipboard helper (cloud-clipboard): it
-- asks GET /api/agent/clipboard-target which machine is running and at
-- what IP. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS clipboard_tokens (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
