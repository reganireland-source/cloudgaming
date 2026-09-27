/**
 * ============================================================================
 * src/api/routes/snapshots.ts — DISK BACKUPS YOU CAN CARRY BETWEEN CLOUDS
 * ============================================================================
 *
 * A SNAPSHOT is a saved copy of a machine's disk — with all your installed
 * games on it. Why it matters for cost:
 *   - A running GPU machine costs ~50c/hour. A stored snapshot costs a few
 *     cents per GB per MONTH. So: play, snapshot, delete the machine, and
 *     restore later, instead of paying for a machine you're not using.
 *   - Snapshots can be copied ("replicated") to other regions so you can
 *     restore close to wherever you're playing from.
 *
 * Mounted at /api/snapshots (login required):
 *   POST   /api/snapshots                          create a snapshot of a machine
 *   GET    /api/snapshots                          list my snapshots (+ monthly cost)
 *   GET    /api/snapshots/:snapshotId              one snapshot's details
 *   POST   /api/snapshots/:snapshotId/replicate    copy it to another region/cloud
 *   DELETE /api/snapshots/:snapshotId              delete it everywhere
 *
 * All real work is in src/services/SnapshotService.ts.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { SnapshotService } from '../../services/SnapshotService';

const router = Router();

/**
 * POST /api/snapshots
 * Body: { machineId, paths?, description? }
 * `paths` = which folders to back up; defaults to the games folder.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { machineId, paths, description } = req.body;

    if (!machineId) {
      return res.status(400).json({ error: 'machineId is required' });
    }

    // Arguments passed as one object ({ ... }) rather than a long list, so
    // each value is clearly labelled at the call site.
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
 * Every snapshot I own, each with its estimated monthly storage cost.
 */
router.get('/', async (req: Request, res: Response) => {
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
 * One snapshot, including every region/cloud it has been copied to.
 */
router.get('/:snapshotId', async (req: Request, res: Response) => {
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
 * Copy a snapshot to another region (and, in future, another cloud).
 * Body: { "targetProvider": "aws", "targetRegion": "us-east-1" }
 * NOTE: today only AWS -> AWS copies work; other clouds reply "not implemented".
 */
router.post(
  '/:snapshotId/replicate',
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
 * Delete the snapshot and every copy of it, in every cloud. Irreversible.
 */
router.delete('/:snapshotId', async (req: Request, res: Response) => {
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
