import cron from 'node-cron';
import { syncCostsJob, checkIdleJob, budgetAlertJob } from './SyncCosts';

/**
 * Initialize all background jobs
 */
export function initializeJobs() {
  console.log('Initializing background jobs...');

  // Sync costs every hour
  cron.schedule('0 * * * *', () => {
    syncCostsJob().catch(err => console.error('Sync costs job error:', err));
  });

  // Check idle machines every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    checkIdleJob(15).catch(err => console.error('Idle check job error:', err));
  });

  // Budget alerts daily at 9 AM
  cron.schedule('0 9 * * *', () => {
    budgetAlertJob().catch(err => console.error('Budget alert job error:', err));
  });

  console.log('Background jobs initialized');
}
