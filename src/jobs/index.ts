/**
 * ============================================================================
 * src/jobs/index.ts — TASKS THAT RUN ON A TIMER
 * ============================================================================
 *
 * Some work isn't triggered by anyone clicking anything — it just needs to
 * happen regularly (collect metrics, sync costs, check budgets). These are
 * BACKGROUND JOBS. initializeJobs() is called once from src/index.ts when
 * the server starts, and schedules each job with `node-cron`.
 *
 * CRON SYNTAX (the first argument to cron.schedule)
 * -------------------------------------------------
 * Five fields separated by spaces:   minute  hour  day-of-month  month  day-of-week
 *   an asterisk            = "every value" for that field
 *   asterisk + slash + 5   = "every 5th" (as in the idle-check line below)
 * So:
 *   '0 * * * *'    at minute 0 of every hour        (hourly)
 *   every-5th-minute pattern = every 5 minutes (see the code; it can't be
 *                    written literally inside this comment because an
 *                    asterisk followed by a slash would end the comment)
 *   '0 9 * * *'    at 09:00 every day (server time — UTC on Railway)
 *   '* * * * *'    every minute
 *
 * `.catch(err => ...)` on each job: jobs are async; if one throws, we log
 * the error instead of letting an unhandled failure crash the server.
 *
 * WHAT RUNS IN PRODUCTION
 * -----------------------
 * - syncCostsJob (hourly): records each machine's ESTIMATED cost for the
 *   hour — compute while running, disk storage while it exists.
 * - checkIdleJob (every 5 min): despite its name, reconciles every machine's
 *   status/IP with what its cloud reports (idle shutdown happens ON the
 *   machine itself — see providers/shared/setupScript.ts auto-stop).
 * - autoShelveJob (hourly): shelves machines stopped longer than their
 *   auto-shelve setting (snapshot, then delete machine + disk).
 * - budgetAlertJob (daily): logs users over their budget threshold.
 * - collectPerformanceMetricsJob is NOT scheduled: it only invented random
 *   numbers, which would be misleading on the Performance page. Re-enable
 *   it once it reads real metrics (cloud monitoring or an on-machine agent).
 * ============================================================================
 */

import cron from 'node-cron';
import { syncCostsJob, checkIdleJob, budgetAlertJob, autoShelveJob } from './SyncCosts';
import { collectPerformanceMetricsJob } from './CollectPerformance';

/**
 * Initialize all background jobs
 */
export function initializeJobs() {
  console.log('Initializing background jobs...');

  // Record each machine's estimated cost every hour (compute + disk)
  cron.schedule('0 * * * *', () => {
    syncCostsJob().catch(err => console.error('Sync costs job error:', err));
  });

  // Every 5 minutes: re-check each machine's real status/IP with its cloud
  cron.schedule('*/5 * * * *', () => {
    checkIdleJob(15).catch(err => console.error('Idle check job error:', err));
  });

  // Hourly (at :30): shelve machines stopped longer than their owner's
  // auto-shelve setting (snapshot first; the disk is only deleted once the
  // snapshot is complete).
  cron.schedule('30 * * * *', () => {
    autoShelveJob().catch(err => console.error('Auto-shelve job error:', err));
  });

  // Budget alerts daily at 9 AM (UTC on Railway). Only logs for now — no email is sent.
  cron.schedule('0 9 * * *', () => {
    budgetAlertJob().catch(err => console.error('Budget alert job error:', err));
  });

  // Performance metrics: disabled — collectPerformanceMetricsJob only makes
  // up random numbers (see src/jobs/CollectPerformance.ts).
  void collectPerformanceMetricsJob;

  console.log('Background jobs initialized');
}
