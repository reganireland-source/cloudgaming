-- ============================================================================
-- 012 — Remember the on-machine setup's last known progress
-- ============================================================================
-- Progress is read live from the machine's serial console. When that read
-- fails (the machine was stopped, a spot machine was reclaimed, the cloud's
-- API hiccuped) the app used to fall back to 0%. Keeping the last stages we
-- saw lets it show "last seen 65%, 4 min ago" and offer a way to resume.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS setup_progress JSONB;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS setup_progress_at TIMESTAMPTZ;
