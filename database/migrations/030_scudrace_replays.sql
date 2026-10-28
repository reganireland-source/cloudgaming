-- Replay (ghost) blobs for Scud Race laps: one small blob per score row, removed
-- with the row (the board keeps only each install's best laps). 'verified' is
-- for later checking of laps and is not set by anything yet.
ALTER TABLE scudrace_scores ADD COLUMN IF NOT EXISTS verified BOOLEAN;
CREATE TABLE IF NOT EXISTS scudrace_replays (
  score_id BIGINT PRIMARY KEY REFERENCES scudrace_scores(id) ON DELETE CASCADE,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
