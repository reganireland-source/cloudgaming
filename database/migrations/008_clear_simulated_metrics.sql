-- ============================================================================
-- 008_clear_simulated_metrics.sql
-- ============================================================================
-- Until now a background job (src/jobs/CollectPerformance.ts) filled
-- performance_metrics with RANDOM numbers for every running machine. That job
-- is switched off, so every row already in the table is made up. Remove them
-- so the Performance page never shows invented GPU/FPS readings.
-- ============================================================================
DELETE FROM performance_metrics;
