-- ============================================================================
-- 016 — Which GPU models a stored live check actually asked about
-- ============================================================================
-- A check only knows about the GPU models the app had at the time. Without
-- this, a row stored before a new model was added (e.g. the SUPER tier's
-- L40S / RTX PRO 6000) would erase that model from the region at startup.
-- NULL = an older row: it asked about T4, L4, A10G and A10 only.
ALTER TABLE gpu_offerings ADD COLUMN IF NOT EXISTS checked TEXT[];
