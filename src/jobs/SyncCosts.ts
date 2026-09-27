/**
 * ============================================================================
 * src/jobs/SyncCosts.ts — HOURLY COSTS, IDLE SHUTDOWN, BUDGET ALERTS
 * ============================================================================
 *
 * Three background jobs (scheduled in src/jobs/index.ts):
 *   syncCostsJob    hourly   — record what running machines cost
 *   checkIdleJob    5 min    — "auto-stop" machines considered idle
 *   budgetAlertJob  daily    — warn users near their budget cap
 *
 * ⚠️⚠️  READ BEFORE DEPLOYING  ⚠️⚠️
 * 1. checkIdleJob ONLY CHANGES OUR DATABASE. It sets status = 'stopped' but
 *    never calls the cloud provider, so the real VM keeps running and
 *    billing while the dashboard says it's off. And "idle" here means
 *    "started more than 15 minutes ago" (or never recorded as started —
 *    which is every newly launched machine, since launch doesn't set
 *    last_started), NOT "nobody is using it". Net effect: every machine is
 *    shown as stopped within ~15–20 minutes while still costing money.
 * 2. syncCostsJob records RANDOM numbers (Math.random), not real costs, and
 *    adds a new row every hour, labelled as that whole day's cost.
 * 3. budgetAlertJob only writes a log line — no email is sent (TODO).
 * ============================================================================
 */

import { query } from '../config/database';
import { getProvider } from '../providers'; // imported for the future real implementation; unused now
import { CostService } from '../services/CostService';

/**
 * Background job: Sync costs from cloud providers (hourly)
 * Runs via node-cron in the main server
 *
 * Finds every (user, cloud) pair that has a running machine, then records
 * costs for each pair. One pair failing doesn't stop the others (each has
 * its own try/catch).
 */
export async function syncCostsJob() {
  console.log('[Job] Starting hourly cost sync...');

  try {
    // Get all active machines
    const machinesResult = await query(
      `SELECT DISTINCT user_id, provider FROM machines WHERE status = 'running'`
    );

    // A Map is a key -> value collection. Only the KEYS matter here (a
    // de-duplicated set of "userId:provider" strings); the empty-array values
    // are unused. (SELECT DISTINCT has already removed duplicates anyway.)
    const activeProviders = new Map<string, string[]>();

    // Group users by provider
    for (const row of machinesResult.rows) {
      const key = `${row.user_id}:${row.provider}`;
      if (!activeProviders.has(key)) {
        activeProviders.set(key, []);
      }
    }

    // Sync costs for each user-provider combination.
    // `[key, _]` unpacks each Map entry; `_` is a conventional name for a
    // value we deliberately ignore. key.split(':') turns "abc:aws" back into
    // ["abc", "aws"].
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

/**
 * Record costs for one user's running machines on one cloud.
 * Not exported — only used by syncCostsJob above.
 * ⚠️ The "costs" are random mock values (see file header). The real version
 * would call cloudProvider.queryCosts(...) (e.g. AWS Cost Explorer).
 */
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
 *
 * INTENT: stop machines nobody is using, to save money.
 * ACTUAL BEHAVIOUR (⚠️ see file header, point 1): marks machines as
 * 'stopped' in our database only — the cloud VM is NOT stopped — and uses
 * "time since last start" as a stand-in for "idle".
 * A real version would check activity (e.g. no streaming client connected
 * for N minutes) and call cloudProvider.stopInstance(...) via
 * MachineService.stopMachine.
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
 *
 * For each user with a budget cap: add up this month's costs and compare
 * with (alert threshold % × cap). e.g. cap $100, threshold 80 -> alert once
 * spend passes $80. Currently it only writes a log line (no email yet).
 * Note: budget_cap and budget_alert_threshold are DECIMAL columns, which the
 * database driver returns as text; the maths still works here because `/`
 * and `*` convert text to numbers automatically.
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
