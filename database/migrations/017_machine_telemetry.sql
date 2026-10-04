-- ============================================================================
-- 017 — Real telemetry from the machines (on-machine agent, serial console)
-- ============================================================================
-- One row per 15-second sample the agent prints ("CGT {json}", see
-- src/providers/shared/agent.ts): CPU, RAM, disk, I/O, network, GPU, errors.
-- Collected every minute for running machines (and live while someone has
-- the Monitor tab open); kept 7 days.
CREATE TABLE IF NOT EXISTS machine_telemetry (
  machine_id UUID        NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  t          TIMESTAMPTZ NOT NULL,
  data       JSONB       NOT NULL,
  PRIMARY KEY (machine_id, t)
);
