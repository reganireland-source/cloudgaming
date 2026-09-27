/**
 * ============================================================================
 * src/api/routes/performance.ts — MACHINE PERFORMANCE METRICS
 * ============================================================================
 *
 * Mounted at /api/performance (login required). Serves the numbers behind
 * the Performance page: CPU/GPU usage, frame rate, network latency, etc.
 *
 *   GET /api/performance/:machineId            summary over recent hours
 *   GET /api/performance/:machineId/realtime   the single latest reading
 *   GET /api/performance/:machineId/health     healthy / warning / critical
 *
 * `:machineId` in a route path is a URL PARAMETER — a placeholder. For
 * /api/performance/abc123, Express puts "abc123" in req.params.machineId.
 *
 * This file is deliberately thin: it reads the inputs, calls
 * PerformanceService (src/services/PerformanceService.ts) to do the real
 * work, and sends back the result. Keeping business logic in "services"
 * and HTTP handling in "routes" makes each easier to read and test.
 *
 * NOTE: these routes don't check that the machine belongs to the logged-in
 * user, so any logged-in user could read any machine's metrics by id.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { PerformanceService } from '../../services/PerformanceService';

const router = Router();

/**
 * GET /api/performance/:machineId?hours=N
 * Averages, peaks and history for the last N hours (default 1).
 */
router.get('/:machineId', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;

    // Read ?hours=... from the URL, defaulting to '1' if absent.
    const { hours = '1' } = req.query;

    // Query values arrive as text; convert to a whole number. If it isn't a
    // valid number, parseInt gives NaN (a falsy value), so `|| 1` falls back
    // to 1. `as string` reassures TypeScript about the type.
    const hoursBack = parseInt(hours as string) || 1;

    const stats = await PerformanceService.getPerformanceStats(machineId, hoursBack);

    res.json(stats);
  } catch (error) {
    console.error('Get performance stats error:', error);
    res.status(500).json({ error: 'Failed to fetch performance stats', details: String(error) });
  }
});

/**
 * GET /api/performance/:machineId/realtime
 * Just the most recent metric reading.
 */
router.get('/:machineId/realtime', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;

    const metric = await PerformanceService.getRealtimeMetric(machineId);

    // No readings yet (e.g. a brand-new machine) -> 404 rather than empty data.
    if (!metric) {
      return res.status(404).json({ error: 'No performance data available' });
    }

    res.json(metric);
  } catch (error) {
    console.error('Get realtime performance error:', error);
    res.status(500).json({ error: 'Failed to fetch realtime performance', details: String(error) });
  }
});

/**
 * GET /api/performance/:machineId/health
 * A simple overall verdict (healthy / warning / critical) plus the reasons.
 */
router.get('/:machineId/health', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;

    const health = await PerformanceService.getHealthStatus(machineId);

    res.json(health);
  } catch (error) {
    console.error('Get health status error:', error);
    res.status(500).json({ error: 'Failed to fetch health status', details: String(error) });
  }
});

export default router;
