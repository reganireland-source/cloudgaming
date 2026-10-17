-- What a local machine's agent measured: a one-off "diagnose" snapshot, a
-- "record" (per-second samples while streaming) or "logs". The raw data is
-- kept (newest 10 per machine and kind); the plain-English findings are
-- worked out when it is read, so improved rules apply to old reports too.
CREATE TABLE IF NOT EXISTS local_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES local_machines(id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL,
  command_id UUID,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS local_reports_machine_idx ON local_reports (machine_id, kind, created_at DESC);
