-- SSH to a local PC through GGGH (no router changes): off until switched on per PC.
ALTER TABLE local_machines ADD COLUMN IF NOT EXISTS ssh_enabled BOOLEAN NOT NULL DEFAULT FALSE;
