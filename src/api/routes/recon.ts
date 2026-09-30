/**
 * ============================================================================
 * src/api/routes/recon.ts — THE RECON PAGE'S RECOMMENDATIONS
 * ============================================================================
 *
 * Mounted at /api/recon in src/index.ts, WITHOUT the login check: it only
 * reads the price catalogs, so anyone can compare before signing up.
 *
 *   GET /api/recon?lat=..&lng=..[&priority=latency|balanced|price]
 *                  [&budget=0.9][&spot=true][&game=Elden]
 *     → best regions per hardware tier (Good / Better / Best), see
 *       src/services/ReconService.ts
 *
 * The page turns a city or country into lat/lng itself
 * (frontend/app/api/geocode/route.ts).
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { recon, type Priority } from '../../services/ReconService';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const lat = parseFloat(String(req.query.lat));
  const lng = parseFloat(String(req.query.lng));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Pick a location first (a city, a country, or "use my location").' });
  }
  const budget = parseFloat(String(req.query.budget));
  try {
    res.json(await recon({
      lat, lng,
      budgetPerHour: Number.isFinite(budget) && budget > 0 ? budget : undefined,
      spot: req.query.spot === 'true',
      priority: (['latency', 'balanced', 'price'] as const).find((p) => p === req.query.priority) as Priority | undefined,
      clouds: typeof req.query.clouds === 'string'
        ? (['aws', 'azure', 'gcp', 'oracle'] as const).filter((c) => req.query.clouds!.toString().split(',').includes(c))
        : undefined,
      gameTitle: typeof req.query.game === 'string' ? req.query.game.slice(0, 100) : undefined,
    }));
  } catch (error) {
    console.error('Recon error:', error);
    res.status(500).json({ error: 'Could not work out recommendations' });
  }
});

export default router;
