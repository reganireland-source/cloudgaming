-- ============================================================================
-- 009_shelving.sql — "SHELVE": SNAPSHOT A MACHINE, THEN DELETE IT
-- ============================================================================
-- A stopped machine still pays for its disk every month. Shelving takes a
-- snapshot (billed only on the data actually stored, at roughly half the
-- per-GB price), then deletes the machine and its disk. The machine row
-- stays, with status 'shelved', so it can be restored with one click.
--
--   machines.shelved_at        when it was shelved (NULL = not shelved)
--   machines.stopped_at        when it last stopped (for "stopped for N days"
--                              advice and auto-shelve)
--   machines.auto_shelve_days  shelve automatically after this many days
--                              stopped (NULL = off)
--   machines.auto_stop_minutes the idle auto-stop chosen at launch, reused
--                              when a shelved machine is restored
--   snapshots.stored_gb        GB the cloud actually bills for, where it
--                              reports it
-- ============================================================================
ALTER TABLE machines ADD COLUMN IF NOT EXISTS shelved_at TIMESTAMP;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMP;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS auto_shelve_days INTEGER;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS auto_stop_minutes INTEGER;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS stored_gb DECIMAL(10, 1);

-- Machines already stopped: count from now.
UPDATE machines SET stopped_at = NOW() WHERE status = 'stopped' AND stopped_at IS NULL;
