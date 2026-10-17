-- "Local machines": a PC you own (Windows + Sunshine) that GGGH controls
-- over your home network through a small agent on the PC. The agent
-- connects OUT to GGGH (nothing is opened on the PC's side); GGGH queues
-- commands and the agent picks them up. Only SHA-256 hashes of the tokens
-- are stored.
CREATE TABLE IF NOT EXISTS local_machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(40) NOT NULL,
  lan_ip VARCHAR(64),                 -- what the agent last reported (or typed by hand)
  mac_address VARCHAR(17),            -- for Wake-on-LAN, AA:BB:CC:DD:EE:FF
  agent_token_hash TEXT NOT NULL UNIQUE,
  launcher_token_hash TEXT NOT NULL UNIQUE, -- lookup for the generated Moonlight command's token (it may only match the screen)
  launcher_token_enc TEXT NOT NULL,         -- the same token, encrypted (as cloud keys are), so the app can put it in the command again
  script_enabled BOOLEAN NOT NULL DEFAULT FALSE, -- "run a script" is off until switched on
  status JSONB,                       -- the agent's last report
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS local_machines_user_idx ON local_machines (user_id);

-- Every command GGGH asked the agent to run, and what came back (an audit trail).
CREATE TABLE IF NOT EXISTS local_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES local_machines(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL,
  args JSONB NOT NULL DEFAULT '{}',
  source VARCHAR(16) NOT NULL DEFAULT 'app', -- app | launcher
  status VARCHAR(12) NOT NULL DEFAULT 'queued', -- queued | sent | done | failed | expired
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS local_commands_machine_idx ON local_commands (machine_id, created_at DESC);
