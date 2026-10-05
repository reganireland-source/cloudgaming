-- ============================================================================
-- 018 — Cost estimates accrue continuously (every 5 minutes), not hourly snapshots
-- ============================================================================
-- When each machine's estimate was last brought up to date. The accrual job
-- adds (now − cost_accrued_at) of compute, disk, public IP and streaming
-- traffic, so short sessions and starting/stopping time are counted too.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS cost_accrued_at TIMESTAMPTZ;
