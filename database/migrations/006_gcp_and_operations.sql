-- ============================================================================
-- 006 — Google Cloud support + the "operations" activity log
-- ============================================================================
--
-- 1. machines.ip_address
--    The public IP of the machine, so the frontend can show where to connect.
--    On GCP the IP can CHANGE every time a machine is stopped and started
--    (it's an "ephemeral" address), so the backend re-reads it on each
--    start/sync and overwrites this column.
--
-- 2. cloud_operations + cloud_operation_events
--    Every action that talks to a cloud (launch, start, stop, delete, test
--    connection, sync...) is recorded as one OPERATION with a running list of
--    EVENTS ("Checking credentials...", "Trying zone asia-southeast1-b...",
--    "Out of GPUs there, trying the next zone..."). The frontend polls these
--    and shows them as a live console, so you can see exactly what is
--    happening without opening the Google Cloud console.
--
-- Written to be safe to run more than once (IF NOT EXISTS everywhere).
-- ============================================================================

ALTER TABLE machines ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64);

CREATE TABLE IF NOT EXISTS cloud_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which machine it's about (NULL for things like "test connection").
  -- ON DELETE SET NULL keeps the history of a machine you later delete.
  machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
  provider VARCHAR(20) NOT NULL,
  action VARCHAR(40) NOT NULL,           -- 'launch', 'start', 'stop', 'delete', 'test', 'sync'
  title TEXT NOT NULL,                   -- human summary, e.g. "Launch T4 machine in asia-southeast1"
  status VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed')),
  error JSONB,                           -- the plain-English error card, if it failed
  result JSONB,                          -- anything useful it produced (e.g. the new machine id)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_cloud_operations_user_created
  ON cloud_operations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_operations_machine
  ON cloud_operations(machine_id);

CREATE TABLE IF NOT EXISTS cloud_operation_events (
  id BIGSERIAL PRIMARY KEY,              -- ever-increasing, so the frontend can ask "events after #123"
  operation_id UUID NOT NULL REFERENCES cloud_operations(id) ON DELETE CASCADE,
  level VARCHAR(10) NOT NULL CHECK (level IN ('info', 'success', 'warn', 'error')),
  message TEXT NOT NULL,
  detail TEXT,                           -- optional extra (raw error text, ids...)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cloud_operation_events_op
  ON cloud_operation_events(operation_id, id);

-- Game profiles that work on our machines (Ubuntu + Steam/Proton), so the
-- launch form has sensible choices. ON CONFLICT (title) keeps existing rows.
INSERT INTO game_profiles (title, gpu_class, target_quality, gpu_vram_gb, cpu_vram_gb, fps_cpu_bound)
VALUES
  ('Steam (any game)', 't4', '1080p-60', 4, 8, false),
  ('Cyberpunk 2077', 'l4', '1440p-60', 16, 16, false),
  ('Counter-Strike 2', 't4', '1080p-144', 4, 8, true)
ON CONFLICT (title) DO NOTHING;

-- Valorant's anti-cheat (Riot Vanguard) refuses to run on Linux AND inside
-- virtual machines, so it can never work on a cloud gaming machine like
-- ours. Remove it rather than let people launch a machine for it.
DELETE FROM game_profiles WHERE title = 'Valorant';

-- ----------------------------------------------------------------------------
-- 3. Encrypted, per-user cloud credentials
-- ----------------------------------------------------------------------------
-- Each user adds their OWN cloud keys on the Config page. The backend
-- encrypts them (AES-256-GCM, see src/services/CredentialService.ts) before
-- they reach this table, so `encrypted_data` is unreadable without the
-- server's CREDENTIALS_ENCRYPTION_KEY. Secrets are never sent back to the
-- browser — only the harmless `metadata` summary below is.
--
-- Old rows written before encryption existed (plain JSON) can't be trusted
-- and are removed; users simply add their keys again.
DELETE FROM cloud_credentials WHERE encrypted_data NOT LIKE 'v1:%';

ALTER TABLE cloud_credentials ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
  -- non-secret summary shown in the UI, e.g. { projectId, clientEmail }
ALTER TABLE cloud_credentials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE cloud_credentials ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE cloud_credentials ADD COLUMN IF NOT EXISTS last_check_ok BOOLEAN;
ALTER TABLE cloud_credentials ADD COLUMN IF NOT EXISTS last_check_summary TEXT;

-- ----------------------------------------------------------------------------
-- 4. The streaming server's admin login, per machine (encrypted)
-- ----------------------------------------------------------------------------
-- Each machine gets a random Sunshine web-admin username/password at launch
-- (used once, to pair the Moonlight app). Stored encrypted the same way as
-- cloud keys, and shown only to the machine's owner.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS connection_secret TEXT;
-- Free-form status now includes 'creating', 'starting', 'stopping',
-- 'deleting' and 'failed' as well as 'running' / 'stopped'.
ALTER TABLE machines ALTER COLUMN status TYPE VARCHAR(20);
ALTER TABLE machines ADD COLUMN IF NOT EXISTS game_title VARCHAR(255);
ALTER TABLE machines ADD COLUMN IF NOT EXISTS spot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS disk_size_gb INTEGER;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_error JSONB;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP WITH TIME ZONE;
