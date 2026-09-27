-- Create snapshots table for tracking game library snapshots across providers
CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  provider VARCHAR(50) NOT NULL,
  region VARCHAR(50) NOT NULL,
  snapshot_provider_id VARCHAR(255) NOT NULL,
  disk_size_gb INTEGER NOT NULL,
  description TEXT,
  snapshot_data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_snapshots_user_id ON snapshots(user_id);
CREATE INDEX idx_snapshots_machine_id ON snapshots(machine_id);
CREATE INDEX idx_snapshots_created_at ON snapshots(created_at DESC);

-- Add trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_snapshots_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER snapshots_timestamp_trigger
  BEFORE UPDATE ON snapshots
  FOR EACH ROW
  EXECUTE FUNCTION update_snapshots_timestamp();
