import { Router, Request, Response } from 'express';
import { query } from '../../config/database';

const router = Router();

/**
 * GET /api/regions
 * Get all available regions with current pricing and latency
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userLocation = req.query.location || 'sg'; // user's location code

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

    // TODO: Calculate latency from user location to each region
    // TODO: Sort by latency

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
    const { provider, region } = req.body;

    if (!provider || !region) {
      return res.status(400).json({ error: 'Missing provider or region' });
    }

    // TODO: Ping the region and measure latency
    // For MVP, return mock data
    const latency = Math.random() * 100;

    res.json({
      provider,
      region,
      latencyMs: latency,
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

    if (!gameTitle) {
      return res.status(400).json({ error: 'Game title required' });
    }

    // TODO: Look up game profile
    // TODO: Query region pricing
    // TODO: Calculate cost for each region + quality combo
    // TODO: Filter by budget
    // TODO: Sort by latency + cost
    // TODO: Return top 3 recommendations

    res.status(501).json({ error: 'Not yet implemented' });
  } catch (error) {
    console.error('Get recommendation error:', error);
    res.status(500).json({ error: 'Failed to get recommendation' });
  }
});

export default router;
