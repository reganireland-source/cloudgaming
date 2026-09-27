/**
 * ============================================================================
 * src/api/routes/regions.ts — CLOUD REGIONS, LATENCY AND RECOMMENDATIONS
 * ============================================================================
 *
 * A REGION is a cluster of a cloud provider's data centres in one place
 * (e.g. AWS "ap-southeast-1" = Singapore). For game streaming, WHERE the
 * machine is matters a lot: the further away it is, the longer every button
 * press takes to reach the game and the video to come back (LATENCY).
 *
 * Mounted at /api/regions (login required):
 *   GET  /api/regions                  every known region with prices
 *   POST /api/regions/test-latency     estimated latency to one region
 *   GET  /api/regions/recommend        best region/machine for a game
 *   GET  /api/regions/qualities        streaming quality tiers + their costs
 *
 * Region data comes from the `region_data` table.
 * ============================================================================
 */

import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { RecommendationEngine } from '../../services/RecommendationEngine';

const router = Router();

/**
 * GET /api/regions
 * List every region with its location and current prices.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT
        provider,
        name,
        region,
        lat,
        lng,
        spot_price,
        on_demand_price,
        egress_cost_per_gb,
        updated_at
       FROM region_data
       ORDER BY provider, name`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get regions error:', error);
    res.status(500).json({ error: 'Failed to fetch regions' });
  }
});

/**
 * POST /api/regions/test-latency
 * Body: { provider, region, userLat?, userLng? }
 *
 * IMPORTANT: this does NOT actually measure the network. It ESTIMATES
 * latency from the straight-line distance between the player and the
 * region (see calculateLatency at the bottom). If the player's location
 * isn't supplied, it assumes Singapore.
 */
router.post('/test-latency', async (req: Request, res: Response) => {
  try {
    const { provider, region, userLat, userLng } = req.body;

    if (!provider || !region) {
      return res.status(400).json({ error: 'Missing provider or region' });
    }

    // Find where the region is on the map.
    const regionResult = await query(
      `SELECT lat, lng FROM region_data WHERE provider = $1 AND region = $2`,
      [provider, region]
    );

    if (regionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Region not found' });
    }

    const regionData = regionResult.rows[0];

    // 1.3521, 103.8198 are Singapore's latitude/longitude — the default
    // player location when none is provided.
    const latency = calculateLatency(
      userLat || 1.3521,
      userLng || 103.8198,
      regionData.lat,
      regionData.lng
    );

    res.json({
      provider,
      region,
      latencyMs: Math.round(latency),
      timestamp: new Date(),
    });
  } catch (error) {
    console.error('Test latency error:', error);
    res.status(500).json({ error: 'Failed to test latency' });
  }
});

/**
 * GET /api/regions/recommend?gameTitle=...&budgetPerHour=...&userLat=...&userLng=...
 * Ask the RecommendationEngine for the best provider/region/machine for a
 * game, optionally within a budget. The actual decision logic lives in
 * src/services/RecommendationEngine.ts.
 */
router.get('/recommend', async (req: Request, res: Response) => {
  try {
    const { gameTitle, budgetPerHour, userLat, userLng } = req.query;

    // `(req as any)` sidesteps TypeScript's type checking to read userId.
    // Equivalent to req.userId (see the Express type extension in auth.ts).
    const userId = (req as any).userId;

    if (!gameTitle) {
      return res.status(400).json({ error: 'Game title required' });
    }

    const recommendations = await RecommendationEngine.recommend(
      userId!,                                   // `!` tells TypeScript "trust me, this isn't undefined"
      gameTitle as string,
      parseFloat(userLat as string) || 1.3521,   // Default: Singapore
      parseFloat(userLng as string) || 103.8198,
      // Only pass a budget if one was given; `undefined` means "no limit".
      budgetPerHour ? parseFloat(budgetPerHour as string) : undefined
    );

    res.json(recommendations);
  } catch (error) {
    console.error('Get recommendation error:', error);
    res.status(500).json({ error: 'Failed to get recommendation', details: String(error) });
  }
});

/**
 * GET /api/regions/qualities?provider=...&region=...
 * The streaming quality tiers (Budget/Good/High/Ultra) and what each would
 * cost per hour in data-transfer ("egress") fees in this region. Higher
 * quality = more video data per hour = higher egress cost.
 */
router.get('/qualities', async (req: Request, res: Response) => {
  try {
    const { provider, region } = req.query;

    if (!provider || !region) {
      return res.status(400).json({ error: 'Missing provider or region' });
    }

    // Each region charges a different price per gigabyte of data sent out.
    const regionResult = await query(
      `SELECT egress_cost_per_gb FROM region_data WHERE provider = $1 AND region = $2`,
      [provider, region]
    );

    if (regionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Region not found' });
    }

    // Fall back to $0.12/GB (a typical price) if the region has no value.
    const egressCostPerGb = regionResult.rows[0].egress_cost_per_gb || 0.12;

    const qualities = await RecommendationEngine.getQualityTiers(egressCostPerGb);

    res.json({
      provider,
      region,
      egressCostPerGb,
      qualities,
    });
  } catch (error) {
    console.error('Get qualities error:', error);
    res.status(500).json({ error: 'Failed to fetch qualities' });
  }
});

/**
 * Estimate network latency (milliseconds) between two points on Earth.
 *
 * Step 1 — distance: the HAVERSINE formula, the standard way to get the
 * distance between two latitude/longitude points on a sphere. R is the
 * Earth's radius in km; the trigonometry converts degrees to radians
 * (× π/180) and works out the arc between the points.
 *
 * Step 2 — latency: a rough rule of thumb of 5 ms fixed overhead plus about
 * 1 ms per 100 km. Real latency also depends on routing, congestion and the
 * player's own connection, so treat this as a ballpark only.
 */
function calculateLatency(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in kilometres
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // kilometres
  return 5 + distance / 100; // Base 5ms + ~1ms per 100km
}

export default router;
