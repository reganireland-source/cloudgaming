-- ============================================================================
-- 011 — EXPERIMENTAL "big screen": which NVIDIA driver a machine runs
-- ============================================================================
-- 'standard' = NVIDIA's datacenter driver (headless screens up to 2560x1600).
-- 'grid'     = the cloud's licensed GRID / virtual-workstation driver, which
--              allows up to 4096x2160 (AWS, Azure; Google via "vWS" GPUs).
-- Chosen at launch; kept through stop/start, shelve and restore.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS display_driver VARCHAR(16) NOT NULL DEFAULT 'standard';
