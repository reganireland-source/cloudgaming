-- ============================================================================
-- 015 — Which GPUs each cloud region actually sells (learned live)
-- ============================================================================
-- The catalogs list the GPU models per region from the clouds' docs, which
-- drift (e.g. AWS Jakarta sells g5/A10G but not g4dn/T4). Each region check
-- on the Regions page asks the cloud live; what it finds is stored here and
-- overrides the catalog everywhere (Recon, launch form, launch checks).
-- Shared by all users: what a cloud sells in a region isn't account-specific.
CREATE TABLE IF NOT EXISTS gpu_offerings (
  provider   VARCHAR(16) NOT NULL,
  region     VARCHAR(64) NOT NULL,
  gpus       TEXT[]      NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, region)
);
