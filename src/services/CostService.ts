import { query } from '../config/database';

interface CostRecord {
  machineId: string;
  provider: string;
  computeCost: number;
  egressCost: number;
  storageCost: number;
}

interface ProviderBreakdown {
  provider: string;
  compute: number;
  egress: number;
  storage: number;
  total: number;
}

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

    const total = result.rows.reduce((sum, row) => sum + parseFloat(row.total), 0);
    const breakdown: ProviderBreakdown[] = result.rows.map(row => ({
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

    return result.rows.map(row => ({
      date: row.date,
      cost: parseFloat(row.total),
    }));
  }

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
