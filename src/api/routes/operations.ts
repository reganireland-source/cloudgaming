/**
 * ============================================================================
 * src/api/routes/operations.ts — THE LIVE COMMENTARY FOR CLOUD ACTIONS
 * ============================================================================
 *
 * Mounted at /api/operations behind authMiddleware.
 *
 *   GET /api/operations?limit=20&machineId=…   my recent actions (Activity panel)
 *   GET /api/operations/:id?after=123          one action + its log lines
 *
 * The frontend polls GET /:id about once a second while an action runs,
 * passing `after` = the id of the last line it already has, so each poll
 * only downloads NEW lines. When `status` becomes 'succeeded' or 'failed'
 * it stops polling; a failure includes `error`, the plain-English card.
 * See services/OperationLog.ts for how operations are written.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { getOperation, listOperations } from '../../services/OperationLog';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const machineId = typeof req.query.machineId === 'string' ? req.query.machineId : undefined;
    res.json(await listOperations(req.userId!, limit, machineId));
  } catch (error) {
    console.error('List operations error:', error);
    res.status(500).json({ error: 'Failed to load activity', tip: 'Try again in a moment.' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const after = Number(req.query.after) || 0;
    const op = await getOperation(req.params.id, req.userId!, after);
    if (!op) return res.status(404).json({ error: 'Operation not found.', tip: 'It may belong to another account.' });
    res.json(op);
  } catch (error) {
    console.error('Get operation error:', error);
    res.status(500).json({ error: 'Failed to load the operation', tip: 'Try again in a moment.' });
  }
});

export default router;
