-- Add quality configuration to machines table
ALTER TABLE machines
ADD COLUMN IF NOT EXISTS streaming_quality VARCHAR(20) DEFAULT 'high' CHECK (streaming_quality IN ('budget', 'good', 'high', 'ultra'));

-- Create index for quality filtering
CREATE INDEX IF NOT EXISTS idx_machines_quality ON machines(streaming_quality);

-- Add quality notes table for tracking quality changes
CREATE TABLE IF NOT EXISTS quality_updates (
  id SERIAL PRIMARY KEY,
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  old_quality VARCHAR(20),
  new_quality VARCHAR(20) NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quality_updates_machine_id ON quality_updates(machine_id);
CREATE INDEX IF NOT EXISTS idx_quality_updates_user_id ON quality_updates(user_id);
