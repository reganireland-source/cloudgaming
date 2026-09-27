import { Router, Request, Response } from 'express';
import { PerformanceService } from '../../services/PerformanceService';

const router = Router();

/**
 * GET /api/performance/:machineId
 * Get performance stats for a machine
 */
router.get('/:machineId', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const { hours = '1' } = req.query;

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
 * Get latest performance metric
 */
router.get('/:machineId/realtime', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;

    const metric = await PerformanceService.getRealtimeMetric(machineId);

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
 * Get machine health status
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
