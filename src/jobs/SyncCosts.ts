import { query } from '../config/database';
import { getProvider } from '../providers';
import { CostService } from '../services/CostService';

/**
 * Background job: Sync costs from cloud providers (hourly)
 * Runs via node-cron in the main server
 */
export async function syncCostsJob() {
  console.log('[Job] Starting hourly cost sync...');

  try {
    // Get all active machines
    const machinesResult = await query(
      `SELECT DISTINCT user_id, provider FROM machines WHERE status = 'running'`
    );

    const activeProviders = new Map<string, string[]>();

    // Group users by provider
    for (const row of machinesResult.rows) {
      const key = `${row.user_id}:${row.provider}`;
      if (!activeProviders.has(key)) {
        activeProviders.set(key, []);
      }
    }

    // Sync costs for each user-provider combination
    for (const [key, _] of activeProviders) {
      const [userId, provider] = key.split(':');

      try {
        await syncCostsForUserProvider(userId, provider);
      } catch (error) {
        console.error(`Failed to sync costs for ${userId}/${provider}:`, error);
      }
    }

    console.log('[Job] Cost sync completed');
  } catch (error) {
    console.error('[Job] Cost sync failed:', error);
  }
}

async function syncCostsForUserProvider(userId: string, provider: string) {
  // Get cloud credentials
  const credsResult = await query(
    'SELECT encrypted_data FROM cloud_credentials WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );

  if (credsResult.rows.length === 0) {
    console.warn(`No credentials for ${userId}/${provider}`);
    return;
  }

  // Get user's machines for this provider
  const machinesResult = await query(
    `SELECT id, instance_id FROM machines WHERE user_id = $1 AND provider = $2 AND status = 'running'`,
    [userId, provider]
  );

  // For each machine, generate realistic mock costs
  for (const machine of machinesResult.rows) {
    // In production, query cloud provider API
    // For MVP, use mock data based on machine type

    // Simulate: compute cost varies by instance type
    const computeCostPerHour = Math.random() * 1.5; // $0-1.50/hr
    const egressCostPerHour = Math.random() * 0.5; // $0-0.50/hr (depends on quality)
    const storageCostPerDay = Math.random() * 0.2; // $0-0.20/day

    await CostService.recordCosts(userId, {
      machineId: machine.id,
      provider,
      computeCost: computeCostPerHour,
      egressCost: egressCostPerHour,
      storageCost: storageCostPerDay / 24, // Convert to hourly
    });
  }
}

/**
 * Background job: Check for idle machines and auto-shutdown
 */
export async function checkIdleJob(idleThresholdMinutes: number = 15) {
  console.log(`[Job] Checking for idle machines (>${idleThresholdMinutes} min)...`);

  try {
    const idleThreshold = new Date(Date.now() - idleThresholdMinutes * 60 * 1000);

    // Find machines idle for too long
    const idleResult = await query(
      `SELECT id, user_id FROM machines
       WHERE status = 'running' AND (last_started IS NULL OR last_started < $1)`,
      [idleThreshold]
    );

    console.log(`[Job] Found ${idleResult.rows.length} idle machines`);

    // Auto-shutdown (optional: could email user first)
    for (const machine of idleResult.rows) {
      try {
        await query(
          `UPDATE machines SET status = 'stopped' WHERE id = $1`,
          [machine.id]
        );
        console.log(`[Job] Auto-stopped machine ${machine.id}`);
      } catch (error) {
        console.error(`[Job] Failed to stop machine ${machine.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[Job] Idle check failed:', error);
  }
}

/**
 * Background job: Send budget alerts
 */
export async function budgetAlertJob() {
  console.log('[Job] Checking budget thresholds...');

  try {
    // Get users with budget caps
    const usersResult = await query(
      `SELECT id, email, budget_cap, budget_alert_threshold FROM users WHERE budget_cap IS NOT NULL`
    );

    for (const user of usersResult.rows) {
      try {
        // Get current month spend
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const costResult = await query(
          `SELECT COALESCE(SUM(compute_cost + egress_cost + storage_cost), 0) as total
           FROM costs
           WHERE user_id = $1 AND date >= $2`,
          [user.id, monthStart]
        );

        const currentSpend = parseFloat(costResult.rows[0].total) || 0;
        const threshold = (user.budget_alert_threshold / 100) * user.budget_cap;

        if (currentSpend > threshold) {
          // Send email alert (TODO: implement email service)
          console.log(
            `[Job] Budget alert for ${user.email}: $${currentSpend.toFixed(2)} / $${user.budget_cap}`
          );
        }
      } catch (error) {
        console.error(`[Job] Failed to check budget for user ${user.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[Job] Budget alert job failed:', error);
  }
}
