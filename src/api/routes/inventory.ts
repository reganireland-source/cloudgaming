/**
 * ============================================================================
 * src/api/routes/inventory.ts — WHAT'S DEPLOYED WHERE (FOR THE MAP)
 * ============================================================================
 *
 * Mounted at /api/inventory behind authMiddleware (you only ever see your
 * own infrastructure).
 *
 *   GET /api/inventory              everything deployed, all clouds (cached 60 s)
 *   GET /api/inventory?refresh=true ask the clouds again right now
 *
 * See services/InventoryService.ts for how it's assembled.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { getInventory } from '../../services/InventoryService';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await getInventory(req.userId!, req.query.refresh === 'true'));
  } catch (error) {
    console.error('Inventory error:', error);
    res.status(500).json({ error: 'Failed to load your infrastructure', tip: 'Try again in a moment; if it persists, check the DATABASE light.' });
  }
});

export default router;
