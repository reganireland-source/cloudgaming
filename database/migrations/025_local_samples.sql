-- One reading of a local PC per agent check-in (about every 30 s), for the
-- Performance page's trend lines. Pruned to the last 25 hours.
CREATE TABLE IF NOT EXISTS local_samples (
  id BIGSERIAL PRIMARY KEY,
  machine_id UUID NOT NULL REFERENCES local_machines(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS local_samples_machine_at_idx ON local_samples (machine_id, at DESC);
