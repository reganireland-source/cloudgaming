import { Router, Request, Response } from 'express';
import { query } from '../../config/database';
import { RecommendationEngine } from '../../services/RecommendationEngine';

const router = Router();

/**
 * GET /api/regions
 * Get all available regions with current pricing and latency
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
 * Test latency to a specific region
 */
router.post('/test-latency', async (req: Request, res: Response) => {
  try {
    const { provider, region, userLat, userLng } = req.body;

    if (!provider || !region) {
      return res.status(400).json({ error: 'Missing provider or region' });
    }

    // Get region coordinates
    const regionResult = await query(
      `SELECT lat, lng FROM region_data WHERE provider = $1 AND region = $2`,
      [provider, region]
    );

    if (regionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Region not found' });
    }

    const regionData = regionResult.rows[0];

    // Calculate simulated latency
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
 * GET /api/regions/recommend
 * Get recommendation for best region based on game and budget
 */
router.get('/recommend', async (req: Request, res: Response) => {
  try {
    const { gameTitle, budgetPerHour, userLat, userLng } = req.query;
    const userId = (req as any).userId;

    if (!gameTitle) {
      return res.status(400).json({ error: 'Game title required' });
    }

    const recommendations = await RecommendationEngine.recommend(
      userId!,
      gameTitle as string,
      parseFloat(userLat as string) || 1.3521, // Default: Singapore
      parseFloat(userLng as string) || 103.8198,
      budgetPerHour ? parseFloat(budgetPerHour as string) : undefined
    );

    res.json(recommendations);
  } catch (error) {
    console.error('Get recommendation error:', error);
    res.status(500).json({ error: 'Failed to get recommendation', details: String(error) });
  }
});

/**
 * GET /api/regions/qualities
 * Get streaming quality tiers and their costs for a region
 */
router.get('/qualities', async (req: Request, res: Response) => {
  try {
    const { provider, region } = req.query;

    if (!provider || !region) {
      return res.status(400).json({ error: 'Missing provider or region' });
    }

    // Get region egress cost
    const regionResult = await query(
      `SELECT egress_cost_per_gb FROM region_data WHERE provider = $1 AND region = $2`,
      [provider, region]
    );

    if (regionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Region not found' });
    }

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

function calculateLatency(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return 5 + distance / 100; // Base 5ms + ~1ms per 100km
}

export default router;
