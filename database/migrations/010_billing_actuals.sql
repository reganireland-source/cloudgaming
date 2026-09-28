-- ============================================================================
-- 010_billing_actuals.sql — WHAT EACH CLOUD ACTUALLY BILLED
-- ============================================================================
-- The `costs` table holds the app's hourly ESTIMATES (in USD, from list
-- prices). These tables hold what each cloud's billing API reports, in the
-- cloud's billing currency, so the Costs page can reconcile the two.
--
--   billing_actuals   one row per user, cloud and day: the amount for what
--                     this app created (or the scope the cloud can report)
--                     and for the whole account, in `currency`
--   billing_fetches   when each cloud was last asked, and what it said
--                     (scope, notes, or a plain-English error to fix)
--   billing_settings  per-cloud settings for reading bills, e.g. Google's
--                     BigQuery billing export table
-- ============================================================================
CREATE TABLE IF NOT EXISTS billing_actuals (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  date DATE NOT NULL,
  currency VARCHAR(8) NOT NULL,
  amount DECIMAL(14, 4) NOT NULL DEFAULT 0,
  account_amount DECIMAL(14, 4),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider, date)
);

CREATE TABLE IF NOT EXISTS billing_fetches (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok BOOLEAN NOT NULL,
  currency VARCHAR(8),
  scope VARCHAR(20),
  scope_note TEXT,
  notes JSONB,
  error JSONB,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS billing_settings (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);
