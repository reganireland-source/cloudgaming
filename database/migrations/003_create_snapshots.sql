-- Snapshots table for tracking game library snapshots across providers.
-- The base table now lives in src/db/schema.sql (created before `machines`,
-- since machines.snapshot_id references it). This migration only adds the
-- columns/indexes schema.sql might not yet have, so it's safe to run
-- against either a fresh DB (everything already present, all no-ops) or an
-- older DB created before snapshots picked up description/snapshot_data.
CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  provider VARCHAR(50) NOT NULL,
  region VARCHAR(50) NOT NULL,
  snapshot_provider_id VARCHAR(255) NOT NULL,
  disk_size_gb INTEGER NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS snapshot_data JSONB DEFAULT '{}';
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_snapshots_user_id ON snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_machine_id ON snapshots(machine_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at DESC);

-- Auto-update updated_at on write
CREATE OR REPLACE FUNCTION update_snapshots_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS snapshots_timestamp_trigger ON snapshots;
CREATE TRIGGER snapshots_timestamp_trigger
  BEFORE UPDATE ON snapshots
  FOR EACH ROW
  EXECUTE FUNCTION update_snapshots_timestamp();
