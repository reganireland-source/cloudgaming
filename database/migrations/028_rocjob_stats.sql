-- Anonymous stats for the Rocjob game. NO personal data: no IP, user agent,
-- hardware id, name or email is ever stored. An "install" is a random id the
-- game makes once; a "session" is a random id per launch.
CREATE TABLE IF NOT EXISTS rocjob_installs (
  install UUID PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform VARCHAR(8) NOT NULL,
  build INTEGER NOT NULL,
  version VARCHAR(16) NOT NULL
);
CREATE INDEX IF NOT EXISTS rocjob_installs_first_seen_idx ON rocjob_installs (first_seen);

CREATE TABLE IF NOT EXISTS rocjob_sessions (
  session VARCHAR(64) PRIMARY KEY,
  install UUID NOT NULL,
  started TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_event TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform VARCHAR(8) NOT NULL,
  build INTEGER NOT NULL,
  version VARCHAR(16) NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0   -- cumulative playtime; retries keep the MAX, never add
);
CREATE INDEX IF NOT EXISTS rocjob_sessions_install_idx ON rocjob_sessions (install);
CREATE INDEX IF NOT EXISTS rocjob_sessions_started_idx ON rocjob_sessions (started);
CREATE INDEX IF NOT EXISTS rocjob_sessions_last_event_idx ON rocjob_sessions (last_event);
