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
 *   GET /api/inventory/standing     everything billed while you aren't playing, with advice
 *
 * See services/InventoryService.ts for how it's assembled.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { getInventory } from '../../services/InventoryService';
import { getStandingCosts } from '../../services/StandingCostService';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await getInventory(req.userId!, req.query.refresh === 'true'));
  } catch (error) {
    console.error('Inventory error:', error);
    res.status(500).json({ error: 'Failed to load your infrastructure', tip: 'Try again in a moment; if it persists, check the DATABASE light.' });
  }
});

router.get('/standing', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getStandingCosts(req.userId!, req.query.refresh === 'true'));
  } catch (error) {
    console.error('Standing cost error:', error);
    res.status(500).json({ error: 'Failed to work out your standing costs', tip: 'Try again in a moment.' });
  }
});

export default router;
