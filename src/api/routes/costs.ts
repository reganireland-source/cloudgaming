/**
 * ============================================================================
 * src/api/routes/costs.ts — HOW MUCH HAVE I SPENT, AND WHERE IS IT HEADING?
 * ============================================================================
 *
 * Mounted at /api/costs (login required). Reads the `costs` table, which
 * holds one row per machine per day, split into three kinds of cost:
 *   compute_cost  — paying for the machine to be switched on
 *   egress_cost   — paying for data leaving the cloud (mostly the video stream)
 *   storage_cost  — paying for disks and snapshots
 * (Rows are written by the background job in src/jobs/SyncCosts.ts.)
 *
 *   GET  /api/costs/monthly    this month's totals per provider
 *   GET  /api/costs/daily      a day-by-day history (for charts)
 *   GET  /api/costs/forecast   projected end-of-month spend
 *   POST /api/costs/budget     set a budget cap and alert threshold
 *   GET  /api/costs/actuals    what each cloud ACTUALLY billed (its billing currency),
 *                              reconciled with the estimates; ?refresh=true re-asks
 *   PUT  /api/costs/billing-settings/:provider   e.g. Google's BigQuery export table
 *   GET  /api/costs/summary    today / week / month to date, for the status strip
 *
 * Everything in the `costs` table is an ESTIMATE in USD (list prices).
 *
 * SQL TOOLS USED BELOW
 *   SUM(x)           add up a column across rows
 *   COALESCE(a, 0)   use a, but 0 if a is empty (SUM of zero rows is NULL)
 *   GROUP BY p       produce one result row per distinct value of p
 *   ... AS name      give a computed column a name to read it by
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { getReconciliation, saveBillingSettings, getSpendSummary } from '../../services/BillingService';
import { isProviderName } from '../../providers/registry';

const router = Router();

/**
 * GET /api/costs/monthly
 * Spend since the 1st of the current month, broken down by cloud provider.
 */
router.get('/monthly', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const now = new Date();

    // Midnight on the 1st of this month. JavaScript months are ZERO-based
    // (January = 0), and getMonth() returns the same scheme, so this works.
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

    // Add up all providers into one grand total.
    // `reduce` walks the array carrying a running total (`sum`), starting at 0.
    // Postgres returns DECIMAL columns as TEXT (to avoid rounding errors),
    // hence parseFloat() to turn "12.34" into the number 12.34.
    const total = result.rows.reduce((sum: number, row: any) => {
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
 * GET /api/costs/daily?days=N
 * One row per day for the last N days (default 30) — the data for the
 * "daily trend" chart on the Costs page.
 */
router.get('/daily', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const daysParam = req.query.days || '30';
    const days = parseInt(daysParam as string, 10);

    // "N days ago": take today and subtract N days. setDate handles
    // month/year boundaries automatically (e.g. 3 days before March 1st).
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
 * A simple straight-line projection:
 *   average per day so far  ×  number of days in the month
 */
router.get('/forecast', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Trick for "how many days are in this month": day 0 of NEXT month is
    // the last day of THIS month, and its date number is the day count.
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

    // Math.max(daysElapsed, 1) guards against dividing by zero.
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
 * Save a monthly budget cap and the % at which to warn.
 * Request body: { "budgetCap": 150, "alertThreshold": 80 }
 */
router.post('/budget', async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { budgetCap, alertThreshold } = req.body;

    // `=== undefined` (rather than `!value`) so that a legitimate 0 is allowed.
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

    // UPDATE matched no rows -> that user doesn't exist.
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Set budget error:', error);
    res.status(500).json({ error: 'Failed to set budget' });
  }
});

/** GET /api/costs/actuals — actual charges per cloud vs the app's estimates. */
router.get('/actuals', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getReconciliation(req.userId!, req.query.refresh === 'true'));
  } catch (error) {
    console.error('Actual costs error:', error);
    res.status(500).json({ error: 'Failed to read actual charges', tip: 'Try again in a moment.' });
  }
});

/** GET /api/costs/summary — the short spend line shown on every page. */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getSpendSummary(req.userId!));
  } catch (error) {
    console.error('Spend summary error:', error);
    res.status(500).json({ error: 'Failed to read spend' });
  }
});

/** PUT /api/costs/billing-settings/:provider — body e.g. { exportTable: "proj.dataset.table" } */
router.put('/billing-settings/:provider', async (req: Request, res: Response) => {
  try {
    if (!isProviderName(req.params.provider)) return res.status(400).json({ error: 'Unknown cloud.' });
    res.json(await saveBillingSettings(req.userId!, req.params.provider, req.body));
  } catch (error) {
    console.error('Billing settings error:', error);
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

export default router;
