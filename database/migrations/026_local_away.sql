-- Away access: reaching a local PC over the internet (port forwarding / UPnP).
-- wan_host: a name or address the user wants used instead of the one GGGH sees the agent connect from
-- away_ok: whether the last "test from the internet" saw Sunshine answer
ALTER TABLE local_machines ADD COLUMN IF NOT EXISTS wan_host VARCHAR(255);
ALTER TABLE local_machines ADD COLUMN IF NOT EXISTS away_ok BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE local_machines ADD COLUMN IF NOT EXISTS away_checked_at TIMESTAMPTZ;
