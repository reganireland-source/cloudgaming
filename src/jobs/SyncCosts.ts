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
/** Public IPv4 address, $/hour while the machine runs (AWS, Google, Azure charge for it; Oracle doesn't). */
const PUBLIC_IP_PER_HOUR: Record<string, number> = { aws: 0.005, gcp: 0.005, azure: 0.004, oracle: 0 };
/** States in which the cloud bills the machine's compute (it exists and is on, or booting/shutting down). */
const COMPUTE_STATES = new Set(['running', 'starting', 'stopping', 'creating', 'restoring']);
/** States in which its disk exists and is billed. */
const DISK_STATES = new Set(['running', 'starting', 'stopping', 'creating', 'restoring', 'stopped']);

/**
 * Background job (every 5 minutes): bring each machine's ESTIMATED cost up
 * to now. Replaces the old hourly snapshot, which only counted machines that
 * happened to be running at :00 — a 40-minute session between two hours,
 * the setup time and starting/stopping were never counted. For the time
 * since the machine's last accrual (capped at 6 h, e.g. after server downtime):
 *   compute = its $/hour × hours in a billed state (+ public IPv4 address)
 *   disk    = disk GB × $/GB-month ÷ 730 per hour while it exists
 *             (shelved: the snapshot's stored GB × snapshot price)
 *   egress  = data it actually sent (telemetry "network out") × the region's
 *             $/GB — that's mostly the game stream
 * Still list prices, so still an estimate: no free tiers, credits, taxes or
 * sustained-use discounts.
 */
export async function syncCostsJob() {
  try {
    const rows = (await query(
      `SELECT m.id, m.user_id, m.provider, m.region, m.status, m.cost_per_hour, m.disk_size_gb, m.cost_accrued_at, s.stored_gb
         FROM machines m LEFT JOIN snapshots s ON s.id = m.snapshot_id
        WHERE m.status NOT IN ('terminated', 'deleted', 'failed', 'missing')`,
    )).rows;
    const now = new Date();
    for (const m of rows) {
      try {
        const provider = String(m.provider);
        if (!isProviderName(provider)) continue;
        const catalog = CATALOGS[provider];
        const since = m.cost_accrued_at ? new Date(m.cost_accrued_at) : now;
        const hours = Math.min(6, Math.max(0, (now.getTime() - since.getTime()) / 3600_000));
        await query('UPDATE machines SET cost_accrued_at = $2 WHERE id = $1', [m.id, now]);
        if (hours <= 0) continue;
        const diskGb = Number(m.disk_size_gb) || catalog.defaultDiskGb;
        const storage = m.status === 'shelved'
          ? (Number(m.stored_gb) || diskGb) * catalog.snapshotPerGbMonth * hours / 730
          : DISK_STATES.has(m.status) ? diskGb * catalog.diskPerGbMonth * hours / 730 : 0;
        const compute = COMPUTE_STATES.has(m.status)
          ? ((Number(m.cost_per_hour) || 0) + (PUBLIC_IP_PER_HOUR[m.provider] ?? 0)) * hours : 0;
        // Data sent: each telemetry sample is 15 s of "network out" (Mbit/s).
        let egress = 0;
        if (COMPUTE_STATES.has(m.status)) {
          const r = await query(
            `SELECT COALESCE(SUM((data->>'no')::float), 0) AS mbit FROM machine_telemetry WHERE machine_id = $1 AND t > $2 AND t <= $3`,
            [m.id, since, now]);
          const gb = (Number(r.rows[0]?.mbit) || 0) * 15 / 8 / 1000;
          const perGb = catalog.regions.find((x: { id: string }) => x.id === m.region)?.egressPerGb ?? 0.1;
          egress = gb * perGb;
        }
        if (compute + storage + egress > 0) {
          await CostService.recordCosts(m.user_id, { machineId: m.id, provider: m.provider, computeCost: compute, egressCost: egress, storageCost: storage });
        }
      } catch (error) {
        console.error(`[Job] Cost accrual failed for machine ${m.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[Job] Cost accrual failed:', error);
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
