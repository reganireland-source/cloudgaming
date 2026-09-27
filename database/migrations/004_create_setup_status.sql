-- Create setup_status table for tracking CloudyPad setup progress
CREATE TABLE IF NOT EXISTS setup_status (
  id SERIAL PRIMARY KEY,
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  stage VARCHAR(50) NOT NULL DEFAULT 'initializing',
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  message TEXT NOT NULL,
  sunshine_pin VARCHAR(6),
  sunshine_url VARCHAR(255),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_setup_status_machine_id ON setup_status(machine_id);
CREATE INDEX IF NOT EXISTS idx_setup_status_updated_at ON setup_status(updated_at DESC);

-- Add trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_setup_status_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS setup_status_timestamp_trigger ON setup_status;
CREATE TRIGGER setup_status_timestamp_trigger
  BEFORE UPDATE ON setup_status
  FOR EACH ROW
  EXECUTE FUNCTION update_setup_status_timestamp();
