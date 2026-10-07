-- ============================================================================
-- 019 — What the cloud billed, line by line (service × SKU), per fetch
-- ============================================================================
-- Lets the Costs page reconcile: the cloud's own items (e.g. "Compute Engine ·
-- Nvidia L4 GPU running in Singapore", "Network Internet Egress") next to the
-- app's estimate split into compute / data out / storage.
ALTER TABLE billing_fetches ADD COLUMN IF NOT EXISTS breakdown JSONB;
