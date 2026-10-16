-- SSH public keys for the developer tools' "dev" user (key-only login).
-- Written into every machine's /home/dev/.ssh/authorized_keys at launch and
-- at each boot. Public keys only; never private keys.
CREATE TABLE IF NOT EXISTS dev_ssh_keys (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  keys TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
