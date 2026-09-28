/**
 * ============================================================================
 * src/jobs/SyncCosts.ts — HOURLY COST ESTIMATES, STATE RECONCILE, BUDGET ALERTS
 * ============================================================================
 *
 * Three background jobs (scheduled in src/jobs/index.ts):
 *   syncCostsJob    hourly   — record ESTIMATED costs of running machines
 *   checkIdleJob    5 min    — (name kept) reconcile machine states with the clouds
 *   budgetAlertJob  daily    — warn users near their budget cap
 *
 * NOTES
 * 1. The old idle job marked machines 'stopped' in our database without
 *    stopping them at the cloud (so they kept billing). It has been replaced
 *    by a reconcile job that only ever REPORTS the cloud's real state.
 * 2. Costs are estimates from the launch catalog, not billing data (see
 *    syncCostsForUserProvider). Each hourly row is one hour's estimate.
 * 3. budgetAlertJob only writes a log line — no email is sent (TODO).
 * ============================================================================
 */

import { MachineService } from '../services/MachineService';
import { query } from '../config/database';
import { getReconciliation } from '../services/BillingService';
import { expireStaleOperations } from '../services/OperationLog';
import { providerFor } from '../services/CredentialService';
import { CATALOGS, isProviderName } from '../providers/registry';
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
      `SELECT DISTINCT user_id, provider FROM machines WHERE status IN ('running', 'stopped', 'shelved')`
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
 * Record ESTIMATED costs for one user's running machines on one cloud, for
 * the last hour. Not exported — only used by syncCostsJob above.
 *
 * Real spend can only be read from each cloud's billing system (AWS Cost
 * Explorer, a GCP BigQuery billing export...), which isn't connected yet. So
 * instead of the old random numbers, we record honest estimates:
 *   compute = the machine's estimated $/hour (from the launch catalog)
 *   storage = its disk size × the catalog's $/GB/month ÷ 730 hours
 *   egress  = 0 (we don't yet know how many hours were actually streamed)
 */
async function syncCostsForUserProvider(userId: string, provider: string) {
  if (!isProviderName(provider)) return;
  const catalog = CATALOGS[provider];

  const machinesResult = await query(
    // Stopped machines too: their disk is still billed. Shelved machines:
    // their snapshot (actual stored GB when known, else the disk size).
    `SELECT m.id, m.status, m.cost_per_hour, m.disk_size_gb, s.stored_gb FROM machines m
     LEFT JOIN snapshots s ON s.id = m.snapshot_id
     WHERE m.user_id = $1 AND m.provider = $2 AND m.status IN ('running', 'stopped', 'shelved')`,
    [userId, provider]
  );

  for (const machine of machinesResult.rows) {
    const diskGb = Number(machine.disk_size_gb) || catalog.defaultDiskGb;
    const monthly = machine.status === 'shelved'
      ? (Number(machine.stored_gb) || diskGb) * catalog.snapshotPerGbMonth
      : diskGb * catalog.diskPerGbMonth;
    await CostService.recordCosts(userId, {
      machineId: machine.id,
      provider,
      computeCost: machine.status === 'running' ? Number(machine.cost_per_hour) || 0 : 0,
      egressCost: 0,
      storageCost: monthly / 730,
    });
  }
}

/**
 * Background job: keep our records in step with the clouds (every 5 min).
 *
 * WHY THIS REPLACED THE OLD "IDLE AUTO-STOP" JOB
 * ---------------------------------------------
 * The old job marked any machine running for 15+ minutes as 'stopped' in
 * OUR database only — the real machine kept running and billing, while the
 * app claimed it was off. That's the worst kind of bug for a cost tool, so
 * it's gone. (Real idle detection needs "is anyone streaming?" data from
 * Sunshine, which we don't collect yet.)
 *
 * Instead, this asks each cloud for the REAL state of every machine that
 * isn't mid-action, and updates status and IP. So if a spot machine is
 * reclaimed, or someone stops a machine in the cloud console, the app shows
 * the truth within 5 minutes. Each user's own (encrypted) keys are used.
 *
 * The parameter is kept for compatibility with jobs/index.ts and ignored.
 */
export async function checkIdleJob(_idleThresholdMinutes: number = 15) {
  try {
    // Watchdog first: actions that ran far too long are marked failed and
    // their machines released (see OperationLog.expireStaleOperations).
    const expired = await expireStaleOperations();
    if (expired) console.log(`[Job] Expired ${expired} stuck operation(s)`);

    // Every machine not being changed by a live action — including ones left
    // "starting"/"stopping" (e.g. Azure reports 'stopping' while it releases
    // a VM that shut itself down; a lost action can leave any of these).
    const machines = await query(
      `SELECT m.id, m.user_id, m.provider, m.instance_id, m.status, m.ip_address
       FROM machines m
       WHERE m.status IN ('running', 'stopped', 'unknown', 'missing', 'starting', 'stopping', 'deleting', 'shelving', 'restoring')
         AND m.instance_id NOT LIKE 'pending:%'
         AND m.instance_id NOT LIKE 'shelved:%'
         AND NOT EXISTS (SELECT 1 FROM cloud_operations o WHERE o.machine_id = m.id AND o.status = 'running')`
    );
    // One provider object per user+cloud (building one decrypts their keys).
    const providers = new Map<string, any>();
    let changed = 0;
    for (const m of machines.rows) {
      try {
        const key = `${m.user_id}:${m.provider}`;
        if (!providers.has(key)) providers.set(key, await providerFor(m.user_id, m.provider));
        const status = await providers.get(key).getInstanceStatus(m.instance_id);
        const newStatus = status.status === 'terminated' ? 'missing' : status.status;
        const newIp = status.ipAddress || m.ip_address;
        if (newStatus !== m.status || newIp !== m.ip_address) {
          changed++;
          console.log(`[Job] Machine ${m.id}: ${m.status} -> ${newStatus} (reported by ${m.provider})`);
        }
        // stopped_at: when it (first) became stopped — e.g. by its own idle
        // auto-stop — for the "stopped N days" advice and auto-shelve.
        await query(
          `UPDATE machines SET status = $1::varchar, ip_address = $2, last_synced_at = NOW(),
             stopped_at = CASE WHEN $1::varchar = 'stopped' THEN COALESCE(stopped_at, NOW()) ELSE NULL END
           WHERE id = $3`, [newStatus, newIp, m.id]);
      } catch (error) {
        // Missing/undecryptable keys or a cloud hiccup: leave the record as is.
        console.error(`[Job] Couldn't check machine ${m.id}:`, (error as Error).message);
      }
    }
    if (machines.rows.length) console.log(`[Job] Reconciled ${machines.rows.length} machines, ${changed} changed`);
  } catch (error) {
    console.error('[Job] Reconcile failed:', error);
  }
}

/**
 * Background job: auto-shelve (hourly). Machines whose owner turned
 * auto-shelve on and that have been STOPPED for at least that many days get
 * shelved (snapshot, then machine + disk deleted — see MachineService.shelve,
 * which never deletes the disk unless the snapshot completed).
 */
export async function autoShelveJob() {
  try {
    const due = await query(
      `SELECT id, user_id FROM machines
       WHERE status = 'stopped' AND auto_shelve_days IS NOT NULL AND stopped_at IS NOT NULL
         AND stopped_at < NOW() - make_interval(days => auto_shelve_days)
         AND NOT EXISTS (SELECT 1 FROM cloud_operations o WHERE o.machine_id = machines.id AND o.status = 'running')`
    );
    for (const m of due.rows) {
      try {
        console.log(`[Job] Auto-shelving machine ${m.id}`);
        await MachineService.shelve(m.user_id, m.id, 'auto');
      } catch (error) {
        console.error(`[Job] Couldn't auto-shelve ${m.id}:`, (error as Error).message);
      }
    }
  } catch (error) {
    console.error('[Job] Auto-shelve failed:', error);
  }
}

/**
 * Background job (daily): fetch what each cloud actually billed, for every
 * user with cloud keys, so the Costs page has the history even if nobody
 * opened it (see services/BillingService.ts; each fetch is cached/limited).
 */
export async function refreshBillingActualsJob() {
  try {
    const users = await query('SELECT DISTINCT user_id FROM cloud_credentials');
    for (const u of users.rows) {
      try { await getReconciliation(u.user_id, false); }
      catch (error) { console.error(`[Job] Billing actuals for ${u.user_id}:`, (error as Error).message); }
    }
  } catch (error) {
    console.error('[Job] Billing actuals failed:', error);
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
            `[Job] Budget alert for ${user.email}: USD ${currentSpend.toFixed(2)} / USD ${user.budget_cap}`
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
