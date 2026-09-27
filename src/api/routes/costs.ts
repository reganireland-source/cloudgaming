import { Router, Request, Response } from 'express';
import { query } from '../../config/database';

const router = Router();

/**
 * GET /api/costs/monthly
 * Get cost breakdown for current month
 */
router.get('/monthly', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const result = await query(
      `SELECT
        COALESCE(SUM(compute_cost), 0) as compute,
        COALESCE(SUM(egress_cost), 0) as egress,
        COALESCE(SUM(storage_cost), 0) as storage,
        provider,
        COUNT(*) as days
       FROM costs
       WHERE user_id = $1 AND date >= $2
       GROUP BY provider
       ORDER BY provider`,
      [userId, monthStart]
    );

    const total = result.rows.reduce((sum, row) => {
      return sum + parseFloat(row.compute) + parseFloat(row.egress) + parseFloat(row.storage);
    }, 0);

    res.json({
      total,
      breakdown: result.rows,
      period: { start: monthStart, end: now },
    });
  } catch (error) {
    console.error('Get monthly costs error:', error);
    res.status(500).json({ error: 'Failed to fetch costs' });
  }
});

/**
 * GET /api/costs/daily
 * Get cost history by day
 */
router.get('/daily', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const daysParam = req.query.days || '30';
    const days = parseInt(daysParam as string, 10);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await query(
      `SELECT
        date,
        COALESCE(SUM(compute_cost), 0) as compute,
        COALESCE(SUM(egress_cost), 0) as egress,
        COALESCE(SUM(storage_cost), 0) as storage,
        COALESCE(SUM(compute_cost + egress_cost + storage_cost), 0) as total
       FROM costs
       WHERE user_id = $1 AND date >= $2
       GROUP BY date
       ORDER BY date ASC`,
      [userId, startDate]
    );

    res.json({
      history: result.rows,
      period: { start: startDate, end: new Date(), days },
    });
  } catch (error) {
    console.error('Get daily costs error:', error);
    res.status(500).json({ error: 'Failed to fetch cost history' });
  }
});

/**
 * GET /api/costs/forecast
 * Forecast end-of-month spend based on current usage
 */
router.get('/forecast', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();

    const result = await query(
      `SELECT
        COALESCE(SUM(compute_cost + egress_cost + storage_cost), 0) as total_so_far
       FROM costs
       WHERE user_id = $1 AND date >= $2`,
      [userId, monthStart]
    );

    const totalSoFar = parseFloat(result.rows[0].total_so_far) || 0;
    const dailyAverage = totalSoFar / Math.max(daysElapsed, 1);
    const projectedTotal = dailyAverage * daysInMonth;

    res.json({
      totalSoFar,
      dailyAverage,
      projectedTotal,
      daysElapsed,
      daysInMonth,
    });
  } catch (error) {
    console.error('Get cost forecast error:', error);
    res.status(500).json({ error: 'Failed to calculate forecast' });
  }
});

/**
 * POST /api/costs/budget
 * Set budget cap and alert threshold
 */
router.post('/budget', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { budgetCap, alertThreshold } = req.body;

    if (budgetCap === undefined || alertThreshold === undefined) {
      return res.status(400).json({ error: 'Missing budget or alert threshold' });
    }

    const result = await query(
      `UPDATE users
       SET budget_cap = $1, budget_alert_threshold = $2
       WHERE id = $3
       RETURNING budget_cap, budget_alert_threshold`,
      [budgetCap, alertThreshold, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Set budget error:', error);
    res.status(500).json({ error: 'Failed to set budget' });
  }
});

export default router;
