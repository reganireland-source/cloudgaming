import { query } from '../config/database';
import { RecommendationResult } from '../types';

/**
 * ============================================================================
 * src/services/RecommendationEngine.ts — "WHAT SHOULD I RUN THIS GAME ON?"
 * ============================================================================
 *
 * RecommendationEngine solves:
 * Best instance type + region + streaming quality for a game + location + budget
 *
 * HOW IT DECIDES (recommend)
 * --------------------------
 *   1. Look up the game in game_profiles — its `gpu_class` says how strong a
 *      graphics card it needs (t4 < a10g < a100 < h100).
 *   2. Translate that GPU class into each cloud's matching machine types
 *      (the instanceTypesByGpuClass table).
 *   3. For every region of every cloud offering one:
 *        - estimate latency from the player's distance to the region
 *        - pick a quality: High if close (< 30 ms), Budget if far (> 80 ms),
 *          otherwise Good — further away = lower quality to keep it smooth
 *        - cost per hour = machine price + (GB per hour × egress price)
 *        - skip it if it's over the player's budget
 *   4. Sort cheapest first (latency breaks ties) and return the top 5.
 *
 * Data comes from the game_profiles, region_data and streaming_qualities
 * tables. NOTE: region_data is never filled in by anything yet, so until it
 * is populated this returns an empty list.
 * `userId` is accepted but not used.
 * ============================================================================
 */
export class RecommendationEngine {
  /**
   * Get recommendations based on user intent
   */
  static async recommend(
    userId: string,
    gameTitle: string,
    userLat: number,
    userLng: number,
    budgetPerHour?: number
  ): Promise<RecommendationResult[]> {
    // 1. Look up game profile
    const gameResult = await query(
      `SELECT * FROM game_profiles WHERE title ILIKE $1`,
      [`%${gameTitle}%`]
    );

    if (gameResult.rows.length === 0) {
      throw new Error(`Game "${gameTitle}" not found in library`);
    }

    const game: any = gameResult.rows[0];

    // 2. Map GPU class to instance types per provider
    const instanceTypesByGpuClass: Record<string, Record<string, string[]>> = {
      't4': {
        'aws': ['g4dn.xlarge', 'g4dn.2xlarge'],
        'azure': ['Standard_NV6'],
        'gcp': ['n1-standard-4 + NVIDIA_TESLA_T4'],
        'oracle': ['VM.GPU2.1'],
      },
      'a10g': {
        'aws': ['g5.xlarge', 'g5.2xlarge'],
        'azure': ['Standard_NVadsA10_v5'],
        'gcp': ['n1-standard-8 + NVIDIA_TESLA_L4'],
        'oracle': ['VM.GPU3.1'],
      },
      'a100': {
        'aws': ['g4dn.12xlarge'],
        'azure': ['Standard_ND96asr_v4'],
        'gcp': ['a2-highgpu-1g'],
        'oracle': ['VM.GPU3.4'],
      },
      'h100': {   // SUPER tier: graphics GPUs with DLSS frame generation
        'aws': ['g6e.2xlarge'],
        'gcp': ['g4-standard-48'],
        'oracle': ['VM.GPU3.8'],
      },
    };

    // 3. Get all regions with pricing and latency
    const regionsResult = await query(
      `SELECT * FROM region_data ORDER BY provider, name`
    );

    const regions = regionsResult.rows;

    // 4. Get streaming qualities
    const qualitiesResult = await query(`SELECT * FROM streaming_qualities ORDER BY name`);
    const qualities = qualitiesResult.rows;

    // 5. Generate recommendations
    const recommendations: RecommendationResult[] = [];

    const instanceTypes = instanceTypesByGpuClass[game.gpu_class] || {};

    for (const provider of Object.keys(instanceTypes)) {
      const types = instanceTypes[provider];
      const providerRegions = regions.filter((r: any) => r.provider === provider);

      for (const region of providerRegions) {
        // Calculate latency (simple Haversine)
        const latency = this.calculateLatency(userLat, userLng, region.lat, region.lng);

        // Recommend appropriate quality based on latency
        let recommendedQuality = qualities.find((q: any) => q.name === 'Good');
        if (latency < 30) {
          recommendedQuality = qualities.find((q: any) => q.name === 'High') || recommendedQuality;
        } else if (latency > 80) {
          recommendedQuality = qualities.find((q: any) => q.name === 'Budget') || recommendedQuality;
        }

        // Get best instance type for this game on this provider
        const instanceType = types[0];

        // Calculate costs
        const computePerHour = region.on_demand_price || 0.5;
        const egressPerHour = (recommendedQuality?.gb_per_hour || 3.6) * (region.egress_cost_per_gb || 0.12);
        const totalPerHour = computePerHour + egressPerHour;

        // Filter by budget if specified
        if (budgetPerHour && totalPerHour > budgetPerHour) {
          continue;
        }

        recommendations.push({
          provider: provider as 'aws' | 'azure' | 'gcp' | 'oracle',
          region: region.region,
          instanceType,
          quality: recommendedQuality,
          latencyMs: Math.round(latency),
          computePerHour,
          egressPerHour,
          totalPerHour,
        });
      }
    }

    // Sort by total cost, then by latency
    recommendations.sort((a, b) => {
      const costDiff = a.totalPerHour - b.totalPerHour;
      return costDiff !== 0 ? costDiff : a.latencyMs - b.latencyMs;
    });

    return recommendations.slice(0, 5); // Return top 5
  }

  /**
   * Calculate latency based on distance (simplified Haversine)
   */
  private static calculateLatency(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    // Rough estimate: 1ms per 100km of distance + base latency
    return 5 + distance / 100;
  }

  /**
   * Get quality tiers for a recommendation
   */
  static async getQualityTiers(egressCostPerGb: number): Promise<{
    quality: string;
    resolution: string;
    fps: number;
    gbPerHour: number;
    costPerHour: number;
  }[]> {
    const qualitiesResult = await query(`SELECT * FROM streaming_qualities ORDER BY name`);
    const qualities = qualitiesResult.rows;

    return qualities.map((q: any) => ({
      quality: q.name,
      resolution: q.resolution,
      fps: q.fps,
      gbPerHour: q.gb_per_hour,
      costPerHour: q.gb_per_hour * egressCostPerGb,
    }));
  }
}
