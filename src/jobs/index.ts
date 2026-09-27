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
 * ⚠️  THESE JOBS RUN IN PRODUCTION AS SOON AS YOU DEPLOY — READ THIS
 * ------------------------------------------------------------------
 * - checkIdleJob marks machines 'stopped' in OUR database after ~15 minutes
 *   WITHOUT stopping them at the cloud provider. They keep running and
 *   BILLING while the app shows them as stopped. See SyncCosts.ts.
 * - syncCostsJob writes RANDOM, made-up costs every hour.
 * - collectPerformanceMetricsJob writes RANDOM, made-up metrics every minute.
 * Consider disabling the idle job until it actually stops instances.
 * ============================================================================
 */

import cron from 'node-cron';
import { syncCostsJob, checkIdleJob, budgetAlertJob } from './SyncCosts';
import { collectPerformanceMetricsJob } from './CollectPerformance';

/**
 * Initialize all background jobs
 */
export function initializeJobs() {
  console.log('Initializing background jobs...');

  // Sync costs every hour (⚠️ currently writes mock data)
  cron.schedule('0 * * * *', () => {
    syncCostsJob().catch(err => console.error('Sync costs job error:', err));
  });

  // Check idle machines every 5 minutes (⚠️ see warning above)
  // The 15 = minutes a machine may run before being considered "idle".
  cron.schedule('*/5 * * * *', () => {
    checkIdleJob(15).catch(err => console.error('Idle check job error:', err));
  });

  // Budget alerts daily at 9 AM (UTC on Railway). Only logs for now — no email is sent.
  cron.schedule('0 9 * * *', () => {
    budgetAlertJob().catch(err => console.error('Budget alert job error:', err));
  });

  // Collect performance metrics every minute (⚠️ currently writes mock data)
  cron.schedule('* * * * *', () => {
    collectPerformanceMetricsJob().catch(err => console.error('Performance collection job error:', err));
  });

  console.log('Background jobs initialized');
}
