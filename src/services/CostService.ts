/**
 * ============================================================================
 * src/services/CostService.ts — ACTUAL SPEND: RECORD, SUMMARISE, FORECAST
 * ============================================================================
 *
 * Where CostAnalysisService ESTIMATES what things would cost, this service
 * works with what was actually SPENT, stored in the `costs` table (one row
 * per machine per day, split into compute / egress / storage).
 *
 *   recordCosts          write one day's costs (called by the SyncCosts job)
 *   getMonthlyBreakdown  this month's spend per cloud provider
 *   getDailyHistory      spend per day for the last N days
 *   forecast             projected spend for the rest of the month
 *   getMachineBoM        a "bill of materials" — cost per hour/day/month for one machine
 *
 * NOTE: only recordCosts is currently used (by src/jobs/SyncCosts.ts). The
 * /api/costs routes run their own similar queries directly instead of
 * calling this service, so the other methods are unused for now.
 *
 * ⚠️  getMachineBoM would fail if called: it joins on m.game_profile_id,
 * but the machines table has no such column (see database/schema.sql).
 * ============================================================================
 */

import { query } from '../config/database';

/** One day's costs for one machine (input to recordCosts). */
interface CostRecord {
  machineId: string;
  provider: string;
  computeCost: number;
  egressCost: number;
  storageCost: number;
}

/** One cloud provider's totals for the month. */
interface ProviderBreakdown {
  provider: string;
  compute: number;
  egress: number;
  storage: number;
  total: number;
}

/**
 * A "bill of materials" (BoM) — borrowed from manufacturing, meaning an
 * itemised list of what something is made of and what each part costs.
 * Here: the machine itself + the streaming data, then totals.
 */
interface BillOfMaterials {
  compute: {
    component: string;
    quantity: number;
    unit: string;
    costPerUnit: number;
    total: number;
  };
  streaming: {
    resolution: string;
    fps: number;
    bitrate: string;
    gbPerHour: number;
    egressRate: number;
    costPerHour: number;
  };
  total: {
    costPerHour: number;
    costPerDay: number;
    costPerMonth: number;
  };
}

export class CostService {
  /**
   * This month's spend (from the 1st until now), grouped by cloud provider,
   * plus a grand total. Postgres returns DECIMAL sums as text, hence
   * parseFloat() on every figure.
   */
  static async getMonthlyBreakdown(userId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const result = await query(
      `SELECT
        provider,
        COALESCE(SUM(compute_cost), 0) as compute,
        COALESCE(SUM(egress_cost), 0) as egress,
        COALESCE(SUM(storage_cost), 0) as storage,
        COALESCE(SUM(compute_cost + egress_cost + storage_cost), 0) as total
       FROM costs
       WHERE user_id = $1 AND date >= $2
       GROUP BY provider`,
      [userId, monthStart]
    );

    const total = result.rows.reduce((sum: number, row: any) => sum + parseFloat(row.total), 0);
    const breakdown: ProviderBreakdown[] = result.rows.map((row: any) => ({
      provider: row.provider,
      compute: parseFloat(row.compute),
      egress: parseFloat(row.egress),
      storage: parseFloat(row.storage),
      total: parseFloat(row.total),
    }));

    return {
      total,
      breakdown,
      period: { start: monthStart, end: now },
    };
  }

  /**
   * Total spend per day for the last `days` days (default 30), oldest first.
   * `days * 24 * 60 * 60 * 1000` converts days to milliseconds.
   */
  static async getDailyHistory(userId: string, days: number = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await query(
      `SELECT
        date,
        COALESCE(SUM(compute_cost + egress_cost + storage_cost), 0) as total
       FROM costs
       WHERE user_id = $1 AND date >= $2
       GROUP BY date
       ORDER BY date ASC`,
      [userId, startDate]
    );

    return result.rows.map((row: any) => ({
      date: row.date,
      cost: parseFloat(row.total),
    }));
  }

  /**
   * Straight-line forecast: (spend so far) + (average daily spend × days left).
   * Caveats: "spend so far" here is the last 30 DAYS of history, not strictly
   * this calendar month, and every month is treated as 30 days long.
   * (`monthStart` is calculated but not used.)
   */
  static async forecast(userId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayOfMonth = now.getDate();

    const history = await this.getDailyHistory(userId, 30);

    if (history.length === 0) {
      return { projectedCost: 0, daysOfData: 0, daysRemaining: 30 - dayOfMonth };
    }

    const totalSpend = history.reduce((sum, day) => sum + day.cost, 0);
    const avgDailySpend = totalSpend / history.length;
    const daysRemaining = 30 - dayOfMonth;
    const currentMonthSpend = history.reduce((sum, day) => sum + day.cost, 0);

    return {
      projectedCost: currentMonthSpend + avgDailySpend * daysRemaining,
      daysOfData: history.length,
      daysRemaining,
      avgDailyCost: avgDailySpend,
    };
  }

  /**
   * Itemised running cost for one machine:
   *   compute  = the machine's hourly price
   *   streaming = GB per hour for its quality × egress price per GB in its region
   * then per hour / per day (× 24) / per month (× 24 × 30, i.e. running non-stop).
   * Falls back to sensible defaults ($0.50/h, 'Good' quality, $0.12/GB)
   * when data is missing.
   * ⚠️ Fails today — see the note about game_profile_id in the file header.
   */
  static async getMachineBoM(machineId: string): Promise<{
    machine: any;
    billOfMaterials: BillOfMaterials;
  }> {
    const machineResult = await query(
      `SELECT m.*, g.target_quality, g.vram_requirement
       FROM machines m
       LEFT JOIN game_profiles g ON m.game_profile_id = g.id
       WHERE m.id = $1`,
      [machineId]
    );

    if (machineResult.rows.length === 0) {
      throw new Error('Machine not found');
    }

    const machine = machineResult.rows[0];

    const qualityResult = await query(
      `SELECT * FROM streaming_qualities WHERE name = $1`,
      [machine.target_quality || 'Good']
    );

    const quality = qualityResult.rows[0] || {
      name: 'Good',
      resolution: '1440p',
      fps: 60,
      bitrate: '35 Mbps',
      gb_per_hour: 3.6,
    };

    const regionResult = await query(
      `SELECT egress_cost_per_gb FROM region_data WHERE provider = $1 AND region = $2`,
      [machine.provider, machine.region]
    );

    const egressCostPerGb = regionResult.rows[0]?.egress_cost_per_gb || 0.12;
    const egressCostPerHour = quality.gb_per_hour * egressCostPerGb;

    return {
      machine,
      billOfMaterials: {
        compute: {
          component: machine.instance_type,
          quantity: 1,
          unit: 'instance',
          costPerUnit: machine.cost_per_hour || 0.5,
          total: machine.cost_per_hour || 0.5,
        },
        streaming: {
          resolution: quality.resolution,
          fps: quality.fps,
          bitrate: quality.bitrate,
          gbPerHour: quality.gb_per_hour,
          egressRate: egressCostPerGb,
          costPerHour: egressCostPerHour,
        },
        total: {
          costPerHour: (machine.cost_per_hour || 0.5) + egressCostPerHour,
          costPerDay: ((machine.cost_per_hour || 0.5) + egressCostPerHour) * 24,
          costPerMonth: ((machine.cost_per_hour || 0.5) + egressCostPerHour) * 24 * 30,
        },
      },
    };
  }

  /**
   * Save one day's costs for one machine. Called by the SyncCosts
   * background job. `toISOString().split('T')[0]` turns the current moment
   * into just today's date, e.g. "2026-09-27" (in UTC).
   * Note: running this twice on the same day adds a SECOND row for that
   * day rather than replacing the first.
   */
  static async recordCosts(userId: string, costs: CostRecord) {
    const today = new Date().toISOString().split('T')[0];

    await query(
      `INSERT INTO costs (user_id, machine_id, provider, compute_cost, egress_cost, storage_cost, date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        costs.machineId,
        costs.provider,
        costs.computeCost,
        costs.egressCost,
        costs.storageCost,
        today,
      ]
    );
  }
}
