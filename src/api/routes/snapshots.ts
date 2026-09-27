import { Router, Request, Response } from 'express';
import { SnapshotService } from '../../services/SnapshotService';
import { authenticateToken } from '../middleware/auth';

const router = Router();

/**
 * POST /api/snapshots
 * Create snapshot of running machine game library
 */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { machineId, paths, description } = req.body;

    if (!machineId) {
      return res.status(400).json({ error: 'machineId is required' });
    }

    const snapshot = await SnapshotService.createSnapshot({
      machineId,
      userId,
      paths: paths || ['/mnt/games'],
      description,
    });

    res.json(snapshot);
  } catch (error: any) {
    console.error('Snapshot creation error:', error);
    res.status(500).json({ error: error.message || 'Failed to create snapshot' });
  }
});

/**
 * GET /api/snapshots
 * List all snapshots for user with cost breakdown
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const snapshots = await SnapshotService.listSnapshots(userId);
    res.json(snapshots);
  } catch (error: any) {
    console.error('List snapshots error:', error);
    res.status(500).json({ error: error.message || 'Failed to list snapshots' });
  }
});

/**
 * GET /api/snapshots/:snapshotId
 * Get snapshot metadata including replicas and cost
 */
router.get('/:snapshotId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { snapshotId } = req.params;

    const snapshot = await SnapshotService.getSnapshotMetadata(snapshotId, userId);
    res.json(snapshot);
  } catch (error: any) {
    console.error('Get snapshot error:', error);
    res.status(500).json({ error: error.message || 'Failed to get snapshot' });
  }
});

/**
 * POST /api/snapshots/:snapshotId/replicate
 * Replicate snapshot to another provider/region
 */
router.post(
  '/:snapshotId/replicate',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId;
      const { snapshotId } = req.params;
      const { targetProvider, targetRegion } = req.body;

      if (!targetProvider || !targetRegion) {
        return res
          .status(400)
          .json({ error: 'targetProvider and targetRegion are required' });
      }

      const snapshot = await SnapshotService.replicateSnapshot(
        snapshotId,
        userId,
        targetProvider,
        targetRegion
      );

      res.json(snapshot);
    } catch (error: any) {
      console.error('Snapshot replication error:', error);
      res
        .status(500)
        .json({ error: error.message || 'Failed to replicate snapshot' });
    }
  }
);

/**
 * DELETE /api/snapshots/:snapshotId
 * Delete snapshot and all replicas
 */
router.delete('/:snapshotId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { snapshotId } = req.params;

    await SnapshotService.deleteSnapshot(snapshotId, userId);
    res.json({ success: true, message: 'Snapshot deleted' });
  } catch (error: any) {
    console.error('Delete snapshot error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete snapshot' });
  }
});

export default router;
