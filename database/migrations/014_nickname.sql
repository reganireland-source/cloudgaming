-- ============================================================================
-- 014 — Machine nicknames
-- ============================================================================
-- An editable name per machine, e.g. GOOGLE-SINGAPORE-L4-BEST-S-BS (cloud,
-- city, GPU, tier, then -S for spot and -BS for big screen). Shown in the app
-- and announced by Sunshine, so Moonlight lists the machine by it.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS nickname VARCHAR(40);
