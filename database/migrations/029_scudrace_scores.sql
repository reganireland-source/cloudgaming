-- Lap-time leaderboard for the Scud Race hobby game. No personal data: a
-- random install id, three-letter initials and the lap itself.
CREATE TABLE IF NOT EXISTS scudrace_scores (
  id BIGSERIAL PRIMARY KEY,
  install UUID NOT NULL,
  grp VARCHAR(32) NOT NULL,           -- the friends' group code
  initials CHAR(3) NOT NULL,
  mode VARCHAR(12) NOT NULL,          -- rebuilt | remaster | reimagined
  course VARCHAR(16) NOT NULL,        -- beginner_day | beginner_night | medium | expert
  car VARCHAR(10) NOT NULL,           -- ferrari | mclaren | porsche | viper
  transmission VARCHAR(8) NOT NULL,   -- auto | manual
  lap_ms INTEGER NOT NULL,
  total_ms INTEGER,
  build VARCHAR(32) NOT NULL,
  replay_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The same lap sent twice (a retry) is stored once.
CREATE UNIQUE INDEX IF NOT EXISTS scudrace_scores_dedupe_idx
  ON scudrace_scores (install, grp, mode, course, car, transmission, lap_ms, COALESCE(total_ms, -1));
CREATE INDEX IF NOT EXISTS scudrace_scores_board_idx ON scudrace_scores (grp, mode, course, lap_ms);
CREATE INDEX IF NOT EXISTS scudrace_scores_install_idx ON scudrace_scores (install, grp, mode, course, car, transmission, lap_ms);
