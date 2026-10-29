-- Endurance Cup runs: a run's pit stops, laps and tyre class (stored, not ranked).
-- Boards for mode=endurance rank by total_ms; other modes still rank by lap_ms.
ALTER TABLE scudrace_scores ADD COLUMN IF NOT EXISTS stops SMALLINT;
ALTER TABLE scudrace_scores ADD COLUMN IF NOT EXISTS laps SMALLINT;
ALTER TABLE scudrace_scores ADD COLUMN IF NOT EXISTS tyre_class VARCHAR(16);
-- Endurance boards sort by total_ms.
CREATE INDEX IF NOT EXISTS scudrace_scores_endurance_idx ON scudrace_scores (grp, course, total_ms) WHERE mode = 'endurance';
